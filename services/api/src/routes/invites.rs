use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64_STD};
use chrono::{DateTime, Duration, Utc};
use cloak_core::{
    auth::{
        decode_base64_any, decode_base64_exact, hash_invite_password, sha256_bytes,
        verify_invite_password,
    },
    error::CloakError,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    authz::require_permission,
    error::ApiError,
    extractors::AuthenticatedDevice,
    routes::rooms::{EpochEnvelopeInput, RoomDetailDto, broadcast_room_event, fetch_room_detail},
    state::AppState,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteRequest {
    pub invite_token: String,
    pub role_name: Option<String>,
    pub access_scope: Option<String>,
    pub requires_approval: Option<bool>,
    pub password: Option<String>,
    pub wrapped_epoch: i64,
    pub wrapped_room_key_blob_b64: String,
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteSummaryDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub role_name: String,
    pub access_scope: String,
    pub requires_approval: bool,
    pub has_password: bool,
    pub wrapped_epoch: i64,
    pub max_uses: Option<i32>,
    pub uses_count: i32,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct InspectInviteQuery {
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInspectionDto {
    pub invite_id: Uuid,
    pub room_id: Uuid,
    pub room_name: String,
    pub room_kind: String,
    pub role_name: String,
    pub access_scope: String,
    pub requires_approval: bool,
    pub has_password: bool,
    pub wrapped_epoch: i64,
    pub wrapped_room_key_blob_b64: String,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInviteRequest {
    pub token: String,
    pub password: Option<String>,
    pub self_wrapped_epoch_key_b64: Option<String>,
    pub x25519_public_key_b64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInviteResponseDto {
    pub status: String, // active | pending_approval
    pub room_id: Uuid,
    pub room_detail: Option<RoomDetailDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveMemberRequest {
    pub sender_x25519_public_key_b64: String,
    pub envelopes: Vec<EpochEnvelopeInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberRoleRequest {
    pub role_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveMemberRequest {
    pub action: String, // kick | ban
    pub sender_x25519_public_key_b64: Option<String>,
    pub rotated_envelopes: Option<Vec<EpochEnvelopeInput>>,
}

pub async fn create_invite(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Json(req): Json<CreateInviteRequest>,
) -> Result<Json<InviteSummaryDto>, ApiError> {
    let ctx = require_permission(&state.db, room_id, auth.device_id, "manage_invites").await?;
    if req.invite_token.len() < 16 || req.invite_token.len() > 256 {
        return Err(ApiError(CloakError::BadRequest(
            "inviteToken must be 16..256 chars".into(),
        )));
    }
    let role_name = req.role_name.unwrap_or_else(|| "member".to_string());
    if !matches!(role_name.as_str(), "admin" | "member" | "readonly") {
        return Err(ApiError(CloakError::BadRequest(
            "invite roleName must be admin, member, or readonly".into(),
        )));
    }
    if role_name == "admin" && ctx.role_name != "owner" {
        return Err(ApiError(CloakError::Forbidden(
            "only room owner can mint admin invitations".into(),
        )));
    }

    let access_scope = req.access_scope.unwrap_or_else(|| {
        if role_name == "readonly" {
            "read_only".to_string()
        } else {
            "read_write".to_string()
        }
    });
    if !matches!(access_scope.as_str(), "read_only" | "read_write") {
        return Err(ApiError(CloakError::BadRequest(
            "invalid accessScope".into(),
        )));
    }

    let effective_role_name = if access_scope == "read_only" {
        "readonly"
    } else {
        role_name.as_str()
    };

    let role_id: Uuid = sqlx::query_scalar("SELECT id FROM roles WHERE room_id = $1 AND name = $2")
        .bind(room_id)
        .bind(effective_role_name)
        .fetch_one(&state.db)
        .await?;

    let token_hash = sha256_bytes(req.invite_token.as_bytes());
    let wrapped_blob =
        decode_base64_any(&req.wrapped_room_key_blob_b64, 512, "wrappedRoomKeyBlobB64")?;
    let password_hash = match req
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(pw) => Some(hash_invite_password(pw)?),
        None => None,
    };
    let expires_at = req
        .expires_in_hours
        .map(|h| Utc::now() + Duration::hours(h.max(1)));
    let invite_id = Uuid::new_v4();

    let row = sqlx::query(
        r#"
        INSERT INTO invitations (
            id, room_id, created_by_device_id, token_hash, role_id, access_scope,
            requires_approval, password_hash, wrapped_epoch, wrapped_room_key_blob,
            max_uses, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, room_id, access_scope, requires_approval, (password_hash IS NOT NULL) AS has_password,
                  wrapped_epoch, max_uses, uses_count, expires_at, revoked_at, created_at
        "#,
    )
    .bind(invite_id)
    .bind(room_id)
    .bind(auth.device_id)
    .bind(&token_hash)
    .bind(role_id)
    .bind(&access_scope)
    .bind(req.requires_approval.unwrap_or(false))
    .bind(&password_hash)
    .bind(req.wrapped_epoch)
    .bind(&wrapped_blob)
    .bind(req.max_uses)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await
    .map_err(|err| match &err {
        sqlx::Error::Database(db_err) if db_err.code().as_deref() == Some("23505") => {
            ApiError(CloakError::Conflict("invitation token already exists".into()))
        }
        _ => ApiError::from(err),
    })?;

    Ok(Json(row_to_invite(row, effective_role_name.to_string())))
}

pub async fn list_invites(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
) -> Result<Json<Vec<InviteSummaryDto>>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_invites").await?;
    let rows = sqlx::query(
        r#"
        SELECT i.id, i.room_id, r.name AS role_name, i.access_scope, i.requires_approval,
               (i.password_hash IS NOT NULL) AS has_password, i.wrapped_epoch,
               i.max_uses, i.uses_count, i.expires_at, i.revoked_at, i.created_at
        FROM invitations i
        JOIN roles r ON r.id = i.role_id
        WHERE i.room_id = $1
        ORDER BY i.created_at DESC
        "#,
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let rn: String = row.get("role_name");
                row_to_invite(row, rn)
            })
            .collect(),
    ))
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, invite_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_invites").await?;
    let res = sqlx::query(
        "UPDATE invitations SET revoked_at = NOW(), revoked_by_device_id = $3 WHERE id = $1 AND room_id = $2 AND revoked_at IS NULL",
    )
    .bind(invite_id)
    .bind(room_id)
    .bind(auth.device_id)
    .execute(&state.db)
    .await?;

    if res.rows_affected() == 0 {
        return Err(ApiError(CloakError::NotFound(
            "invite not found or already revoked".into(),
        )));
    }
    Ok(Json(serde_json::json!({ "revoked": true })))
}

pub async fn inspect_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<InspectInviteQuery>,
) -> Result<Json<InviteInspectionDto>, ApiError> {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("local");
    state
        .state_store
        .enforce_rate_limit(&format!("invite-inspect:{ip}"), 30, 0.5, 60)
        .await?;

    let token_hash = sha256_bytes(q.token.trim().as_bytes());
    let row = sqlx::query(
        r#"
        SELECT i.id AS invite_id, i.room_id, rm.name AS room_name, rm.room_kind,
               r.name AS role_name, i.access_scope, i.requires_approval,
               (i.password_hash IS NOT NULL) AS has_password,
               i.wrapped_epoch, i.wrapped_room_key_blob, i.max_uses, i.uses_count,
               i.expires_at, i.revoked_at
        FROM invitations i
        JOIN rooms rm ON rm.id = i.room_id
        JOIN roles r ON r.id = i.role_id
        WHERE i.token_hash = $1 AND rm.deleted_at IS NULL
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("invitation not found".into()))?;

    validate_invite_row(&row)?;

    let requires_approval: bool = row.get("requires_approval");
    let blob: Vec<u8> = row.get("wrapped_room_key_blob");
    let exp: Option<DateTime<Utc>> = row.get("expires_at");
    Ok(Json(InviteInspectionDto {
        invite_id: row.get("invite_id"),
        room_id: row.get("room_id"),
        room_name: row.get("room_name"),
        room_kind: row.get("room_kind"),
        role_name: row.get("role_name"),
        access_scope: row.get("access_scope"),
        requires_approval,
        has_password: row.get("has_password"),
        wrapped_epoch: row.get("wrapped_epoch"),
        wrapped_room_key_blob_b64: if requires_approval {
            String::new()
        } else {
            B64_STD.encode(blob)
        },
        expires_at: exp.map(|d| d.to_rfc3339()),
    }))
}

pub async fn join_invite(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    headers: HeaderMap,
    Json(req): Json<JoinInviteRequest>,
) -> Result<Json<JoinInviteResponseDto>, ApiError> {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("local");
    let cap = state.config.rate_limits.join_per_min;
    state
        .state_store
        .enforce_rate_limit(
            &format!("join:{ip}:{}", auth.device_id),
            cap,
            cap as f64 / 60.0,
            60,
        )
        .await?;

    let token_hash = sha256_bytes(req.token.trim().as_bytes());
    let mut tx = state.db.begin().await?;

    let row = sqlx::query(
        r#"
        SELECT i.id AS invite_id, i.room_id, i.role_id, i.requires_approval, i.password_hash,
               i.wrapped_epoch, i.max_uses, i.uses_count, i.expires_at, i.revoked_at,
               rm.owner_device_id
        FROM invitations i
        JOIN rooms rm ON rm.id = i.room_id
        WHERE i.token_hash = $1 AND rm.deleted_at IS NULL
        FOR UPDATE OF i
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloakError::NotFound("invitation not found".into()))?;

    validate_invite_row(&row)?;

    if let Some(pw_hash) = row.get::<Option<String>, _>("password_hash") {
        let supplied = req
            .password
            .as_deref()
            .ok_or_else(|| CloakError::Unauthorized("invitation requires a password".into()))?;
        if !verify_invite_password(supplied, &pw_hash)? {
            return Err(ApiError(CloakError::Unauthorized(
                "incorrect invitation password".into(),
            )));
        }
    }

    let room_id: Uuid = row.get("room_id");
    let invite_id: Uuid = row.get("invite_id");
    let role_id: Uuid = row.get("role_id");
    let requires_approval: bool = row.get("requires_approval");
    let wrapped_epoch: i64 = row.get("wrapped_epoch");

    let existing_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM memberships WHERE room_id = $1 AND device_id = $2")
            .bind(room_id)
            .bind(auth.device_id)
            .fetch_optional(&mut *tx)
            .await?;

    if matches!(existing_status.as_deref(), Some("banned")) {
        return Err(ApiError(CloakError::Forbidden(
            "this device is banned from the room".into(),
        )));
    }

    if existing_status.as_deref() != Some("active") {
        sqlx::query("UPDATE invitations SET uses_count = uses_count + 1 WHERE id = $1")
            .bind(invite_id)
            .execute(&mut *tx)
            .await?;
    }

    let target_status = if existing_status.as_deref() == Some("active") {
        "active"
    } else if requires_approval {
        "pending_approval"
    } else {
        "active"
    };

    sqlx::query(
        r#"
        INSERT INTO memberships (id, room_id, device_id, role_id, status)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (room_id, device_id) DO UPDATE SET
            role_id = EXCLUDED.role_id,
            status = CASE WHEN memberships.status = 'active' THEN 'active' ELSE EXCLUDED.status END,
            removed_at = NULL,
            removed_by_device_id = NULL,
            updated_at = NOW()
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(room_id)
    .bind(auth.device_id)
    .bind(role_id)
    .bind(target_status)
    .execute(&mut *tx)
    .await?;

    if target_status == "active"
        && let (Some(wrapped_b64), Some(x_pk_b64)) =
            (&req.self_wrapped_epoch_key_b64, &req.x25519_public_key_b64)
    {
        let wrapped = decode_base64_any(wrapped_b64, 512, "selfWrappedEpochKeyB64")?;
        let x_pk = decode_base64_exact(x_pk_b64, 32, "x25519PublicKeyB64")?;
        sqlx::query(
            r#"
                INSERT INTO epoch_key_envelopes (id, room_id, epoch, recipient_device_id, sender_device_id, sender_x25519_public_key, wrapped_key_ciphertext)
                VALUES ($1, $2, $3, $4, $4, $5, $6)
                ON CONFLICT (room_id, epoch, recipient_device_id) DO NOTHING
                "#,
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(wrapped_epoch)
        .bind(auth.device_id)
        .bind(&x_pk)
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
        "member.updated",
        None,
    )
    .await?;

    let room_detail = if target_status == "active" {
        Some(fetch_room_detail(&state.db, room_id, auth.device_id).await?)
    } else {
        None
    };

    Ok(Json(JoinInviteResponseDto {
        status: target_status.to_string(),
        room_id,
        room_detail,
    }))
}

pub async fn approve_member(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, target_device_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<ApproveMemberRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "manage_members").await?;
    let sender_x_pk = decode_base64_exact(
        &req.sender_x25519_public_key_b64,
        32,
        "senderX25519PublicKeyB64",
    )?;

    let mut tx = state.db.begin().await?;
    let res = sqlx::query(
        "UPDATE memberships SET status = 'active', updated_at = NOW() WHERE room_id = $1 AND device_id = $2 AND status = 'pending_approval'",
    )
    .bind(room_id)
    .bind(target_device_id)
    .execute(&mut *tx)
    .await?;

    if res.rows_affected() == 0 {
        return Err(ApiError(CloakError::NotFound(
            "no pending approval for device".into(),
        )));
    }

    let current_epoch: i64 = sqlx::query_scalar("SELECT current_epoch FROM rooms WHERE id = $1")
        .bind(room_id)
        .fetch_one(&mut *tx)
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
        .bind(current_epoch)
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
        "member.updated",
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "approved": true })))
}

pub async fn update_member_role(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, target_device_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateMemberRoleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ctx = require_permission(&state.db, room_id, auth.device_id, "manage_members").await?;
    if target_device_id == ctx.owner_device_id {
        return Err(ApiError(CloakError::Forbidden(
            "cannot alter room owner role".into(),
        )));
    }
    if !matches!(req.role_name.as_str(), "admin" | "member" | "readonly") {
        return Err(ApiError(CloakError::BadRequest("invalid roleName".into())));
    }
    if req.role_name == "admin" && auth.device_id != ctx.owner_device_id {
        return Err(ApiError(CloakError::Forbidden(
            "only owner may promote to admin".into(),
        )));
    }

    let role_id: Uuid = sqlx::query_scalar("SELECT id FROM roles WHERE room_id = $1 AND name = $2")
        .bind(room_id)
        .bind(&req.role_name)
        .fetch_one(&state.db)
        .await?;

    sqlx::query("UPDATE memberships SET role_id = $3, updated_at = NOW() WHERE room_id = $1 AND device_id = $2")
        .bind(room_id)
        .bind(target_device_id)
        .bind(role_id)
        .execute(&state.db)
        .await?;

    broadcast_room_event(
        &state,
        room_id,
        None,
        None,
        auth.device_id,
        "member.updated",
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "updated": true })))
}

pub async fn remove_member(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, target_device_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<RemoveMemberRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ctx = require_permission(&state.db, room_id, auth.device_id, "manage_members").await?;
    if target_device_id == ctx.owner_device_id {
        return Err(ApiError(CloakError::Forbidden(
            "cannot remove or ban room owner".into(),
        )));
    }
    let next_status = match req.action.as_str() {
        "kick" => "removed",
        "ban" => "banned",
        _ => {
            return Err(ApiError(CloakError::BadRequest(
                "action must be kick or ban".into(),
            )));
        }
    };

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE memberships SET status = $3, removed_at = NOW(), removed_by_device_id = $4, updated_at = NOW() WHERE room_id = $1 AND device_id = $2",
    )
    .bind(room_id)
    .bind(target_device_id)
    .bind(next_status)
    .bind(auth.device_id)
    .execute(&mut *tx)
    .await?;

    let mut new_epoch = ctx.current_epoch;
    if let (Some(spk_b64), Some(envelopes)) =
        (&req.sender_x25519_public_key_b64, &req.rotated_envelopes)
    {
        let sender_x_pk = decode_base64_exact(spk_b64, 32, "senderX25519PublicKeyB64")?;
        new_epoch = sqlx::query_scalar(
            "UPDATE rooms SET current_epoch = current_epoch + 1, updated_at = NOW() WHERE id = $1 RETURNING current_epoch",
        )
        .bind(room_id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO room_encryption_epochs (room_id, epoch, created_by_device_id, reason) VALUES ($1, $2, $3, 'member_removed')",
        )
        .bind(room_id)
        .bind(new_epoch)
        .bind(auth.device_id)
        .execute(&mut *tx)
        .await?;

        for env in envelopes {
            if env.recipient_device_id == target_device_id {
                continue;
            }
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
    }

    tx.commit().await?;

    // Kick from any active LiveKit call session
    let lk_rooms: Vec<String> = sqlx::query_scalar(
        "SELECT livekit_room_name FROM call_sessions WHERE room_id = $1 AND ended_at IS NULL",
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await?;
    for lk_room in lk_rooms {
        state
            .livekit
            .remove_participant_best_effort(&lk_room, target_device_id)
            .await;
    }

    broadcast_room_event(
        &state,
        room_id,
        None,
        None,
        auth.device_id,
        "member.updated",
        None,
    )
    .await?;
    Ok(Json(
        serde_json::json!({ "status": next_status, "epoch": new_epoch }),
    ))
}

fn validate_invite_row(row: &sqlx::postgres::PgRow) -> Result<(), CloakError> {
    if row.get::<Option<DateTime<Utc>>, _>("revoked_at").is_some() {
        return Err(CloakError::Forbidden("invitation has been revoked".into()));
    }
    if let Some(exp) = row.get::<Option<DateTime<Utc>>, _>("expires_at")
        && exp <= Utc::now()
    {
        return Err(CloakError::Forbidden("invitation has expired".into()));
    }
    if let Some(max_uses) = row.get::<Option<i32>, _>("max_uses") {
        let uses: i32 = row.get("uses_count");
        if uses >= max_uses {
            return Err(CloakError::Forbidden(
                "invitation usage limit reached".into(),
            ));
        }
    }
    Ok(())
}

fn row_to_invite(row: sqlx::postgres::PgRow, role_name: String) -> InviteSummaryDto {
    let exp: Option<DateTime<Utc>> = row.get("expires_at");
    let rev: Option<DateTime<Utc>> = row.get("revoked_at");
    let created: DateTime<Utc> = row.get("created_at");
    InviteSummaryDto {
        id: row.get("id"),
        room_id: row.get("room_id"),
        role_name,
        access_scope: row.get("access_scope"),
        requires_approval: row.get("requires_approval"),
        has_password: row.get("has_password"),
        wrapped_epoch: row.get("wrapped_epoch"),
        max_uses: row.get("max_uses"),
        uses_count: row.get("uses_count"),
        expires_at: exp.map(|d| d.to_rfc3339()),
        revoked_at: rev.map(|d| d.to_rfc3339()),
        created_at: created.to_rfc3339(),
    }
}
