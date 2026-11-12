use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::HeaderMap,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64_STD};
use chrono::{Duration, Utc};
use cloak_core::{
    auth::{decode_base64_any, decode_base64_exact, issue_session_jwt, verify_ed25519_signature},
    error::CloakError,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{error::ApiError, extractors::AuthenticatedDevice, state::AppState};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceRequest {
    pub device_id: Uuid,
    pub ed25519_public_key_b64: String,
    pub x25519_public_key_b64: String,
    pub display_name: Option<String>,
    pub avatar_color: Option<String>,
    pub avatar_emoji: Option<String>,
    pub signature_b64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfileDto {
    pub id: Uuid,
    pub ed25519_public_key_b64: String,
    pub x25519_public_key_b64: String,
    pub display_name: String,
    pub avatar_color: String,
    pub avatar_emoji: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionResponseDto {
    pub access_token: String,
    pub expires_at: String,
    pub device: DeviceProfileDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeRequest {
    pub device_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeResponseDto {
    pub challenge_id: Uuid,
    pub nonce_b64: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub device_id: Uuid,
    pub challenge_id: Uuid,
    pub signature_b64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub avatar_color: Option<String>,
    pub avatar_emoji: Option<String>,
}

fn client_ip_key(headers: &HeaderMap, addr: Option<&ConnectInfo<SocketAddr>>) -> String {
    if let Some(fwd) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return fwd.to_string();
    }
    addr.map(|a| a.0.ip().to_string())
        .unwrap_or_else(|| "local".into())
}

fn sanitize_display_name(raw: Option<String>) -> String {
    let trimmed = raw.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        "Anonymous".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn sanitize_color(raw: Option<String>) -> String {
    let s = raw.unwrap_or_else(|| "#7c6cff".to_string());
    if s.starts_with('#')
        && (s.len() == 4 || s.len() == 7)
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        s
    } else {
        "#7c6cff".to_string()
    }
}

pub async fn register_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RegisterDeviceRequest>,
) -> Result<Json<AuthSessionResponseDto>, ApiError> {
    let ip = client_ip_key(&headers, None);
    state
        .state_store
        .enforce_rate_limit(&format!("register:ip:{ip}"), 10, 10.0 / 60.0, 120)
        .await?;

    let ed_pk = decode_base64_exact(&req.ed25519_public_key_b64, 32, "ed25519PublicKeyB64")?;
    let x_pk = decode_base64_exact(&req.x25519_public_key_b64, 32, "x25519PublicKeyB64")?;
    let sig = decode_base64_exact(&req.signature_b64, 64, "signatureB64")?;

    let canonical = format!(
        "cloak-register-v1:{}:{}:{}",
        req.device_id, req.ed25519_public_key_b64, req.x25519_public_key_b64
    );
    verify_ed25519_signature(&ed_pk, canonical.as_bytes(), &sig)?;

    let display_name = sanitize_display_name(req.display_name);
    let avatar_color = sanitize_color(req.avatar_color);
    let avatar_emoji = req
        .avatar_emoji
        .map(|e| e.chars().take(8).collect::<String>())
        .filter(|s| !s.is_empty());

    let row = sqlx::query(
        r#"
        INSERT INTO device_identities (id, ed25519_public_key, x25519_public_key, display_name, avatar_color, avatar_emoji)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
            last_seen_at = NOW()
        WHERE device_identities.ed25519_public_key = $2
        RETURNING id, ed25519_public_key, x25519_public_key, display_name, avatar_color, avatar_emoji, created_at
        "#,
    )
    .bind(req.device_id)
    .bind(&ed_pk)
    .bind(&x_pk)
    .bind(&display_name)
    .bind(&avatar_color)
    .bind(&avatar_emoji)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloakError::Conflict("device ID already bound to a different cryptographic key".into()))?;

    let (token, _jti, expires_at) =
        issue_session_jwt(req.device_id, &state.config.session_jwt_secret, 12)?;

    Ok(Json(AuthSessionResponseDto {
        access_token: token,
        expires_at: expires_at.to_rfc3339(),
        device: row_to_device(row),
    }))
}

pub async fn create_challenge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponseDto>, ApiError> {
    let ip = client_ip_key(&headers, None);
    state
        .state_store
        .enforce_rate_limit(
            &format!("auth-challenge:{ip}:{}", req.device_id),
            15,
            0.25,
            120,
        )
        .await?;

    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM device_identities WHERE id = $1)")
            .bind(req.device_id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(ApiError(CloakError::NotFound(
            "device identity not registered".into(),
        )));
    }

    let mut nonce = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let challenge_id = Uuid::new_v4();
    let expires_at = Utc::now() + Duration::minutes(2);

    sqlx::query(
        "INSERT INTO auth_challenges (id, device_id, nonce, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(challenge_id)
    .bind(req.device_id)
    .bind(&nonce[..])
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    Ok(Json(ChallengeResponseDto {
        challenge_id,
        nonce_b64: B64_STD.encode(nonce),
        expires_at: expires_at.to_rfc3339(),
    }))
}

pub async fn exchange_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SessionRequest>,
) -> Result<Json<AuthSessionResponseDto>, ApiError> {
    let ip = client_ip_key(&headers, None);
    state
        .state_store
        .enforce_rate_limit(
            &format!("auth-session:{ip}:{}", req.device_id),
            10,
            10.0 / 60.0,
            120,
        )
        .await?;

    let sig = decode_base64_any(&req.signature_b64, 64, "signatureB64")?;
    if sig.len() != 64 {
        return Err(ApiError(CloakError::Unauthorized(
            "invalid signature length".into(),
        )));
    }

    let mut tx = state.db.begin().await?;
    let challenge_row = sqlx::query(
        r#"
        UPDATE auth_challenges
        SET used_at = NOW()
        WHERE id = $1 AND device_id = $2 AND used_at IS NULL AND expires_at > NOW()
        RETURNING nonce
        "#,
    )
    .bind(req.challenge_id)
    .bind(req.device_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        CloakError::Unauthorized("challenge missing, expired, or already used".into())
    })?;

    let nonce: Vec<u8> = challenge_row.get("nonce");
    let nonce_b64 = B64_STD.encode(&nonce);

    let device_row = sqlx::query(
        "UPDATE device_identities SET last_seen_at = NOW() WHERE id = $1 RETURNING id, ed25519_public_key, x25519_public_key, display_name, avatar_color, avatar_emoji, created_at",
    )
    .bind(req.device_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloakError::Unauthorized("unknown device".into()))?;

    let ed_pk: Vec<u8> = device_row.get("ed25519_public_key");
    let canonical = format!(
        "cloak-auth-v1:{}:{}:{}",
        req.challenge_id, nonce_b64, req.device_id
    );
    verify_ed25519_signature(&ed_pk, canonical.as_bytes(), &sig)?;

    tx.commit().await?;

    let (token, _jti, expires_at) =
        issue_session_jwt(req.device_id, &state.config.session_jwt_secret, 12)?;
    Ok(Json(AuthSessionResponseDto {
        access_token: token,
        expires_at: expires_at.to_rfc3339(),
        device: row_to_device(device_row),
    }))
}

pub async fn update_me(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
    Json(req): Json<UpdateProfileRequest>,
) -> Result<Json<DeviceProfileDto>, ApiError> {
    let row = sqlx::query(
        r#"
        UPDATE device_identities
        SET display_name = COALESCE($2, display_name),
            avatar_color = COALESCE($3, avatar_color),
            avatar_emoji = COALESCE($4, avatar_emoji),
            last_seen_at = NOW()
        WHERE id = $1
        RETURNING id, ed25519_public_key, x25519_public_key, display_name, avatar_color, avatar_emoji, created_at
        "#,
    )
    .bind(auth.device_id)
    .bind(req.display_name.map(|s| sanitize_display_name(Some(s))))
    .bind(req.avatar_color.map(|c| sanitize_color(Some(c))))
    .bind(req.avatar_emoji.map(|e| e.chars().take(8).collect::<String>()))
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row_to_device(row)))
}

pub async fn logout(
    State(state): State<AppState>,
    auth: AuthenticatedDevice,
) -> Result<Json<serde_json::Value>, ApiError> {
    let now_secs = Utc::now().timestamp() as usize;
    let remaining_ttl = auth.exp.saturating_sub(now_secs).max(60) as u64;
    state
        .state_store
        .revoke_jti(auth.jti, remaining_ttl)
        .await?;

    let exp_dt = chrono::DateTime::from_timestamp(auth.exp as i64, 0)
        .unwrap_or_else(|| Utc::now() + Duration::hours(12));
    sqlx::query(
        "INSERT INTO revoked_credentials (jti, device_id, reason, expires_at) VALUES ($1, $2, 'logout', $3) ON CONFLICT (jti) DO NOTHING",
    )
    .bind(auth.jti)
    .bind(auth.device_id)
    .bind(exp_dt)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "revoked": true })))
}

fn row_to_device(row: sqlx::postgres::PgRow) -> DeviceProfileDto {
    let ed_pk: Vec<u8> = row.get("ed25519_public_key");
    let x_pk: Vec<u8> = row.get("x25519_public_key");
    let created_at: chrono::DateTime<Utc> = row.get("created_at");
    DeviceProfileDto {
        id: row.get("id"),
        ed25519_public_key_b64: B64_STD.encode(ed_pk),
        x25519_public_key_b64: B64_STD.encode(x_pk),
        display_name: row.get("display_name"),
        avatar_color: row.get("avatar_color"),
        avatar_emoji: row.get("avatar_emoji"),
        created_at: created_at.to_rfc3339(),
    }
}
