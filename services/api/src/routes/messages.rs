use axum::{
    Json,
    extract::{Path, Query, State},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64_STD};
use chrono::{DateTime, Duration, Utc};
use cloak_core::{auth::decode_base64_any, error::CloakError};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::{
    authz::{has_permission, require_active_member, require_channel_access, require_permission},
    error::ApiError,
    extractors::AuthenticatedDevice,
    routes::rooms::EpochKeyEnvelopeDto,
    state::AppState,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub message_id: Uuid,
    pub idempotency_key: Uuid,
    pub encryption_epoch: i64,
    pub ciphertext_b64: String,
    pub reply_to_message_id: Option<Uuid>,
    pub thread_root_id: Option<Uuid>,
    pub attachment_ids: Option<Vec<Uuid>>,
    pub expire_in_seconds: Option<i32>,
    pub expire_after_read_seconds: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditMessageRequest {
    pub ciphertext_b64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactMessageRequest {
    pub encrypted_payload_b64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub before_seq: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncQuery {
    pub after_seq: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    pub scope: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMessageDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub channel_id: Uuid,
    pub sender_device_id: Uuid,
    pub idempotency_key: Uuid,
    pub encryption_epoch: i64,
    pub event_seq: i64,
    pub ciphertext_b64: String,
    pub ciphertext_version: i16,
    pub reply_to_message_id: Option<Uuid>,
    pub thread_root_id: Option<Uuid>,
    pub edited_at: Option<String>,
    pub expires_at: Option<String>,
    pub expire_after_read_seconds: Option<i32>,
    pub deleted_for_everyone_at: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEventDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub channel_id: Option<Uuid>,
    pub message_id: Option<Uuid>,
    pub actor_device_id: Uuid,
    pub event_seq: i64,
    pub event_type: String,
    pub encrypted_payload_b64: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTombstoneDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub scope: String,
    pub target_device_id: Option<Uuid>,
    pub actor_device_id: Uuid,
    pub event_seq: i64,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSyncDto {
    pub room_id: Uuid,
    pub current_epoch: i64,
    pub latest_event_seq: i64,
    pub synced_at: String,
    pub events: Vec<MessageEventDto>,
    pub tombstones: Vec<MessageTombstoneDto>,
    pub pinned_message_ids: HashMap<Uuid, Vec<Uuid>>,
    pub epoch_envelopes: Vec<EpochKeyEnvelopeDto>,
}

pub async fn send_message(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<EncryptedMessageDto>, ApiError> {
    let rl = &state.config.rate_limits;
    state
        .state_store
        .enforce_rate_limit(
            &format!("msg:device:{}:room:{}", auth.device_id, room_id),
            rl.msg_burst,
            rl.msg_per_min as f64 / 60.0,
            60,
        )
        .await?;

    let ch =
        require_channel_access(&state.db, room_id, channel_id, auth.device_id, true, false).await?;

    if ch.slow_mode_seconds > 0 && ch.member.role_name != "owner" && ch.member.role_name != "admin"
    {
        let slow_key = format!("slowmode:{channel_id}:{}", auth.device_id);
        state
            .state_store
            .enforce_rate_limit(
                &slow_key,
                1,
                1.0 / ch.slow_mode_seconds as f64,
                ch.slow_mode_seconds as u64,
            )
            .await?;
    }

    let ciphertext = decode_base64_any(&req.ciphertext_b64, 65_536, "ciphertextB64")?;

    // Idempotency fast-path: if already committed by this device, return existing record
    if let Some(existing) = sqlx::query(
        r#"
        SELECT id, room_id, channel_id, sender_device_id, idempotency_key, encryption_epoch,
               event_seq, ciphertext, ciphertext_version, reply_to_message_id, thread_root_id,
               edited_at, expires_at, expire_after_read_seconds, deleted_for_everyone_at, created_at
        FROM encrypted_messages
        WHERE room_id = $1 AND sender_device_id = $2 AND idempotency_key = $3
        "#,
    )
    .bind(room_id)
    .bind(auth.device_id)
    .bind(req.idempotency_key)
    .fetch_optional(&state.db)
    .await?
    {
        return Ok(Json(row_to_message(existing)));
    }

    let ttl_secs = req.expire_in_seconds.or(ch.disappear_seconds);
    let expires_at = ttl_secs.map(|s| Utc::now() + Duration::seconds(s.max(5) as i64));

    let mut tx = state.db.begin().await?;
    let seq: i64 = sqlx::query_scalar(
        "UPDATE rooms SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING next_event_seq",
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    let now = Utc::now();
    let row = sqlx::query(
        r#"
        INSERT INTO encrypted_messages (
            id, room_id, channel_id, sender_device_id, idempotency_key, encryption_epoch,
            event_seq, ciphertext, ciphertext_version, reply_to_message_id, thread_root_id,
            expires_at, expire_after_read_seconds, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13)
        RETURNING id, room_id, channel_id, sender_device_id, idempotency_key, encryption_epoch,
                  event_seq, ciphertext, ciphertext_version, reply_to_message_id, thread_root_id,
                  edited_at, expires_at, expire_after_read_seconds, deleted_for_everyone_at, created_at
        "#,
    )
    .bind(req.message_id)
    .bind(room_id)
    .bind(channel_id)
    .bind(auth.device_id)
    .bind(req.idempotency_key)
    .bind(req.encryption_epoch)
    .bind(seq)
    .bind(&ciphertext)
    .bind(req.reply_to_message_id)
    .bind(req.thread_root_id)
    .bind(expires_at)
    .bind(req.expire_after_read_seconds)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    if let Some(att_ids) = &req.attachment_ids {
        for att_id in att_ids {
            let valid: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM encrypted_attachments WHERE id = $1 AND room_id = $2 AND state = 'uploaded')",
            )
            .bind(att_id)
            .bind(room_id)
            .fetch_one(&mut *tx)
            .await?;
            if !valid {
                return Err(ApiError(CloakError::BadRequest(
                    "referenced attachment is missing or not uploaded".into(),
                )));
            }
            sqlx::query(
                "INSERT INTO attachment_references (attachment_id, message_id, room_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(att_id)
            .bind(req.message_id)
            .bind(room_id)
            .execute(&mut *tx)
            .await?;

            if let Some(exp) = expires_at {
                sqlx::query("UPDATE encrypted_attachments SET expires_at = COALESCE(expires_at, $2) WHERE id = $1")
                    .bind(att_id)
                    .bind(exp)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    sqlx::query(
        r#"
        INSERT INTO message_events (id, room_id, channel_id, message_id, actor_device_id, event_seq, event_type, encrypted_payload, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'message.created', $7, $8)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(room_id)
    .bind(channel_id)
    .bind(req.message_id)
    .bind(auth.device_id)
    .bind(seq)
    .bind(&ciphertext)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let dto = row_to_message(row);
    let ws_msg = serde_json::json!({
        "type": "message.created",
        "message": &dto
    });
    state
        .ws_hub
        .broadcast_room(room_id, ws_msg.to_string())
        .await;

    Ok(Json(dto))
}

pub async fn get_channel_messages(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, channel_id)): Path<(Uuid, Uuid)>,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Vec<EncryptedMessageDto>>, ApiError> {
    let _ch = require_channel_access(&state.db, room_id, channel_id, auth.device_id, false, false)
        .await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let before_seq = q.before_seq.unwrap_or(i64::MAX);

    let rows = sqlx::query(
        r#"
        SELECT em.id, em.room_id, em.channel_id, em.sender_device_id, em.idempotency_key,
               em.encryption_epoch, em.event_seq, em.ciphertext, em.ciphertext_version,
               em.reply_to_message_id, em.thread_root_id, em.edited_at, em.expires_at,
               em.expire_after_read_seconds, em.deleted_for_everyone_at, em.created_at
        FROM encrypted_messages em
        WHERE em.room_id = $1
          AND em.channel_id = $2
          AND em.event_seq < $3
          AND em.deleted_for_everyone_at IS NULL
          AND (em.expires_at IS NULL OR em.expires_at > NOW())
          AND NOT EXISTS (
              SELECT 1 FROM message_tombstones mt
              WHERE mt.message_id = em.id
                AND (
                    (mt.scope = 'device' AND mt.target_device_id = $4)
                    OR mt.scope IN ('everyone', 'expired', 'burned', 'cleared')
                )
          )
        ORDER BY em.event_seq DESC
        LIMIT $5
        "#,
    )
    .bind(room_id)
    .bind(channel_id)
    .bind(before_seq)
    .bind(auth.device_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let mut msgs: Vec<EncryptedMessageDto> = rows.into_iter().map(row_to_message).collect();
    msgs.reverse();
    Ok(Json(msgs))
}

pub async fn edit_message(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, message_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<EditMessageRequest>,
) -> Result<Json<EncryptedMessageDto>, ApiError> {
    let rl = &state.config.rate_limits;
    state
        .state_store
        .enforce_rate_limit(
            &format!("editdel:{}:{}", auth.device_id, room_id),
            rl.edit_delete_per_min,
            rl.edit_delete_per_min as f64 / 60.0,
            60,
        )
        .await?;

    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let ciphertext = decode_base64_any(&req.ciphertext_b64, 65_536, "ciphertextB64")?;

    let mut tx = state.db.begin().await?;
    let msg_row = sqlx::query(
        r#"
        SELECT channel_id, sender_device_id, deleted_for_everyone_at, expires_at
        FROM encrypted_messages WHERE id = $1 AND room_id = $2 FOR UPDATE
        "#,
    )
    .bind(message_id)
    .bind(room_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloakError::NotFound("message not found".into()))?;

    let sender: Uuid = msg_row.get("sender_device_id");
    if sender != auth.device_id {
        return Err(ApiError(CloakError::Forbidden(
            "only the sender can edit a message".into(),
        )));
    }
    if msg_row
        .get::<Option<DateTime<Utc>>, _>("deleted_for_everyone_at")
        .is_some()
    {
        return Err(ApiError(CloakError::Conflict(
            "cannot edit deleted message".into(),
        )));
    }

    let channel_id: Uuid = msg_row.get("channel_id");
    let seq: i64 = sqlx::query_scalar(
        "UPDATE rooms SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING next_event_seq",
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    let now = Utc::now();
    let updated = sqlx::query(
        r#"
        UPDATE encrypted_messages
        SET ciphertext = $3, edited_at = $4
        WHERE id = $1 AND room_id = $2
        RETURNING id, room_id, channel_id, sender_device_id, idempotency_key, encryption_epoch,
                  event_seq, ciphertext, ciphertext_version, reply_to_message_id, thread_root_id,
                  edited_at, expires_at, expire_after_read_seconds, deleted_for_everyone_at, created_at
        "#,
    )
    .bind(message_id)
    .bind(room_id)
    .bind(&ciphertext)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    let ev_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO message_events (id, room_id, channel_id, message_id, actor_device_id, event_seq, event_type, encrypted_payload, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'message.edited', $7, $8)
        "#,
    )
    .bind(ev_id)
    .bind(room_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(auth.device_id)
    .bind(seq)
    .bind(&ciphertext)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let ws_ev = serde_json::json!({
        "type": "event",
        "event": {
            "id": ev_id,
            "roomId": room_id,
            "channelId": channel_id,
            "messageId": message_id,
            "actorDeviceId": auth.device_id,
            "eventSeq": seq,
            "eventType": "message.edited",
            "encryptedPayloadB64": B64_STD.encode(&ciphertext),
            "createdAt": now.to_rfc3339(),
        }
    });
    state
        .ws_hub
        .broadcast_room(room_id, ws_ev.to_string())
        .await;

    Ok(Json(row_to_message(updated)))
}

pub async fn delete_message(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, message_id)): Path<(Uuid, Uuid)>,
    Query(q): Query<DeleteQuery>,
) -> Result<Json<MessageTombstoneDto>, ApiError> {
    let rl = &state.config.rate_limits;
    state
        .state_store
        .enforce_rate_limit(
            &format!("editdel:{}:{}", auth.device_id, room_id),
            rl.edit_delete_per_min,
            rl.edit_delete_per_min as f64 / 60.0,
            60,
        )
        .await?;

    let ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let scope = q.scope.unwrap_or_else(|| "everyone".to_string());
    if !matches!(scope.as_str(), "me" | "everyone") {
        return Err(ApiError(CloakError::BadRequest(
            "scope must be 'me' or 'everyone'".into(),
        )));
    }

    let mut tx = state.db.begin().await?;
    let msg_row = sqlx::query(
        "SELECT channel_id, sender_device_id FROM encrypted_messages WHERE id = $1 AND room_id = $2",
    )
    .bind(message_id)
    .bind(room_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloakError::NotFound("message not found".into()))?;

    let channel_id: Uuid = msg_row.get("channel_id");
    let sender_id: Uuid = msg_row.get("sender_device_id");

    let db_scope = if scope == "me" { "device" } else { "everyone" };
    if db_scope == "everyone"
        && sender_id != auth.device_id
        && !has_permission(&state.db, &ctx, "manage_messages").await?
    {
        return Err(ApiError(CloakError::Forbidden(
            "only sender or moderator may delete for everyone".into(),
        )));
    }

    let seq: i64 = sqlx::query_scalar(
        "UPDATE rooms SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING next_event_seq",
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    let tombstone_id = Uuid::new_v4();
    let now = Utc::now();
    let target_device = if db_scope == "device" {
        Some(auth.device_id)
    } else {
        None
    };

    sqlx::query(
        r#"
        INSERT INTO message_tombstones (id, room_id, channel_id, message_id, scope, target_device_id, actor_device_id, event_seq, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(tombstone_id)
    .bind(room_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(db_scope)
    .bind(target_device)
    .bind(auth.device_id)
    .bind(seq)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let mut purge_keys = Vec::new();
    if db_scope == "everyone" {
        sqlx::query(
            "UPDATE encrypted_messages SET ciphertext = ''::bytea, deleted_for_everyone_at = $3, deleted_by_device_id = $4 WHERE id = $1 AND room_id = $2",
        )
        .bind(message_id)
        .bind(room_id)
        .bind(now)
        .bind(auth.device_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM channel_pins WHERE channel_id = $1 AND message_id = $2")
            .bind(channel_id)
            .bind(message_id)
            .execute(&mut *tx)
            .await?;

        let att_ids: Vec<Uuid> = sqlx::query_scalar(
            "DELETE FROM attachment_references WHERE message_id = $1 RETURNING attachment_id",
        )
        .bind(message_id)
        .fetch_all(&mut *tx)
        .await?;

        for att_id in att_ids {
            let still_referenced: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM attachment_references WHERE attachment_id = $1)",
            )
            .bind(att_id)
            .fetch_one(&mut *tx)
            .await?;
            if !still_referenced {
                sqlx::query(
                    "UPDATE encrypted_attachments SET state = 'deleted', deleted_at = $2, updated_at = $2 WHERE id = $1",
                )
                .bind(att_id)
                .bind(now)
                .execute(&mut *tx)
                .await?;

                let keys: Vec<String> = sqlx::query_scalar(
                    "SELECT object_key FROM attachment_chunks WHERE attachment_id = $1",
                )
                .bind(att_id)
                .fetch_all(&mut *tx)
                .await?;
                for key in keys {
                    sqlx::query(
                        "INSERT INTO retention_jobs (id, room_id, job_type, target_id, object_key) VALUES ($1, $2, 'purge_attachment_object', $3, $4)",
                    )
                    .bind(Uuid::new_v4())
                    .bind(room_id)
                    .bind(att_id)
                    .bind(&key)
                    .execute(&mut *tx)
                    .await?;
                    purge_keys.push(key);
                }
            }
        }

        sqlx::query(
            "INSERT INTO message_events (id, room_id, channel_id, message_id, actor_device_id, event_seq, event_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'message.deleted', $7)",
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(channel_id)
        .bind(message_id)
        .bind(auth.device_id)
        .bind(seq)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    for key in purge_keys {
        let _ = state.object_store.delete_object(&key).await;
    }

    let dto = MessageTombstoneDto {
        id: tombstone_id,
        room_id,
        channel_id,
        message_id,
        scope: db_scope.to_string(),
        target_device_id: target_device,
        actor_device_id: auth.device_id,
        event_seq: seq,
        created_at: now.to_rfc3339(),
    };

    if db_scope == "everyone" {
        let ws_msg = serde_json::json!({ "type": "tombstone", "tombstone": &dto });
        state
            .ws_hub
            .broadcast_room(room_id, ws_msg.to_string())
            .await;
    }

    Ok(Json(dto))
}

pub async fn clear_channel_messages(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_messages").await?;
    let mut tx = state.db.begin().await?;
    let now = Utc::now();

    let msg_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM encrypted_messages WHERE room_id = $1 AND channel_id = $2 AND deleted_for_everyone_at IS NULL",
    )
    .bind(room_id)
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await?;

    let mut last_seq = 0_i64;
    for mid in &msg_ids {
        last_seq = sqlx::query_scalar(
            "UPDATE rooms SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING next_event_seq",
        )
        .bind(room_id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO message_tombstones (id, room_id, channel_id, message_id, scope, actor_device_id, event_seq, created_at) VALUES ($1, $2, $3, $4, 'cleared', $5, $6, $7)",
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(channel_id)
        .bind(mid)
        .bind(auth.device_id)
        .bind(last_seq)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "UPDATE encrypted_messages SET ciphertext = ''::bytea, deleted_for_everyone_at = $3, deleted_by_device_id = $4 WHERE room_id = $1 AND channel_id = $2",
    )
    .bind(room_id)
    .bind(channel_id)
    .bind(now)
    .bind(auth.device_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM channel_pins WHERE channel_id = $1")
        .bind(channel_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let ws_msg = serde_json::json!({
        "type": "event",
        "event": {
            "id": Uuid::new_v4(),
            "roomId": room_id,
            "channelId": channel_id,
            "messageId": null,
            "actorDeviceId": auth.device_id,
            "eventSeq": last_seq,
            "eventType": "message.deleted",
            "encryptedPayloadB64": null,
            "createdAt": now.to_rfc3339(),
        }
    });
    state
        .ws_hub
        .broadcast_room(room_id, ws_msg.to_string())
        .await;

    Ok(Json(serde_json::json!({ "clearedCount": msg_ids.len() })))
}

pub async fn react_message(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, message_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<ReactMessageRequest>,
) -> Result<Json<MessageEventDto>, ApiError> {
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let payload = decode_base64_any(&req.encrypted_payload_b64, 4096, "encryptedPayloadB64")?;

    let channel_id: Uuid = sqlx::query_scalar(
        "SELECT channel_id FROM encrypted_messages WHERE id = $1 AND room_id = $2 AND deleted_for_everyone_at IS NULL",
    )
    .bind(message_id)
    .bind(room_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("message not found".into()))?;

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
        VALUES ($1, $2, $3, $4, $5, $6, 'message.reacted', $7, $8)
        "#,
    )
    .bind(event_id)
    .bind(room_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(auth.device_id)
    .bind(seq)
    .bind(&payload)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let dto = MessageEventDto {
        id: event_id,
        room_id,
        channel_id: Some(channel_id),
        message_id: Some(message_id),
        actor_device_id: auth.device_id,
        event_seq: seq,
        event_type: "message.reacted".to_string(),
        encrypted_payload_b64: Some(req.encrypted_payload_b64),
        created_at: now.to_rfc3339(),
    };
    let ws_msg = serde_json::json!({ "type": "event", "event": &dto });
    state
        .ws_hub
        .broadcast_room(room_id, ws_msg.to_string())
        .await;

    Ok(Json(dto))
}

pub async fn pin_message(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let channel_id: Uuid = sqlx::query_scalar(
        "SELECT channel_id FROM encrypted_messages WHERE id = $1 AND room_id = $2 AND deleted_for_everyone_at IS NULL",
    )
    .bind(message_id)
    .bind(room_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("message not found".into()))?;

    sqlx::query(
        "INSERT INTO channel_pins (channel_id, message_id, pinned_by_device_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(channel_id)
    .bind(message_id)
    .bind(auth.device_id)
    .execute(&state.db)
    .await?;

    crate::routes::rooms::broadcast_room_event(
        &state,
        room_id,
        Some(channel_id),
        Some(message_id),
        auth.device_id,
        "message.pinned",
        None,
    )
    .await?;

    Ok(Json(serde_json::json!({ "pinned": true })))
}

pub async fn unpin_message(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let channel_id: Option<Uuid> = sqlx::query_scalar(
        "DELETE FROM channel_pins WHERE message_id = $1 AND channel_id IN (SELECT id FROM channels WHERE room_id = $2) RETURNING channel_id",
    )
    .bind(message_id)
    .bind(room_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some(cid) = channel_id {
        crate::routes::rooms::broadcast_room_event(
            &state,
            room_id,
            Some(cid),
            Some(message_id),
            auth.device_id,
            "message.unpinned",
            None,
        )
        .await?;
    }

    Ok(Json(serde_json::json!({ "unpinned": true })))
}

pub async fn sync_room(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Query(q): Query<SyncQuery>,
) -> Result<Json<RoomSyncDto>, ApiError> {
    let ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let after_seq = q.after_seq.unwrap_or(0);
    let limit = q.limit.unwrap_or(500).clamp(1, 2000);

    let room_row = sqlx::query("SELECT current_epoch, next_event_seq FROM rooms WHERE id = $1")
        .bind(room_id)
        .fetch_one(&state.db)
        .await?;
    let latest_event_seq: i64 = room_row.get("next_event_seq");
    let current_epoch: i64 = room_row.get("current_epoch");

    let event_rows = sqlx::query(
        r#"
        SELECT id, room_id, channel_id, message_id, actor_device_id, event_seq, event_type, encrypted_payload, created_at
        FROM message_events
        WHERE room_id = $1 AND event_seq > $2
        ORDER BY event_seq ASC
        LIMIT $3
        "#,
    )
    .bind(room_id)
    .bind(after_seq)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let events = event_rows
        .into_iter()
        .map(|row| {
            let payload: Option<Vec<u8>> = row.get("encrypted_payload");
            let created: DateTime<Utc> = row.get("created_at");
            MessageEventDto {
                id: row.get("id"),
                room_id: row.get("room_id"),
                channel_id: row.get("channel_id"),
                message_id: row.get("message_id"),
                actor_device_id: row.get("actor_device_id"),
                event_seq: row.get("event_seq"),
                event_type: row.get("event_type"),
                encrypted_payload_b64: payload.map(|b| B64_STD.encode(b)),
                created_at: created.to_rfc3339(),
            }
        })
        .collect();

    let tomb_rows = sqlx::query(
        r#"
        SELECT id, room_id, channel_id, message_id, scope, target_device_id, actor_device_id, event_seq, created_at
        FROM message_tombstones
        WHERE room_id = $1 AND event_seq > $2
          AND (scope <> 'device' OR target_device_id = $3)
        ORDER BY event_seq ASC
        "#,
    )
    .bind(room_id)
    .bind(after_seq)
    .bind(auth.device_id)
    .fetch_all(&state.db)
    .await?;

    let tombstones = tomb_rows
        .into_iter()
        .map(|row| {
            let created: DateTime<Utc> = row.get("created_at");
            MessageTombstoneDto {
                id: row.get("id"),
                room_id: row.get("room_id"),
                channel_id: row.get("channel_id"),
                message_id: row.get("message_id"),
                scope: row.get("scope"),
                target_device_id: row.get("target_device_id"),
                actor_device_id: row.get("actor_device_id"),
                event_seq: row.get("event_seq"),
                created_at: created.to_rfc3339(),
            }
        })
        .collect();

    let pin_rows = sqlx::query(
        r#"
        SELECT cp.channel_id, cp.message_id
        FROM channel_pins cp
        JOIN channels c ON c.id = cp.channel_id
        WHERE c.room_id = $1
        ORDER BY cp.pinned_at DESC
        "#,
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await?;

    let mut pinned_message_ids: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for pr in pin_rows {
        let cid: Uuid = pr.get("channel_id");
        let mid: Uuid = pr.get("message_id");
        pinned_message_ids.entry(cid).or_default().push(mid);
    }

    let env_rows = sqlx::query(
        r#"
        SELECT id, room_id, epoch, recipient_device_id, sender_device_id, sender_x25519_public_key, wrapped_key_ciphertext
        FROM epoch_key_envelopes
        WHERE room_id = $1 AND recipient_device_id = $2
        ORDER BY epoch ASC
        "#,
    )
    .bind(room_id)
    .bind(ctx.device_id)
    .fetch_all(&state.db)
    .await?;

    let epoch_envelopes = env_rows
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

    Ok(Json(RoomSyncDto {
        room_id,
        current_epoch,
        latest_event_seq,
        synced_at: Utc::now().to_rfc3339(),
        events,
        tombstones,
        pinned_message_ids,
        epoch_envelopes,
    }))
}

fn row_to_message(row: sqlx::postgres::PgRow) -> EncryptedMessageDto {
    let ct: Vec<u8> = row.get("ciphertext");
    let edited_at: Option<DateTime<Utc>> = row.get("edited_at");
    let expires_at: Option<DateTime<Utc>> = row.get("expires_at");
    let deleted_at: Option<DateTime<Utc>> = row.get("deleted_for_everyone_at");
    let created_at: DateTime<Utc> = row.get("created_at");
    EncryptedMessageDto {
        id: row.get("id"),
        room_id: row.get("room_id"),
        channel_id: row.get("channel_id"),
        sender_device_id: row.get("sender_device_id"),
        idempotency_key: row.get("idempotency_key"),
        encryption_epoch: row.get("encryption_epoch"),
        event_seq: row.get("event_seq"),
        ciphertext_b64: B64_STD.encode(ct),
        ciphertext_version: row.get("ciphertext_version"),
        reply_to_message_id: row.get("reply_to_message_id"),
        thread_root_id: row.get("thread_root_id"),
        edited_at: edited_at.map(|d| d.to_rfc3339()),
        expires_at: expires_at.map(|d| d.to_rfc3339()),
        expire_after_read_seconds: row.get("expire_after_read_seconds"),
        deleted_for_everyone_at: deleted_at.map(|d| d.to_rfc3339()),
        created_at: created_at.to_rfc3339(),
    }
}
