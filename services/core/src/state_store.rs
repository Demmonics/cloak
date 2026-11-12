use chrono::Utc;
use redis::{AsyncCommands, Script};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::CloakError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceRecord {
    pub device_id: Uuid,
    pub status: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct RateLimitOutcome {
    pub allowed: bool,
    pub remaining: u32,
    pub retry_after_secs: u64,
}

#[derive(Clone)]
pub enum StateStore {
    Redis(RedisStore),
    InMemory(Arc<InMemoryStore>),
}

#[derive(Clone)]
pub struct RedisStore {
    manager: redis::aio::ConnectionManager,
}

#[derive(Default)]
pub struct InMemoryStore {
    buckets: Mutex<HashMap<String, TokenBucketState>>,
    revoked_jtis: Mutex<HashMap<Uuid, i64>>,
    presence: Mutex<HashMap<Uuid, PresenceRecord>>,
    upload_counts: Mutex<HashMap<Uuid, u32>>,
}

#[derive(Clone)]
struct TokenBucketState {
    tokens: f64,
    last_refill_ms: i64,
}

const TOKEN_BUCKET_LUA: &str = r#"
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl_secs = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if tokens == nil or last_ts == nil then
  tokens = capacity
  last_ts = now_ms
else
  local elapsed = math.max(0, now_ms - last_ts)
  tokens = math.min(capacity, tokens + elapsed * refill_per_ms)
  last_ts = now_ms
end

local allowed = 0
local retry_after = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  if refill_per_ms > 0 then
    retry_after = math.ceil((deficit / refill_per_ms) / 1000)
  else
    retry_after = ttl_secs
  end
end

redis.call("HSET", key, "tokens", tokens, "ts", last_ts)
redis.call("EXPIRE", key, ttl_secs)
return { allowed, math.floor(tokens), retry_after }
"#;

impl StateStore {
    pub async fn connect_redis(redis_url: &str) -> Result<Self, CloakError> {
        let client = redis::Client::open(redis_url)
            .map_err(|e| CloakError::Internal(format!("invalid REDIS_URL: {e}")))?;
        let manager = redis::aio::ConnectionManager::new(client)
            .await
            .map_err(|e| CloakError::Internal(format!("redis connection failed: {e}")))?;
        Ok(Self::Redis(RedisStore { manager }))
    }

    pub fn in_memory_dev() -> Self {
        Self::InMemory(Arc::new(InMemoryStore::default()))
    }

    pub async fn check_rate_limit(
        &self,
        key: &str,
        capacity: u32,
        refill_per_sec: f64,
        ttl_secs: u64,
    ) -> Result<RateLimitOutcome, CloakError> {
        let now_ms = Utc::now().timestamp_millis();
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let script = Script::new(TOKEN_BUCKET_LUA);
                let refill_per_ms = refill_per_sec / 1000.0;
                let res: (i64, i64, i64) = script
                    .key(format!("cloak:rl:{key}"))
                    .arg(capacity as f64)
                    .arg(refill_per_ms)
                    .arg(now_ms)
                    .arg(1.0_f64)
                    .arg(ttl_secs.max(1))
                    .invoke_async(&mut conn)
                    .await
                    .map_err(|e| CloakError::Internal(format!("redis rate limit error: {e}")))?;
                Ok(RateLimitOutcome {
                    allowed: res.0 == 1,
                    remaining: res.1.max(0) as u32,
                    retry_after_secs: res.2.max(1) as u64,
                })
            }
            Self::InMemory(store) => {
                let mut map = store.buckets.lock().await;
                let refill_per_ms = refill_per_sec / 1000.0;
                let entry = map.entry(key.to_string()).or_insert_with(|| TokenBucketState {
                    tokens: capacity as f64,
                    last_refill_ms: now_ms,
                });
                let elapsed = (now_ms - entry.last_refill_ms).max(0) as f64;
                entry.tokens = (capacity as f64).min(entry.tokens + elapsed * refill_per_ms);
                entry.last_refill_ms = now_ms;

                if entry.tokens >= 1.0 {
                    entry.tokens -= 1.0;
                    Ok(RateLimitOutcome {
                        allowed: true,
                        remaining: entry.tokens.floor() as u32,
                        retry_after_secs: 0,
                    })
                } else {
                    let deficit = 1.0 - entry.tokens;
                    let retry = if refill_per_ms > 0.0 {
                        ((deficit / refill_per_ms) / 1000.0).ceil().max(1.0) as u64
                    } else {
                        ttl_secs.max(1)
                    };
                    Ok(RateLimitOutcome {
                        allowed: false,
                        remaining: 0,
                        retry_after_secs: retry,
                    })
                }
            }
        }
    }

    pub async fn enforce_rate_limit(
        &self,
        key: &str,
        capacity: u32,
        refill_per_sec: f64,
        ttl_secs: u64,
    ) -> Result<(), CloakError> {
        let outcome = self
            .check_rate_limit(key, capacity, refill_per_sec, ttl_secs)
            .await?;
        if !outcome.allowed {
            return Err(CloakError::RateLimited {
                retry_after_secs: outcome.retry_after_secs,
            });
        }
        Ok(())
    }

    pub async fn revoke_jti(&self, jti: Uuid, ttl_secs: u64) -> Result<(), CloakError> {
        let exp_ms = Utc::now().timestamp_millis() + (ttl_secs as i64 * 1000);
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let _: () = conn
                    .set_ex(format!("cloak:revoked:{jti}"), "1", ttl_secs.max(60))
                    .await
                    .map_err(|e| CloakError::Internal(format!("redis revoke error: {e}")))?;
                Ok(())
            }
            Self::InMemory(store) => {
                store.revoked_jtis.lock().await.insert(jti, exp_ms);
                Ok(())
            }
        }
    }

    pub async fn is_jti_revoked(&self, jti: Uuid) -> Result<bool, CloakError> {
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let exists: bool = conn
                    .exists(format!("cloak:revoked:{jti}"))
                    .await
                    .map_err(|e| CloakError::Internal(format!("redis exists error: {e}")))?;
                Ok(exists)
            }
            Self::InMemory(store) => {
                let now = Utc::now().timestamp_millis();
                let mut map = store.revoked_jtis.lock().await;
                map.retain(|_, exp| *exp > now);
                Ok(map.contains_key(&jti))
            }
        }
    }

    pub async fn set_presence(&self, device_id: Uuid, status: &str) -> Result<(), CloakError> {
        let rec = PresenceRecord {
            device_id,
            status: status.to_string(),
            updated_at_ms: Utc::now().timestamp_millis(),
        };
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let payload = serde_json::to_string(&rec)
                    .map_err(|e| CloakError::Internal(format!("presence serialize error: {e}")))?;
                let _: () = conn
                    .set_ex(format!("cloak:presence:{device_id}"), payload, 90)
                    .await
                    .map_err(|e| CloakError::Internal(format!("redis presence set error: {e}")))?;
                Ok(())
            }
            Self::InMemory(store) => {
                store.presence.lock().await.insert(device_id, rec);
                Ok(())
            }
        }
    }

    pub async fn get_presences(&self, device_ids: &[Uuid]) -> Result<Vec<PresenceRecord>, CloakError> {
        if device_ids.is_empty() {
            return Ok(Vec::new());
        }
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let keys: Vec<String> = device_ids
                    .iter()
                    .map(|id| format!("cloak:presence:{id}"))
                    .collect();
                let vals: Vec<Option<String>> = conn
                    .mget(keys)
                    .await
                    .map_err(|e| CloakError::Internal(format!("redis presence mget error: {e}")))?;
                let mut out = Vec::new();
                for val in vals.into_iter().flatten() {
                    if let Ok(rec) = serde_json::from_str::<PresenceRecord>(&val) {
                        out.push(rec);
                    }
                }
                Ok(out)
            }
            Self::InMemory(store) => {
                let cutoff = Utc::now().timestamp_millis() - 90_000;
                let mut map = store.presence.lock().await;
                map.retain(|_, v| v.updated_at_ms >= cutoff);
                Ok(device_ids
                    .iter()
                    .filter_map(|id| map.get(id).cloned())
                    .collect())
            }
        }
    }

    pub async fn acquire_upload_slot(&self, device_id: Uuid, max_parallel: u32) -> Result<(), CloakError> {
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let key = format!("cloak:uploads:{device_id}");
                let count: i64 = conn
                    .incr(&key, 1)
                    .await
                    .map_err(|e| CloakError::Internal(format!("redis upload incr error: {e}")))?;
                let _: bool = conn.expire(&key, 300).await.unwrap_or(false);
                if count > max_parallel as i64 {
                    let _: i64 = conn.decr(&key, 1).await.unwrap_or(0);
                    return Err(CloakError::RateLimited { retry_after_secs: 5 });
                }
                Ok(())
            }
            Self::InMemory(store) => {
                let mut map = store.upload_counts.lock().await;
                let cur = map.entry(device_id).or_insert(0);
                if *cur >= max_parallel {
                    return Err(CloakError::RateLimited { retry_after_secs: 5 });
                }
                *cur += 1;
                Ok(())
            }
        }
    }

    pub async fn release_upload_slot(&self, device_id: Uuid) {
        match self {
            Self::Redis(store) => {
                let mut conn = store.manager.clone();
                let key = format!("cloak:uploads:{device_id}");
                let val: i64 = conn.decr(&key, 1).await.unwrap_or(0);
                if val <= 0 {
                    let _: i64 = conn.del(&key).await.unwrap_or(0);
                }
            }
            Self::InMemory(store) => {
                let mut map = store.upload_counts.lock().await;
                if let Some(cur) = map.get_mut(&device_id) {
                    *cur = cur.saturating_sub(1);
                }
            }
        }
    }
}

