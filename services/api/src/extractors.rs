use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{Method, header, request::Parts},
};
use cloak_core::{auth::verify_session_jwt, error::CloakError};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

#[derive(Debug, Clone)]
pub struct AuthenticatedDevice {
    pub device_id: Uuid,
    pub jti: Uuid,
    pub exp: usize,
}

impl FromRequestParts<AppState> for AuthenticatedDevice {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| CloakError::Unauthorized("missing Authorization header".into()))?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CloakError::Unauthorized("expected Bearer token".into()))?;

        verify_token_against_state(token, state)
            .await
            .map_err(ApiError)
    }
}

pub async fn verify_token_against_state(
    token: &str,
    state: &AppState,
) -> Result<AuthenticatedDevice, CloakError> {
    let (device_id, jti, exp) = verify_session_jwt(token, &state.config.session_jwt_secret)?;

    if state.state_store.is_jti_revoked(jti).await? {
        return Err(CloakError::Unauthorized(
            "session token has been revoked".into(),
        ));
    }

    let revoked_db: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM revoked_credentials WHERE jti = $1)")
            .bind(jti)
            .fetch_one(&state.db)
            .await?;

    if revoked_db {
        return Err(CloakError::Unauthorized(
            "session token has been revoked".into(),
        ));
    }

    let device_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM device_identities WHERE id = $1)")
            .bind(device_id)
            .fetch_one(&state.db)
            .await?;

    if !device_exists {
        return Err(CloakError::Unauthorized(
            "device identity not registered".into(),
        ));
    }

    Ok(AuthenticatedDevice {
        device_id,
        jti,
        exp,
    })
}

pub fn extract_client_ip(parts: &Parts) -> String {
    if let Some(fwd) = parts
        .headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return fwd.to_string();
    }
    if let Some(ConnectInfo(addr)) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
        return addr.ip().to_string();
    }
    "unknown".to_string()
}

pub fn validate_origin_headers(
    method: &Method,
    headers: &axum::http::HeaderMap,
    allowed_origins: &[String],
) -> Result<(), CloakError> {
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok())
        && site == "cross-site"
        && *method != Method::GET
    {
        // Allow explicitly configured cross-origin frontend dev/deploy origins via Origin check below
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        match origin {
            Some(o) if allowed_origins.iter().any(|a| a == o) => {}
            _ => {
                return Err(CloakError::Forbidden(
                    "cross-site mutation blocked by origin policy".into(),
                ));
            }
        }
    }

    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !allowed_origins.is_empty()
        && !allowed_origins.iter().any(|a| a == origin)
    {
        return Err(CloakError::Forbidden("origin not permitted".into()));
    }
    Ok(())
}
