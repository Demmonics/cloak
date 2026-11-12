use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Connectivity policy controlling how peers establish routes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
#[derive(Default)]
pub enum ConnectivityMode {
    /// Strict peer-to-peer mode: attempts direct TCP/UDP routes only and never falls back to relays.
    #[default]
    DirectOnly,
    /// Optional user-enabled connectivity assistance via configured STUN/rendezvous/relay helpers.
    Assisted {
        rendezvous_url: Option<String>,
        stun_servers: Vec<String>,
    },
}

impl std::fmt::Display for ConnectivityMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DirectOnly => f.write_str("direct_only"),
            Self::Assisted { .. } => f.write_str("assisted"),
        }
    }
}

/// Live direct peer connection status reported to diagnostics & UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum PeerConnectionState {
    #[default]
    Disconnected,
    Connecting,
    DirectConnected,
    Reconnecting,
    DirectBlocked,
    Revoked,
}

/// Public device summary exchanged in pairing tickets and peer directories.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSummary {
    pub device_id: String,
    pub display_name: String,
    pub ed25519_public_key_b64: String,
    pub x25519_public_key_b64: String,
    pub direct_addr: String,
    #[serde(default)]
    pub alternate_addrs: Vec<String>,
    pub connectivity_mode: ConnectivityMode,
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub revoked: bool,
}

fn default_invite_max_uses() -> u32 {
    1
}

/// Shareable signed & bounded direct pairing ticket encoded as a `cloakp2p://` URI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingTicket {
    pub device_id: String,
    pub display_name: String,
    pub ed25519_public_key_b64: String,
    pub x25519_public_key_b64: String,
    pub direct_addr: String,
    #[serde(default)]
    pub alternate_addrs: Vec<String>,
    pub room_id: String,
    pub room_name: String,
    pub room_key_b64: String,
    #[serde(default)]
    pub invite_id: String,
    #[serde(default)]
    pub issued_at_ms: i64,
    #[serde(default)]
    pub expires_at_ms: i64,
    #[serde(default = "default_invite_max_uses")]
    pub max_uses: u32,
    #[serde(default)]
    pub invite_sig_b64: String,
}

impl PairingTicket {
    /// Canonical domain-separated invitation capability payload signed by the inviter's Ed25519 key.
    pub fn invite_signing_payload(&self) -> String {
        format!(
            "cloak-invite-v1:{}:{}:{}:{}:{}:{}:{}",
            self.device_id,
            self.room_id,
            self.ed25519_public_key_b64,
            self.invite_id,
            self.issued_at_ms,
            self.expires_at_ms,
            self.max_uses
        )
    }

    /// Encodes the pairing ticket into a copyable URI (`cloakp2p://host:port?...`).
    pub fn to_uri(&self) -> String {
        let mut extra_params = String::new();
        if !self.alternate_addrs.is_empty() {
            let joined = self.alternate_addrs.join(",");
            extra_params.push_str(&format!("&alt={}", urlencoding::encode(&joined)));
        }
        if !self.invite_id.is_empty() {
            extra_params.push_str(&format!("&inv={}", urlencoding::encode(&self.invite_id)));
            extra_params.push_str(&format!("&iat={}", self.issued_at_ms));
            extra_params.push_str(&format!("&exp={}", self.expires_at_ms));
            extra_params.push_str(&format!("&uses={}", self.max_uses));
        }
        if !self.invite_sig_b64.is_empty() {
            extra_params.push_str(&format!(
                "&sig={}",
                urlencoding::encode(&self.invite_sig_b64)
            ));
        }
        format!(
            "cloakp2p://{}?dev={}&name={}&ed={}&x={}&room={}&rname={}{}#rk={}",
            self.direct_addr,
            urlencoding::encode(&self.device_id),
            urlencoding::encode(&self.display_name),
            urlencoding::encode(&self.ed25519_public_key_b64),
            urlencoding::encode(&self.x25519_public_key_b64),
            urlencoding::encode(&self.room_id),
            urlencoding::encode(&self.room_name),
            extra_params,
            urlencoding::encode(&self.room_key_b64),
        )
    }

    /// Parses a `cloakp2p://` pairing ticket URI.
    pub fn from_uri(uri: &str) -> Result<Self, String> {
        let rest = uri
            .trim()
            .strip_prefix("cloakp2p://")
            .ok_or_else(|| "Ticket must start with cloakp2p://".to_string())?;
        let (addr_and_query, frag) = rest
            .split_once('#')
            .ok_or_else(|| "Ticket missing #rk= room key fragment".to_string())?;
        let (addr, query) = addr_and_query
            .split_once('?')
            .ok_or_else(|| "Ticket missing query parameters".to_string())?;

        let mut dev = None;
        let mut name = None;
        let mut ed = None;
        let mut x = None;
        let mut room = None;
        let mut rname = None;
        let mut invite_id = None;
        let mut issued_at_ms = 0i64;
        let mut expires_at_ms = 0i64;
        let mut max_uses = 1u32;
        let mut invite_sig_b64 = None;
        let mut alternate_addrs = Vec::new();
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                let decoded = urlencoding::decode(v)
                    .map_err(|_| format!("Invalid percent encoding for {k}"))?
                    .into_owned();
                match k {
                    "dev" => dev = Some(decoded),
                    "name" => name = Some(decoded),
                    "ed" => ed = Some(decoded),
                    "x" => x = Some(decoded),
                    "room" => room = Some(decoded),
                    "rname" => rname = Some(decoded),
                    "inv" => invite_id = Some(decoded),
                    "iat" => {
                        issued_at_ms = decoded
                            .parse::<i64>()
                            .map_err(|_| "Invalid invitation issued_at".to_string())?;
                    }
                    "exp" => {
                        expires_at_ms = decoded
                            .parse::<i64>()
                            .map_err(|_| "Invalid invitation expires_at".to_string())?;
                    }
                    "uses" => {
                        max_uses = decoded
                            .parse::<u32>()
                            .map_err(|_| "Invalid invitation max_uses".to_string())?;
                    }
                    "sig" => invite_sig_b64 = Some(decoded),
                    "alt" => {
                        alternate_addrs = decoded
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(ToOwned::to_owned)
                            .collect();
                    }
                    _ => {}
                }
            }
        }
        let rk = frag
            .strip_prefix("rk=")
            .ok_or_else(|| "Ticket fragment must start with rk=".to_string())?;
        let room_key_b64 = urlencoding::decode(rk)
            .map_err(|_| "Invalid room key encoding".to_string())?
            .into_owned();

        Ok(Self {
            device_id: dev.ok_or_else(|| "Missing dev".to_string())?,
            display_name: name.unwrap_or_else(|| "Peer".to_string()),
            ed25519_public_key_b64: ed.ok_or_else(|| "Missing ed".to_string())?,
            x25519_public_key_b64: x.ok_or_else(|| "Missing x".to_string())?,
            direct_addr: addr.to_string(),
            alternate_addrs,
            room_id: room.ok_or_else(|| "Missing room".to_string())?,
            room_name: rname.unwrap_or_else(|| "Private Peer Room".to_string()),
            room_key_b64,
            invite_id: invite_id.unwrap_or_default(),
            issued_at_ms,
            expires_at_ms,
            max_uses,
            invite_sig_b64: invite_sig_b64.unwrap_or_default(),
        })
    }
}

/// Active or consumed invitation record stored locally by the room inviter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomInvitationSummary {
    pub invite_id: String,
    pub room_id: String,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub max_uses: u32,
    pub uses_count: u32,
    pub revoked: bool,
}

/// Per-room peer authorization entry in `room_members`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomMemberSummary {
    pub room_id: String,
    pub device_id: String,
    pub role: String,
    pub added_at: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoom {
    pub id: String,
    pub name: String,
    pub current_epoch: i64,
    pub default_disappear_seconds: Option<i64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalChannel {
    pub id: String,
    pub room_id: String,
    pub name: String,
    pub channel_type: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAttachmentMeta {
    pub id: String,
    pub room_id: String,
    pub filename: String,
    pub mime_type: String,
    pub total_size_bytes: u64,
    pub chunk_size_bytes: u32,
    pub total_chunks: u32,
    pub sha256_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub room_id: String,
    pub channel_id: String,
    pub sender_device_id: String,
    pub encryption_epoch: i64,
    pub seq: i64,
    pub ciphertext_b64: String,
    pub signature_b64: String,
    pub attachment_ids: Vec<String>,
    pub reply_to_message_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub expire_on_leave: bool,
    #[serde(default)]
    pub expire_after_view_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedMessageView {
    pub id: String,
    pub room_id: String,
    pub channel_id: String,
    pub sender_device_id: String,
    pub encryption_epoch: i64,
    pub seq: i64,
    pub text: String,
    pub signature_verified: bool,
    pub attachments: Vec<LocalAttachmentMeta>,
    pub reply_to_message_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub viewed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub is_outgoing: bool,
    #[serde(default)]
    pub expire_on_leave: bool,
    #[serde(default)]
    pub expire_after_view_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TombstoneScope {
    Everyone,
    Cleared,
    Burned,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletionTombstone {
    pub id: String,
    pub room_id: String,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    pub scope: TombstoneScope,
    pub created_at: DateTime<Utc>,
}

/// Ghost Mode privacy tier configured by the user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GhostModeLevel {
    #[default]
    Off,
    /// Masks UI & requires optional PIN unlock without erasing local messages.
    PrivacyShield,
    /// Snapchat-style: clears only messages marked viewed locally on this PC.
    ClearViewed,
    /// Explicit destructive opt-in: wipes entire open local conversation history on this PC.
    ClearOpenConversation,
}

/// How Ghost Mode treats outgoing messages authored on this computer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutgoingViewedPolicy {
    /// Outgoing messages become eligible for viewed-message clearing once viewed in the viewport.
    #[default]
    ImmediateAfterDwell,
    /// Keep my own sent messages when clearing viewed incoming messages.
    PreserveOutgoing,
    /// Mark outgoing messages viewed immediately upon sending.
    ImmediateOnSend,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhostTriggers {
    pub on_focus_loss: bool,
    pub on_minimize: bool,
    pub on_session_lock: bool,
    pub on_close: bool,
}

impl Default for GhostTriggers {
    fn default() -> Self {
        Self {
            on_focus_loss: true,
            on_minimize: true,
            on_session_lock: true,
            on_close: true,
        }
    }
}

/// Global Ghost Mode settings persisted inside SQLite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhostPolicy {
    pub enabled: bool,
    pub mode: GhostModeLevel,
    pub triggers: GhostTriggers,
    pub clear_attachments: bool,
    pub hide_sensitive_names: bool,
    pub capture_protection: bool,
    pub require_pin_unlock: bool,
    pub has_pin_configured: bool,
    pub destructive_confirmed: bool,
    pub viewed_dwell_ms: u64,
    pub outgoing_viewed_policy: OutgoingViewedPolicy,
}

impl Default for GhostPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: GhostModeLevel::Off,
            triggers: GhostTriggers::default(),
            clear_attachments: true,
            hide_sensitive_names: true,
            capture_protection: false,
            require_pin_unlock: false,
            has_pin_configured: false,
            destructive_confirmed: false,
            viewed_dwell_ms: 800,
            outgoing_viewed_policy: OutgoingViewedPolicy::ImmediateAfterDwell,
        }
    }
}

/// Per-conversation override for Ghost Mode policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhostRoomOverride {
    pub room_id: String,
    pub enabled: bool,
    pub mode: GhostModeLevel,
    pub clear_attachments: Option<bool>,
}

/// Classification of focus/lifecycle events received from Win32 or browser visibility hooks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GhostTriggerKind {
    ExternalFocusLoss,
    Minimize,
    SessionLock,
    AppClose,
    ManualLock,
    RestoreFocus,
    Unlock,
}

/// Summary of the most recent local Ghost erasure execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhostDeletionSummary {
    pub room_id: String,
    pub channel_id: String,
    pub mode: GhostModeLevel,
    pub deleted_messages: usize,
    pub deleted_attachments: usize,
    pub preserved_unread: usize,
    pub completed_at: DateTime<Utc>,
}

/// Authoritative runtime state tracked by Rust's privacy-state controller.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhostRuntimeState {
    pub enabled: bool,
    pub effective_mode: GhostModeLevel,
    pub shielded: bool,
    pub pin_locked: bool,
    pub window_focused: bool,
    pub minimized: bool,
    pub session_locked: bool,
    pub in_app_modal_depth: u32,
    pub active_room_id: Option<String>,
    pub active_channel_id: Option<String>,
    pub capture_protection_active: bool,
    pub last_cleanup: Option<GhostDeletionSummary>,
}

impl Default for GhostRuntimeState {
    fn default() -> Self {
        Self {
            enabled: false,
            effective_mode: GhostModeLevel::Off,
            shielded: false,
            pin_locked: false,
            window_focused: true,
            minimized: false,
            session_locked: false,
            in_app_modal_depth: 0,
            active_room_id: None,
            active_channel_id: None,
            capture_protection_active: false,
            last_cleanup: None,
        }
    }
}

/// Network interface candidate discovered on this host for LAN / IPv6 pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceCandidate {
    pub name: String,
    pub ip: String,
    pub family: String,
    pub scope: String,
    pub suggested_addr: String,
}

/// Local network, firewall & vault encryption diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostics {
    pub listen_addr: String,
    pub primary_lan_ip: Option<String>,
    pub primary_ipv6: Option<String>,
    pub interfaces: Vec<NetworkInterfaceCandidate>,
    pub windows_firewall_rule_present: Option<bool>,
    pub firewall_note: String,
    pub vault_dpapi_protected: bool,
}

/// WebRTC SDP/ICE/media-state signal forwarded directly across the encrypted P2P TCP stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebRtcSignalPayload {
    pub room_id: String,
    pub call_id: String,
    pub sender_device_id: String,
    pub kind: String,
    pub payload: String,
}

/// Authenticated encrypted P2P wire frames exchanged over direct peer connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireFrame {
    Ping {
        ts_ms: i64,
    },
    Pong {
        ts_ms: i64,
    },
    SyncRequest {
        room_id: String,
        after_seq: i64,
    },
    SyncBatch {
        room_id: String,
        messages: Vec<StoredMessage>,
        tombstones: Vec<DeletionTombstone>,
        attachments: Vec<LocalAttachmentMeta>,
    },
    Message(StoredMessage),
    MessageEdit {
        room_id: String,
        message_id: String,
        new_ciphertext_b64: String,
        new_signature_b64: String,
        edited_at: DateTime<Utc>,
    },
    Tombstone(DeletionTombstone),
    FileInit(LocalAttachmentMeta),
    FileChunk {
        attachment_id: String,
        chunk_index: u32,
        data_b64: String,
    },
    FileAck {
        attachment_id: String,
        chunk_index: u32,
    },
    WebRtcSignal(WebRtcSignalPayload),
    /// In-session forward-secrecy ratchet step carrying fresh ephemeral X25519 key.
    Rekey {
        epoch: u64,
        ephemeral_x25519_b64: String,
    },
    /// Explicit peer room key rotation envelope encrypted for recipient's static X25519 key or delivered in-band.
    RoomKeyRotation {
        room_id: String,
        new_epoch: i64,
        new_room_key_b64: String,
    },
    /// Optional mutual conversation reset agreement (strictly distinct from local Ghost clearing).
    MutualReset {
        room_id: String,
        new_epoch: i64,
        initiator_device_id: String,
    },
    /// Signed, bounded room invitation capability presented by an incoming peer before room sync/messaging.
    JoinWithInvite {
        room_id: String,
        invite_id: String,
        issued_at_ms: i64,
        expires_at_ms: i64,
        max_uses: u32,
        invite_sig_b64: String,
    },
    /// Confirmation returned to the joining peer once invitation verification and room admission commit.
    JoinAccepted {
        room_id: String,
    },
    /// Explicit authorization rejection returned when a peer attempts unauthorized room operations.
    JoinRejected {
        room_id: String,
        reason: String,
    },
}

/// Real-time local events pushed from `P2pNode` to UI listeners / WebSocket bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum NodeEvent {
    PeerConnected {
        device_id: String,
        direct_addr: String,
    },
    PeerDisconnected {
        device_id: String,
        reason: String,
    },
    PeerReconnecting {
        device_id: String,
        attempt: u32,
        detail: String,
    },
    PeerConnectivityFailed {
        device_id: String,
        mode: ConnectivityMode,
        detail: String,
    },
    SessionRekeyed {
        device_id: String,
        key_epoch: u64,
    },
    MessageReceived {
        room_id: String,
        channel_id: String,
        message_id: String,
    },
    MessageEdited {
        room_id: String,
        message_id: String,
    },
    HistoryChanged {
        room_id: String,
        scope: String,
    },
    AttachmentReceived {
        room_id: String,
        attachment_id: String,
        filename: String,
    },
    WebRtcSignal(WebRtcSignalPayload),
    GhostStateChanged(GhostRuntimeState),
    StealthStateChanged(crate::stealth::StealthBootstrapState),
}
