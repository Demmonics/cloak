pub mod authz;
pub mod error;
pub mod extractors;
pub mod routes;
pub mod state;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Method, Request, header},
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, patch, post, put},
};
use std::sync::Arc;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

use crate::{
    error::ApiError,
    extractors::validate_origin_headers,
    state::{AppState, WsHub},
};
use cloak_core::{
    config::AppConfig, db::connect_and_migrate, livekit::LiveKitClient, object_store::ObjectStore,
    state_store::StateStore,
};

pub async fn build_state(config: AppConfig) -> Result<AppState, cloak_core::error::CloakError> {
    let db = connect_and_migrate(&config.database_url, config.database_max_connections).await?;
    let state_store = match &config.redis_url {
        Some(url) if !config.allow_in_memory_redis => StateStore::connect_redis(url).await?,
        Some(url) => match StateStore::connect_redis(url).await {
            Ok(store) => store,
            Err(err) => {
                tracing::warn!(error = %err, "Redis unreachable; using single-node in-memory dev state store");
                StateStore::in_memory_dev()
            }
        },
        None => {
            tracing::warn!(
                "Using single-node in-memory dev state store (requires Redis in production)"
            );
            StateStore::in_memory_dev()
        }
    };
    let object_store = ObjectStore::from_config(&config).await?;
    let livekit = LiveKitClient::new(
        config.livekit_url.clone(),
        config.livekit_http_url.clone(),
        config.livekit_api_key.clone(),
        config.livekit_api_secret.clone(),
    );

    Ok(AppState {
        db,
        state_store,
        object_store,
        livekit,
        config,
        ws_hub: Arc::new(WsHub::default()),
    })
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "cloak-api", "version": "v1" }))
}

async fn origin_guard_middleware(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, ApiError> {
    validate_origin_headers(req.method(), req.headers(), &state.config.allowed_origins)
        .map_err(ApiError)?;
    Ok(next.run(req).await)
}

pub fn build_router(state: AppState) -> Router {
    let allowed_origins = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect::<Vec<_>>();

    let cors = if allowed_origins.is_empty() {
        CorsLayer::new()
    } else {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(allowed_origins))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
    };

    let api_v1 = Router::new()
        .route("/health", get(health))
        .route("/devices/register", post(routes::auth::register_device))
        .route("/devices/me", patch(routes::auth::update_me))
        .route("/auth/challenge", post(routes::auth::create_challenge))
        .route("/auth/session", post(routes::auth::exchange_session))
        .route("/auth/logout", post(routes::auth::logout))
        .route(
            "/rooms",
            post(routes::rooms::create_room).get(routes::rooms::list_rooms),
        )
        .route(
            "/rooms/{room_id}",
            get(routes::rooms::get_room).patch(routes::rooms::update_room),
        )
        .route(
            "/rooms/{room_id}/channels",
            post(routes::rooms::create_channel),
        )
        .route(
            "/rooms/{room_id}/channels/{channel_id}",
            patch(routes::rooms::update_channel).delete(routes::rooms::delete_channel),
        )
        .route(
            "/rooms/{room_id}/epochs/rotate",
            post(routes::rooms::rotate_epoch),
        )
        .route(
            "/rooms/{room_id}/burn",
            post(routes::rooms::burn_room_history),
        )
        .route(
            "/rooms/{room_id}/invites",
            post(routes::invites::create_invite).get(routes::invites::list_invites),
        )
        .route(
            "/rooms/{room_id}/invites/{invite_id}",
            delete(routes::invites::revoke_invite),
        )
        .route("/invites/inspect", get(routes::invites::inspect_invite))
        .route("/invites/join", post(routes::invites::join_invite))
        .route(
            "/rooms/{room_id}/members/{device_id}/approve",
            post(routes::invites::approve_member),
        )
        .route(
            "/rooms/{room_id}/members/{device_id}/role",
            post(routes::invites::update_member_role),
        )
        .route(
            "/rooms/{room_id}/members/{device_id}/remove",
            post(routes::invites::remove_member),
        )
        .route(
            "/rooms/{room_id}/channels/{channel_id}/messages",
            post(routes::messages::send_message).get(routes::messages::get_channel_messages),
        )
        .route(
            "/rooms/{room_id}/channels/{channel_id}/clear",
            post(routes::messages::clear_channel_messages),
        )
        .route("/rooms/{room_id}/sync", get(routes::messages::sync_room))
        .route(
            "/rooms/{room_id}/messages/{message_id}",
            patch(routes::messages::edit_message).delete(routes::messages::delete_message),
        )
        .route(
            "/rooms/{room_id}/messages/{message_id}/react",
            post(routes::messages::react_message),
        )
        .route(
            "/rooms/{room_id}/messages/{message_id}/pin",
            post(routes::messages::pin_message).delete(routes::messages::unpin_message),
        )
        .route(
            "/rooms/{room_id}/attachments/init",
            post(routes::attachments::init_attachment),
        )
        .route(
            "/rooms/{room_id}/attachments",
            get(routes::attachments::list_room_attachments),
        )
        .route(
            "/attachments/{attachment_id}/chunks/{chunk_index}",
            put(routes::attachments::upload_chunk)
                .get(routes::attachments::download_chunk)
                .layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .route(
            "/attachments/{attachment_id}/complete",
            post(routes::attachments::complete_attachment),
        )
        .route(
            "/attachments/{attachment_id}",
            get(routes::attachments::get_attachment_meta)
                .delete(routes::attachments::delete_attachment),
        )
        .route(
            "/rooms/{room_id}/channels/{channel_id}/call-token",
            post(routes::calls::issue_call_token),
        )
        .route("/ws", get(routes::ws::ws_handler));

    Router::new()
        .nest("/api/v1", api_v1)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            origin_guard_middleware,
        ))
        .layer(cors)
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin-allow-popups"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
