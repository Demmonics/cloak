use axum::{
    Json,
    extract::{Path, State},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64_STD};
use chrono::{DateTime, Utc};
use cloak_core::{
    auth::{decode_base64_any, decode_base64_exact},
    error::CloakError,
};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    authz::{require_active_member, require_permission},
    error::ApiError,
    extractors::AuthenticatedDevice,
    state::AppState,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomRequest {
    pub room_id: Option<Uuid>,
    pub room_kind: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub default_disappear_seconds: Option<i32>,
    pub owner_wrapped_epoch_key_b64: String,
    pub owner_x25519_public_key_b64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoomRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub default_disappear_seconds: Option<Option<i32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannelRequest {
    pub category_name: Option<String>,
    pub name: String,
    pub topic: Option<String>,
    pub channel_type: String,
    pub is_private: Option<bool>,
    pub slow_mode_seconds: Option<i32>,
    pub disappear_seconds: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelRequest {
    pub category_name: Option<Option<String>>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub is_private: Option<bool>,
    pub slow_mode_seconds: Option<i32>,
    pub disappear_seconds: Option<Option<i32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochEnvelopeInput {
    pub recipient_device_id: Uuid,
    pub wrapped_key_ciphertext_b64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateEpochRequest {
    pub reason: Option<String>,
    pub sender_x25519_public_key_b64: String,
    pub envelopes: Vec<EpochEnvelopeInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub category_name: Option<String>,
    pub name: String,
    pub topic: String,
    pub channel_type: String,
    pub position: i32,
    pub is_private: bool,
    pub slow_mode_seconds: i32,
    pub disappear_seconds: Option<i32>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummaryDto {
    pub id: Uuid,
    pub room_kind: String,
    pub name: String,
    pub description: String,
    pub owner_device_id: Uuid,
    pub current_epoch: i64,
    pub default_disappear_seconds: Option<i32>,
    pub quota_bytes: i64,
    pub used_bytes: i64,
    pub next_event_seq: i64,
    pub my_role: String,
    pub my_status: String,
    pub channels: Vec<ChannelDto>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMemberDto {
    pub device_id: Uuid,
    pub display_name: String,
    pub avatar_color: String,
    pub avatar_emoji: Option<String>,
    pub x25519_public_key_b64: String,
    pub ed25519_public_key_b64: String,
    pub role_name: String,
    pub status: String,
    pub joined_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochKeyEnvelopeDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub epoch: i64,
    pub recipient_device_id: Uuid,
    pub sender_device_id: Uuid,
    pub sender_x25519_public_key_b64: String,
    pub wrapped_key_ciphertext_b64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDetailDto {
    pub room: RoomSummaryDto,
    pub members: Vec<RoomMemberDto>,
    pub my_epoch_envelopes: Vec<EpochKeyEnvelopeDto>,
}

async fn seed_system_roles(
    tx: &mut Transaction<'_, Postgres>,
    room_id: Uuid,
) -> Result<Uuid, CloakError> {
    let roles_spec: [(&str, i32, &[&str]); 4] = [
        (
            "owner",
            100,
            &[
                "send_messages",
                "attach_files",
                "connect_voice",
                "manage_channels",
                "manage_invites",
                "manage_members",
                "manage_messages",
                "burn_room",
                "export_chat",
            ],
        ),
        (
            "admin",
            80,
            &[
                "send_messages",
                "attach_files",
                "connect_voice",
                "manage_channels",
                "manage_invites",
                "manage_members",
                "manage_messages",
                "export_chat",
            ],
        ),
        (
            "member",
            40,
            &[
                "send_messages",
                "attach_files",
                "connect_voice",
                "export_chat",
            ],
        ),
        ("readonly", 10, &["export_chat"]),
    ];

    let mut owner_role_id = Uuid::nil();
    for (name, rank, perms) in roles_spec {
        let role_id = Uuid::new_v4();
        if name == "owner" {
            owner_role_id = role_id;
        }
        sqlx::query(
            "INSERT INTO roles (id, room_id, name, rank, is_system) VALUES ($1, $2, $3, $4, TRUE)",
        )
        .bind(role_id)
        .bind(room_id)
        .bind(name)
        .bind(rank)
        .execute(&mut **tx)
        .await?;

        for perm in perms {
            sqlx::query(
                "INSERT INTO permissions (id, role_id, permission_key, allowed) VALUES ($1, $2, $3, TRUE)",
            )
            .bind(Uuid::new_v4())
            .bind(role_id)
            .bind(*perm)
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(owner_role_id)
}

pub async fn create_room(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<RoomDetailDto>, ApiError> {
    let cap = state.config.rate_limits.room_create_per_hour;
    state
        .state_store
        .enforce_rate_limit(
            &format!("room-create:device:{}", auth.device_id),
            cap,
            cap as f64 / 3600.0,
            3600,
        )
        .await?;

    let name = req.name.trim().to_string();
    if name.is_empty() || name.len() > 100 {
        return Err(ApiError(CloakError::BadRequest(
            "room name must be 1..100 characters".into(),
        )));
    }
    let room_kind = req.room_kind.unwrap_or_else(|| "group".to_string());
    if !matches!(room_kind.as_str(), "dm" | "group" | "community") {
        return Err(ApiError(CloakError::BadRequest("invalid roomKind".into())));
    }

    let wrapped_key = decode_base64_any(
        &req.owner_wrapped_epoch_key_b64,
        512,
        "ownerWrappedEpochKeyB64",
    )?;
    let sender_x_pk = decode_base64_exact(
        &req.owner_x25519_public_key_b64,
        32,
        "ownerX25519PublicKeyB64",
    )?;

    let mut tx = state.db.begin().await?;
    let room_id = req.room_id.unwrap_or_else(Uuid::new_v4);
    let description = req
        .description
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect::<String>();

    sqlx::query(
        r#"
        INSERT INTO rooms (id, room_kind, name, description, owner_device_id, current_epoch, default_disappear_seconds, quota_bytes)
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
        "#,
    )
    .bind(room_id)
    .bind(&room_kind)
    .bind(&name)
    .bind(&description)
    .bind(auth.device_id)
    .bind(req.default_disappear_seconds)
    .bind(state.config.room_quota_bytes)
    .execute(&mut *tx)
    .await
    .map_err(|err| match &err {
        sqlx::Error::Database(db_err) if db_err.code().as_deref() == Some("23505") => {
            ApiError(CloakError::Conflict("roomId already exists".into()))
        }
        _ => ApiError::from(err),
    })?;

    let owner_role_id = seed_system_roles(&mut tx, room_id).await?;

    sqlx::query(
        "INSERT INTO memberships (id, room_id, device_id, role_id, status) VALUES ($1, $2, $3, $4, 'active')",
    )
    .bind(Uuid::new_v4())
    .bind(room_id)
    .bind(auth.device_id)
    .bind(owner_role_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO room_encryption_epochs (room_id, epoch, created_by_device_id, reason) VALUES ($1, 1, $2, 'initial')",
    )
    .bind(room_id)
    .bind(auth.device_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO epoch_key_envelopes (id, room_id, epoch, recipient_device_id, sender_device_id, sender_x25519_public_key, wrapped_key_ciphertext)
        VALUES ($1, $2, 1, $3, $3, $4, $5)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(room_id)
    .bind(auth.device_id)
    .bind(&sender_x_pk)
    .bind(&wrapped_key)
    .execute(&mut *tx)
    .await?;

    // Default text & voice channels
    let text_channel_id = Uuid::new_v4();
    let voice_channel_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO channels (id, room_id, category_name, name, topic, channel_type, position, created_by_device_id)
        VALUES
          ($1, $3, 'Text Channels', 'general', 'Encrypted conversation', 'text', 0, $4),
          ($2, $3, 'Voice Channels', 'voice-lounge', 'E2EE LiveKit audio & video', 'voice', 1, $4)
        "#,
    )
    .bind(text_channel_id)
    .bind(voice_channel_id)
    .bind(room_id)
    .bind(auth.device_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    fetch_room_detail(&state.db, room_id, auth.device_id)
        .await
        .map(Json)
        .map_err(ApiError)
}

pub async fn list_rooms(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
) -> Result<Json<Vec<RoomSummaryDto>>, ApiError> {
    let room_rows = sqlx::query(
        r#"
        SELECT rm.id, rm.room_kind, rm.name, rm.description, rm.owner_device_id,
               rm.current_epoch, rm.default_disappear_seconds, rm.quota_bytes,
               rm.used_bytes, rm.next_event_seq, rm.created_at,
               r.name AS my_role, m.status AS my_status
        FROM memberships m
        JOIN rooms rm ON rm.id = m.room_id
        JOIN roles r ON r.id = m.role_id
        WHERE m.device_id = $1 AND m.status = 'active' AND rm.deleted_at IS NULL
        ORDER BY rm.created_at ASC
        "#,
    )
    .bind(auth.device_id)
    .fetch_all(&state.db)
    .await?;

    let mut out = Vec::with_capacity(room_rows.len());
    for row in room_rows {
        let room_id: Uuid = row.get("id");
        let channels = fetch_channels(&state.db, room_id).await?;
        let created_at: DateTime<Utc> = row.get("created_at");
        out.push(RoomSummaryDto {
            id: room_id,
            room_kind: row.get("room_kind"),
            name: row.get("name"),
            description: row.get("description"),
            owner_device_id: row.get("owner_device_id"),
            current_epoch: row.get("current_epoch"),
            default_disappear_seconds: row.get("default_disappear_seconds"),
            quota_bytes: row.get("quota_bytes"),
            used_bytes: row.get("used_bytes"),
            next_event_seq: row.get("next_event_seq"),
            my_role: row.get("my_role"),
            my_status: row.get("my_status"),
            channels,
            created_at: created_at.to_rfc3339(),
        });
    }

    Ok(Json(out))
}

pub async fn get_room(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
) -> Result<Json<RoomDetailDto>, ApiError> {
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    fetch_room_detail(&state.db, room_id, auth.device_id)
        .await
        .map(Json)
        .map_err(ApiError)
}

pub async fn update_room(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Json(req): Json<UpdateRoomRequest>,
) -> Result<Json<RoomDetailDto>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_channels").await?;

    if let Some(name) = &req.name {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.len() > 100 {
            return Err(ApiError(CloakError::BadRequest("invalid room name".into())));
        }
        sqlx::query("UPDATE rooms SET name = $2, updated_at = NOW() WHERE id = $1")
            .bind(room_id)
            .bind(trimmed)
            .execute(&state.db)
            .await?;
    }
    if let Some(desc) = &req.description {
        sqlx::query("UPDATE rooms SET description = $2, updated_at = NOW() WHERE id = $1")
            .bind(room_id)
            .bind(desc.chars().take(500).collect::<String>())
            .execute(&state.db)
            .await?;
    }
    if let Some(disappear) = req.default_disappear_seconds {
        sqlx::query(
            "UPDATE rooms SET default_disappear_seconds = $2, updated_at = NOW() WHERE id = $1",
        )
        .bind(room_id)
        .bind(disappear)
        .execute(&state.db)
        .await?;
    }

    fetch_room_detail(&state.db, room_id, auth.device_id)
        .await
        .map(Json)
        .map_err(ApiError)
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<ChannelDto>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_channels").await?;
    if !matches!(req.channel_type.as_str(), "text" | "voice" | "announcement") {
        return Err(ApiError(CloakError::BadRequest(
            "invalid channelType".into(),
        )));
    }
    let name = req.name.trim().to_lowercase().replace(' ', "-");
    if name.is_empty() || name.len() > 64 {
        return Err(ApiError(CloakError::BadRequest(
            "invalid channel name".into(),
        )));
    }

    let next_pos: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE room_id = $1 AND archived_at IS NULL",
    )
    .bind(room_id)
    .fetch_one(&state.db)
    .await?;

    let channel_id = Uuid::new_v4();
    let row = sqlx::query(
        r#"
        INSERT INTO channels (id, room_id, category_name, name, topic, channel_type, position, is_private, slow_mode_seconds, disappear_seconds, created_by_device_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, room_id, category_name, name, topic, channel_type, position, is_private, slow_mode_seconds, disappear_seconds, created_at
        "#,
    )
    .bind(channel_id)
    .bind(room_id)
    .bind(req.category_name.map(|c| c.chars().take(64).collect::<String>()))
    .bind(&name)
    .bind(req.topic.unwrap_or_default().chars().take(256).collect::<String>())
    .bind(&req.channel_type)
    .bind(next_pos)
    .bind(req.is_private.unwrap_or(false))
    .bind(req.slow_mode_seconds.unwrap_or(0).max(0))
    .bind(req.disappear_seconds)
    .bind(auth.device_id)
    .fetch_one(&state.db)
    .await?;

    let dto = row_to_channel(row);
    broadcast_room_event(
        &state,
        room_id,
        Some(channel_id),
        None,
        auth.device_id,
        "channel.updated",
        None,
    )
    .await?;
    Ok(Json(dto))
}

pub async fn update_channel(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateChannelRequest>,
) -> Result<Json<ChannelDto>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_channels").await?;

    if let Some(cat) = req.category_name {
        sqlx::query("UPDATE channels SET category_name = $3 WHERE id = $1 AND room_id = $2")
            .bind(channel_id)
            .bind(room_id)
            .bind(cat)
            .execute(&state.db)
            .await?;
    }
    if let Some(name) = req.name {
        let clean = name.trim().to_lowercase().replace(' ', "-");
        if clean.is_empty() || clean.len() > 64 {
            return Err(ApiError(CloakError::BadRequest(
                "invalid channel name".into(),
            )));
        }
        sqlx::query("UPDATE channels SET name = $3 WHERE id = $1 AND room_id = $2")
            .bind(channel_id)
            .bind(room_id)
            .bind(clean)
            .execute(&state.db)
            .await?;
    }
    if let Some(topic) = req.topic {
        sqlx::query("UPDATE channels SET topic = $3 WHERE id = $1 AND room_id = $2")
            .bind(channel_id)
            .bind(room_id)
            .bind(topic.chars().take(256).collect::<String>())
            .execute(&state.db)
            .await?;
    }
    if let Some(is_private) = req.is_private {
        sqlx::query("UPDATE channels SET is_private = $3 WHERE id = $1 AND room_id = $2")
            .bind(channel_id)
            .bind(room_id)
            .bind(is_private)
            .execute(&state.db)
            .await?;
    }
    if let Some(slow) = req.slow_mode_seconds {
        sqlx::query("UPDATE channels SET slow_mode_seconds = $3 WHERE id = $1 AND room_id = $2")
            .bind(channel_id)
            .bind(room_id)
            .bind(slow.max(0))
            .execute(&state.db)
            .await?;
    }
    if let Some(disappear) = req.disappear_seconds {
        sqlx::query("UPDATE channels SET disappear_seconds = $3 WHERE id = $1 AND room_id = $2")
            .bind(channel_id)
            .bind(room_id)
            .bind(disappear)
            .execute(&state.db)
            .await?;
    }

    let row = sqlx::query(
        "SELECT id, room_id, category_name, name, topic, channel_type, position, is_private, slow_mode_seconds, disappear_seconds, created_at FROM channels WHERE id = $1 AND room_id = $2 AND archived_at IS NULL",
    )
    .bind(channel_id)
    .bind(room_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("channel not found".into()))?;

    broadcast_room_event(
        &state,
        room_id,
        Some(channel_id),
        None,
        auth.device_id,
        "channel.updated",
        None,
    )
    .await?;
    Ok(Json(row_to_channel(row)))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_channels").await?;
    let active_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channels WHERE room_id = $1 AND archived_at IS NULL",
    )
    .bind(room_id)
    .fetch_one(&state.db)
    .await?;
    if active_count <= 1 {
        return Err(ApiError(CloakError::BadRequest(
            "cannot remove the last remaining channel in a room".into(),
        )));
    }

    sqlx::query("UPDATE channels SET archived_at = NOW() WHERE id = $1 AND room_id = $2")
        .bind(channel_id)
        .bind(room_id)
        .execute(&state.db)
        .await?;

    broadcast_room_event(
        &state,
        room_id,
        Some(channel_id),
        None,
        auth.device_id,
        "channel.updated",
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "archived": true })))
}

pub async fn rotate_epoch(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Json(req): Json<RotateEpochRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_members").await?;
    let sender_x_pk = decode_base64_exact(
        &req.sender_x25519_public_key_b64,
        32,
        "senderX25519PublicKeyB64",
    )?;
    let reason = req.reason.unwrap_or_else(|| "manual_rotate".to_string());

    let mut tx = state.db.begin().await?;
    let new_epoch: i64 = sqlx::query_scalar(
        "UPDATE rooms SET current_epoch = current_epoch + 1, updated_at = NOW() WHERE id = $1 RETURNING current_epoch",
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO room_encryption_epochs (room_id, epoch, created_by_device_id, reason) VALUES ($1, $2, $3, $4)",
    )
    .bind(room_id)
    .bind(new_epoch)
    .bind(auth.device_id)
    .bind(reason.chars().take(64).collect::<String>())
    .execute(&mut *tx)
    .await?;

    for env in req.envelopes {
        let wrapped = decode_base64_any(
            &env.wrapped_key_ciphertext_b64,
            512,
            "wrappedKeyCiphertextB64",
        )?;
        sqlx::query(
            r#"
            INSERT INTO epoch_key_envelopes (id, room_id, epoch, recipient_device_id, sender_device_id, sender_x25519_public_key, wrapped_key_ciphertext)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (room_id, epoch, recipient_device_id) DO UPDATE SET wrapped_key_ciphertext = EXCLUDED.wrapped_key_ciphertext
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(new_epoch)
        .bind(env.recipient_device_id)
        .bind(auth.device_id)
        .bind(&sender_x_pk)
        .bind(&wrapped)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    broadcast_room_event(
        &state,
        room_id,
        None,
        None,
        auth.device_id,
        "epoch.rotated",
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "epoch": new_epoch })))
}

pub async fn burn_room_history(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Json(req): Json<RotateEpochRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ctx = require_permission(&state.db, room_id, auth.device_id, "burn_room").await?;
    if auth.device_id != ctx.owner_device_id {
        return Err(ApiError(CloakError::Forbidden(
            "only the room owner may burn conversation history".into(),
        )));
    }
    let sender_x_pk = decode_base64_exact(
        &req.sender_x25519_public_key_b64,
        32,
        "senderX25519PublicKeyB64",
    )?;

    let mut tx = state.db.begin().await?;

    let attachment_rows =
        sqlx::query("SELECT id, object_key FROM encrypted_attachments WHERE room_id = $1")
            .bind(room_id)
            .fetch_all(&mut *tx)
            .await?;

    let chunk_keys: Vec<String> = sqlx::query_scalar(
        "SELECT ac.object_key FROM attachment_chunks ac JOIN encrypted_attachments ea ON ea.id = ac.attachment_id WHERE ea.room_id = $1",
    )
    .bind(room_id)
    .fetch_all(&mut *tx)
    .await?;

    for row in &attachment_rows {
        let att_id: Uuid = row.get("id");
        let obj_key: String = row.get("object_key");
        sqlx::query(
            "INSERT INTO retention_jobs (id, room_id, job_type, target_id, object_key) VALUES ($1, $2, 'purge_attachment_object', $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(att_id)
        .bind(obj_key)
        .execute(&mut *tx)
        .await?;
    }
    for key in &chunk_keys {
        sqlx::query(
            "INSERT INTO retention_jobs (id, room_id, job_type, object_key) VALUES ($1, $2, 'purge_attachment_object', $3)",
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "DELETE FROM channel_pins WHERE channel_id IN (SELECT id FROM channels WHERE room_id = $1)",
    )
    .bind(room_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM encrypted_messages WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM message_tombstones WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM message_events WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE encrypted_attachments SET state = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM attachment_chunks WHERE attachment_id IN (SELECT id FROM encrypted_attachments WHERE room_id = $1)")
        .bind(room_id)
        .execute(&mut *tx)
        .await?;

    let updated = sqlx::query(
        r#"
        UPDATE rooms
        SET current_epoch = current_epoch + 1,
            used_bytes = 0,
            next_event_seq = next_event_seq + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING current_epoch, next_event_seq
        "#,
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    let new_epoch: i64 = updated.get("current_epoch");
    let burn_seq: i64 = updated.get("next_event_seq");

    sqlx::query(
        "INSERT INTO room_encryption_epochs (room_id, epoch, created_by_device_id, reason) VALUES ($1, $2, $3, 'room_burned')",
    )
    .bind(room_id)
    .bind(new_epoch)
    .bind(auth.device_id)
    .execute(&mut *tx)
    .await?;

    for env in req.envelopes {
        let wrapped = decode_base64_any(
            &env.wrapped_key_ciphertext_b64,
            512,
            "wrappedKeyCiphertextB64",
        )?;
        sqlx::query(
            r#"
            INSERT INTO epoch_key_envelopes (id, room_id, epoch, recipient_device_id, sender_device_id, sender_x25519_public_key, wrapped_key_ciphertext)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (room_id, epoch, recipient_device_id) DO UPDATE SET wrapped_key_ciphertext = EXCLUDED.wrapped_key_ciphertext
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(new_epoch)
        .bind(env.recipient_device_id)
        .bind(auth.device_id)
        .bind(&sender_x_pk)
        .bind(&wrapped)
        .execute(&mut *tx)
        .await?;
    }

    let burn_event_id = Uuid::new_v4();
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO message_events (id, room_id, actor_device_id, event_seq, event_type, created_at) VALUES ($1, $2, $3, $4, 'room.burned', $5)",
    )
    .bind(burn_event_id)
    .bind(room_id)
    .bind(auth.device_id)
    .bind(burn_seq)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Best-effort immediate object purge alongside queued retention jobs
    for key in chunk_keys {
        let _ = state.object_store.delete_object(&key).await;
    }

    let ws_payload = serde_json::json!({
        "type": "event",
        "event": {
            "id": burn_event_id,
            "roomId": room_id,
            "channelId": null,
            "messageId": null,
            "actorDeviceId": auth.device_id,
            "eventSeq": burn_seq,
            "eventType": "room.burned",
            "encryptedPayloadB64": null,
            "createdAt": now.to_rfc3339(),
        }
    });
    state
        .ws_hub
        .broadcast_room(room_id, ws_payload.to_string())
        .await;

    Ok(Json(serde_json::json!({
        "burned": true,
        "newEpoch": new_epoch,
        "eventSeq": burn_seq
    })))
}

pub async fn fetch_room_detail(
    db: &PgPool,
    room_id: Uuid,
    viewer_device_id: Uuid,
) -> Result<RoomDetailDto, CloakError> {
    let row = sqlx::query(
        r#"
        SELECT rm.id, rm.room_kind, rm.name, rm.description, rm.owner_device_id,
               rm.current_epoch, rm.default_disappear_seconds, rm.quota_bytes,
               rm.used_bytes, rm.next_event_seq, rm.created_at,
               r.name AS my_role, m.status AS my_status
        FROM rooms rm
        JOIN memberships m ON m.room_id = rm.id AND m.device_id = $2
        JOIN roles r ON r.id = m.role_id
        WHERE rm.id = $1 AND rm.deleted_at IS NULL
        "#,
    )
    .bind(room_id)
    .bind(viewer_device_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloakError::NotFound("room not found".into()))?;

    let channels = fetch_channels(db, room_id).await?;

    let member_rows = sqlx::query(
        r#"
        SELECT d.id AS device_id, d.display_name, d.avatar_color, d.avatar_emoji,
               d.x25519_public_key, d.ed25519_public_key,
               r.name AS role_name, m.status, m.joined_at
        FROM memberships m
        JOIN device_identities d ON d.id = m.device_id
        JOIN roles r ON r.id = m.role_id
        WHERE m.room_id = $1 AND m.status IN ('active', 'pending_approval')
        ORDER BY r.rank DESC, m.joined_at ASC
        "#,
    )
    .bind(room_id)
    .fetch_all(db)
    .await?;

    let members = member_rows
        .into_iter()
        .map(|mr| {
            let x_pk: Vec<u8> = mr.get("x25519_public_key");
            let ed_pk: Vec<u8> = mr.get("ed25519_public_key");
            let joined_at: DateTime<Utc> = mr.get("joined_at");
            RoomMemberDto {
                device_id: mr.get("device_id"),
                display_name: mr.get("display_name"),
                avatar_color: mr.get("avatar_color"),
                avatar_emoji: mr.get("avatar_emoji"),
                x25519_public_key_b64: B64_STD.encode(x_pk),
                ed25519_public_key_b64: B64_STD.encode(ed_pk),
                role_name: mr.get("role_name"),
                status: mr.get("status"),
                joined_at: joined_at.to_rfc3339(),
            }
        })
        .collect();

    let env_rows = sqlx::query(
        r#"
        SELECT id, room_id, epoch, recipient_device_id, sender_device_id, sender_x25519_public_key, wrapped_key_ciphertext
        FROM epoch_key_envelopes
        WHERE room_id = $1 AND recipient_device_id = $2
        ORDER BY epoch ASC
        "#,
    )
    .bind(room_id)
    .bind(viewer_device_id)
    .fetch_all(db)
    .await?;

    let envelopes = env_rows
        .into_iter()
        .map(|er| {
            let spk: Vec<u8> = er.get("sender_x25519_public_key");
            let wkc: Vec<u8> = er.get("wrapped_key_ciphertext");
            EpochKeyEnvelopeDto {
                id: er.get("id"),
                room_id: er.get("room_id"),
                epoch: er.get("epoch"),
                recipient_device_id: er.get("recipient_device_id"),
                sender_device_id: er.get("sender_device_id"),
                sender_x25519_public_key_b64: B64_STD.encode(spk),
                wrapped_key_ciphertext_b64: B64_STD.encode(wkc),
            }
        })
        .collect();

    let created_at: DateTime<Utc> = row.get("created_at");
    Ok(RoomDetailDto {
        room: RoomSummaryDto {
            id: row.get("id"),
            room_kind: row.get("room_kind"),
            name: row.get("name"),
            description: row.get("description"),
            owner_device_id: row.get("owner_device_id"),
            current_epoch: row.get("current_epoch"),
            default_disappear_seconds: row.get("default_disappear_seconds"),
            quota_bytes: row.get("quota_bytes"),
            used_bytes: row.get("used_bytes"),
            next_event_seq: row.get("next_event_seq"),
            my_role: row.get("my_role"),
            my_status: row.get("my_status"),
            channels,
            created_at: created_at.to_rfc3339(),
        },
        members,
        my_epoch_envelopes: envelopes,
    })
}

use sqlx::PgPool;

pub async fn fetch_channels(db: &PgPool, room_id: Uuid) -> Result<Vec<ChannelDto>, CloakError> {
    let rows = sqlx::query(
        r#"
        SELECT id, room_id, category_name, name, topic, channel_type, position, is_private, slow_mode_seconds, disappear_seconds, created_at
        FROM channels
        WHERE room_id = $1 AND archived_at IS NULL
        ORDER BY position ASC, created_at ASC
        "#,
    )
    .bind(room_id)
    .fetch_all(db)
    .await?;

    Ok(rows.into_iter().map(row_to_channel).collect())
}

fn row_to_channel(row: sqlx::postgres::PgRow) -> ChannelDto {
    let created_at: DateTime<Utc> = row.get("created_at");
    ChannelDto {
        id: row.get("id"),
        room_id: row.get("room_id"),
        category_name: row.get("category_name"),
        name: row.get("name"),
        topic: row.get("topic"),
        channel_type: row.get("channel_type"),
        position: row.get("position"),
        is_private: row.get("is_private"),
        slow_mode_seconds: row.get("slow_mode_seconds"),
        disappear_seconds: row.get("disappear_seconds"),
        created_at: created_at.to_rfc3339(),
    }
}

pub async fn broadcast_room_event(
    state: &AppState,
    room_id: Uuid,
    channel_id: Option<Uuid>,
    message_id: Option<Uuid>,
    actor_device_id: Uuid,
    event_type: &str,
    encrypted_payload: Option<Vec<u8>>,
) -> Result<i64, CloakError> {
    let mut tx = state.db.begin().await?;
    let seq: i64 = sqlx::query_scalar(
        "UPDATE rooms SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING next_event_seq",
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    let event_id = Uuid::new_v4();
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO message_events (id, room_id, channel_id, message_id, actor_device_id, event_seq, event_type, encrypted_payload, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(event_id)
    .bind(room_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(actor_device_id)
    .bind(seq)
    .bind(event_type)
    .bind(&encrypted_payload)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let ws_msg = serde_json::json!({
        "type": "event",
        "event": {
            "id": event_id,
            "roomId": room_id,
            "channelId": channel_id,
            "messageId": message_id,
            "actorDeviceId": actor_device_id,
            "eventSeq": seq,
            "eventType": event_type,
            "encryptedPayloadB64": encrypted_payload.map(|b| B64_STD.encode(b)),
            "createdAt": now.to_rfc3339(),
        }
    });
    state
        .ws_hub
        .broadcast_room(room_id, ws_msg.to_string())
        .await;
    Ok(seq)
}
