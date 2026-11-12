use std::env;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloakEnv {
    Development,
    Test,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectStoreBackend {
    S3,
    Local,
}

#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    pub msg_burst: u32,
    pub msg_per_min: u32,
    pub edit_delete_per_min: u32,
    pub join_per_min: u32,
    pub room_create_per_hour: u32,
    pub call_per_min: u32,
    pub parallel_uploads_per_device: u32,
    pub ws_max_payload_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub env: CloakEnv,
    pub api_host: String,
    pub api_port: u16,
    pub allowed_origins: Vec<String>,
    pub session_jwt_secret: String,
    pub database_url: String,
    pub database_max_connections: u32,
    pub redis_url: Option<String>,
    pub allow_in_memory_redis: bool,
    pub object_store_backend: ObjectStoreBackend,
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_access_key_id: String,
    pub s3_secret_access_key: String,
    pub s3_force_path_style: bool,
    pub local_object_store_dir: String,
    pub livekit_url: String,
    pub livekit_http_url: String,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub max_attachment_bytes: i64,
    pub room_quota_bytes: i64,
    pub retention_check_secs: u64,
    pub rate_limits: RateLimitConfig,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required environment variable: {0}")]
    Missing(&'static str),
    #[error("invalid environment value for {0}: {1}")]
    Invalid(&'static str, String),
    #[error("insecure configuration rejected in production: {0}")]
    InsecureProduction(&'static str),
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let env_str = env::var("CLOAK_ENV").unwrap_or_else(|_| "development".to_string());
        let env = match env_str.to_lowercase().as_str() {
            "production" | "prod" => CloakEnv::Production,
            "test" => CloakEnv::Test,
            "development" | "dev" => CloakEnv::Development,
            other => return Err(ConfigError::Invalid("CLOAK_ENV", other.to_string())),
        };

        let api_host = env::var("API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let api_port = parse_u16("API_PORT", 8080)?;
        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://127.0.0.1:5173,http://localhost:5173".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();

        let session_jwt_secret = env::var("SESSION_JWT_SECRET").unwrap_or_else(|_| {
            "dev-only-insecure-session-secret-change-in-production-min-32-bytes".to_string()
        });
        if session_jwt_secret.len() < 32 {
            return Err(ConfigError::Invalid(
                "SESSION_JWT_SECRET",
                "must be at least 32 bytes".to_string(),
            ));
        }

        let database_url =
            env::var("DATABASE_URL").map_err(|_| ConfigError::Missing("DATABASE_URL"))?;
        let database_max_connections = parse_u32("DATABASE_MAX_CONNECTIONS", 20)?;

        let redis_url = env::var("REDIS_URL").ok().filter(|s| !s.trim().is_empty());
        let allow_in_memory_redis = env::var("CLOAK_DEV_ALLOW_IN_MEMORY_REDIS")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let backend_str = env::var("OBJECT_STORE_BACKEND").unwrap_or_else(|_| "s3".to_string());
        let object_store_backend = match backend_str.to_lowercase().as_str() {
            "s3" => ObjectStoreBackend::S3,
            "local" => ObjectStoreBackend::Local,
            other => {
                return Err(ConfigError::Invalid(
                    "OBJECT_STORE_BACKEND",
                    other.to_string(),
                ));
            }
        };

        let s3_endpoint =
            env::var("S3_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:9000".to_string());
        let s3_region = env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let s3_bucket = env::var("S3_BUCKET").unwrap_or_else(|_| "cloak-attachments".to_string());
        let s3_access_key_id =
            env::var("S3_ACCESS_KEY_ID").unwrap_or_else(|_| "minioadmin".to_string());
        let s3_secret_access_key =
            env::var("S3_SECRET_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".to_string());
        let s3_force_path_style = env::var("S3_FORCE_PATH_STYLE")
            .map(|v| v != "false" && v != "0")
            .unwrap_or(true);
        let local_object_store_dir =
            env::var("LOCAL_OBJECT_STORE_DIR").unwrap_or_else(|_| ".cloak-dev/objects".to_string());

        let livekit_url =
            env::var("LIVEKIT_URL").unwrap_or_else(|_| "ws://127.0.0.1:7880".to_string());
        let livekit_http_url =
            env::var("LIVEKIT_HTTP_URL").unwrap_or_else(|_| "http://127.0.0.1:7880".to_string());
        let livekit_api_key = env::var("LIVEKIT_API_KEY").unwrap_or_else(|_| "devkey".to_string());
        let livekit_api_secret = env::var("LIVEKIT_API_SECRET").unwrap_or_else(|_| {
            "devsecret_must_be_at_least_32_characters_long_for_livekit".to_string()
        });

        let max_attachment_bytes = parse_i64("MAX_ATTACHMENT_BYTES", 25 * 1024 * 1024)?;
        let room_quota_bytes = parse_i64("ROOM_QUOTA_BYTES", 512 * 1024 * 1024)?;
        let retention_check_secs = parse_u64("DEFAULT_MESSAGE_RETENTION_CHECK_SECS", 15)?;

        let rate_limits = RateLimitConfig {
            msg_burst: parse_u32("RATE_LIMIT_MSG_BURST", 20)?,
            msg_per_min: parse_u32("RATE_LIMIT_MSG_PER_MIN", 120)?,
            edit_delete_per_min: parse_u32("RATE_LIMIT_EDIT_DELETE_PER_MIN", 30)?,
            join_per_min: parse_u32("RATE_LIMIT_JOIN_PER_MIN", 10)?,
            room_create_per_hour: parse_u32("RATE_LIMIT_ROOM_CREATE_PER_HOUR", 5)?,
            call_per_min: parse_u32("RATE_LIMIT_CALL_PER_MIN", 5)?,
            parallel_uploads_per_device: parse_u32("RATE_LIMIT_PARALLEL_UPLOADS", 3)?,
            ws_max_payload_bytes: parse_usize("WS_MAX_PAYLOAD_BYTES", 64 * 1024)?,
        };

        if env == CloakEnv::Production {
            if allow_in_memory_redis || redis_url.is_none() {
                return Err(ConfigError::InsecureProduction(
                    "REDIS_URL is required and CLOAK_DEV_ALLOW_IN_MEMORY_REDIS must be false in production",
                ));
            }
            if object_store_backend == ObjectStoreBackend::Local {
                return Err(ConfigError::InsecureProduction(
                    "OBJECT_STORE_BACKEND=local is prohibited in production",
                ));
            }
            if session_jwt_secret.contains("dev-only-insecure") {
                return Err(ConfigError::InsecureProduction(
                    "SESSION_JWT_SECRET must not use the dev default in production",
                ));
            }
            if livekit_api_secret.contains("devsecret") || livekit_api_secret.len() < 32 {
                return Err(ConfigError::InsecureProduction(
                    "LIVEKIT_API_SECRET must be a strong secret (>=32 chars) in production",
                ));
            }
            if s3_access_key_id == "minioadmin" && s3_secret_access_key == "minioadmin" {
                return Err(ConfigError::InsecureProduction(
                    "S3 credentials must not use minioadmin defaults in production",
                ));
            }
        } else if redis_url.is_none() && !allow_in_memory_redis {
            return Err(ConfigError::Missing(
                "REDIS_URL (or set CLOAK_DEV_ALLOW_IN_MEMORY_REDIS=true for single-node local dev)",
            ));
        }

        Ok(Self {
            env,
            api_host,
            api_port,
            allowed_origins,
            session_jwt_secret,
            database_url,
            database_max_connections,
            redis_url,
            allow_in_memory_redis,
            object_store_backend,
            s3_endpoint,
            s3_region,
            s3_bucket,
            s3_access_key_id,
            s3_secret_access_key,
            s3_force_path_style,
            local_object_store_dir,
            livekit_url,
            livekit_http_url,
            livekit_api_key,
            livekit_api_secret,
            max_attachment_bytes,
            room_quota_bytes,
            retention_check_secs,
            rate_limits,
        })
    }
}

fn parse_u16(key: &'static str, default: u16) -> Result<u16, ConfigError> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.parse::<u16>().map_err(|_| ConfigError::Invalid(key, v)),
        _ => Ok(default),
    }
}

fn parse_u32(key: &'static str, default: u32) -> Result<u32, ConfigError> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.parse::<u32>().map_err(|_| ConfigError::Invalid(key, v)),
        _ => Ok(default),
    }
}

fn parse_u64(key: &'static str, default: u64) -> Result<u64, ConfigError> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.parse::<u64>().map_err(|_| ConfigError::Invalid(key, v)),
        _ => Ok(default),
    }
}

fn parse_i64(key: &'static str, default: i64) -> Result<i64, ConfigError> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.parse::<i64>().map_err(|_| ConfigError::Invalid(key, v)),
        _ => Ok(default),
    }
}

fn parse_usize(key: &'static str, default: usize) -> Result<usize, ConfigError> {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => {
            v.parse::<usize>().map_err(|_| ConfigError::Invalid(key, v))
        }
        _ => Ok(default),
    }
}
