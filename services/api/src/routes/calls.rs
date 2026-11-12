use axum::{
    Json,
    extract::{Path, State},
};
use serde::Serialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    authz::{has_permission, require_channel_access},
    error::ApiError,
    extractors::AuthenticatedDevice,
    state::AppState,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallTokenResponseDto {
    pub livekit_url: String,
    pub token: String,
    pub livekit_room_name: String,
    pub call_session_id: Uuid,
    pub e2ee_required: bool,
    pub expires_at: String,
}

pub async fn issue_call_token(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Path((room_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<CallTokenResponseDto>, ApiError> {
    let cap = state.config.rate_limits.call_per_min;
    state
        .state_store
        .enforce_rate_limit(
            &format!("call:{}:{room_id}", auth.device_id),
            cap,
            cap as f64 / 60.0,
            60,
        )
        .await?;

    let ch =
        require_channel_access(&state.db, room_id, channel_id, auth.device_id, false, true).await?;
    let can_publish = has_permission(&state.db, &ch.member, "connect_voice").await?;

    let display_name: String =
        sqlx::query_scalar("SELECT display_name FROM device_identities WHERE id = $1")
            .bind(auth.device_id)
            .fetch_one(&state.db)
            .await?;

    let livekit_room_name = format!("cloak-{room_id}-{channel_id}");
    let existing = sqlx::query(
        "SELECT id FROM call_sessions WHERE channel_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await?;

    let call_session_id = if let Some(row) = existing {
        row.get("id")
    } else {
        let sid = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO call_sessions (id, room_id, channel_id, livekit_room_name, started_by_device_id, e2ee_required) VALUES ($1, $2, $3, $4, $5, TRUE)",
        )
        .bind(sid)
        .bind(room_id)
        .bind(channel_id)
        .bind(&livekit_room_name)
        .bind(auth.device_id)
        .execute(&state.db)
        .await?;
        sid
    };

    let (token, expires_at) = state.livekit.create_participant_token(
        auth.device_id,
        &display_name,
        &livekit_room_name,
        can_publish,
    )?;

    Ok(Json(CallTokenResponseDto {
        livekit_url: state.livekit.ws_url.clone(),
        token,
        livekit_room_name,
        call_session_id,
        e2ee_required: true,
        expires_at: expires_at.to_rfc3339(),
    }))
}
