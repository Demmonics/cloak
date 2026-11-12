use cloak_core::{
    config::AppConfig, livekit::LiveKitClient, object_store::ObjectStore, state_store::StateStore,
};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub state_store: StateStore,
    pub object_store: ObjectStore,
    pub livekit: LiveKitClient,
    pub config: AppConfig,
    pub ws_hub: Arc<WsHub>,
}

#[derive(Default)]
pub struct WsHub {
    rooms: RwLock<HashMap<Uuid, broadcast::Sender<String>>>,
}

impl WsHub {
    pub async fn subscribe_room(&self, room_id: Uuid) -> broadcast::Receiver<String> {
        {
            let guard = self.rooms.read().await;
            if let Some(tx) = guard.get(&room_id) {
                return tx.subscribe();
            }
        }
        let mut guard = self.rooms.write().await;
        let tx = guard
            .entry(room_id)
            .or_insert_with(|| broadcast::channel(512).0);
        tx.subscribe()
    }

    pub async fn broadcast_room(&self, room_id: Uuid, payload_json: String) {
        let guard = self.rooms.read().await;
        if let Some(tx) = guard.get(&room_id) {
            let _ = tx.send(payload_json);
        }
    }
}
