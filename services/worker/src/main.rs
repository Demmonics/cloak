use chrono::Utc;
use cloak_core::{config::AppConfig, db::connect_and_migrate, object_store::ObjectStore};
use sqlx::{PgPool, Row};
use std::time::Duration;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cloak_worker=info,cloak_core=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::from_env().expect("invalid worker configuration");
    let pool = connect_and_migrate(&config.database_url, config.database_max_connections)
        .await
        .expect("failed to connect database");
    let object_store = ObjectStore::from_config(&config)
        .await
        .expect("failed to initialize object store");

    let interval = Duration::from_secs(config.retention_check_secs.max(5));
    tracing::info!(
        interval_secs = interval.as_secs(),
        "Cloak retention worker started"
    );

    loop {
        if let Err(err) = run_retention_sweep(&pool, &object_store).await {
            tracing::error!(error = %err, "retention sweep error");
        }
        tokio::time::sleep(interval).await;
    }
}

pub async fn run_retention_sweep(
    db: &PgPool,
    object_store: &ObjectStore,
) -> Result<(), cloak_core::error::CloakError> {
    let now = Utc::now();

    // 1. Expire disappearing messages and create tombstones
    let expired_msgs = sqlx::query(
        r#"
        SELECT id, room_id, channel_id, sender_device_id
        FROM encrypted_messages
        WHERE expires_at IS NOT NULL AND expires_at <= $1 AND deleted_for_everyone_at IS NULL
        LIMIT 250
        "#,
    )
    .bind(now)
    .fetch_all(db)
    .await?;

    for row in expired_msgs {
        let msg_id: Uuid = row.get("id");
        let room_id: Uuid = row.get("room_id");
        let channel_id: Uuid = row.get("channel_id");
        let sender_id: Uuid = row.get("sender_device_id");

        let mut tx = db.begin().await?;
        let seq: i64 = sqlx::query_scalar(
            "UPDATE rooms SET next_event_seq = next_event_seq + 1 WHERE id = $1 RETURNING next_event_seq",
        )
        .bind(room_id)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE encrypted_messages SET ciphertext = ''::bytea, deleted_for_everyone_at = $2 WHERE id = $1",
        )
        .bind(msg_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO message_tombstones (id, room_id, channel_id, message_id, scope, actor_device_id, event_seq, created_at) VALUES ($1, $2, $3, $4, 'expired', $5, $6, $7)",
        )
        .bind(Uuid::new_v4())
        .bind(room_id)
        .bind(channel_id)
        .bind(msg_id)
        .bind(sender_id)
        .bind(seq)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM channel_pins WHERE message_id = $1")
            .bind(msg_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
    }

    // 2. Expire disappearing attachments and enqueue object purges
    let expired_atts = sqlx::query(
        "SELECT id, room_id, actual_ciphertext_bytes FROM encrypted_attachments WHERE expires_at IS NOT NULL AND expires_at <= $1 AND state = 'uploaded' LIMIT 100",
    )
    .bind(now)
    .fetch_all(db)
    .await?;

    for row in expired_atts {
        let att_id: Uuid = row.get("id");
        let room_id: Uuid = row.get("room_id");
        let size: i64 = row.get("actual_ciphertext_bytes");

        let mut tx = db.begin().await?;
        sqlx::query("UPDATE encrypted_attachments SET state = 'expired', deleted_at = $2, updated_at = $2 WHERE id = $1")
            .bind(att_id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE rooms SET used_bytes = GREATEST(0, used_bytes - $2) WHERE id = $1")
            .bind(room_id)
            .bind(size)
            .execute(&mut *tx)
            .await?;
        let keys: Vec<String> =
            sqlx::query_scalar("SELECT object_key FROM attachment_chunks WHERE attachment_id = $1")
                .bind(att_id)
                .fetch_all(&mut *tx)
                .await?;
        for k in keys {
            sqlx::query(
                "INSERT INTO retention_jobs (id, room_id, job_type, target_id, object_key) VALUES ($1, $2, 'purge_attachment_object', $3, $4)",
            )
            .bind(Uuid::new_v4())
            .bind(room_id)
            .bind(att_id)
            .bind(k)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }

    // 3. Process queued object deletions
    let jobs = sqlx::query(
        "SELECT id, object_key FROM retention_jobs WHERE status IN ('queued', 'failed') AND job_type = 'purge_attachment_object' AND run_after <= NOW() AND attempts < 5 LIMIT 100",
    )
    .fetch_all(db)
    .await?;

    for job in jobs {
        let job_id: Uuid = job.get("id");
        let key: Option<String> = job.get("object_key");
        let res = match key {
            Some(k) => object_store.delete_object(&k).await,
            None => Ok(()),
        };
        match res {
            Ok(()) => {
                sqlx::query("UPDATE retention_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1")
                    .bind(job_id)
                    .execute(db)
                    .await?;
            }
            Err(err) => {
                sqlx::query("UPDATE retention_jobs SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1")
                    .bind(job_id)
                    .bind(err.to_string())
                    .execute(db)
                    .await?;
            }
        }
    }

    // 4. Prune expired challenges and old revoked JTI records
    sqlx::query("DELETE FROM auth_challenges WHERE expires_at < NOW() - INTERVAL '1 hour'")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM revoked_credentials WHERE expires_at < NOW()")
        .execute(db)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use cloak_core::config::{CloakEnv, ObjectStoreBackend, RateLimitConfig};

    #[tokio::test]
    async fn retention_sweep_purges_expired_messages_and_attachments() {
        let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://cloak:cloak_dev_pass_2026@127.0.0.1:55432/cloak_dev".to_string()
        });
        let pool = connect_and_migrate(&db_url, 5).await.expect("connect db");
        let store_dir = std::env::temp_dir().join(format!("cloak-worker-it-{}", Uuid::new_v4()));
        let cfg = AppConfig {
            env: CloakEnv::Test,
            api_host: "127.0.0.1".into(),
            api_port: 8080,
            allowed_origins: vec![],
            session_jwt_secret: "test_worker_jwt_secret_minimum_64_characters_long_000000000000000"
                .into(),
            database_url: db_url,
            database_max_connections: 5,
            redis_url: None,
            allow_in_memory_redis: true,
            object_store_backend: ObjectStoreBackend::Local,
            s3_endpoint: "http://127.0.0.1:9000".into(),
            s3_region: "us-east-1".into(),
            s3_bucket: "test".into(),
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_force_path_style: true,
            local_object_store_dir: store_dir.to_string_lossy().into_owned(),
            livekit_url: "ws://127.0.0.1:7880".into(),
            livekit_http_url: "http://127.0.0.1:7880".into(),
            livekit_api_key: "devkey".into(),
            livekit_api_secret: "devsecret_must_be_at_least_32_characters_long_for_livekit".into(),
            max_attachment_bytes: 1024 * 1024,
            room_quota_bytes: 10 * 1024 * 1024,
            retention_check_secs: 15,
            rate_limits: RateLimitConfig {
                msg_burst: 20,
                msg_per_min: 120,
                edit_delete_per_min: 60,
                join_per_min: 20,
                room_create_per_hour: 20,
                call_per_min: 10,
                parallel_uploads_per_device: 3,
                ws_max_payload_bytes: 65536,
            },
        };
        let store = ObjectStore::from_config(&cfg).await.expect("object store");

        let device_id = Uuid::new_v4();
        let room_id = Uuid::new_v4();
        let channel_id = Uuid::new_v4();
        let msg_id = Uuid::new_v4();
        let att_id = Uuid::new_v4();
        let mut ed_pk = [0u8; 32];
        ed_pk[..16].copy_from_slice(device_id.as_bytes());
        let x_pk = [2u8; 32];

        sqlx::query("INSERT INTO device_identities (id, ed25519_public_key, x25519_public_key) VALUES ($1, $2, $3)")
            .bind(device_id)
            .bind(&ed_pk[..])
            .bind(&x_pk[..])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO rooms (id, name, owner_device_id, used_bytes) VALUES ($1, 'Worker Room', $2, 256)")
            .bind(room_id)
            .bind(device_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels (id, room_id, name, created_by_device_id) VALUES ($1, $2, 'general', $3)")
            .bind(channel_id)
            .bind(room_id)
            .bind(device_id)
            .execute(&pool)
            .await
            .unwrap();

        let past = Utc::now() - chrono::Duration::seconds(30);
        sqlx::query(
            "INSERT INTO encrypted_messages (id, room_id, channel_id, sender_device_id, idempotency_key, encryption_epoch, event_seq, ciphertext, expires_at) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $7)",
        )
        .bind(msg_id)
        .bind(room_id)
        .bind(channel_id)
        .bind(device_id)
        .bind(Uuid::new_v4())
        .bind(b"expired-ciphertext".as_slice())
        .bind(past)
        .execute(&pool)
        .await
        .unwrap();

        let chunk_key = format!("rooms/{room_id}/att/{att_id}/0");
        store
            .put_object(&chunk_key, Bytes::from_static(b"encrypted-chunk-bytes"))
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO encrypted_attachments (id, room_id, uploader_device_id, encryption_epoch, state, object_key, expected_ciphertext_bytes, actual_ciphertext_bytes, chunk_size_bytes, total_chunks, stream_header, expires_at) VALUES ($1, $2, $3, 1, 'uploaded', $4, 256, 256, 1024, 1, $5, $6)",
        )
        .bind(att_id)
        .bind(room_id)
        .bind(device_id)
        .bind(format!("rooms/{room_id}/att/{att_id}"))
        .bind(&[9u8; 24][..])
        .bind(past)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO attachment_chunks (attachment_id, chunk_index, object_key, byte_length, sha256) VALUES ($1, 0, $2, 21, $3)",
        )
        .bind(att_id)
        .bind(&chunk_key)
        .bind(&[1u8; 32][..])
        .execute(&pool)
        .await
        .unwrap();

        run_retention_sweep(&pool, &store).await.unwrap();

        let wiped_ct: Vec<u8> =
            sqlx::query_scalar("SELECT ciphertext FROM encrypted_messages WHERE id = $1")
                .bind(msg_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(wiped_ct.is_empty());

        let scope: String =
            sqlx::query_scalar("SELECT scope FROM message_tombstones WHERE message_id = $1")
                .bind(msg_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(scope, "expired");

        let att_state: String =
            sqlx::query_scalar("SELECT state FROM encrypted_attachments WHERE id = $1")
                .bind(att_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(att_state, "expired");

        let used_bytes: i64 = sqlx::query_scalar("SELECT used_bytes FROM rooms WHERE id = $1")
            .bind(room_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(used_bytes, 0);

        assert!(store.get_object(&chunk_key).await.is_err());

        // Cleanup test fixtures
        sqlx::query("DELETE FROM rooms WHERE id = $1")
            .bind(room_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM device_identities WHERE id = $1")
            .bind(device_id)
            .execute(&pool)
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&store_dir);
    }
}
