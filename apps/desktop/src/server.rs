use std::collections::HashMap;
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use cloak_p2p::{
    ActiveCallPrivacySummary, ConnectivityMode, GhostPolicy, GhostRoomOverride, GhostTriggerKind,
    LocalDeletionAction, NotificationPrivacyLevel, P2pError, P2pNode, PairingTicket,
    PdfDocumentStateUpdate, PrivacyTriggerKind, SecretCodeAction, StealthConfig, UnlockMethod,
    WebRtcSignalPayload,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::capture;

static DIST_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../apps/web/dist");

#[derive(Clone)]
pub struct DesktopState {
    pub node: P2pNode,
    pub data_dir: PathBuf,
    pub session_token: String,
    pub expected_http_port: std::sync::Arc<std::sync::atomic::AtomicU16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    error: String,
}

fn map_p2p_error(err: P2pError) -> Response {
    let (status, code) = match &err {
        P2pError::DirectConnectivityBlocked { .. } => {
            (StatusCode::BAD_GATEWAY, "DIRECT_CONNECTIVITY_BLOCKED")
        }
        P2pError::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
        P2pError::Validation(_) | P2pError::Protocol(_) => {
            (StatusCode::BAD_REQUEST, "INVALID_REQUEST")
        }
        P2pError::PeerRejected(_) | P2pError::Crypto(_) => {
            (StatusCode::FORBIDDEN, "AUTH_OR_CRYPTO_FAILED")
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
    };
    (
        status,
        Json(ErrorBody {
            code,
            error: err.to_string(),
        }),
    )
        .into_response()
}

fn is_allowed_loopback_origin(origin: &str, bound_port: u16) -> bool {
    let expected_ip = format!("http://127.0.0.1:{bound_port}");
    let expected_host = format!("http://localhost:{bound_port}");
    if bound_port == 0 {
        return origin.starts_with("http://127.0.0.1:")
            || origin.starts_with("http://localhost:")
            || origin == "http://127.0.0.1"
            || origin == "http://localhost";
    }
    origin == expected_ip || origin == expected_host
}

fn is_allowed_host(host: &str, bound_port: u16) -> bool {
    if bound_port == 0 {
        return host.starts_with("127.0.0.1") || host.starts_with("localhost");
    }
    host == format!("127.0.0.1:{bound_port}") || host == format!("localhost:{bound_port}")
}

/// Strict loopback capability guard blocking cross-site browser requests and unauthenticated local processes.
async fn require_loopback_auth(
    State(st): State<DesktopState>,
    req: Request,
    next: Next,
) -> Response {
    let bound_port = st
        .expected_http_port
        .load(std::sync::atomic::Ordering::Relaxed);

    if let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        && !is_allowed_host(host, bound_port)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorBody {
                code: "INVALID_HOST",
                error: "Rejected non-loopback Host header".into(),
            }),
        )
            .into_response();
    }

    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        && !is_allowed_loopback_origin(origin, bound_port)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorBody {
                code: "INVALID_ORIGIN",
                error: "Rejected untrusted cross-site Origin".into(),
            }),
        )
            .into_response();
    }

    let header_tok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .or_else(|| {
            req.headers()
                .get("x-cloak-token")
                .and_then(|v| v.to_str().ok())
        });

    let ws_query_tok = if req.uri().path() == "/ws" || req.uri().path() == "/p2p/v1/ws" {
        req.uri()
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")))
    } else {
        None
    };

    let candidate = header_tok.or(ws_query_tok).unwrap_or("");
    let ok = candidate.len() == st.session_token.len()
        && candidate
            .as_bytes()
            .ct_eq(st.session_token.as_bytes())
            .unwrap_u8()
            == 1;

    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                code: "UNAUTHORIZED",
                error: "Missing or invalid Cloak desktop session token".into(),
            }),
        )
            .into_response();
    }

    next.run(req).await
}

/// Blocks private messenger/settings APIs while Rust's StealthController is in a locked state.
async fn require_unlocked_stealth(
    State(st): State<DesktopState>,
    req: Request,
    next: Next,
) -> Response {
    if st.node.is_stealth_locked() {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorBody {
                code: "STEALTH_LOCKED",
                error: "Private workspace is locked; authenticate via Stealth unlock first".into(),
            }),
        )
            .into_response();
    }
    next.run(req).await
}

pub fn build_router(state: DesktopState) -> Router {
    let private_routes = Router::new()
        .route("/status", get(get_status))
        .route("/identity", patch(update_identity))
        .route("/network/diagnostics", get(get_network_diagnostics))
        .route("/peers", get(list_peers))
        .route("/peers/{device_id}/connect", post(connect_peer))
        .route("/peers/{device_id}/revoke", post(revoke_peer))
        .route("/rooms", get(list_rooms).post(create_room))
        .route("/rooms/{room_id}/channels", get(list_channels))
        .route("/rooms/{room_id}/ticket", post(export_ticket))
        .route("/pair", post(pair_with_ticket))
        .route(
            "/rooms/{room_id}/channels/{channel_id}/messages",
            get(list_messages).post(send_message),
        )
        .route(
            "/rooms/{room_id}/messages/{message_id}",
            patch(edit_message).delete(delete_message),
        )
        .route("/rooms/{room_id}/burn", post(burn_room))
        .route(
            "/rooms/{room_id}/files",
            post(upload_file).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/files/{attachment_id}", get(download_file))
        .route("/signals", post(send_signal))
        // Ghost Mode APIs
        .route(
            "/ghost/policy",
            get(get_ghost_policy).put(update_ghost_policy),
        )
        .route("/ghost/pin", post(set_ghost_pin))
        .route("/ghost/state", get(get_ghost_state))
        .route("/ghost/trigger", post(trigger_ghost_event))
        .route("/ghost/unlock", post(unlock_ghost_mode))
        .route("/ghost/viewed", post(mark_viewed))
        .route("/ghost/active", post(set_active_conversation))
        .route("/ghost/modal", post(set_modal_state))
        .route("/ghost/overrides", get(list_ghost_overrides))
        .route("/ghost/overrides/{room_id}", put(set_ghost_override))
        // Stealth Configuration & Secret Codes (Unlocked Only)
        .route(
            "/stealth/settings",
            get(get_stealth_settings).put(update_stealth_settings),
        )
        .route(
            "/stealth/codes",
            get(list_stealth_codes).post(create_stealth_code),
        )
        .route("/stealth/codes/{id}", delete(delete_stealth_code))
        .route("/stealth/passphrase", post(set_stealth_passphrase))
        .route("/stealth/recovery-code", post(generate_stealth_recovery))
        .route("/stealth/test-preview", post(run_stealth_test_preview))
        // Native Windows Capture & File Picker APIs
        .route("/capture/sources", get(list_capture_sources))
        .route("/capture/frame/{source_id}", get(capture_source_frame))
        .route("/dialog/pick-files", post(pick_native_files))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_unlocked_stealth,
        ));

    let locked_safe_routes = Router::new()
        .route("/stealth/bootstrap", get(get_stealth_bootstrap))
        .route("/stealth/unlock", post(stealth_unlock))
        .route("/stealth/recover", post(stealth_recover))
        .route("/stealth/trigger", post(stealth_trigger))
        .route(
            "/stealth/foreground-activity",
            post(stealth_foreground_activity),
        )
        .route("/stealth/system-idle", post(stealth_report_system_idle))
        .route("/stealth/call-summary", post(stealth_update_call_summary))
        .route("/stealth/return-messenger", post(stealth_return_messenger))
        .route(
            "/stealth/test-clock-advance",
            post(stealth_test_clock_advance),
        )
        .route(
            "/pdf/documents",
            get(list_pdf_docs)
                .post(upload_pdf_doc)
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/pdf/documents/pick", post(pick_native_pdf))
        .route("/pdf/documents/sample", post(create_sample_pdf_doc))
        .route("/pdf/documents/{id}/content", get(get_pdf_content))
        .route(
            "/pdf/documents/{id}",
            patch(patch_pdf_doc).delete(delete_pdf_doc),
        )
        .route("/ws", get(ws_events));

    let api_routes =
        private_routes
            .merge(locked_safe_routes)
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_loopback_auth,
            ));

    Router::new()
        .nest("/p2p/v1", api_routes)
        .fallback(serve_embedded_web)
        .with_state(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    device_id: String,
    display_name: String,
    ed25519_public_b64: String,
    x25519_public_b64: String,
    listen_addr: String,
    data_dir: String,
    active_peer_ids: Vec<String>,
    peer_states: HashMap<String, cloak_p2p::PeerConnectionState>,
}

async fn get_status(State(st): State<DesktopState>) -> Response {
    match st.node.identity() {
        Ok(ident) => Json(StatusResponse {
            device_id: ident.device_id,
            display_name: ident.display_name,
            ed25519_public_b64: ident.ed25519_public_b64,
            x25519_public_b64: ident.x25519_public_b64,
            listen_addr: st.node.local_addr().to_string(),
            data_dir: st.data_dir.to_string_lossy().into_owned(),
            active_peer_ids: st.node.active_peer_ids().await,
            peer_states: st.node.peer_connection_states().await,
        })
        .into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn get_network_diagnostics(State(st): State<DesktopState>) -> Response {
    Json(st.node.network_diagnostics()).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateIdentityReq {
    display_name: String,
}

async fn update_identity(
    State(st): State<DesktopState>,
    Json(req): Json<UpdateIdentityReq>,
) -> Response {
    match st.node.update_display_name(&req.display_name) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn list_peers(State(st): State<DesktopState>) -> Response {
    match st.node.list_peers() {
        Ok(peers) => Json(peers).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn connect_peer(State(st): State<DesktopState>, Path(device_id): Path<String>) -> Response {
    match st.node.connect_to_peer(&device_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct RevokeReq {
    revoked: bool,
}

async fn revoke_peer(
    State(st): State<DesktopState>,
    Path(device_id): Path<String>,
    Json(req): Json<RevokeReq>,
) -> Response {
    match st.node.revoke_peer(&device_id, req.revoked).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn list_rooms(State(st): State<DesktopState>) -> Response {
    match st.node.list_rooms() {
        Ok(rooms) => Json(rooms).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomReq {
    name: String,
    default_disappear_seconds: Option<i64>,
}

async fn create_room(State(st): State<DesktopState>, Json(req): Json<CreateRoomReq>) -> Response {
    match st
        .node
        .create_room(&req.name, req.default_disappear_seconds)
    {
        Ok((room, channel, _)) => Json(serde_json::json!({
            "room": room,
            "channel": channel,
        }))
        .into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn list_channels(State(st): State<DesktopState>, Path(room_id): Path<String>) -> Response {
    match st.node.list_channels(&room_id) {
        Ok(chs) => Json(chs).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportTicketReq {
    advertised_addr: Option<String>,
}

async fn export_ticket(
    State(st): State<DesktopState>,
    Path(room_id): Path<String>,
    Json(req): Json<ExportTicketReq>,
) -> Response {
    match st
        .node
        .export_pairing_ticket(&room_id, req.advertised_addr.as_deref())
    {
        Ok(ticket) => Json(serde_json::json!({ "uri": ticket.to_uri() })).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairReq {
    uri: String,
    connectivity_mode: ConnectivityMode,
}

async fn pair_with_ticket(State(st): State<DesktopState>, Json(req): Json<PairReq>) -> Response {
    let ticket = match PairingTicket::from_uri(&req.uri) {
        Ok(t) => t,
        Err(msg) => return map_p2p_error(P2pError::Validation(msg)),
    };
    match st
        .node
        .pair_and_connect(&ticket, req.connectivity_mode)
        .await
    {
        Ok((room, channel)) => Json(serde_json::json!({
            "room": room,
            "channel": channel,
        }))
        .into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn list_messages(
    State(st): State<DesktopState>,
    Path((room_id, channel_id)): Path<(String, String)>,
) -> Response {
    match st.node.list_decrypted_messages(&room_id, &channel_id) {
        Ok(msgs) => Json(msgs).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageReq {
    text: String,
    attachment_ids: Option<Vec<String>>,
    expire_in_seconds: Option<i64>,
    #[serde(default)]
    expire_on_leave: bool,
    expire_after_view_seconds: Option<i64>,
}

async fn send_message(
    State(st): State<DesktopState>,
    Path((room_id, channel_id)): Path<(String, String)>,
    Json(req): Json<SendMessageReq>,
) -> Response {
    match st
        .node
        .send_message_with_ghost_options(
            &room_id,
            &channel_id,
            &req.text,
            req.attachment_ids.unwrap_or_default(),
            None,
            req.expire_in_seconds,
            req.expire_on_leave,
            req.expire_after_view_seconds,
        )
        .await
    {
        Ok(stored) => Json(serde_json::json!({ "id": stored.id })).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct EditReq {
    text: String,
}

async fn edit_message(
    State(st): State<DesktopState>,
    Path((room_id, message_id)): Path<(String, String)>,
    Json(req): Json<EditReq>,
) -> Response {
    match st.node.edit_message(&room_id, &message_id, &req.text).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn delete_message(
    State(st): State<DesktopState>,
    Path((room_id, message_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let scope = q.get("scope").map(String::as_str).unwrap_or("everyone");
    let res = if scope == "me" {
        st.node.delete_message_for_me(&message_id)
    } else {
        st.node.delete_message_everyone(&room_id, &message_id).await
    };
    match res {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn burn_room(State(st): State<DesktopState>, Path(room_id): Path<String>) -> Response {
    match st.node.burn_room_history(&room_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn upload_file(
    State(st): State<DesktopState>,
    Path(room_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let filename = q
        .get("filename")
        .cloned()
        .unwrap_or_else(|| "file.bin".to_string());
    let mime = q
        .get("mimeType")
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    match st
        .node
        .store_and_send_file(&room_id, &filename, &mime, &body)
        .await
    {
        Ok(meta) => Json(meta).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn download_file(
    State(st): State<DesktopState>,
    Path(attachment_id): Path<String>,
) -> Response {
    match st.node.read_verified_attachment(&attachment_id) {
        Ok(bytes) => (
            StatusCode::OK,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            )],
            bytes,
        )
            .into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn send_signal(
    State(st): State<DesktopState>,
    Json(sig): Json<WebRtcSignalPayload>,
) -> Response {
    match st.node.send_webrtc_signal(sig).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

// ==================== Ghost Mode Routes ====================

async fn get_ghost_policy(State(st): State<DesktopState>) -> Response {
    match st.node.get_ghost_policy() {
        Ok(p) => Json(p).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn update_ghost_policy(
    State(st): State<DesktopState>,
    Json(policy): Json<GhostPolicy>,
) -> Response {
    match st.node.update_ghost_policy(policy) {
        Ok(p) => Json(p).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct PinReq {
    pin: Option<String>,
}

async fn set_ghost_pin(State(st): State<DesktopState>, Json(req): Json<PinReq>) -> Response {
    match st.node.set_ghost_pin(req.pin.as_deref()) {
        Ok(p) => Json(p).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn get_ghost_state(State(st): State<DesktopState>) -> Response {
    Json(st.node.get_ghost_state()).into_response()
}

#[derive(Deserialize)]
struct TriggerReq {
    kind: GhostTriggerKind,
}

async fn trigger_ghost_event(
    State(st): State<DesktopState>,
    Json(req): Json<TriggerReq>,
) -> Response {
    match st.node.handle_ghost_trigger(req.kind) {
        Ok(s) => Json(s).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct UnlockReq {
    pin: Option<String>,
}

async fn unlock_ghost_mode(State(st): State<DesktopState>, Json(req): Json<UnlockReq>) -> Response {
    match st.node.unlock_ghost_mode(req.pin.as_deref()) {
        Ok(s) => Json(s).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewedReq {
    room_id: String,
    channel_id: String,
    message_ids: Vec<String>,
}

async fn mark_viewed(State(st): State<DesktopState>, Json(req): Json<ViewedReq>) -> Response {
    match st
        .node
        .mark_messages_viewed(&req.room_id, &req.channel_id, &req.message_ids)
    {
        Ok(updated) => Json(serde_json::json!({ "updated": updated })).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveConvoReq {
    room_id: Option<String>,
    channel_id: Option<String>,
}

async fn set_active_conversation(
    State(st): State<DesktopState>,
    Json(req): Json<ActiveConvoReq>,
) -> Response {
    match st
        .node
        .set_active_conversation(req.room_id.as_deref(), req.channel_id.as_deref())
    {
        Ok(s) => Json(s).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct ModalReq {
    open: bool,
}

async fn set_modal_state(State(st): State<DesktopState>, Json(req): Json<ModalReq>) -> Response {
    Json(st.node.set_in_app_modal_open(req.open)).into_response()
}

async fn list_ghost_overrides(State(st): State<DesktopState>) -> Response {
    match st.node.list_room_ghost_overrides() {
        Ok(list) => Json(list).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn set_ghost_override(
    State(st): State<DesktopState>,
    Path(room_id): Path<String>,
    Json(mut ov): Json<GhostRoomOverride>,
) -> Response {
    ov.room_id = room_id;
    match st.node.set_room_ghost_override(&ov) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

// ==================== Native Screen Capture & Owned File Picker ====================

async fn list_capture_sources() -> Response {
    let sources = tokio::task::spawn_blocking(capture::list_capture_sources)
        .await
        .unwrap_or_default();
    Json(sources).into_response()
}

async fn capture_source_frame(
    Path(source_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let max_width = q
        .get("maxWidth")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(1280);
    let res =
        tokio::task::spawn_blocking(move || capture::capture_source_bmp(&source_id, max_width))
            .await;
    match res {
        Ok(Ok(bmp)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("image/bmp")),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            ],
            bmp,
        )
            .into_response(),
        Ok(Err(msg)) => map_p2p_error(P2pError::NotFound(msg)),
        Err(_) => map_p2p_error(P2pError::Protocol("Capture worker panicked".into())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickFilesReq {
    room_id: String,
}

async fn pick_native_files(
    State(st): State<DesktopState>,
    Json(req): Json<PickFilesReq>,
) -> Response {
    #[cfg(target_os = "windows")]
    {
        st.node.set_in_app_modal_open(true);
        let paths = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Attach Encrypted Files via Cloak P2P")
                .pick_files()
        })
        .await
        .ok()
        .flatten();
        st.node.set_in_app_modal_open(false);

        let Some(files) = paths else {
            return Json(Vec::<cloak_p2p::LocalAttachmentMeta>::new()).into_response();
        };

        let mut uploaded = Vec::new();
        for path in files {
            if let Ok(bytes) = tokio::fs::read(&path).await
                && bytes.len() <= 64 * 1024 * 1024
            {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file.bin");
                if let Ok(meta) = st
                    .node
                    .store_and_send_file(&req.room_id, name, "application/octet-stream", &bytes)
                    .await
                {
                    uploaded.push(meta);
                }
            }
        }
        Json(uploaded).into_response()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (st, req);
        Json(Vec::<cloak_p2p::LocalAttachmentMeta>::new()).into_response()
    }
}

// ==================== Stealth Mode & PDF Library Routes ====================

async fn get_stealth_bootstrap(State(st): State<DesktopState>) -> Response {
    Json(st.node.get_stealth_bootstrap()).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StealthUnlockReq {
    method: UnlockMethod,
    #[serde(default)]
    secret: String,
    additional_secret: Option<String>,
}

async fn stealth_unlock(
    State(st): State<DesktopState>,
    Json(req): Json<StealthUnlockReq>,
) -> Response {
    let secret = req.secret;
    let additional = req.additional_secret;
    let node = st.node.clone();
    match tokio::task::spawn_blocking(move || {
        node.stealth()
            .verify_and_unlock(req.method, &secret, additional.as_deref())
    })
    .await
    {
        Ok(Ok(outcome)) => Json(outcome).into_response(),
        Ok(Err(err)) => map_p2p_error(err),
        Err(_) => map_p2p_error(P2pError::Protocol("Unlock worker panicked".into())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoverReq {
    recovery_code: String,
}

async fn stealth_recover(State(st): State<DesktopState>, Json(req): Json<RecoverReq>) -> Response {
    match st
        .node
        .stealth()
        .recover_unlock_with_recovery_code(&req.recovery_code)
    {
        Ok(outcome) => Json(outcome).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct StealthTriggerReq {
    trigger: PrivacyTriggerKind,
}

async fn stealth_trigger(
    State(st): State<DesktopState>,
    Json(req): Json<StealthTriggerReq>,
) -> Response {
    match st.node.stealth().handle_trigger(req.trigger) {
        Ok(boot) => Json(boot).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn stealth_foreground_activity(State(st): State<DesktopState>) -> Response {
    st.node.stealth().record_foreground_activity();
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemIdleReq {
    idle_ms: u64,
}

async fn stealth_report_system_idle(
    State(st): State<DesktopState>,
    Json(req): Json<SystemIdleReq>,
) -> Response {
    match st.node.stealth().report_system_idle_ms(req.idle_ms) {
        Ok(()) => Json(st.node.get_stealth_bootstrap()).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn stealth_update_call_summary(
    State(st): State<DesktopState>,
    Json(summary): Json<ActiveCallPrivacySummary>,
) -> Response {
    Json(st.node.stealth().update_call_summary(summary)).into_response()
}

async fn stealth_return_messenger(State(st): State<DesktopState>) -> Response {
    match st.node.stealth().switch_to_messenger_if_unlocked() {
        Ok(boot) => Json(boot).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClockAdvanceReq {
    delta_ms: i64,
}

async fn stealth_test_clock_advance(
    State(st): State<DesktopState>,
    Json(req): Json<ClockAdvanceReq>,
) -> Response {
    match st.node.stealth().advance_clock_ms(req.delta_ms) {
        Ok(boot) => Json(boot).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn get_stealth_settings(State(st): State<DesktopState>) -> Response {
    match st.node.stealth().get_config() {
        Ok(cfg) => Json(cfg).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn update_stealth_settings(
    State(st): State<DesktopState>,
    Json(cfg): Json<StealthConfig>,
) -> Response {
    match st.node.stealth().update_config(cfg) {
        Ok(saved) => Json(saved).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn list_stealth_codes(State(st): State<DesktopState>) -> Response {
    match st.node.list_stealth_secret_codes() {
        Ok(codes) => Json(codes).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSecretCodeReq {
    label: String,
    code: String,
    action: SecretCodeAction,
    target_room_id: Option<String>,
    #[serde(default = "default_true")]
    case_sensitive: bool,
    #[serde(default)]
    require_additional_auth: bool,
}

fn default_true() -> bool {
    true
}

async fn create_stealth_code(
    State(st): State<DesktopState>,
    Json(req): Json<CreateSecretCodeReq>,
) -> Response {
    match st.node.add_stealth_secret_code(
        &req.label,
        &req.code,
        req.action,
        req.target_room_id.as_deref(),
        req.case_sensitive,
        req.require_additional_auth,
    ) {
        Ok(meta) => Json(meta).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn delete_stealth_code(State(st): State<DesktopState>, Path(id): Path<String>) -> Response {
    match st.node.remove_stealth_secret_code(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => map_p2p_error(P2pError::NotFound(format!("secret code {id}"))),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
struct PassphraseReq {
    passphrase: Option<String>,
}

async fn set_stealth_passphrase(
    State(st): State<DesktopState>,
    Json(req): Json<PassphraseReq>,
) -> Response {
    match st.node.set_stealth_passphrase(req.passphrase.as_deref()) {
        Ok(configured) => Json(serde_json::json!({ "configured": configured })).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn generate_stealth_recovery(State(st): State<DesktopState>) -> Response {
    match st.node.generate_stealth_recovery_code() {
        Ok(code) => Json(serde_json::json!({ "recoveryCode": code })).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestPreviewReq {
    trigger: PrivacyTriggerKind,
    disposable_total: usize,
    disposable_viewed: usize,
    #[serde(default)]
    deletion_override: Option<LocalDeletionAction>,
}

async fn run_stealth_test_preview(
    State(st): State<DesktopState>,
    Json(req): Json<TestPreviewReq>,
) -> Response {
    let mut cfg = match st.node.stealth().get_config() {
        Ok(c) => c,
        Err(err) => return map_p2p_error(err),
    };
    cfg.enabled = true;
    let ghost = st.node.get_ghost_policy().unwrap_or_default();
    let ghost_mode = match req.deletion_override {
        Some(LocalDeletionAction::DeleteActiveConversation) => {
            cloak_p2p::GhostModeLevel::ClearOpenConversation
        }
        Some(LocalDeletionAction::DeleteViewedLocal)
        | Some(LocalDeletionAction::DeleteIncomingViewedLocal)
        | Some(LocalDeletionAction::DeleteOutgoingViewedLocal) => {
            cloak_p2p::GhostModeLevel::ClearViewed
        }
        _ => ghost.mode,
    };
    let preview = cloak_p2p::stealth::simulate_stealth_test_mode(
        &cfg,
        req.trigger,
        req.disposable_total,
        req.disposable_viewed,
        ghost_mode,
        true,
    );
    Json(preview).into_response()
}

// ==================== Local PDF Library Routes (Decoy-Safe) ====================

async fn list_pdf_docs(State(st): State<DesktopState>) -> Response {
    match st.node.list_pdf_documents() {
        Ok(docs) => Json(docs).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn upload_pdf_doc(
    State(st): State<DesktopState>,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let filename = q
        .get("filename")
        .cloned()
        .unwrap_or_else(|| "document.pdf".to_string());
    let title = q.get("title").map(String::as_str);
    let page_count = q
        .get("pageCount")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(1);
    let make_default = q
        .get("makeDefault")
        .is_some_and(|v| v == "true" || v == "1");
    match st
        .node
        .import_pdf_document(title, &filename, &body, page_count, make_default)
    {
        Ok(doc) => Json(doc).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn pick_native_pdf(State(st): State<DesktopState>) -> Response {
    #[cfg(target_os = "windows")]
    {
        st.node.set_in_app_modal_open(true);
        let paths = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Open Local PDF Document")
                .add_filter("PDF Documents", &["pdf"])
                .pick_files()
        })
        .await
        .ok()
        .flatten();
        st.node.set_in_app_modal_open(false);

        let Some(files) = paths else {
            return Json(Vec::<cloak_p2p::PdfDocumentRecord>::new()).into_response();
        };

        let mut imported = Vec::new();
        for path in files {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("document.pdf");
                if let Ok(doc) = st.node.import_pdf_document(None, name, &bytes, 1, false) {
                    imported.push(doc);
                }
            }
        }
        Json(imported).into_response()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = st;
        Json(Vec::<cloak_p2p::PdfDocumentRecord>::new()).into_response()
    }
}

async fn create_sample_pdf_doc(State(st): State<DesktopState>) -> Response {
    let bytes = build_valid_sample_pdf_bytes();
    match st.node.import_pdf_document(
        Some("Q3 Architecture & Compliance Notes"),
        "q3-architecture-notes.pdf",
        &bytes,
        3,
        false,
    ) {
        Ok(doc) => Json(doc).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn get_pdf_content(State(st): State<DesktopState>, Path(id): Path<String>) -> Response {
    match st.node.read_pdf_bytes(&id) {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/pdf"),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                (
                    header::X_CONTENT_TYPE_OPTIONS,
                    HeaderValue::from_static("nosniff"),
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn patch_pdf_doc(
    State(st): State<DesktopState>,
    Path(id): Path<String>,
    Json(patch): Json<PdfDocumentStateUpdate>,
) -> Response {
    match st.node.update_pdf_document_state(&id, &patch) {
        Ok(doc) => Json(doc).into_response(),
        Err(err) => map_p2p_error(err),
    }
}

async fn delete_pdf_doc(State(st): State<DesktopState>, Path(id): Path<String>) -> Response {
    match st.node.delete_pdf_document(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => map_p2p_error(err),
    }
}

/// Generates a minimal standards-compliant 3-page PDF 1.4 offline with searchable text on each page.
fn build_valid_sample_pdf_bytes() -> Vec<u8> {
    let page_texts = [
        "Quarterly Systems Review\nSection 1: Executive Summary\nAll local storage subsystems passed quarterly integrity\nchecks and offline audit verification.\nSearch keyword: quarterly telemetry baseline.",
        "Section 2: Storage & Encryption\nLocal caches remain segmented by workspace boundary with\ndeterministic backup rotation and hash validation.\nSection 2 confirmed zero external cloud dependencies.",
        "Section 3: Operational Notes\nAll client workstations follow scheduled maintenance windows,\nlocal print archival, and hardware thermal monitoring.\nEnd of Q3 reference handbook.",
    ];

    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets: Vec<usize> = vec![0]; // 1-based xref objects

    let mut push_obj = |body: &str| {
        offsets.push(out.len());
        let id = offsets.len() - 1;
        out.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
    };

    // 1: Catalog, 2: Pages, 3: Helvetica Font
    push_obj("<< /Type /Catalog /Pages 2 0 R >>");
    push_obj("<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>");
    push_obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    for (idx, txt) in page_texts.iter().enumerate() {
        let content_id = 5 + idx * 2;
        push_obj(&format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        ));
        let mut stream = String::from("BT\n/F1 18 Tf\n72 720 Td\n");
        for (li, line) in txt.lines().enumerate() {
            let escaped = line
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)");
            if li == 0 {
                stream.push_str(&format!("({escaped}) Tj\n/F1 12 Tf\n0 -32 Td\n"));
            } else {
                stream.push_str(&format!("({escaped}) Tj\n0 -20 Td\n"));
            }
        }
        stream.push_str("ET\n");
        push_obj(&format!(
            "<< /Length {} >>\nstream\n{}endstream",
            stream.len(),
            stream
        ));
    }

    let xref_pos = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for off in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    out
}

// ==================== WebSocket & Embedded Assets ====================

async fn ws_events(ws: WebSocketUpgrade, State(st): State<DesktopState>) -> Response {
    ws.on_upgrade(|socket| handle_ws(socket, st.node))
}

async fn handle_ws(socket: WebSocket, node: P2pNode) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = node.subscribe();
    let send_task = tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let outbound = if node.is_stealth_locked() {
                let boot = node.get_stealth_bootstrap();
                match &ev {
                    cloak_p2p::NodeEvent::StealthStateChanged(_) => Some(ev),
                    cloak_p2p::NodeEvent::MessageReceived { .. }
                    | cloak_p2p::NodeEvent::AttachmentReceived { .. } => {
                        if matches!(
                            boot.notification_level_now,
                            NotificationPrivacyLevel::Disabled | NotificationPrivacyLevel::Silent
                        ) {
                            None
                        } else {
                            // Never leak plaintext/roomId/senderId over WS while Stealth Mode is locked!
                            Some(cloak_p2p::NodeEvent::GhostStateChanged(
                                node.get_ghost_state(),
                            ))
                        }
                    }
                    _ => None,
                }
            } else {
                Some(ev)
            };

            if let Some(ev_to_send) = outbound
                && let Ok(json) = serde_json::to_string(&ev_to_send)
                && sender.send(Message::Text(json.into())).await.is_err()
            {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = receiver.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }
    send_task.abort();
}

async fn serve_embedded_web(uri: axum::http::Uri) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    let file = if raw_path.is_empty() {
        DIST_DIR.get_file("index.html")
    } else {
        DIST_DIR
            .get_file(raw_path)
            .or_else(|| DIST_DIR.get_file("index.html"))
    };

    let Some(file) = file else {
        return (StatusCode::NOT_FOUND, "Embedded frontend missing").into_response();
    };

    let content_type = match file.path().extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("webmanifest") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    };

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
        file.contents(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU16;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn desktop_embedded_ui_security_guard_and_two_instance_p2p_flow() {
        let dir_a = std::env::temp_dir().join(format!("cloak-desk-a-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("cloak-desk-b-{}", std::process::id()));
        let node_a = P2pNode::start(&dir_a, "127.0.0.1:0", "DesktopA")
            .await
            .unwrap();
        let node_b = P2pNode::start(&dir_b, "127.0.0.1:0", "DesktopB")
            .await
            .unwrap();

        let l_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_a = l_a.local_addr().unwrap();
        let l_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_b = l_b.local_addr().unwrap();

        let tok_a = "tok-alpha-test-secret".to_string();
        let tok_b = "tok-beta-test-secret".to_string();

        let app_a = build_router(DesktopState {
            node: node_a.clone(),
            data_dir: dir_a.clone(),
            session_token: tok_a.clone(),
            expected_http_port: Arc::new(AtomicU16::new(addr_a.port())),
        });
        let app_b = build_router(DesktopState {
            node: node_b.clone(),
            data_dir: dir_b.clone(),
            session_token: tok_b.clone(),
            expected_http_port: Arc::new(AtomicU16::new(addr_b.port())),
        });

        let srv_a = tokio::spawn(async move {
            let _ = axum::serve(l_a, app_a).await;
        });
        let srv_b = tokio::spawn(async move {
            let _ = axum::serve(l_b, app_b).await;
        });

        let client = reqwest::Client::new();

        // Loopback security checks: unauthenticated or cross-origin requests must fail closed
        let unauth = client
            .get(format!("http://{addr_a}/p2p/v1/status"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

        let evil_origin = client
            .get(format!("http://{addr_a}/p2p/v1/status"))
            .header("Origin", "https://evil.example")
            .header("Authorization", format!("Bearer {tok_a}"))
            .send()
            .await
            .unwrap();
        assert_eq!(evil_origin.status(), reqwest::StatusCode::FORBIDDEN);

        // Verify embedded frontend serves HTML cleanly
        let index_html = client
            .get(format!("http://{addr_a}/p2p"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(index_html.contains("<!doctype html>") || index_html.contains("<html"));

        // Create room on Desktop A and export pairing ticket
        let created: serde_json::Value = client
            .post(format!("http://{addr_a}/p2p/v1/rooms"))
            .bearer_auth(&tok_a)
            .json(&serde_json::json!({ "name": "Desktop Room" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let room_id = created["room"]["id"].as_str().unwrap();
        let chan_id = created["channel"]["id"].as_str().unwrap();

        let ticket: serde_json::Value = client
            .post(format!("http://{addr_a}/p2p/v1/rooms/{room_id}/ticket"))
            .bearer_auth(&tok_a)
            .json(&serde_json::json!({ "advertisedAddr": null }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let uri = ticket["uri"].as_str().unwrap();

        // Desktop B pairs directly using strict direct_only
        let paired_resp = client
            .post(format!("http://{addr_b}/p2p/v1/pair"))
            .bearer_auth(&tok_b)
            .json(&serde_json::json!({
                "uri": uri,
                "connectivityMode": { "mode": "direct_only" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(paired_resp.status(), reqwest::StatusCode::OK);

        // Send message from Desktop A and verify Desktop B retrieves decrypted plaintext from its own SQLite DB
        let send_resp = client
            .post(format!(
                "http://{addr_a}/p2p/v1/rooms/{room_id}/channels/{chan_id}/messages"
            ))
            .bearer_auth(&tok_a)
            .json(&serde_json::json!({ "text": "Hello from native Rust desktop!" }))
            .send()
            .await
            .unwrap();
        assert_eq!(send_resp.status(), reqwest::StatusCode::OK);

        let mut received = false;
        for _ in 0..30 {
            let msgs: serde_json::Value = client
                .get(format!(
                    "http://{addr_b}/p2p/v1/rooms/{room_id}/channels/{chan_id}/messages"
                ))
                .bearer_auth(&tok_b)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if msgs.as_array().is_some_and(|arr| {
                arr.iter()
                    .any(|m| m["text"] == "Hello from native Rust desktop!")
            }) {
                received = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(received);

        // Verify network diagnostics + native capture endpoints cleanly
        let diag: serde_json::Value = client
            .get(format!("http://{addr_a}/p2p/v1/network/diagnostics"))
            .bearer_auth(&tok_a)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(diag["listenAddr"].is_string());

        let sources: serde_json::Value = client
            .get(format!("http://{addr_a}/p2p/v1/capture/sources"))
            .bearer_auth(&tok_a)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(sources.is_array());

        srv_a.abort();
        srv_b.abort();
        node_a.shutdown();
        node_b.shutdown();
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    #[tokio::test]
    async fn stealth_locked_blocks_private_routes_until_secret_code_unlock() {
        let dir = std::env::temp_dir().join(format!(
            "cloak-http-stealth-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let node = P2pNode::start(&dir, "127.0.0.1:0", "StealthHttp")
            .await
            .unwrap();
        let (_room, _chan, _) = node.create_room("Top Secret Ops", None).unwrap();
        node.add_stealth_secret_code(
            "PDF Gate",
            "#vault-alpha",
            cloak_p2p::SecretCodeAction::OpenMessenger,
            None,
            true,
            false,
        )
        .unwrap();
        let mut cfg = node.stealth().get_config().unwrap();
        cfg.enabled = true;
        cfg.launch_view = cloak_p2p::StealthLaunchView::PdfReader;
        node.stealth().update_config(cfg).unwrap();
        node.stealth()
            .handle_trigger(cloak_p2p::PrivacyTriggerKind::ManualLock)
            .unwrap();
        assert!(node.is_stealth_locked());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let tok = "tok-stealth-http".to_string();
        let app = build_router(DesktopState {
            node: node.clone(),
            data_dir: dir.clone(),
            session_token: tok.clone(),
            expected_http_port: Arc::new(AtomicU16::new(addr.port())),
        });
        let srv = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();

        // While locked, ALL private routes MUST return 403 STEALTH_LOCKED with zero leakage
        for path in [
            "/p2p/v1/status",
            "/p2p/v1/rooms",
            "/p2p/v1/peers",
            "/p2p/v1/stealth/settings",
            "/p2p/v1/stealth/codes",
            "/p2p/v1/ghost/policy",
        ] {
            let resp = client
                .get(format!("http://{addr}{path}"))
                .bearer_auth(&tok)
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN, "path {path}");
            let body = resp.text().await.unwrap();
            assert!(body.contains("STEALTH_LOCKED"));
            assert!(!body.contains("Top Secret Ops"));
        }

        // Bootstrap & PDF endpoints MUST remain available cleanly while locked
        let boot: serde_json::Value = client
            .get(format!("http://{addr}/p2p/v1/stealth/bootstrap"))
            .bearer_auth(&tok)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(boot["locked"], true);
        assert_eq!(boot["activeSurface"], "pdf_reader");

        let sample_pdf = client
            .post(format!("http://{addr}/p2p/v1/pdf/documents/sample"))
            .bearer_auth(&tok)
            .send()
            .await
            .unwrap();
        assert_eq!(sample_pdf.status(), reqwest::StatusCode::OK);

        // Unlock with valid user-defined secret code via pdf_search -> private routes reopen!
        let unlock: serde_json::Value = client
            .post(format!("http://{addr}/p2p/v1/stealth/unlock"))
            .bearer_auth(&tok)
            .json(&serde_json::json!({
                "method": "pdf_search",
                "secret": "#vault-alpha"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(unlock["unlocked"], true);

        let rooms_resp = client
            .get(format!("http://{addr}/p2p/v1/rooms"))
            .bearer_auth(&tok)
            .send()
            .await
            .unwrap();
        assert_eq!(rooms_resp.status(), reqwest::StatusCode::OK);
        let rooms_txt = rooms_resp.text().await.unwrap();
        assert!(rooms_txt.contains("Top Secret Ops"));

        // Trigger ManualLock -> 403 STEALTH_LOCKED re-engages immediately
        let lock_resp = client
            .post(format!("http://{addr}/p2p/v1/stealth/trigger"))
            .bearer_auth(&tok)
            .json(&serde_json::json!({ "trigger": "manual_lock" }))
            .send()
            .await
            .unwrap();
        assert_eq!(lock_resp.status(), reqwest::StatusCode::OK);

        let relocked = client
            .get(format!("http://{addr}/p2p/v1/rooms"))
            .bearer_auth(&tok)
            .send()
            .await
            .unwrap();
        assert_eq!(relocked.status(), reqwest::StatusCode::FORBIDDEN);

        srv.abort();
        node.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
