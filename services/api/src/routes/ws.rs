use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap},
    response::Response,
};
use cloak_core::error::CloakError;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashSet;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    authz::require_active_member,
    error::ApiError,
    extractors::verify_token_against_state,
    state::AppState,
};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WsInbound {
    #[serde(rename_all = "camelCase")]
    Auth { access_token: String },
    #[serde(rename_all = "camelCase")]
    Subscribe { room_ids: Vec<Uuid> },
    Ping { ts: i64 },
    #[serde(rename_all = "camelCase")]
    Typing {
        room_id: Uuid,
        channel_id: Uuid,
        is_typing: bool,
    },
    Presence { status: String },
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !state.config.allowed_origins.is_empty()
            && !state.config.allowed_origins.iter().any(|o| o == origin)
        {
            return Err(ApiError(CloakError::Forbidden("WebSocket origin not allowed".into())));
        }
    }

    let max_frame = state.config.rate_limits.ws_max_payload_bytes;
    Ok(ws
        .max_message_size(max_frame)
        .max_frame_size(max_frame)
        .on_upgrade(move |socket| handle_socket(socket, state)))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let mut authenticated_device: Option<Uuid> = None;
    let mut subscribed_rooms: HashSet<Uuid> = HashSet::new();
    let (fanout_tx, mut fanout_rx) = mpsc::channel::<String>(256);
    let mut forward_handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let max_payload = state.config.rate_limits.ws_max_payload_bytes;

    let idle_timeout = std::time::Duration::from_secs(90);

    loop {
        tokio::select! {
            Some(outbound) = fanout_rx.recv() => {
                if out_tx.try_send(outbound).is_err() {
                    // Backpressure: drop slow consumer if queue saturates
                    break;
                }
            }
            incoming = tokio::time::timeout(idle_timeout, ws_rx.next()) => {
                let msg_opt = match incoming {
                    Ok(opt) => opt,
                    Err(_) => {
                        let _ = out_tx.send(serde_json::json!({
                            "type": "error",
                            "code": "idle_timeout",
                            "message": "WebSocket idle timeout"
                        }).to_string()).await;
                        break;
                    }
                };

                let Some(Ok(msg)) = msg_opt else {
                    break;
                };

                match msg {
                    Message::Text(text) => {
                        if text.len() > max_payload {
                            let _ = out_tx.send(serde_json::json!({
                                "type": "error",
                                "code": "payload_too_large",
                                "message": "WebSocket payload exceeds 64 KiB limit"
                            }).to_string()).await;
                            break;
                        }
                        let parsed = match serde_json::from_str::<WsInbound>(&text) {
                            Ok(v) => v,
                            Err(_) => {
                                let _ = out_tx.send(serde_json::json!({
                                    "type": "error",
                                    "code": "invalid_message",
                                    "message": "Invalid WebSocket payload"
                                }).to_string()).await;
                                continue;
                            }
                        };

                        match parsed {
                            WsInbound::Auth { access_token } => {
                                match verify_token_against_state(&access_token, &state).await {
                                    Ok(auth) => {
                                        authenticated_device = Some(auth.device_id);
                                        let _ = state.state_store.set_presence(auth.device_id, "online").await;
                                        let _ = out_tx.send(serde_json::json!({
                                            "type": "authenticated",
                                            "deviceId": auth.device_id
                                        }).to_string()).await;
                                    }
                                    Err(err) => {
                                        let _ = out_tx.send(serde_json::json!({
                                            "type": "error",
                                            "code": "unauthorized",
                                            "message": err.to_string()
                                        }).to_string()).await;
                                        break;
                                    }
                                }
                            }
                            WsInbound::Ping { ts } => {
                                if let Some(dev_id) = authenticated_device {
                                    let _ = state.state_store.set_presence(dev_id, "online").await;
                                }
                                let _ = out_tx.send(serde_json::json!({ "type": "pong", "ts": ts }).to_string()).await;
                            }
                            WsInbound::Subscribe { room_ids } => {
                                let Some(dev_id) = authenticated_device else {
                                    let _ = out_tx.send(serde_json::json!({
                                        "type": "error",
                                        "code": "unauthorized",
                                        "message": "Authenticate before subscribing"
                                    }).to_string()).await;
                                    continue;
                                };
                                for rid in room_ids.into_iter().take(100) {
                                    if subscribed_rooms.contains(&rid) {
                                        continue;
                                    }
                                    if require_active_member(&state.db, rid, dev_id).await.is_ok() {
                                        subscribed_rooms.insert(rid);
                                        let mut rx = state.ws_hub.subscribe_room(rid).await;
                                        let ftx = fanout_tx.clone();
                                        let handle = tokio::spawn(async move {
                                            loop {
                                                match rx.recv().await {
                                                    Ok(payload) => {
                                                        if ftx.send(payload).await.is_err() {
                                                            break;
                                                        }
                                                    }
                                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                                                    Err(_) => break,
                                                }
                                            }
                                        });
                                        forward_handles.push(handle);

                                        state.ws_hub.broadcast_room(
                                            rid,
                                            serde_json::json!({
                                                "type": "presence",
                                                "roomId": rid,
                                                "deviceId": dev_id,
                                                "status": "online"
                                            }).to_string(),
                                        ).await;
                                    }
                                }
                            }
                            WsInbound::Typing { room_id, channel_id, is_typing } => {
                                let Some(dev_id) = authenticated_device else { continue; };
                                if subscribed_rooms.contains(&room_id) {
                                    state.ws_hub.broadcast_room(
                                        room_id,
                                        serde_json::json!({
                                            "type": "typing",
                                            "roomId": room_id,
                                            "channelId": channel_id,
                                            "deviceId": dev_id,
                                            "isTyping": is_typing
                                        }).to_string(),
                                    ).await;
                                }
                            }
                            WsInbound::Presence { status } => {
                                let Some(dev_id) = authenticated_device else { continue; };
                                if matches!(status.as_str(), "online" | "idle" | "dnd") {
                                    let _ = state.state_store.set_presence(dev_id, &status).await;
                                    for rid in &subscribed_rooms {
                                        state.ws_hub.broadcast_room(
                                            *rid,
                                            serde_json::json!({
                                                "type": "presence",
                                                "roomId": rid,
                                                "deviceId": dev_id,
                                                "status": status
                                            }).to_string(),
                                        ).await;
                                    }
                                }
                            }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Binary(_) => {
                        let _ = out_tx.send(serde_json::json!({
                            "type": "error",
                            "code": "unsupported_binary",
                            "message": "Binary WebSocket frames are not accepted"
                        }).to_string()).await;
                    }
                }
            }
        }
    }

    if let Some(dev_id) = authenticated_device {
        for rid in subscribed_rooms {
            state.ws_hub.broadcast_room(
                rid,
                serde_json::json!({
                    "type": "presence",
                    "roomId": rid,
                    "deviceId": dev_id,
                    "status": "offline"
                }).to_string(),
            ).await;
        }
    }

    for h in forward_handles {
        h.abort();
    }
    writer_task.abort();
}

