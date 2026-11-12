use base64::{engine::general_purpose::STANDARD as B64_STD, Engine as _};
use cloak_core::config::{AppConfig, CloakEnv, ObjectStoreBackend, RateLimitConfig};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use rand::rngs::OsRng;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::{net::SocketAddr, path::PathBuf, time::Duration};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};
use uuid::Uuid;

struct TestDevice {
    id: Uuid,
    signing: SigningKey,
    ed_pk_b64: String,
    x_pk_b64: String,
    token: String,
}

impl TestDevice {
    fn new(signing: SigningKey) -> Self {
        let ed_pk_b64 = B64_STD.encode(signing.verifying_key().to_bytes());
        let mut x_pk = [0u8; 32];
        rand::RngCore::fill_bytes(&mut OsRng, &mut x_pk);
        Self {
            id: Uuid::new_v4(),
            signing,
            ed_pk_b64,
            x_pk_b64: B64_STD.encode(x_pk),
            token: String::new(),
        }
    }

    fn sign_str(&self, msg: &str) -> String {
        let sig = self.signing.sign(msg.as_bytes());
        B64_STD.encode(sig.to_bytes())
    }
}

async fn spawn_test_server(msg_burst: u32) -> (String, String, PathBuf) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info,cloak_api=debug")
        .with_test_writer()
        .try_init();
    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://cloak:cloak_dev_pass_2026@127.0.0.1:55432/cloak_dev".to_string());

    let store_dir = std::env::temp_dir().join(format!("cloak-api-it-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&store_dir).expect("create temp store");

    let config = AppConfig {
        env: CloakEnv::Test,
        api_host: "127.0.0.1".into(),
        api_port: 0,
        allowed_origins: vec!["http://127.0.0.1:5173".into()],
        session_jwt_secret: "test_only_session_jwt_secret_minimum_64_characters_long_1234567890".into(),
        database_url: db_url,
        database_max_connections: 10,
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
        max_attachment_bytes: 10 * 1024 * 1024,
        room_quota_bytes: 50 * 1024 * 1024,
        retention_check_secs: 15,
        rate_limits: RateLimitConfig {
            msg_burst,
            msg_per_min: 600,
            edit_delete_per_min: 60,
            join_per_min: 30,
            room_create_per_hour: 50,
            call_per_min: 20,
            parallel_uploads_per_device: 3,
            ws_max_payload_bytes: 64 * 1024,
        },
    };

    let state = cloak_api::build_state(config).await.expect("build test state");
    let app = cloak_api::build_router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    (
        format!("http://{addr}/api/v1"),
        format!("ws://{addr}/api/v1/ws"),
        store_dir,
    )
}

async fn register(client: &reqwest::Client, api: &str, name: &str) -> TestDevice {
    let mut dev = TestDevice::new(SigningKey::generate(&mut OsRng));
    let canonical = format!("cloak-register-v1:{}:{}:{}", dev.id, dev.ed_pk_b64, dev.x_pk_b64);
    let sig_b64 = dev.sign_str(&canonical);
    let resp = client
        .post(format!("{api}/devices/register"))
        .json(&json!({
            "deviceId": dev.id,
            "ed25519PublicKeyB64": dev.ed_pk_b64,
            "x25519PublicKeyB64": dev.x_pk_b64,
            "displayName": name,
            "avatarColor": "#7c6cff",
            "signatureB64": sig_b64,
        }))
        .send()
        .await
        .expect("register req");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.expect("json");
    dev.token = body["accessToken"].as_str().expect("token").to_string();
    dev
}

#[tokio::test]
async fn end_to_end_room_auth_messaging_attachments_calls_and_burn() {
    let (api, ws_url, store_dir) = spawn_test_server(30).await;
    let client = reqwest::Client::new();

    // 1. Health & security headers
    let h = client.get(format!("{api}/health")).send().await.expect("health");
    assert_eq!(h.status(), StatusCode::OK);
    assert_eq!(h.headers().get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(h.headers().get("x-frame-options").unwrap(), "DENY");

    // 2. Origin CSRF enforcement rejects unauthorized origin
    let bad_origin = client
        .get(format!("{api}/health"))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .expect("bad origin");
    assert_eq!(bad_origin.status(), StatusCode::FORBIDDEN);

    // 3. Register owner, member, outsider
    let owner = register(&client, &api, "Alice Owner").await;
    let member = register(&client, &api, "Bob Member").await;
    let outsider = register(&client, &api, "Eve Outsider").await;

    // 4. Challenge-response auth & logout revocation
    let ch_resp = client
        .post(format!("{api}/auth/challenge"))
        .json(&json!({ "deviceId": member.id }))
        .send()
        .await
        .expect("challenge");
    assert_eq!(ch_resp.status(), StatusCode::OK);
    let ch_json: Value = ch_resp.json().await.unwrap();
    let ch_id = ch_json["challengeId"].as_str().unwrap();
    let nonce_b64 = ch_json["nonceB64"].as_str().unwrap();
    let auth_sig = member.sign_str(&format!("cloak-auth-v1:{ch_id}:{nonce_b64}:{}", member.id));
    let sess_resp = client
        .post(format!("{api}/auth/session"))
        .json(&json!({ "deviceId": member.id, "challengeId": ch_id, "signatureB64": auth_sig }))
        .send()
        .await
        .unwrap();
    assert_eq!(sess_resp.status(), StatusCode::OK);
    let sess_token = sess_resp.json::<Value>().await.unwrap()["accessToken"]
        .as_str()
        .unwrap()
        .to_string();

    let logout = client
        .post(format!("{api}/auth/logout"))
        .bearer_auth(&sess_token)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), StatusCode::OK);
    let after_logout = client
        .get(format!("{api}/rooms"))
        .bearer_auth(&sess_token)
        .send()
        .await
        .unwrap();
    assert_eq!(after_logout.status(), StatusCode::UNAUTHORIZED);

    // 5. Create room
    let wrapped_dummy = B64_STD.encode([7u8; 48]);
    let room_resp = client
        .post(format!("{api}/rooms"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "roomKind": "group",
            "name": "Vault Lab",
            "description": "Private lab",
            "ownerWrappedEpochKeyB64": wrapped_dummy,
            "ownerX25519PublicKeyB64": owner.x_pk_b64,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(room_resp.status(), StatusCode::OK);
    let room_detail: Value = room_resp.json().await.unwrap();
    let room_id = room_detail["room"]["id"].as_str().unwrap().to_string();
    let text_channel_id = room_detail["room"]["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channelType"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let voice_channel_id = room_detail["room"]["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channelType"] == "voice")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Outsider cannot read room
    let unauth_room = client
        .get(format!("{api}/rooms/{room_id}"))
        .bearer_auth(&outsider.token)
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_room.status(), StatusCode::FORBIDDEN);

    // 6. Invite with password + inspection + revocation check
    let pw_token = format!("tok-pw-{}", Uuid::new_v4());
    let inv_resp = client
        .post(format!("{api}/rooms/{room_id}/invites"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "inviteToken": &pw_token,
            "roleName": "member",
            "password": "room-join-password",
            "wrappedEpoch": 1,
            "wrappedRoomKeyBlobB64": wrapped_dummy,
            "maxUses": 3,
        }))
        .send()
        .await
        .unwrap();
    let status = inv_resp.status();
    if status != StatusCode::OK {
        let body = inv_resp.text().await.unwrap_or_default();
        panic!("invite failed {status}: {body}");
    }
    let inv_id = inv_resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // Approval-gated invite hides wrappedRoomKeyBlobB64 on inspect
    let approval_token = format!("tok-app-{}", Uuid::new_v4());
    let app_inv = client
        .post(format!("{api}/rooms/{room_id}/invites"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "inviteToken": &approval_token,
            "requiresApproval": true,
            "wrappedEpoch": 1,
            "wrappedRoomKeyBlobB64": B64_STD.encode([0u8]),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(app_inv.status(), StatusCode::OK);
    let app_insp: Value = client
        .get(format!("{api}/invites/inspect?token={approval_token}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(app_insp["wrappedRoomKeyBlobB64"], "");

    // Wrong invite password fails with 401
    let bad_join = client
        .post(format!("{api}/invites/join"))
        .bearer_auth(&member.token)
        .json(&json!({ "token": pw_token, "password": "wrong" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_join.status(), StatusCode::UNAUTHORIZED);

    // Correct password succeeds
    let good_join = client
        .post(format!("{api}/invites/join"))
        .bearer_auth(&member.token)
        .json(&json!({
            "token": pw_token,
            "password": "room-join-password",
            "selfWrappedEpochKeyB64": wrapped_dummy,
            "x25519PublicKeyB64": member.x_pk_b64,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(good_join.status(), StatusCode::OK);
    assert_eq!(good_join.json::<Value>().await.unwrap()["status"], "active");

    // Revoke invite -> outsider fails to join
    assert_eq!(
        client
            .delete(format!("{api}/rooms/{room_id}/invites/{inv_id}"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let rev_join = client
        .post(format!("{api}/invites/join"))
        .bearer_auth(&outsider.token)
        .json(&json!({ "token": pw_token, "password": "room-join-password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(rev_join.status(), StatusCode::FORBIDDEN);

    // 7. WebSocket connect + auth + subscribe
    let (mut ws_stream, _) = connect_async(&ws_url).await.expect("connect ws");
    ws_stream
        .send(WsMsg::Text(json!({ "type": "auth", "accessToken": member.token }).to_string().into()))
        .await
        .unwrap();
    let authed_frame = tokio::time::timeout(Duration::from_secs(3), ws_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(authed_frame.to_text().unwrap().contains("\"authenticated\""));
    ws_stream
        .send(WsMsg::Text(json!({ "type": "subscribe", "roomIds": [room_id] }).to_string().into()))
        .await
        .unwrap();
    // Wait until subscription is registered (presence frame emitted on subscribe)
    let presence_frame = tokio::time::timeout(Duration::from_secs(3), ws_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(presence_frame.to_text().unwrap().contains("\"presence\""));

    // 8. Send encrypted message + idempotency duplicate suppression + WS fanout
    let msg_id = Uuid::new_v4();
    let idem_key = Uuid::new_v4();
    let msg_ct = B64_STD.encode(b"opaque-xchacha20-ciphertext-payload");
    let send1 = client
        .post(format!("{api}/rooms/{room_id}/channels/{text_channel_id}/messages"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "messageId": msg_id,
            "idempotencyKey": idem_key,
            "encryptionEpoch": 1,
            "ciphertextB64": msg_ct,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send1.status(), StatusCode::OK);
    let m1: Value = send1.json().await.unwrap();

    let send_dup = client
        .post(format!("{api}/rooms/{room_id}/channels/{text_channel_id}/messages"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "messageId": Uuid::new_v4(),
            "idempotencyKey": idem_key,
            "encryptionEpoch": 1,
            "ciphertextB64": msg_ct,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_dup.status(), StatusCode::OK);
    assert_eq!(send_dup.json::<Value>().await.unwrap()["eventSeq"], m1["eventSeq"]);

    let mut received_msg_event = false;
    for _ in 0..5 {
        let ws_event = tokio::time::timeout(Duration::from_secs(3), ws_stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let txt = ws_event.to_text().unwrap();
        if txt.contains(&msg_id.to_string()) {
            received_msg_event = true;
            break;
        }
    }
    assert!(received_msg_event, "expected WS event containing {msg_id}");

    // 9. Attachment init -> chunk upload -> complete -> download -> delete -> verify object file removed
    let enc_bytes = vec![42u8; 512];
    let init_att: Value = client
        .post(format!("{api}/rooms/{room_id}/attachments/init"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "encryptionEpoch": 1,
            "expectedCiphertextBytes": enc_bytes.len(),
            "chunkSizeBytes": 1024,
            "totalChunks": 1,
            "streamHeaderB64": B64_STD.encode([9u8; 24]),
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let att_id = init_att["id"].as_str().unwrap().to_string();

    assert_eq!(
        client
            .put(format!("{api}/attachments/{att_id}/chunks/0"))
            .bearer_auth(&owner.token)
            .body(enc_bytes.clone())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .post(format!("{api}/attachments/{att_id}/complete"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let dl = client
        .get(format!("{api}/attachments/{att_id}/chunks/0"))
        .bearer_auth(&member.token)
        .send()
        .await
        .unwrap();
    assert_eq!(dl.status(), StatusCode::OK);
    assert_eq!(dl.bytes().await.unwrap().as_ref(), enc_bytes.as_slice());

    assert_eq!(
        client
            .delete(format!("{api}/attachments/{att_id}"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let dl_after = client
        .get(format!("{api}/attachments/{att_id}/chunks/0"))
        .bearer_auth(&member.token)
        .send()
        .await
        .unwrap();
    assert_eq!(dl_after.status(), StatusCode::NOT_FOUND);

    // 10. LiveKit call token issuance
    let call_resp = client
        .post(format!("{api}/rooms/{room_id}/channels/{voice_channel_id}/call-token"))
        .bearer_auth(&member.token)
        .send()
        .await
        .unwrap();
    assert_eq!(call_resp.status(), StatusCode::OK);
    let call_json: Value = call_resp.json().await.unwrap();
    assert_eq!(call_json["e2eeRequired"], true);
    assert!(!call_json["token"].as_str().unwrap().is_empty());

    // 11. Delete for me vs everyone + burn room history
    assert_eq!(
        client
            .delete(format!("{api}/rooms/{room_id}/messages/{msg_id}?scope=everyone"))
            .bearer_auth(&owner.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let sync: Value = client
        .get(format!("{api}/rooms/{room_id}/sync?afterSeq=0"))
        .bearer_auth(&member.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!sync["tombstones"].as_array().unwrap().is_empty());

    let burn = client
        .post(format!("{api}/rooms/{room_id}/burn"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "senderX25519PublicKeyB64": owner.x_pk_b64,
            "envelopes": [{
                "recipientDeviceId": owner.id,
                "wrappedKeyCiphertextB64": wrapped_dummy,
            }],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(burn.status(), StatusCode::OK);
    assert_eq!(burn.json::<Value>().await.unwrap()["newEpoch"], 2);

    let _ = std::fs::remove_dir_all(&store_dir);
}

#[tokio::test]
async fn enforces_rate_limits_with_429() {
    let (api, _ws_url, store_dir) = spawn_test_server(2).await;
    let client = reqwest::Client::new();
    let owner = register(&client, &api, "Rate Limiter").await;
    let wrapped_dummy = B64_STD.encode([7u8; 48]);
    let room_detail: Value = client
        .post(format!("{api}/rooms"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "roomKind": "dm",
            "name": "Burst Test",
            "ownerWrappedEpochKeyB64": wrapped_dummy,
            "ownerX25519PublicKeyB64": owner.x_pk_b64,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room_id = room_detail["room"]["id"].as_str().unwrap();
    let ch_id = room_detail["room"]["channels"][0]["id"].as_str().unwrap();

    let mut statuses = Vec::new();
    for _ in 0..5 {
        let r = client
            .post(format!("{api}/rooms/{room_id}/channels/{ch_id}/messages"))
            .bearer_auth(&owner.token)
            .json(&json!({
                "messageId": Uuid::new_v4(),
                "idempotencyKey": Uuid::new_v4(),
                "encryptionEpoch": 1,
                "ciphertextB64": wrapped_dummy,
            }))
            .send()
            .await
            .unwrap();
        statuses.push(r.status());
    }
    assert!(statuses.contains(&StatusCode::TOO_MANY_REQUESTS));
    let _ = std::fs::remove_dir_all(&store_dir);
}
