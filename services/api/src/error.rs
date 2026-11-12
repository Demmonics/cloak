use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use cloak_core::error::CloakError;
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError(pub CloakError);

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_secs: Option<u64>,
}

impl From<CloakError> for ApiError {
    fn from(value: CloakError) -> Self {
        Self(value)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(value: sqlx::Error) -> Self {
        Self(CloakError::Database(value))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, msg, retry_after) = match self.0 {
            CloakError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m, None),
            CloakError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, "unauthorized", m, None),
            CloakError::Forbidden(m) => (StatusCode::FORBIDDEN, "forbidden", m, None),
            CloakError::NotFound(m) => (StatusCode::NOT_FOUND, "not_found", m, None),
            CloakError::Conflict(m) => (StatusCode::CONFLICT, "conflict", m, None),
            CloakError::PayloadTooLarge(m) => {
                (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", m, None)
            }
            CloakError::RateLimited { retry_after_secs } => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("Rate limit exceeded. Retry in {retry_after_secs}s."),
                Some(retry_after_secs),
            ),
            CloakError::Database(err) => {
                tracing::error!(error_kind = ?err, "database query failure");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Internal database error".to_string(),
                    None,
                )
            }
            CloakError::Internal(m) => {
                tracing::error!(detail = %m, "internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Internal server error".to_string(),
                    None,
                )
            }
        };

        let mut resp = (
            status,
            Json(ErrorBody {
                code,
                message: msg,
                retry_after_secs: retry_after,
            }),
        )
            .into_response();

        if let Some(secs) = retry_after
            && let Ok(val) = HeaderValue::from_str(&secs.to_string())
        {
            resp.headers_mut().insert(header::RETRY_AFTER, val);
        }
        resp
    }
}
