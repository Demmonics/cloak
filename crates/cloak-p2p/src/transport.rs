use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::RngCore;
use rand::rngs::OsRng;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{RwLock, broadcast, mpsc};
use uuid::Uuid;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

use crate::crypto::{
    DeviceIdentity, HandshakeAck, PeerHandshake, REKEY_AFTER_FRAMES, TransportSessionCrypto,
    generate_room_key_b64,
};
use crate::error::{P2pError, P2pResult};
use crate::ghost::{evaluate_trigger, resolve_effective_mode};
use crate::model::{
    ConnectivityMode, DecryptedMessageView, DeletionTombstone, GhostModeLevel, GhostPolicy,
    GhostRoomOverride, GhostRuntimeState, GhostTriggerKind, LocalAttachmentMeta, LocalChannel,
    LocalRoom, NetworkDiagnostics, NodeEvent, PairingTicket, PeerConnectionState, PeerSummary,
    StoredMessage, TombstoneScope, WebRtcSignalPayload, WireFrame,
};
use crate::netinfo::{collect_network_diagnostics, enumerate_interface_candidates};
use crate::stealth::{
    PdfDocumentRecord, PdfDocumentStateUpdate, PrivacyTriggerKind, SecretCodeAction,
    SecretCodeMetadata, StealthBootstrapState,
};
use crate::stealth_controller::StealthController;
use crate::storage::LocalVault;

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const DIRECT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_FILE_CHUNK_BYTES: usize = 64 * 1024;
const REPLAY_CACHE_CAP: usize = 2048;

type ActivePeersMap = Arc<RwLock<HashMap<String, mpsc::Sender<WireFrame>>>>;
type PeerStatesMap = Arc<RwLock<HashMap<String, PeerConnectionState>>>;

/// High-level local-first P2P desktop node combining SQLite persistence, direct encrypted TCP transport,
/// and authoritative Rust-side Ghost & Stealth Mode privacy state management.
#[derive(Clone)]
pub struct P2pNode {
    vault: Arc<Mutex<LocalVault>>,
    local_addr: SocketAddr,
    active_peers: ActivePeersMap,
    peer_states: PeerStatesMap,
    ghost_state: Arc<Mutex<GhostRuntimeState>>,
    stealth: StealthController,
    events: broadcast::Sender<NodeEvent>,
    shutdown_tx: Arc<tokio::sync::watch::Sender<bool>>,
}

impl P2pNode {
    /// Starts the local SQLite vault, binds the direct P2P listener on `bind_addr`,
    /// and starts accept, TTL expiry, and peer auto-reconnect loops.
    pub async fn start(
        data_dir: impl AsRef<Path>,
        bind_addr: &str,
        default_display_name: &str,
    ) -> P2pResult<Self> {
        let vault = LocalVault::open(data_dir, default_display_name)?;
        let listener = TcpListener::bind(bind_addr).await?;
        let local_addr = listener.local_addr()?;

        let initial_policy = vault.get_ghost_policy().unwrap_or_default();
        let initial_ghost = GhostRuntimeState {
            enabled: initial_policy.enabled && initial_policy.mode != GhostModeLevel::Off,
            effective_mode: initial_policy.mode,
            capture_protection_active: initial_policy.capture_protection,
            ..GhostRuntimeState::default()
        };

        let (events, _) = broadcast::channel(512);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        let vault_arc = Arc::new(Mutex::new(vault));
        let stealth = StealthController::new(vault_arc.clone(), events.clone());

        let node = Self {
            vault: vault_arc,
            local_addr,
            active_peers: Arc::new(RwLock::new(HashMap::new())),
            peer_states: Arc::new(RwLock::new(HashMap::new())),
            ghost_state: Arc::new(Mutex::new(initial_ghost)),
            stealth,
            events,
            shutdown_tx: Arc::new(shutdown_tx),
        };

        // Incoming P2P TCP accept loop
        let accept_node = node.clone();
        let mut accept_shutdown = shutdown_rx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = accept_shutdown.changed() => {
                        if *accept_shutdown.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, remote_addr)) => {
                                let peer_node = accept_node.clone();
                                tokio::spawn(async move {
                                    if let Err(err) = peer_node.handle_connection(stream, remote_addr, false, None).await {
                                        tracing::debug!(?err, %remote_addr, "Incoming peer session ended");
                                    }
                                });
                            }
                            Err(err) => {
                                tracing::warn!(?err, "P2P listener accept error");
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                }
            }
        });

        // Background auto-reconnect, disappearing TTL purge, & Stealth timer loop
        let bg_node = node.clone();
        let mut bg_shutdown = shutdown_rx;
        tokio::spawn(async move {
            let mut reconnect_interval = tokio::time::interval(Duration::from_secs(12));
            let mut ttl_interval = tokio::time::interval(Duration::from_secs(2));
            let mut stealth_interval = tokio::time::interval(Duration::from_millis(500));
            loop {
                tokio::select! {
                    _ = bg_shutdown.changed() => {
                        if *bg_shutdown.borrow() {
                            break;
                        }
                    }
                    _ = stealth_interval.tick() => {
                        let _ = bg_node.stealth.tick_timers();
                    }
                    _ = ttl_interval.tick() => {
                        let purged = {
                            let vault = bg_node.vault.lock().unwrap();
                            vault.purge_expired_messages().unwrap_or_default()
                        };
                        if !purged.is_empty() {
                            let mut seen_rooms = std::collections::HashSet::new();
                            for t in purged {
                                if seen_rooms.insert(t.room_id.clone()) {
                                    let _ = bg_node.events.send(NodeEvent::HistoryChanged {
                                        room_id: t.room_id,
                                        scope: "expired".into(),
                                    });
                                }
                            }
                        }
                    }
                    _ = reconnect_interval.tick() => {
                        let peers = bg_node.vault.lock().unwrap().list_peers().unwrap_or_default();
                        for peer in peers {
                            if peer.revoked {
                                continue;
                            }
                            if !bg_node.active_peers.read().await.contains_key(&peer.device_id) {
                                let _ = bg_node.events.send(NodeEvent::PeerReconnecting {
                                    device_id: peer.device_id.clone(),
                                    attempt: 1,
                                    detail: format!("Attempting background direct reconnect to {}", peer.direct_addr),
                                });
                                let _ = bg_node.connect_to_peer(&peer.device_id).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(node)
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NodeEvent> {
        self.events.subscribe()
    }

    pub fn shutdown(&self) {
        let _ = self.handle_ghost_trigger(GhostTriggerKind::AppClose);
        let _ = self.shutdown_tx.send(true);
    }

    pub async fn active_peer_ids(&self) -> Vec<String> {
        self.active_peers.read().await.keys().cloned().collect()
    }

    pub async fn peer_connection_states(&self) -> HashMap<String, PeerConnectionState> {
        self.peer_states.read().await.clone()
    }

    pub fn network_diagnostics(&self) -> NetworkDiagnostics {
        let dpapi = self.vault.lock().unwrap().is_dpapi_protected();
        collect_network_diagnostics(self.local_addr, dpapi)
    }

    pub fn identity(&self) -> P2pResult<DeviceIdentity> {
        self.vault.lock().unwrap().identity()
    }

    pub fn update_display_name(&self, name: &str) -> P2pResult<()> {
        self.vault.lock().unwrap().update_display_name(name)
    }

    pub fn list_rooms(&self) -> P2pResult<Vec<LocalRoom>> {
        self.vault.lock().unwrap().list_rooms()
    }

    pub fn list_channels(&self, room_id: &str) -> P2pResult<Vec<LocalChannel>> {
        self.vault.lock().unwrap().list_channels(room_id)
    }

    pub fn list_peers(&self) -> P2pResult<Vec<PeerSummary>> {
        self.vault.lock().unwrap().list_peers()
    }

    pub fn upsert_peer(&self, peer: &PeerSummary) -> P2pResult<()> {
        self.vault.lock().unwrap().upsert_peer(peer)
    }

    pub async fn revoke_peer(&self, device_id: &str, revoked: bool) -> P2pResult<()> {
        self.vault.lock().unwrap().revoke_peer(device_id, revoked)?;
        if revoked {
            self.active_peers.write().await.remove(device_id);
            self.peer_states
                .write()
                .await
                .insert(device_id.to_string(), PeerConnectionState::Revoked);
        } else {
            self.peer_states
                .write()
                .await
                .insert(device_id.to_string(), PeerConnectionState::Disconnected);
        }
        Ok(())
    }

    pub fn create_room(
        &self,
        name: &str,
        default_disappear_seconds: Option<i64>,
    ) -> P2pResult<(LocalRoom, LocalChannel, String)> {
        self.vault
            .lock()
            .unwrap()
            .create_room(None, name, None, default_disappear_seconds)
    }

    // ==================== Stealth Mode & PDF Library ====================

    pub fn stealth(&self) -> &StealthController {
        &self.stealth
    }

    pub fn is_stealth_locked(&self) -> bool {
        self.stealth.is_locked()
    }

    pub fn get_stealth_bootstrap(&self) -> StealthBootstrapState {
        self.stealth.bootstrap_state()
    }

    pub fn add_stealth_secret_code(
        &self,
        label: &str,
        raw_code: &str,
        action: SecretCodeAction,
        target_room_id: Option<&str>,
        case_sensitive: bool,
        require_additional_auth: bool,
    ) -> P2pResult<SecretCodeMetadata> {
        self.vault.lock().unwrap().add_secret_code(
            label,
            raw_code,
            action,
            target_room_id,
            case_sensitive,
            require_additional_auth,
        )
    }

    pub fn list_stealth_secret_codes(&self) -> P2pResult<Vec<SecretCodeMetadata>> {
        self.vault.lock().unwrap().list_secret_code_metadata()
    }

    pub fn remove_stealth_secret_code(&self, id: &str) -> P2pResult<bool> {
        self.vault.lock().unwrap().remove_secret_code(id)
    }

    pub fn set_stealth_passphrase(&self, passphrase: Option<&str>) -> P2pResult<bool> {
        self.vault
            .lock()
            .unwrap()
            .set_stealth_passphrase(passphrase)
    }

    pub fn generate_stealth_recovery_code(&self) -> P2pResult<String> {
        self.vault
            .lock()
            .unwrap()
            .generate_and_store_recovery_code()
    }

    pub fn import_pdf_document(
        &self,
        title: Option<&str>,
        filename: &str,
        bytes: &[u8],
        page_count: u32,
        make_default: bool,
    ) -> P2pResult<PdfDocumentRecord> {
        self.vault.lock().unwrap().import_pdf_document(
            title,
            filename,
            bytes,
            page_count,
            make_default,
        )
    }

    pub fn list_pdf_documents(&self) -> P2pResult<Vec<PdfDocumentRecord>> {
        self.vault.lock().unwrap().list_pdf_documents()
    }

    pub fn read_pdf_bytes(&self, doc_id: &str) -> P2pResult<Vec<u8>> {
        self.vault.lock().unwrap().read_pdf_bytes(doc_id)
    }

    pub fn update_pdf_document_state(
        &self,
        doc_id: &str,
        patch: &PdfDocumentStateUpdate,
    ) -> P2pResult<PdfDocumentRecord> {
        self.vault
            .lock()
            .unwrap()
            .update_pdf_document_state(doc_id, patch)
    }

    pub fn delete_pdf_document(&self, doc_id: &str) -> P2pResult<()> {
        self.vault.lock().unwrap().delete_pdf_document(doc_id)
    }

    // ==================== Authoritative Ghost Mode Controller ====================

    pub fn get_ghost_policy(&self) -> P2pResult<GhostPolicy> {
        self.vault.lock().unwrap().get_ghost_policy()
    }

    pub fn update_ghost_policy(&self, policy: GhostPolicy) -> P2pResult<GhostPolicy> {
        let updated = self.vault.lock().unwrap().update_ghost_policy(policy)?;
        let room_id = self.ghost_state.lock().unwrap().active_room_id.clone();
        let room_override = room_id.as_deref().and_then(|rid| {
            self.vault
                .lock()
                .unwrap()
                .get_room_ghost_override(rid)
                .ok()
                .flatten()
        });
        let (eff_enabled, eff_mode, _) = resolve_effective_mode(&updated, room_override.as_ref());

        let snapshot = {
            let mut st = self.ghost_state.lock().unwrap();
            st.enabled = eff_enabled;
            st.effective_mode = eff_mode;
            st.capture_protection_active = updated.capture_protection;
            if !eff_enabled {
                st.shielded = false;
                st.pin_locked = false;
            }
            st.clone()
        };
        let _ = self.events.send(NodeEvent::GhostStateChanged(snapshot));
        Ok(updated)
    }

    pub fn set_ghost_pin(&self, new_pin: Option<&str>) -> P2pResult<GhostPolicy> {
        let updated = self.vault.lock().unwrap().set_ghost_pin(new_pin)?;
        if !updated.has_pin_configured {
            let mut st = self.ghost_state.lock().unwrap();
            st.pin_locked = false;
        }
        Ok(updated)
    }

    pub fn set_room_ghost_override(&self, ov: &GhostRoomOverride) -> P2pResult<()> {
        self.vault.lock().unwrap().set_room_ghost_override(ov)?;
        let active_room = self.ghost_state.lock().unwrap().active_room_id.clone();
        if active_room.as_deref() == Some(ov.room_id.as_str()) {
            let policy = self.get_ghost_policy()?;
            let (eff_enabled, eff_mode, _) = resolve_effective_mode(&policy, Some(ov));
            let snapshot = {
                let mut st = self.ghost_state.lock().unwrap();
                st.enabled = eff_enabled;
                st.effective_mode = eff_mode;
                st.clone()
            };
            let _ = self.events.send(NodeEvent::GhostStateChanged(snapshot));
        }
        Ok(())
    }

    pub fn list_room_ghost_overrides(&self) -> P2pResult<Vec<GhostRoomOverride>> {
        self.vault.lock().unwrap().list_room_ghost_overrides()
    }

    pub fn get_ghost_state(&self) -> GhostRuntimeState {
        self.ghost_state.lock().unwrap().clone()
    }

    pub fn set_in_app_modal_open(&self, open: bool) -> GhostRuntimeState {
        self.stealth.set_modal_open(open);
        let mut st = self.ghost_state.lock().unwrap();
        if open {
            st.in_app_modal_depth = st.in_app_modal_depth.saturating_add(1);
        } else {
            st.in_app_modal_depth = st.in_app_modal_depth.saturating_sub(1);
        }
        let snapshot = st.clone();
        drop(st);
        let _ = self
            .events
            .send(NodeEvent::GhostStateChanged(snapshot.clone()));
        snapshot
    }

    pub fn set_active_conversation(
        &self,
        room_id: Option<&str>,
        channel_id: Option<&str>,
    ) -> P2pResult<GhostRuntimeState> {
        let (prev_room, prev_chan) = {
            let st = self.ghost_state.lock().unwrap();
            (st.active_room_id.clone(), st.active_channel_id.clone())
        };

        // If user switched away from an active channel/room, purge any `expire_on_leave` messages in it cleanly
        if let (Some(pr), Some(pc)) = (prev_room, prev_chan)
            && (Some(pr.as_str()) != room_id || Some(pc.as_str()) != channel_id)
        {
            let purged = self
                .vault
                .lock()
                .unwrap()
                .purge_on_leave_messages(&pr, &pc)?;
            if purged > 0 {
                let _ = self.events.send(NodeEvent::HistoryChanged {
                    room_id: pr,
                    scope: "ghost_on_leave".into(),
                });
            }
        }

        let policy = self.get_ghost_policy()?;
        let room_override = room_id.and_then(|rid| {
            self.vault
                .lock()
                .unwrap()
                .get_room_ghost_override(rid)
                .ok()
                .flatten()
        });
        let (eff_enabled, eff_mode, _) = resolve_effective_mode(&policy, room_override.as_ref());
        self.stealth.set_active_conversation(room_id, channel_id);

        let snapshot = {
            let mut st = self.ghost_state.lock().unwrap();
            st.active_room_id = room_id.map(ToOwned::to_owned);
            st.active_channel_id = channel_id.map(ToOwned::to_owned);
            st.enabled = eff_enabled;
            st.effective_mode = eff_mode;
            st.clone()
        };
        let _ = self
            .events
            .send(NodeEvent::GhostStateChanged(snapshot.clone()));
        Ok(snapshot)
    }

    /// Persists viewport dwell view-tracking strictly only if Cloak is foreground, visible, and unlocked.
    pub fn mark_messages_viewed(
        &self,
        room_id: &str,
        channel_id: &str,
        message_ids: &[String],
    ) -> P2pResult<usize> {
        let st = self.ghost_state.lock().unwrap().clone();
        if st.shielded
            || st.pin_locked
            || !st.window_focused
            || st.minimized
            || st.session_locked
            || self.stealth.is_locked()
        {
            return Ok(0);
        }
        self.vault
            .lock()
            .unwrap()
            .mark_messages_viewed(room_id, channel_id, message_ids)
    }

    pub fn unlock_ghost_mode(&self, pin_candidate: Option<&str>) -> P2pResult<GhostRuntimeState> {
        let policy = self.get_ghost_policy()?;
        if policy.require_pin_unlock && policy.has_pin_configured {
            let candidate = pin_candidate.unwrap_or_default();
            if !self.vault.lock().unwrap().verify_ghost_pin(candidate)? {
                return Err(P2pError::PeerRejected("Incorrect Ghost Mode PIN".into()));
            }
        }
        let snapshot = {
            let mut st = self.ghost_state.lock().unwrap();
            st.pin_locked = false;
            st.shielded = false;
            st.window_focused = true;
            st.minimized = false;
            st.session_locked = false;
            st.clone()
        };
        let _ = self
            .events
            .send(NodeEvent::GhostStateChanged(snapshot.clone()));
        Ok(snapshot)
    }

    /// Processes a native Win32 or lifecycle privacy trigger atomically in Rust.
    pub fn handle_ghost_trigger(&self, kind: GhostTriggerKind) -> P2pResult<GhostRuntimeState> {
        if self
            .stealth
            .get_config()
            .map(|c| c.enabled)
            .unwrap_or(false)
        {
            let mapped = match kind {
                GhostTriggerKind::ExternalFocusLoss => Some(PrivacyTriggerKind::FocusLoss),
                GhostTriggerKind::Minimize => Some(PrivacyTriggerKind::Minimize),
                GhostTriggerKind::SessionLock => Some(PrivacyTriggerKind::SessionLock),
                GhostTriggerKind::AppClose => Some(PrivacyTriggerKind::WindowClose),
                GhostTriggerKind::ManualLock => Some(PrivacyTriggerKind::ManualLock),
                GhostTriggerKind::RestoreFocus => {
                    let _ = self.stealth.notify_window_focus_restored(false);
                    None
                }
                GhostTriggerKind::Unlock => None,
            };
            if let Some(st_trig) = mapped {
                let boot = self.stealth.handle_trigger(st_trig)?;
                let mut st = self.ghost_state.lock().unwrap();
                st.shielded = boot.locked;
                st.pin_locked = boot.locked;
                st.window_focused = !matches!(
                    kind,
                    GhostTriggerKind::ExternalFocusLoss
                        | GhostTriggerKind::Minimize
                        | GhostTriggerKind::SessionLock
                );
                st.minimized = matches!(kind, GhostTriggerKind::Minimize);
                st.session_locked = matches!(kind, GhostTriggerKind::SessionLock);
                return Ok(st.clone());
            }
        }

        let policy = self.get_ghost_policy()?;
        let current_state = self.ghost_state.lock().unwrap().clone();
        let room_override = current_state.active_room_id.as_deref().and_then(|rid| {
            self.vault
                .lock()
                .unwrap()
                .get_room_ghost_override(rid)
                .ok()
                .flatten()
        });
        let (eff_enabled, eff_mode, clear_attachments) =
            resolve_effective_mode(&policy, room_override.as_ref());

        // Fast path for restoration & explicit unlock
        if matches!(
            kind,
            GhostTriggerKind::RestoreFocus | GhostTriggerKind::Unlock
        ) {
            let snapshot = {
                let mut st = self.ghost_state.lock().unwrap();
                st.window_focused = true;
                st.minimized = false;
                if kind == GhostTriggerKind::Unlock || !st.pin_locked {
                    st.session_locked = false;
                    st.shielded = false;
                }
                st.clone()
            };
            let _ = self
                .events
                .send(NodeEvent::GhostStateChanged(snapshot.clone()));
            return Ok(snapshot);
        }

        let decision = evaluate_trigger(&policy, eff_enabled, eff_mode, &current_state, kind);

        let mut cleanup_summary = None;
        if decision.should_clear_local_history
            && let (Some(rid), Some(cid)) = (
                current_state.active_room_id.clone(),
                current_state.active_channel_id.clone(),
            )
        {
            let summary = self.vault.lock().unwrap().execute_ghost_clear(
                &rid,
                &cid,
                decision.clear_level,
                clear_attachments,
            )?;
            cleanup_summary = Some(summary);
            let _ = self.events.send(NodeEvent::HistoryChanged {
                room_id: rid,
                scope: "ghost_local_clear".into(),
            });
        }

        let snapshot = {
            let mut st = self.ghost_state.lock().unwrap();
            st.enabled = eff_enabled;
            st.effective_mode = eff_mode;
            st.capture_protection_active = policy.capture_protection;
            match kind {
                GhostTriggerKind::ExternalFocusLoss => {
                    st.window_focused = false;
                }
                GhostTriggerKind::Minimize => {
                    st.window_focused = false;
                    st.minimized = true;
                }
                GhostTriggerKind::SessionLock => {
                    st.window_focused = false;
                    st.session_locked = true;
                }
                GhostTriggerKind::ManualLock => {
                    st.shielded = true;
                }
                GhostTriggerKind::AppClose
                | GhostTriggerKind::RestoreFocus
                | GhostTriggerKind::Unlock => {}
            }
            if decision.should_shield {
                st.shielded = true;
                if policy.require_pin_unlock && policy.has_pin_configured {
                    st.pin_locked = true;
                }
            }
            if let Some(summary) = cleanup_summary {
                st.last_cleanup = Some(summary);
            }
            st.clone()
        };

        let _ = self
            .events
            .send(NodeEvent::GhostStateChanged(snapshot.clone()));
        Ok(snapshot)
    }

    // ==================== Pairing, Multi-Interface Direct P2P & Sync ====================

    /// Creates a shareable `cloakp2p://` pairing ticket bound to the best LAN/explicit address + alternate routes.
    pub fn export_pairing_ticket(
        &self,
        room_id: &str,
        advertised_addr: Option<&str>,
    ) -> P2pResult<PairingTicket> {
        let vault = self.vault.lock().unwrap();
        let ident = vault.identity()?;
        let room = vault
            .get_room(room_id)?
            .ok_or_else(|| P2pError::NotFound(format!("room {room_id}")))?;
        let room_key_b64 = vault.get_room_key(room_id)?;

        let candidates = enumerate_interface_candidates(self.local_addr.port());
        let default_addr = if let Some(explicit) = advertised_addr.filter(|s| !s.trim().is_empty())
        {
            explicit.trim().to_string()
        } else if self.local_addr.ip().is_unspecified() {
            candidates
                .first()
                .map(|c| c.suggested_addr.clone())
                .unwrap_or_else(|| format!("127.0.0.1:{}", self.local_addr.port()))
        } else {
            self.local_addr.to_string()
        };

        let alternate_addrs: Vec<String> = candidates
            .into_iter()
            .map(|c| c.suggested_addr)
            .filter(|a| a != &default_addr)
            .take(4)
            .collect();

        Ok(PairingTicket {
            device_id: ident.device_id,
            display_name: ident.display_name,
            ed25519_public_key_b64: ident.ed25519_public_b64,
            x25519_public_key_b64: ident.x25519_public_b64,
            direct_addr: default_addr,
            alternate_addrs,
            room_id: room.id,
            room_name: room.name,
            room_key_b64,
        })
    }

    /// Pairs a remote peer + shared room key locally and establishes a direct encrypted TCP session.
    pub async fn pair_and_connect(
        &self,
        ticket: &PairingTicket,
        connectivity_mode: ConnectivityMode,
    ) -> P2pResult<(LocalRoom, LocalChannel)> {
        let peer = PeerSummary {
            device_id: ticket.device_id.clone(),
            display_name: ticket.display_name.clone(),
            ed25519_public_key_b64: ticket.ed25519_public_key_b64.clone(),
            x25519_public_key_b64: ticket.x25519_public_key_b64.clone(),
            direct_addr: ticket.direct_addr.clone(),
            alternate_addrs: ticket.alternate_addrs.clone(),
            connectivity_mode: connectivity_mode.clone(),
            last_seen_at: None,
            revoked: false,
        };

        let (room, channel, _) = {
            let vault = self.vault.lock().unwrap();
            vault.upsert_peer(&peer)?;
            vault.create_room(
                Some(&ticket.room_id),
                &ticket.room_name,
                Some(&ticket.room_key_b64),
                None,
            )?
        };

        self.connect_to_peer(&peer.device_id).await?;
        let _ = self
            .send_frame_to_peer(
                &peer.device_id,
                WireFrame::SyncRequest {
                    room_id: room.id.clone(),
                    after_seq: 0,
                },
            )
            .await;

        Ok((room, channel))
    }

    /// Establishes a direct encrypted peer session, trying `direct_addr` then `alternate_addrs`,
    /// and failing explicitly when `DirectOnly` cannot reach the peer.
    pub async fn connect_to_peer(&self, peer_device_id: &str) -> P2pResult<()> {
        if self.active_peers.read().await.contains_key(peer_device_id) {
            return Ok(());
        }

        let peer = self
            .vault
            .lock()
            .unwrap()
            .get_peer(peer_device_id)?
            .ok_or_else(|| P2pError::NotFound(format!("peer {peer_device_id}")))?;

        if peer.revoked {
            self.peer_states
                .write()
                .await
                .insert(peer.device_id.clone(), PeerConnectionState::Revoked);
            return Err(P2pError::PeerRejected(format!(
                "Peer {} is revoked locally",
                peer.device_id
            )));
        }

        self.peer_states
            .write()
            .await
            .insert(peer.device_id.clone(), PeerConnectionState::Connecting);

        let mut addrs = Vec::with_capacity(1 + peer.alternate_addrs.len());
        addrs.push(peer.direct_addr.clone());
        for alt in &peer.alternate_addrs {
            if !addrs.contains(alt) {
                addrs.push(alt.clone());
            }
        }

        let mut last_cause = String::new();
        let mut connected_stream = None;
        for addr in &addrs {
            match tokio::time::timeout(DIRECT_CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
                Ok(Ok(stream)) => {
                    connected_stream = Some(stream);
                    break;
                }
                Ok(Err(err)) => {
                    last_cause = format!("{addr}: {err}");
                }
                Err(_) => {
                    last_cause = format!("{addr}: connection timed out after 5s");
                }
            }
        }

        let stream = match connected_stream {
            Some(s) => s,
            None => {
                self.peer_states
                    .write()
                    .await
                    .insert(peer.device_id.clone(), PeerConnectionState::DirectBlocked);
                let detail = Self::connectivity_error_message(
                    &peer.connectivity_mode,
                    &peer.direct_addr,
                    &last_cause,
                );
                let _ = self.events.send(NodeEvent::PeerConnectivityFailed {
                    device_id: peer.device_id.clone(),
                    mode: peer.connectivity_mode.clone(),
                    detail: detail.clone(),
                });
                return Err(P2pError::DirectConnectivityBlocked {
                    mode: peer.connectivity_mode.to_string(),
                    detail,
                });
            }
        };

        let remote_addr = stream.peer_addr().unwrap_or(self.local_addr);
        let expected_id = Some(peer.device_id.clone());
        let session_node = self.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            if let Err(err) = session_node
                .handle_connection(stream, remote_addr, true, Some((expected_id, ready_tx)))
                .await
            {
                tracing::debug!(?err, "Outgoing peer session closed");
            }
        });

        ready_rx.await.map_err(|_| {
            P2pError::PeerRejected("Handshake channel dropped before completion".into())
        })??;

        // Automatically sync all rooms on fresh reconnect
        let rooms = self.list_rooms().unwrap_or_default();
        for room in rooms {
            let _ = self
                .send_frame_to_peer(
                    &peer.device_id,
                    WireFrame::SyncRequest {
                        room_id: room.id,
                        after_seq: 0,
                    },
                )
                .await;
        }
        Ok(())
    }

    fn connectivity_error_message(mode: &ConnectivityMode, addr: &str, cause: &str) -> String {
        match mode {
            ConnectivityMode::DirectOnly => format!(
                "Direct-only route to {addr} failed ({cause}). Strict DirectOnly mode refused any silent relay fallback; verify LAN/VPN route, firewall port permission, or explicitly enable Assisted connectivity."
            ),
            ConnectivityMode::Assisted { .. } => format!(
                "Direct route to {addr} failed ({cause}); configure a reachable rendezvous/relay helper to continue."
            ),
        }
    }

    /// Encrypts a message in SQLite and pushes it directly to connected peers (or queues offline outbox).
    #[allow(clippy::too_many_arguments)]
    pub async fn send_message(
        &self,
        room_id: &str,
        channel_id: &str,
        plaintext: &str,
        attachment_ids: Vec<String>,
        reply_to_message_id: Option<String>,
        expire_in_seconds: Option<i64>,
    ) -> P2pResult<StoredMessage> {
        self.send_message_with_ghost_options(
            room_id,
            channel_id,
            plaintext,
            attachment_ids,
            reply_to_message_id,
            expire_in_seconds,
            false,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_message_with_ghost_options(
        &self,
        room_id: &str,
        channel_id: &str,
        plaintext: &str,
        attachment_ids: Vec<String>,
        reply_to_message_id: Option<String>,
        expire_in_seconds: Option<i64>,
        expire_on_leave: bool,
        expire_after_view_seconds: Option<i64>,
    ) -> P2pResult<StoredMessage> {
        let (msg, peers) = {
            let vault = self.vault.lock().unwrap();
            let msg = vault.store_outgoing_message(
                room_id,
                channel_id,
                plaintext,
                attachment_ids,
                reply_to_message_id,
                expire_in_seconds,
                expire_on_leave,
                expire_after_view_seconds,
            )?;
            let peers = vault.list_peers()?;
            (msg, peers)
        };

        self.broadcast_to_peers(&peers, WireFrame::Message(msg.clone()))
            .await?;
        Ok(msg)
    }

    pub async fn edit_message(
        &self,
        room_id: &str,
        message_id: &str,
        new_plaintext: &str,
    ) -> P2pResult<()> {
        let (new_ciphertext_b64, new_signature_b64, edited_at, peers) = {
            let vault = self.vault.lock().unwrap();
            let (ct, sig, ts) = vault.edit_message(room_id, message_id, new_plaintext)?;
            let peers = vault.list_peers()?;
            (ct, sig, ts, peers)
        };
        self.broadcast_to_peers(
            &peers,
            WireFrame::MessageEdit {
                room_id: room_id.to_string(),
                message_id: message_id.to_string(),
                new_ciphertext_b64,
                new_signature_b64,
                edited_at,
            },
        )
        .await
    }

    pub async fn delete_message_everyone(&self, room_id: &str, message_id: &str) -> P2pResult<()> {
        let tomb = DeletionTombstone {
            id: Uuid::new_v4().to_string(),
            room_id: room_id.to_string(),
            channel_id: None,
            message_id: Some(message_id.to_string()),
            scope: TombstoneScope::Everyone,
            created_at: Utc::now(),
        };
        let peers = {
            let vault = self.vault.lock().unwrap();
            vault.record_and_apply_tombstone(&tomb)?;
            vault.list_peers()?
        };
        self.broadcast_to_peers(&peers, WireFrame::Tombstone(tomb))
            .await
    }

    pub async fn burn_room_history(&self, room_id: &str) -> P2pResult<()> {
        let new_room_key = generate_room_key_b64();
        let tomb = DeletionTombstone {
            id: Uuid::new_v4().to_string(),
            room_id: room_id.to_string(),
            channel_id: None,
            message_id: None,
            scope: TombstoneScope::Burned,
            created_at: Utc::now(),
        };
        let (peers, new_epoch) = {
            let vault = self.vault.lock().unwrap();
            vault.record_and_apply_tombstone(&tomb)?;
            let next_epoch = vault
                .get_room(room_id)?
                .map(|r| r.current_epoch)
                .unwrap_or(2);
            vault.rotate_room_key(room_id, next_epoch, &new_room_key)?;
            (vault.list_peers()?, next_epoch)
        };
        self.broadcast_to_peers(&peers, WireFrame::Tombstone(tomb))
            .await?;
        self.broadcast_to_peers(
            &peers,
            WireFrame::RoomKeyRotation {
                room_id: room_id.to_string(),
                new_epoch,
                new_room_key_b64: new_room_key,
            },
        )
        .await?;
        let _ = self.events.send(NodeEvent::HistoryChanged {
            room_id: room_id.to_string(),
            scope: "burned".into(),
        });
        Ok(())
    }

    pub fn delete_message_for_me(&self, message_id: &str) -> P2pResult<()> {
        self.vault.lock().unwrap().delete_for_me(message_id)
    }

    pub fn list_decrypted_messages(
        &self,
        room_id: &str,
        channel_id: &str,
    ) -> P2pResult<Vec<DecryptedMessageView>> {
        self.vault
            .lock()
            .unwrap()
            .list_decrypted_channel_messages(room_id, channel_id)
    }

    /// Saves a file into chunked local storage and transmits chunks directly to connected peers.
    pub async fn store_and_send_file(
        &self,
        room_id: &str,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> P2pResult<LocalAttachmentMeta> {
        let (meta, peers) = {
            let vault = self.vault.lock().unwrap();
            let meta = vault.store_local_attachment(
                room_id,
                filename,
                mime_type,
                bytes,
                DEFAULT_FILE_CHUNK_BYTES,
            )?;
            let peers = vault.list_peers()?;
            (meta, peers)
        };

        self.broadcast_to_peers(&peers, WireFrame::FileInit(meta.clone()))
            .await?;

        for idx in 0..meta.total_chunks {
            let chunk_bytes = self
                .vault
                .lock()
                .unwrap()
                .read_attachment_chunk(&meta.id, idx)?;
            let frame = WireFrame::FileChunk {
                attachment_id: meta.id.clone(),
                chunk_index: idx,
                data_b64: STANDARD.encode(chunk_bytes),
            };
            self.broadcast_to_peers(&peers, frame).await?;
        }
        Ok(meta)
    }

    pub fn read_verified_attachment(&self, attachment_id: &str) -> P2pResult<Vec<u8>> {
        self.vault
            .lock()
            .unwrap()
            .read_verified_attachment_bytes(attachment_id)
    }

    /// Forwards WebRTC SDP offer/answer/ICE candidates directly across the P2P TCP session.
    pub async fn send_webrtc_signal(&self, signal: WebRtcSignalPayload) -> P2pResult<()> {
        let peers = self.vault.lock().unwrap().list_peers()?;
        self.broadcast_to_peers(&peers, WireFrame::WebRtcSignal(signal))
            .await
    }

    async fn broadcast_to_peers(&self, peers: &[PeerSummary], frame: WireFrame) -> P2pResult<()> {
        let mut target_ids: std::collections::HashSet<String> = peers
            .iter()
            .filter(|p| !p.revoked)
            .map(|p| p.device_id.clone())
            .collect();
        let active_guard = self.active_peers.read().await;
        for active_id in active_guard.keys() {
            target_ids.insert(active_id.clone());
        }

        for device_id in target_ids {
            if let Some(tx) = active_guard.get(&device_id).cloned() {
                if tx.send(frame.clone()).await.is_err() {
                    self.vault
                        .lock()
                        .unwrap()
                        .queue_outbox_frame(&device_id, &frame)?;
                }
            } else {
                self.vault
                    .lock()
                    .unwrap()
                    .queue_outbox_frame(&device_id, &frame)?;
            }
        }
        Ok(())
    }

    async fn send_frame_to_peer(&self, device_id: &str, frame: WireFrame) -> P2pResult<()> {
        if let Some(tx) = self.active_peers.read().await.get(device_id).cloned()
            && tx.send(frame).await.is_ok()
        {
            return Ok(());
        }
        Err(P2pError::NotFound(format!(
            "active session for {device_id}"
        )))
    }

    async fn handle_connection(
        &self,
        mut stream: TcpStream,
        remote_addr: SocketAddr,
        is_initiator: bool,
        ready_notifier: Option<(Option<String>, tokio::sync::oneshot::Sender<P2pResult<()>>)>,
    ) -> P2pResult<()> {
        let mut ready_notifier = ready_notifier;
        let (tx, mut rx) = mpsc::channel::<WireFrame>(256);
        let setup = self
            .perform_authenticated_handshake(
                &mut stream,
                remote_addr,
                is_initiator,
                &ready_notifier,
                &tx,
            )
            .await;

        let (peer_device_id, session_crypto) = match setup {
            Ok(v) => {
                if let Some((_, ready_tx)) = ready_notifier.take() {
                    let _ = ready_tx.send(Ok(()));
                }
                v
            }
            Err(err) => {
                let msg = err.to_string();
                if let Some((_, ready_tx)) = ready_notifier.take() {
                    let _ = ready_tx.send(Err(P2pError::PeerRejected(msg.clone())));
                }
                return Err(P2pError::PeerRejected(msg));
            }
        };

        {
            let vault = self.vault.lock().unwrap();
            let _ = vault.touch_peer_seen(&peer_device_id);
            if let Ok(queued) = vault.pop_outbox_for_peer(&peer_device_id) {
                for frame in queued {
                    let _ = tx.try_send(frame);
                }
            }
        }

        let _ = self.events.send(NodeEvent::PeerConnected {
            device_id: peer_device_id.clone(),
            direct_addr: remote_addr.to_string(),
        });

        let (mut reader, mut writer) = stream.into_split();
        let (enc_tx, mut enc_rx) = mpsc::channel::<Vec<u8>>(256);

        let write_task = tokio::spawn(async move {
            while let Some(cipher_frame) = enc_rx.recv().await {
                if write_raw_packet(&mut writer, &cipher_frame).await.is_err() {
                    break;
                }
            }
        });

        let session_tx_crypto = Arc::new(tokio::sync::Mutex::new(session_crypto));
        let fwd_crypto = session_tx_crypto.clone();
        let rekey_events = self.events.clone();
        let rekey_peer_id = peer_device_id.clone();

        let forward_task = tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                let Ok(json) = serde_json::to_vec(&frame) else {
                    continue;
                };
                let (enc_res, need_rekey_epoch) = {
                    let mut c = fwd_crypto.lock().await;
                    let enc = c.encrypt_frame(&json);
                    let need_rekey = if c.tx_counter() >= REKEY_AFTER_FRAMES {
                        Some(c.key_epoch() + 1)
                    } else {
                        None
                    };
                    (enc, need_rekey)
                };
                match enc_res {
                    Ok(ct) => {
                        if enc_tx.send(ct).await.is_err() {
                            break;
                        }
                        // Trigger FIFO forward-secrecy session key rotation seamlessly
                        if let Some(next_epoch) = need_rekey_epoch {
                            let rekey_frame = WireFrame::Rekey {
                                epoch: next_epoch,
                                ephemeral_x25519_b64: String::new(),
                            };
                            if let Ok(rk_json) = serde_json::to_vec(&rekey_frame) {
                                let rk_ct = {
                                    let mut c = fwd_crypto.lock().await;
                                    let encrypted = c.encrypt_frame(&rk_json);
                                    if encrypted.is_ok() {
                                        let _ = c.advance_tx_key();
                                    }
                                    encrypted
                                };
                                if let Ok(bytes) = rk_ct {
                                    let _ = enc_tx.send(bytes).await;
                                    let _ = rekey_events.send(NodeEvent::SessionRekeyed {
                                        device_id: rekey_peer_id.clone(),
                                        key_epoch: next_epoch,
                                    });
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut replay_seen = VecDeque::with_capacity(REPLAY_CACHE_CAP);
        while let Ok(ct) = read_raw_packet(&mut reader).await {
            let plain = {
                let mut c = session_tx_crypto.lock().await;
                c.decrypt_frame(&ct)
            };
            match plain {
                Ok(bytes) => {
                    if let Ok(frame) = serde_json::from_slice::<WireFrame>(&bytes) {
                        if let WireFrame::Rekey { epoch, .. } = &frame {
                            let mut c = session_tx_crypto.lock().await;
                            if c.advance_rx_key(*epoch).is_err() {
                                break;
                            }
                            continue;
                        }
                        if let WireFrame::Message(msg) = &frame {
                            if replay_seen.iter().any(|seen| seen == &msg.id) {
                                continue;
                            }
                            if replay_seen.len() >= REPLAY_CACHE_CAP {
                                replay_seen.pop_front();
                            }
                            replay_seen.push_back(msg.id.clone());
                        }
                        self.handle_inbound_frame(&peer_device_id, &tx, frame).await;
                    }
                }
                Err(err) => {
                    tracing::warn!(?err, %peer_device_id, "AEAD failure on peer wire frame");
                    break;
                }
            }
        }

        drop(tx);
        forward_task.abort();
        write_task.abort();
        self.active_peers.write().await.remove(&peer_device_id);
        self.peer_states
            .write()
            .await
            .insert(peer_device_id.clone(), PeerConnectionState::Disconnected);
        let _ = self.events.send(NodeEvent::PeerDisconnected {
            device_id: peer_device_id,
            reason: "stream closed".into(),
        });
        Ok(())
    }

    async fn perform_authenticated_handshake(
        &self,
        stream: &mut TcpStream,
        remote_addr: SocketAddr,
        is_initiator: bool,
        ready_notifier: &Option<(Option<String>, tokio::sync::oneshot::Sender<P2pResult<()>>)>,
        tx: &mpsc::Sender<WireFrame>,
    ) -> P2pResult<(String, TransportSessionCrypto)> {
        let mut eph_secret_bytes = [0u8; 32];
        let mut local_nonce = [0u8; 32];
        OsRng.fill_bytes(&mut eph_secret_bytes);
        OsRng.fill_bytes(&mut local_nonce);
        let eph_secret = X25519StaticSecret::from(eph_secret_bytes);
        let eph_pub = X25519PublicKey::from(&eph_secret);

        let ident = self.vault.lock().unwrap().identity()?;
        let hello = PeerHandshake::build(&ident, &eph_pub, &local_nonce)?;
        let hello_bytes = serde_json::to_vec(&hello)?;

        let (remote_bytes, init_bytes_owned, resp_bytes_owned) = if is_initiator {
            write_raw_packet(stream, &hello_bytes).await?;
            let incoming = read_raw_packet(stream).await?;
            (incoming.clone(), hello_bytes, incoming)
        } else {
            let incoming = read_raw_packet(stream).await?;
            write_raw_packet(stream, &hello_bytes).await?;
            (incoming.clone(), incoming, hello_bytes)
        };

        let remote_hello: PeerHandshake = serde_json::from_slice(&remote_bytes)?;
        let (_vk, remote_eph) = remote_hello.verify()?;
        if let Some((Some(expected_id), _)) = ready_notifier
            && expected_id != &remote_hello.device_id
        {
            return Err(P2pError::PeerRejected(format!(
                "Expected peer {expected_id} at {remote_addr}, got {}",
                remote_hello.device_id
            )));
        }

        // Key pinning + peer revocation verification
        let allowed = self
            .vault
            .lock()
            .unwrap()
            .is_peer_allowed(&remote_hello.device_id, &remote_hello.ed25519_public_b64)?;
        if !allowed {
            return Err(P2pError::PeerRejected(format!(
                "Peer {} rejected by local trust/revocation policy",
                remote_hello.device_id
            )));
        }

        let remote_nonce_vec = URL_SAFE_NO_PAD
            .decode(remote_hello.nonce_b64u.trim())
            .map_err(|_| P2pError::PeerRejected("Invalid remote nonce".into()))?;
        if remote_nonce_vec.len() != 32 {
            return Err(P2pError::PeerRejected(
                "Remote nonce must be 32 bytes".into(),
            ));
        }
        let mut remote_nonce = [0u8; 32];
        remote_nonce.copy_from_slice(&remote_nonce_vec);

        let session_crypto = TransportSessionCrypto::derive(
            eph_secret,
            &remote_eph,
            &local_nonce,
            &remote_nonce,
            is_initiator,
        )?;

        // Phase-2 mutual HMAC transcript confirmation bound to both hello transcripts
        if is_initiator {
            let ack = session_crypto.compute_handshake_ack(
                &init_bytes_owned,
                &resp_bytes_owned,
                "initiator",
            )?;
            write_raw_packet(stream, &serde_json::to_vec(&ack)?).await?;
            let peer_ack_bytes = read_raw_packet(stream).await?;
            let peer_ack: HandshakeAck = serde_json::from_slice(&peer_ack_bytes)?;
            session_crypto.verify_handshake_ack(
                &peer_ack,
                &init_bytes_owned,
                &resp_bytes_owned,
                "responder",
            )?;
            self.active_peers
                .write()
                .await
                .insert(remote_hello.device_id.clone(), tx.clone());
            self.peer_states.write().await.insert(
                remote_hello.device_id.clone(),
                PeerConnectionState::DirectConnected,
            );
        } else {
            let peer_ack_bytes = read_raw_packet(stream).await?;
            let peer_ack: HandshakeAck = serde_json::from_slice(&peer_ack_bytes)?;
            session_crypto.verify_handshake_ack(
                &peer_ack,
                &init_bytes_owned,
                &resp_bytes_owned,
                "initiator",
            )?;
            let ack = session_crypto.compute_handshake_ack(
                &init_bytes_owned,
                &resp_bytes_owned,
                "responder",
            )?;
            // Register inbound peer key & active channel before sending final responder ack so
            // both sides see each other in Paired Peers and responder can broadcast immediately.
            {
                let vault = self.vault.lock().unwrap();
                if vault.get_peer(&remote_hello.device_id)?.is_none() {
                    let short = &remote_hello.device_id[..remote_hello.device_id.len().min(8)];
                    let _ = vault.upsert_peer(&PeerSummary {
                        device_id: remote_hello.device_id.clone(),
                        display_name: format!("Peer {short}"),
                        ed25519_public_key_b64: remote_hello.ed25519_public_b64.clone(),
                        x25519_public_key_b64: remote_hello.ephemeral_x25519_b64.clone(),
                        direct_addr: remote_addr.to_string(),
                        alternate_addrs: Vec::new(),
                        connectivity_mode: ConnectivityMode::DirectOnly,
                        last_seen_at: Some(Utc::now()),
                        revoked: false,
                    });
                }
            }
            self.active_peers
                .write()
                .await
                .insert(remote_hello.device_id.clone(), tx.clone());
            self.peer_states.write().await.insert(
                remote_hello.device_id.clone(),
                PeerConnectionState::DirectConnected,
            );
            if let Err(err) = write_raw_packet(stream, &serde_json::to_vec(&ack)?).await {
                self.active_peers
                    .write()
                    .await
                    .remove(&remote_hello.device_id);
                return Err(err);
            }
        }

        Ok((remote_hello.device_id, session_crypto))
    }

    async fn handle_inbound_frame(
        &self,
        peer_device_id: &str,
        tx: &mpsc::Sender<WireFrame>,
        frame: WireFrame,
    ) {
        match frame {
            WireFrame::Ping { ts_ms } => {
                let _ = tx.send(WireFrame::Pong { ts_ms }).await;
            }
            WireFrame::Pong { .. } | WireFrame::Rekey { .. } => {}
            WireFrame::SyncRequest { room_id, after_seq } => {
                let batch = {
                    let vault = self.vault.lock().unwrap();
                    let msgs = vault
                        .list_stored_messages_since(&room_id, after_seq)
                        .unwrap_or_default();
                    let tombs = vault.list_tombstones_for_room(&room_id).unwrap_or_default();
                    let mut attachments = Vec::new();
                    for m in &msgs {
                        for aid in &m.attachment_ids {
                            if let Ok(Some(meta)) = vault.get_attachment_meta(aid) {
                                attachments.push(meta);
                            }
                        }
                    }
                    WireFrame::SyncBatch {
                        room_id,
                        messages: msgs,
                        tombstones: tombs,
                        attachments,
                    }
                };
                let _ = tx.send(batch).await;
            }
            WireFrame::SyncBatch {
                room_id,
                messages,
                tombstones,
                attachments,
            } => {
                let vault = self.vault.lock().unwrap();
                for meta in attachments {
                    let _ = vault.register_attachment_meta(&meta);
                }
                for tomb in tombstones {
                    let _ = vault.record_and_apply_tombstone(&tomb);
                }
                for msg in messages {
                    let _ = vault.upsert_received_message(&msg);
                }
                let _ = self.events.send(NodeEvent::HistoryChanged {
                    room_id,
                    scope: "sync".into(),
                });
            }
            WireFrame::Message(msg) => {
                if self
                    .vault
                    .lock()
                    .unwrap()
                    .upsert_received_message(&msg)
                    .unwrap_or(false)
                {
                    let _ = self.events.send(NodeEvent::MessageReceived {
                        room_id: msg.room_id,
                        channel_id: msg.channel_id,
                        message_id: msg.id,
                    });
                }
            }
            WireFrame::MessageEdit {
                room_id,
                message_id,
                new_ciphertext_b64,
                new_signature_b64,
                edited_at,
            } => {
                if self
                    .vault
                    .lock()
                    .unwrap()
                    .apply_remote_edit(
                        &room_id,
                        &message_id,
                        &new_ciphertext_b64,
                        &new_signature_b64,
                        edited_at,
                    )
                    .is_ok()
                {
                    let _ = self.events.send(NodeEvent::MessageEdited {
                        room_id,
                        message_id,
                    });
                }
            }
            WireFrame::Tombstone(tomb) => {
                let room_id = tomb.room_id.clone();
                if self
                    .vault
                    .lock()
                    .unwrap()
                    .record_and_apply_tombstone(&tomb)
                    .is_ok()
                {
                    let _ = self.events.send(NodeEvent::HistoryChanged {
                        room_id,
                        scope: "tombstone".into(),
                    });
                }
            }
            WireFrame::RoomKeyRotation {
                room_id,
                new_epoch,
                new_room_key_b64,
            } => {
                let _ = self.vault.lock().unwrap().rotate_room_key(
                    &room_id,
                    new_epoch,
                    &new_room_key_b64,
                );
                let _ = self.events.send(NodeEvent::HistoryChanged {
                    room_id,
                    scope: "epoch_rotated".into(),
                });
            }
            WireFrame::MutualReset { room_id, .. } => {
                let _ = self.events.send(NodeEvent::HistoryChanged {
                    room_id,
                    scope: "mutual_reset".into(),
                });
            }
            WireFrame::FileInit(meta) => {
                let _ = self.vault.lock().unwrap().register_attachment_meta(&meta);
            }
            WireFrame::FileChunk {
                attachment_id,
                chunk_index,
                data_b64,
            } => {
                let received_event = {
                    let vault = self.vault.lock().unwrap();
                    let _ = vault.write_attachment_chunk(&attachment_id, chunk_index, &data_b64);
                    if let Ok(Some(meta)) = vault.get_attachment_meta(&attachment_id)
                        && chunk_index + 1 == meta.total_chunks
                    {
                        Some((meta.room_id, meta.filename))
                    } else {
                        None
                    }
                };
                let _ = tx
                    .send(WireFrame::FileAck {
                        attachment_id: attachment_id.clone(),
                        chunk_index,
                    })
                    .await;
                if let Some((room_id, filename)) = received_event {
                    let _ = self.events.send(NodeEvent::AttachmentReceived {
                        room_id,
                        attachment_id,
                        filename,
                    });
                }
            }
            WireFrame::FileAck { .. } => {}
            WireFrame::WebRtcSignal(sig) => {
                let _ = peer_device_id;
                let _ = self.events.send(NodeEvent::WebRtcSignal(sig));
            }
        }
    }
}

async fn write_raw_packet<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    payload: &[u8],
) -> P2pResult<()> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(P2pError::Protocol(
            "Outbound frame exceeds 8 MiB limit".into(),
        ));
    }
    let len = payload.len() as u32;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_raw_packet<R: AsyncReadExt + Unpin>(reader: &mut R) -> P2pResult<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(P2pError::Protocol(format!("Invalid frame length: {len}")));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(buf)
}
