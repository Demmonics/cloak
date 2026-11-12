use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64_STD, Engine as _};
use chrono::{DateTime, Utc};
use cloak_core::{auth::decode_base64_exact, error::CloakError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    authz::{has_permission, require_active_member, require_permission},
    error::ApiError,
    extractors::AuthenticatedDevice,
    state::AppState,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitAttachmentRequest {
    pub encryption_epoch: i64,
    pub expected_ciphertext_bytes: i64,
    pub chunk_size_bytes: i32,
    pub total_chunks: i32,
    pub stream_header_b64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMetadataDto {
    pub id: Uuid,
    pub room_id: Uuid,
    pub uploader_device_id: Uuid,
    pub encryption_epoch: i64,
    pub state: String,
    pub expected_ciphertext_bytes: i64,
    pub actual_ciphertext_bytes: i64,
    pub chunk_size_bytes: i32,
    pub total_chunks: i32,
    pub stream_header_b64: String,
    pub expires_at: Option<String>,
    pub deleted_at: Option<String>,
    pub created_at: String,
}

pub async fn init_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
    Json(req): Json<InitAttachmentRequest>,
) -> Result<Json<AttachmentMetadataDto>, ApiError> {
    let _ctx = require_permission(&state.db, room_id, auth.device_id, "attach_files").await?;
    if req.expected_ciphertext_bytes <= 0 || req.expected_ciphertext_bytes > state.config.max_attachment_bytes {
        return Err(ApiError(CloakError::PayloadTooLarge(format!(
            "attachment exceeds maximum size of {} bytes",
            state.config.max_attachment_bytes
        ))));
    }
    if req.total_chunks <= 0 || req.total_chunks > 1024 || req.chunk_size_bytes <= 0 || req.chunk_size_bytes > 4 * 1024 * 1024 {
        return Err(ApiError(CloakError::BadRequest("invalid chunk parameters".into())));
    }

    let quota_row = sqlx::query("SELECT quota_bytes, used_bytes FROM rooms WHERE id = $1")
        .bind(room_id)
        .fetch_one(&state.db)
        .await?;
    let quota: i64 = quota_row.get("quota_bytes");
    let used: i64 = quota_row.get("used_bytes");
    if used + req.expected_ciphertext_bytes > quota {
        return Err(ApiError(CloakError::PayloadTooLarge("room storage quota exceeded".into())));
    }

    state
        .state_store
        .acquire_upload_slot(auth.device_id, state.config.rate_limits.parallel_uploads_per_device)
        .await?;

    let stream_header = decode_base64_exact(&req.stream_header_b64, 24, "streamHeaderB64")?;
    let att_id = Uuid::new_v4();
    let object_key = format!("rooms/{room_id}/attachments/{att_id}");

    let row = sqlx::query(
        r#"
        INSERT INTO encrypted_attachments (
            id, room_id, uploader_device_id, encryption_epoch, state, object_key,
            expected_ciphertext_bytes, chunk_size_bytes, total_chunks, stream_header
        )
        VALUES ($1, $2, $3, $4, 'uploading', $5, $6, $7, $8, $9)
        RETURNING id, room_id, uploader_device_id, encryption_epoch, state,
                  expected_ciphertext_bytes, actual_ciphertext_bytes, chunk_size_bytes,
                  total_chunks, stream_header, expires_at, deleted_at, created_at
        "#,
    )
    .bind(att_id)
    .bind(room_id)
    .bind(auth.device_id)
    .bind(req.encryption_epoch)
    .bind(&object_key)
    .bind(req.expected_ciphertext_bytes)
    .bind(req.chunk_size_bytes)
    .bind(req.total_chunks)
    .bind(&stream_header)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(r) => Ok(Json(row_to_attachment(r))),
        Err(e) => {
            state.state_store.release_upload_slot(auth.device_id).await;
            Err(ApiError(e.into()))
        }
    }
}

pub async fn upload_chunk(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((attachment_id, chunk_index)): Path<(Uuid, i32)>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query(
        "SELECT room_id, uploader_device_id, state, total_chunks, chunk_size_bytes FROM encrypted_attachments WHERE id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("attachment not found".into()))?;

    let uploader: Uuid = row.get("uploader_device_id");
    let room_id: Uuid = row.get("room_id");
    let att_state: String = row.get("state");
    let total_chunks: i32 = row.get("total_chunks");
    if uploader != auth.device_id {
        return Err(ApiError(CloakError::Forbidden("only uploader may send chunks".into())));
    }
    if att_state != "uploading" {
        return Err(ApiError(CloakError::Conflict("attachment is not in uploading state".into())));
    }
    if chunk_index < 0 || chunk_index >= total_chunks {
        return Err(ApiError(CloakError::BadRequest("chunk index out of range".into())));
    }
    if body.is_empty() || body.len() > 5 * 1024 * 1024 {
        return Err(ApiError(CloakError::PayloadTooLarge("chunk size out of bounds".into())));
    }

    let chunk_key = format!("rooms/{room_id}/attachments/{attachment_id}/chunk_{chunk_index}.bin");
    let sha = Sha256::digest(&body).to_vec();
    let len = body.len() as i32;

    state.object_store.put_object(&chunk_key, body).await?;

    sqlx::query(
        r#"
        INSERT INTO attachment_chunks (attachment_id, chunk_index, object_key, byte_length, sha256)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (attachment_id, chunk_index) DO UPDATE SET byte_length = EXCLUDED.byte_length, sha256 = EXCLUDED.sha256, uploaded_at = NOW()
        "#,
    )
    .bind(attachment_id)
    .bind(chunk_index)
    .bind(&chunk_key)
    .bind(len)
    .bind(&sha)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "chunkIndex": chunk_index, "storedBytes": len })))
}

pub async fn complete_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(attachment_id): Path<Uuid>,
) -> Result<Json<AttachmentMetadataDto>, ApiError> {
    let row = sqlx::query(
        "SELECT room_id, uploader_device_id, total_chunks, expected_ciphertext_bytes FROM encrypted_attachments WHERE id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("attachment not found".into()))?;

    let uploader: Uuid = row.get("uploader_device_id");
    let room_id: Uuid = row.get("room_id");
    let total_chunks: i32 = row.get("total_chunks");
    if uploader != auth.device_id {
        return Err(ApiError(CloakError::Forbidden("not uploader".into())));
    }

    let agg = sqlx::query(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(byte_length), 0)::BIGINT AS total_bytes FROM attachment_chunks WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_one(&state.db)
    .await?;
    let cnt: i64 = agg.get("cnt");
    let total_bytes: i64 = agg.get("total_bytes");

    state.state_store.release_upload_slot(auth.device_id).await;

    if cnt != total_chunks as i64 {
        sqlx::query("UPDATE encrypted_attachments SET state = 'failed', updated_at = NOW() WHERE id = $1")
            .bind(attachment_id)
            .execute(&state.db)
            .await?;
        return Err(ApiError(CloakError::BadRequest(format!(
            "missing chunks: got {cnt} of {total_chunks}"
        ))));
    }

    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        r#"
        UPDATE encrypted_attachments
        SET state = 'uploaded', actual_ciphertext_bytes = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, room_id, uploader_device_id, encryption_epoch, state,
                  expected_ciphertext_bytes, actual_ciphertext_bytes, chunk_size_bytes,
                  total_chunks, stream_header, expires_at, deleted_at, created_at
        "#,
    )
    .bind(attachment_id)
    .bind(total_bytes)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("UPDATE rooms SET used_bytes = used_bytes + $2 WHERE id = $1")
        .bind(room_id)
        .bind(total_bytes)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(row_to_attachment(updated)))
}

pub async fn get_attachment_meta(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(attachment_id): Path<Uuid>,
) -> Result<Json<AttachmentMetadataDto>, ApiError> {
    let row = sqlx::query(
        r#"
        SELECT id, room_id, uploader_device_id, encryption_epoch, state,
               expected_ciphertext_bytes, actual_ciphertext_bytes, chunk_size_bytes,
               total_chunks, stream_header, expires_at, deleted_at, created_at
        FROM encrypted_attachments WHERE id = $1
        "#,
    )
    .bind(attachment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("attachment not found".into()))?;

    let room_id: Uuid = row.get("room_id");
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    Ok(Json(row_to_attachment(row)))
}

pub async fn list_room_attachments(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(room_id): Path<Uuid>,
) -> Result<Json<Vec<AttachmentMetadataDto>>, ApiError> {
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    let rows = sqlx::query(
        r#"
        SELECT id, room_id, uploader_device_id, encryption_epoch, state,
               expected_ciphertext_bytes, actual_ciphertext_bytes, chunk_size_bytes,
               total_chunks, stream_header, expires_at, deleted_at, created_at
        FROM encrypted_attachments
        WHERE room_id = $1 AND state = 'uploaded' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 200
        "#,
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(row_to_attachment).collect()))
}

pub async fn download_chunk(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((attachment_id, chunk_index)): Path<(Uuid, i32)>,
) -> Result<impl IntoResponse, ApiError> {
    let row = sqlx::query(
        "SELECT room_id, state, expires_at, deleted_at FROM encrypted_attachments WHERE id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("attachment not found".into()))?;

    let room_id: Uuid = row.get("room_id");
    let _ctx = require_active_member(&state.db, room_id, auth.device_id).await?;

    let att_state: String = row.get("state");
    let deleted_at: Option<DateTime<Utc>> = row.get("deleted_at");
    let expires_at: Option<DateTime<Utc>> = row.get("expires_at");
    if att_state != "uploaded" || deleted_at.is_some() || expires_at.is_some_and(|e| e <= Utc::now()) {
        return Err(ApiError(CloakError::NotFound("attachment is expired or deleted".into())));
    }

    let obj_key: String = sqlx::query_scalar(
        "SELECT object_key FROM attachment_chunks WHERE attachment_id = $1 AND chunk_index = $2",
    )
    .bind(attachment_id)
    .bind(chunk_index)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::NotFound("attachment chunk not found".into()))?;

    let data = state.object_store.get_object(&obj_key).await?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        data,
    ))
}

pub async fn delete_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path(attachment_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query("SELECT room_id, uploader_device_id, actual_ciphertext_bytes FROM encrypted_attachments WHERE id = $1")
        .bind(attachment_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| CloakError::NotFound("attachment not found".into()))?;

    let room_id: Uuid = row.get("room_id");
    let uploader: Uuid = row.get("uploader_device_id");
    let size: i64 = row.get("actual_ciphertext_bytes");

    let ctx = require_active_member(&state.db, room_id, auth.device_id).await?;
    if uploader != auth.device_id && !has_permission(&state.db, &ctx, "manage_messages").await? {
        return Err(ApiError(CloakError::Forbidden("not authorized to delete attachment".into())));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE encrypted_attachments SET state = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = $1")
        .bind(attachment_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE rooms SET used_bytes = GREATEST(0, used_bytes - $2) WHERE id = $1")
        .bind(room_id)
        .bind(size)
        .execute(&mut *tx)
        .await?;
    let keys: Vec<String> = sqlx::query_scalar("SELECT object_key FROM attachment_chunks WHERE attachment_id = $1")
        .bind(attachment_id)
        .fetch_all(&mut *tx)
        .await?;
    for key in &keys {
        sqlx::query(
            "INSERT INTO retention_jobs (id, room_id, job_type, target_id, object_key) VALUES ($1, $2, 'purge_attachment_object', $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(attachment_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    for key in keys {
        let _ = state.object_store.delete_object(&key).await;
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}

fn row_to_attachment(row: sqlx::postgres::PgRow) -> AttachmentMetadataDto {
    let sh: Vec<u8> = row.get("stream_header");
    let exp: Option<DateTime<Utc>> = row.get("expires_at");
    let del: Option<DateTime<Utc>> = row.get("deleted_at");
    let created: DateTime<Utc> = row.get("created_at");
    AttachmentMetadataDto {
        id: row.get("id"),
        room_id: row.get("room_id"),
        uploader_device_id: row.get("uploader_device_id"),
        encryption_epoch: row.get("encryption_epoch"),
        state: row.get("state"),
        expected_ciphertext_bytes: row.get("expected_ciphertext_bytes"),
        actual_ciphertext_bytes: row.get("actual_ciphertext_bytes"),
        chunk_size_bytes: row.get("chunk_size_bytes"),
        total_chunks: row.get("total_chunks"),
        stream_header_b64: B64_STD.encode(sh),
        expires_at: exp.map(|d| d.to_rfc3339()),
        deleted_at: del.map(|d| d.to_rfc3339()),
        created_at: created.to_rfc3339(),
    }
}

