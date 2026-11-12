use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::CloakError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveKitVideoGrant {
    pub room_join: bool,
    pub room: String,
    pub can_publish: bool,
    pub can_subscribe: bool,
    pub can_publish_data: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_admin: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveKitClaims {
    pub iss: String,
    pub sub: String,
    pub name: String,
    pub nbf: usize,
    pub exp: usize,
    pub jti: String,
    pub video: LiveKitVideoGrant,
}

#[derive(Clone)]
pub struct LiveKitClient {
    http: Client,
    pub ws_url: String,
    pub http_url: String,
    api_key: String,
    api_secret: String,
}

impl LiveKitClient {
    pub fn new(ws_url: String, http_url: String, api_key: String, api_secret: String) -> Self {
        Self {
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| Client::new()),
            ws_url,
            http_url: http_url.trim_end_matches('/').to_string(),
            api_key,
            api_secret,
        }
    }

    pub fn create_participant_token(
        &self,
        device_id: Uuid,
        display_name: &str,
        livekit_room_name: &str,
        can_publish: bool,
    ) -> Result<(String, chrono::DateTime<Utc>), CloakError> {
        let now = Utc::now();
        let expires_at = now + Duration::minutes(15);
        let claims = LiveKitClaims {
            iss: self.api_key.clone(),
            sub: device_id.to_string(),
            name: display_name.chars().take(64).collect(),
            nbf: now.timestamp() as usize,
            exp: expires_at.timestamp() as usize,
            jti: Uuid::new_v4().to_string(),
            video: LiveKitVideoGrant {
                room_join: true,
                room: livekit_room_name.to_string(),
                can_publish,
                can_subscribe: true,
                can_publish_data: false, // Messaging uses persistent E2EE event log, not LiveKit data channel
                room_admin: None,
            },
        };

        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )
        .map_err(|e| CloakError::Internal(format!("livekit token encode failed: {e}")))?;

        Ok((token, expires_at))
    }

    pub async fn remove_participant_best_effort(&self, livekit_room_name: &str, device_id: Uuid) {
        let now = Utc::now();
        let claims = LiveKitClaims {
            iss: self.api_key.clone(),
            sub: "cloak-control-plane".to_string(),
            name: "cloak-control-plane".to_string(),
            nbf: now.timestamp() as usize,
            exp: (now + Duration::minutes(2)).timestamp() as usize,
            jti: Uuid::new_v4().to_string(),
            video: LiveKitVideoGrant {
                room_join: false,
                room: livekit_room_name.to_string(),
                can_publish: false,
                can_subscribe: false,
                can_publish_data: false,
                room_admin: Some(true),
            },
        };
        let Ok(admin_jwt) = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        ) else {
            return;
        };

        let url = format!(
            "{}/twirp/livekit.RoomService/RemoveParticipant",
            self.http_url
        );
        let _ = self
            .http
            .post(url)
            .bearer_auth(admin_jwt)
            .json(&serde_json::json!({
                "room": livekit_room_name,
                "identity": device_id.to_string(),
            }))
            .send()
            .await;
    }
}
