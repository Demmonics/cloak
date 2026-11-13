use std::collections::HashSet;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use chrono::{DateTime, Utc};
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{P2pError, P2pResult};
use crate::model::GhostModeLevel;

/// Initial interface displayed when Cloak launches or restarts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StealthLaunchView {
    #[default]
    Messenger,
    PdfReader,
}

/// Visual cover presented when Stealth Mode activates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StealthVisualAction {
    #[default]
    None,
    Blur,
    PrivacyShield,
    LockScreen,
    SwitchToPdf,
    SwitchToSelectedPdf,
    GenericDocumentList,
}

/// What the PDF reader displays upon automatic/manual return to Stealth Mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StealthPdfReturnBehavior {
    #[default]
    LastOpened,
    DocumentLibrary,
    ConfiguredDefault,
    NeutralWelcome,
}

/// Reader visual theme (independent of messenger theme).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PdfReaderTheme {
    #[default]
    Light,
    Dark,
}

/// Supported unlock pathways configured by the user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum UnlockMethod {
    PdfSearch,
    HiddenShortcutInput,
    DiscreetCommand,
    Passphrase,
    Pin,
    WindowsHello,
}

/// Action assigned to each configured secret unlock code.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SecretCodeAction {
    #[default]
    OpenMessenger,
    OpenConversation,
    OpenPrivacySettings,
    ReturnToPdf,
    PanicLock,
}

/// Trigger sources accepted by the configurable privacy rules engine.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyTriggerKind {
    FocusLoss,
    AltTab,
    ClickOtherApp,
    Minimize,
    ShowDesktop,
    VirtualDesktopSwitch,
    SessionLock,
    SessionUnlock,
    RestoreTaskbar,
    RestoreTray,
    WindowClose,
    AppRestart,
    BackgroundAwayTimeout,
    ForegroundInactivity,
    SystemIdle,
    PanicHotkey,
    ManualLock,
    ManualSwitchToPdf,
}

/// Local storage deletion severity applied independently of visual Stealth Mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LocalDeletionAction {
    #[default]
    KeepAll,
    DeleteIncomingViewedLocal,
    DeleteOutgoingViewedLocal,
    DeleteViewedLocal,
    DeleteActiveConversation,
}

/// What happens to local attachment blobs referenced by locally erased messages.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentPurgeAction {
    #[default]
    Keep,
    PurgeRelated,
}

/// Lock behavior applied by a triggered rule.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum LockAction {
    #[default]
    None,
    RequireUnlock,
    HardLock,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum VoiceCallAction {
    #[default]
    Continue,
    AutoMute,
    EndCall,
    AskBeforeEnding,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CameraAction {
    Continue,
    #[default]
    DisableCamera,
    EndVideoStream,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScreenShareAction {
    Continue,
    Pause,
    #[default]
    StopImmediately,
    AskIfVisible,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotificationPrivacyLevel {
    #[default]
    FullPreview,
    SenderOnly,
    GenericNotice,
    Silent,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPrivacySettings {
    pub unlocked_level: NotificationPrivacyLevel,
    pub pdf_mode_level: NotificationPrivacyLevel,
    pub windows_locked_level: NotificationPrivacyLevel,
    pub minimized_level: NotificationPrivacyLevel,
    pub screen_sharing_level: NotificationPrivacyLevel,
    pub dnd_level: NotificationPrivacyLevel,
    pub dnd_enabled: bool,
    pub suppress_taskbar_badge: bool,
    pub suppress_tray_preview: bool,
    pub suppress_sounds: bool,
    pub hide_contact_names: bool,
    pub hide_attachment_thumbnails: bool,
}

impl Default for NotificationPrivacySettings {
    fn default() -> Self {
        Self {
            unlocked_level: NotificationPrivacyLevel::FullPreview,
            pdf_mode_level: NotificationPrivacyLevel::Disabled,
            windows_locked_level: NotificationPrivacyLevel::Disabled,
            minimized_level: NotificationPrivacyLevel::GenericNotice,
            screen_sharing_level: NotificationPrivacyLevel::Silent,
            dnd_level: NotificationPrivacyLevel::Disabled,
            dnd_enabled: false,
            suppress_taskbar_badge: true,
            suppress_tray_preview: true,
            suppress_sounds: false,
            hide_contact_names: true,
            hide_attachment_thumbnails: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallPrivacySettings {
    pub voice_action: VoiceCallAction,
    pub camera_action: CameraAction,
    pub screen_share_action: ScreenShareAction,
    pub show_call_indicator_in_pdf: bool,
}

impl Default for CallPrivacySettings {
    fn default() -> Self {
        Self {
            voice_action: VoiceCallAction::Continue,
            camera_action: CameraAction::DisableCamera,
            screen_share_action: ScreenShareAction::StopImmediately,
            show_call_indicator_in_pdf: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PdfReaderSettings {
    pub restore_last_document: bool,
    pub return_behavior: StealthPdfReturnBehavior,
    pub default_document_id: Option<String>,
    pub theme: PdfReaderTheme,
    pub neutral_window_title: String,
    pub enable_import: bool,
    pub enable_search: bool,
    pub enable_tabs: bool,
}

impl Default for PdfReaderSettings {
    fn default() -> Self {
        Self {
            restore_last_document: true,
            return_behavior: StealthPdfReturnBehavior::LastOpened,
            default_document_id: None,
            theme: PdfReaderTheme::Light,
            neutral_window_title: "Document Reader".to_string(),
            enable_import: true,
            enable_search: true,
            enable_tabs: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnlockPreferences {
    pub enabled_methods: Vec<UnlockMethod>,
    pub case_sensitive: bool,
    pub require_additional_auth: bool,
    pub allow_multiple_codes: bool,
    pub hidden_shortcut: String,
    pub panic_shortcut: String,
    pub require_unlock_on_return: bool,
    pub lock_on_restart: bool,
}

impl Default for UnlockPreferences {
    fn default() -> Self {
        Self {
            enabled_methods: vec![
                UnlockMethod::PdfSearch,
                UnlockMethod::HiddenShortcutInput,
                UnlockMethod::DiscreetCommand,
                UnlockMethod::Passphrase,
                UnlockMethod::Pin,
            ],
            case_sensitive: true,
            require_additional_auth: false,
            allow_multiple_codes: true,
            hidden_shortcut: "Ctrl+Shift+U".to_string(),
            panic_shortcut: "Ctrl+Shift+L".to_string(),
            require_unlock_on_return: true,
            lock_on_restart: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimerPreferences {
    pub background_away_enabled: bool,
    pub background_away_seconds: u64,
    pub background_away_cancel_on_return: bool,
    pub background_away_preserve_deadline: bool,
    pub background_away_deletion: LocalDeletionAction,
    pub foreground_idle_enabled: bool,
    pub foreground_idle_seconds: u64,
    pub system_idle_enabled: bool,
    pub system_idle_seconds: u64,
}

impl Default for TimerPreferences {
    fn default() -> Self {
        Self {
            background_away_enabled: false,
            background_away_seconds: 60,
            background_away_cancel_on_return: true,
            background_away_preserve_deadline: false,
            background_away_deletion: LocalDeletionAction::KeepAll,
            foreground_idle_enabled: false,
            foreground_idle_seconds: 600,
            system_idle_enabled: false,
            system_idle_seconds: 600,
        }
    }
}

/// Configurable WHEN [trigger] OCCURS -> PERFORM [actions] privacy rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: PrivacyTriggerKind,
    pub delay_seconds: u64,
    pub cancel_on_return: bool,
    pub preserve_absolute_deadline: bool,
    pub visual_action: StealthVisualAction,
    pub lock_action: LockAction,
    pub deletion_action: LocalDeletionAction,
    pub attachment_action: AttachmentPurgeAction,
    pub notification_action: Option<NotificationPrivacyLevel>,
    pub voice_action: Option<VoiceCallAction>,
    pub camera_action: Option<CameraAction>,
    pub screen_share_action: Option<ScreenShareAction>,
    pub scope_room_id: Option<String>,
    pub priority: i32,
}

impl PrivacyRule {
    pub fn default_rules() -> Vec<Self> {
        vec![
            Self {
                id: "rule-focus-loss".into(),
                name: "Focus loss / Alt+Tab to PDF".into(),
                enabled: true,
                trigger: PrivacyTriggerKind::FocusLoss,
                delay_seconds: 0,
                cancel_on_return: false,
                preserve_absolute_deadline: false,
                visual_action: StealthVisualAction::SwitchToPdf,
                lock_action: LockAction::RequireUnlock,
                deletion_action: LocalDeletionAction::KeepAll,
                attachment_action: AttachmentPurgeAction::Keep,
                notification_action: Some(NotificationPrivacyLevel::Disabled),
                voice_action: None,
                camera_action: None,
                screen_share_action: None,
                scope_room_id: None,
                priority: 60,
            },
            Self {
                id: "rule-minimize".into(),
                name: "Window minimize to PDF".into(),
                enabled: true,
                trigger: PrivacyTriggerKind::Minimize,
                delay_seconds: 0,
                cancel_on_return: false,
                preserve_absolute_deadline: false,
                visual_action: StealthVisualAction::SwitchToPdf,
                lock_action: LockAction::RequireUnlock,
                deletion_action: LocalDeletionAction::KeepAll,
                attachment_action: AttachmentPurgeAction::Keep,
                notification_action: Some(NotificationPrivacyLevel::GenericNotice),
                voice_action: None,
                camera_action: None,
                screen_share_action: None,
                scope_room_id: None,
                priority: 70,
            },
            Self {
                id: "rule-session-lock".into(),
                name: "Windows session lock".into(),
                enabled: true,
                trigger: PrivacyTriggerKind::SessionLock,
                delay_seconds: 0,
                cancel_on_return: false,
                preserve_absolute_deadline: true,
                visual_action: StealthVisualAction::SwitchToPdf,
                lock_action: LockAction::HardLock,
                deletion_action: LocalDeletionAction::KeepAll,
                attachment_action: AttachmentPurgeAction::Keep,
                notification_action: Some(NotificationPrivacyLevel::Disabled),
                voice_action: Some(VoiceCallAction::Continue),
                camera_action: Some(CameraAction::DisableCamera),
                screen_share_action: Some(ScreenShareAction::StopImmediately),
                scope_room_id: None,
                priority: 90,
            },
            Self {
                id: "rule-panic".into(),
                name: "Manual panic lock & conceal".into(),
                enabled: true,
                trigger: PrivacyTriggerKind::PanicHotkey,
                delay_seconds: 0,
                cancel_on_return: false,
                preserve_absolute_deadline: true,
                visual_action: StealthVisualAction::SwitchToPdf,
                lock_action: LockAction::HardLock,
                deletion_action: LocalDeletionAction::KeepAll,
                attachment_action: AttachmentPurgeAction::PurgeRelated,
                notification_action: Some(NotificationPrivacyLevel::Disabled),
                voice_action: Some(VoiceCallAction::AutoMute),
                camera_action: Some(CameraAction::EndVideoStream),
                screen_share_action: Some(ScreenShareAction::StopImmediately),
                scope_room_id: None,
                priority: 100,
            },
        ]
    }
}

/// Complete persisted Stealth configuration (never contains plaintext secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StealthConfig {
    pub enabled: bool,
    pub launch_view: StealthLaunchView,
    pub stealth_visual_action: StealthVisualAction,
    pub unlock: UnlockPreferences,
    pub pdf_reader: PdfReaderSettings,
    pub timers: TimerPreferences,
    pub calls: CallPrivacySettings,
    pub notifications: NotificationPrivacySettings,
    pub trigger_on_alt_tab: bool,
    pub trigger_on_click_other_app: bool,
    pub trigger_on_focus_loss: bool,
    pub trigger_on_minimize: bool,
    pub trigger_on_show_desktop: bool,
    pub trigger_on_virtual_desktop: bool,
    pub trigger_on_session_lock: bool,
    pub trigger_on_window_close: bool,
    pub trigger_on_restart: bool,
    pub rules: Vec<PrivacyRule>,
}

impl Default for StealthConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            launch_view: StealthLaunchView::Messenger,
            stealth_visual_action: StealthVisualAction::SwitchToPdf,
            unlock: UnlockPreferences::default(),
            pdf_reader: PdfReaderSettings::default(),
            timers: TimerPreferences::default(),
            calls: CallPrivacySettings::default(),
            notifications: NotificationPrivacySettings::default(),
            trigger_on_alt_tab: true,
            trigger_on_click_other_app: true,
            trigger_on_focus_loss: true,
            trigger_on_minimize: true,
            trigger_on_show_desktop: true,
            trigger_on_virtual_desktop: true,
            trigger_on_session_lock: true,
            trigger_on_window_close: true,
            trigger_on_restart: true,
            rules: PrivacyRule::default_rules(),
        }
    }
}

/// Rust privacy state machine states (Section 8).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StealthLifecycleState {
    DecoyLocked,
    UnlockRequested,
    Authenticating,
    #[default]
    MessengerUnlocked,
    MessengerFocused,
    MessengerBackgrounded,
    PrivacyTransitioning,
    PrivacyShielded,
    PendingLocalPurge,
    LocalPurgeComplete,
    Relocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ActiveSurface {
    #[default]
    Messenger,
    PdfReader,
    PrivacyShield,
    LockScreen,
    GenericDocList,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCallPrivacySummary {
    pub in_call: bool,
    pub mic_active: bool,
    pub mic_muted: bool,
    pub camera_active: bool,
    pub screen_sharing_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StealthRateLimitState {
    pub failed_attempts: u32,
    pub cooldown_until_ms: Option<i64>,
    pub lockout_tier: u32,
    pub last_failed_at: Option<DateTime<Utc>>,
}

/// Safe metadata returned to unlocked settings UI for configured secret codes (no secrets/hashes).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretCodeMetadata {
    pub id: String,
    pub label: String,
    pub action: SecretCodeAction,
    pub target_room_id: Option<String>,
    pub case_sensitive: bool,
    pub is_weak: bool,
    pub require_additional_auth: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

/// Public locked-safe bootstrap state served while locked (exposes ZERO chat/peer/secret metadata).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StealthBootstrapState {
    pub stealth_enabled: bool,
    pub locked: bool,
    pub lifecycle_state: StealthLifecycleState,
    pub active_surface: ActiveSurface,
    pub visual_action: StealthVisualAction,
    pub launch_view: StealthLaunchView,
    pub pdf_return_behavior: StealthPdfReturnBehavior,
    pub default_pdf_id: Option<String>,
    pub pdf_theme: PdfReaderTheme,
    pub window_title: String,
    pub enabled_unlock_methods: Vec<UnlockMethod>,
    pub require_additional_auth: bool,
    pub has_passphrase_configured: bool,
    pub has_pin_configured: bool,
    pub hidden_shortcut: String,
    pub panic_shortcut: String,
    pub lockout_remaining_seconds: u64,
    pub failed_attempts: u32,
    pub windows_hello_available: bool,
    pub windows_hello_status: String,
    pub call_summary: ActiveCallPrivacySummary,
    pub notification_level_now: NotificationPrivacyLevel,
    pub away_deadline_ms: Option<i64>,
    pub away_remaining_seconds: Option<u64>,
    pub foreground_idle_remaining_seconds: Option<u64>,
    pub system_idle_seconds: u64,
    pub pending_navigation_target: Option<String>,
    pub pending_open_privacy_settings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnlockOutcome {
    pub matched: bool,
    pub unlocked: bool,
    pub action: Option<SecretCodeAction>,
    pub target_room_id: Option<String>,
    pub open_privacy_settings: bool,
    pub needs_additional_factor: bool,
    pub lockout_remaining_seconds: u64,
    pub message: String,
    pub bootstrap: StealthBootstrapState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfDocumentRecord {
    pub id: String,
    pub title: String,
    pub filename: String,
    pub file_size_bytes: u64,
    pub page_count: u32,
    pub sha256_hex: String,
    pub last_page: u32,
    pub last_zoom: f32,
    pub rotation: u16,
    pub bookmarks: Vec<u32>,
    pub is_default_decoy: bool,
    pub last_opened_at: Option<DateTime<Utc>>,
    pub added_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfDocumentStateUpdate {
    pub page_count: Option<u32>,
    pub last_page: Option<u32>,
    pub last_zoom: Option<f32>,
    pub rotation: Option<u16>,
    pub bookmarks: Option<Vec<u32>>,
    pub is_default_decoy: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleEvaluationDecision {
    pub matched_rule_ids: Vec<String>,
    pub visual_action: StealthVisualAction,
    pub lock_action: LockAction,
    pub deletion_action: LocalDeletionAction,
    pub attachment_action: AttachmentPurgeAction,
    pub notification_action: NotificationPrivacyLevel,
    pub voice_action: VoiceCallAction,
    pub camera_action: CameraAction,
    pub screen_share_action: ScreenShareAction,
    pub arm_background_away_ms: Option<i64>,
    pub supressed_by_modal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StealthTestPreviewResult {
    pub trigger: PrivacyTriggerKind,
    pub resulting_surface: ActiveSurface,
    pub would_lock: bool,
    pub would_delete_messages: bool,
    pub deletion_policy: LocalDeletionAction,
    pub disposable_messages_remaining: usize,
    pub disposable_messages_cleared: usize,
    pub note: String,
}

/// Checks if a user-supplied secret code is structurally weak (short codes / tiny PINs).
pub fn is_weak_secret_code(raw: &str) -> bool {
    let trimmed = raw.trim();
    let char_count = trimmed.chars().count();
    if char_count < 8 {
        return true;
    }
    let inner = trimmed.trim_matches('#').trim();
    if inner.chars().count() < 6 {
        return true;
    }
    let unique: HashSet<char> = trimmed.chars().collect();
    unique.len() <= 3
}

/// Produces the normalized representation hashed by Argon2id (Unicode preserved; lowercase only when case-insensitive).
pub fn normalize_secret_code(raw: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        raw.to_string()
    } else {
        raw.to_lowercase()
    }
}

pub fn hash_secret_code(raw: &str, case_sensitive: bool) -> P2pResult<String> {
    if raw.is_empty() || raw.chars().count() > 256 {
        return Err(P2pError::Validation(
            "Secret code must be between 1 and 256 characters".into(),
        ));
    }
    let normalized = normalize_secret_code(raw, case_sensitive);
    let salt = SaltString::generate(&mut OsRng);
    let params = Params::new(19 * 1024, 2, 1, None)
        .map_err(|e| P2pError::Crypto(format!("Argon2 params error: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let hash = argon2
        .hash_password(normalized.as_bytes(), &salt)
        .map_err(|e| P2pError::Crypto(format!("Secret code hashing failed: {e}")))?;
    Ok(hash.to_string())
}

pub fn verify_secret_code(raw: &str, case_sensitive: bool, phc_hash: &str) -> P2pResult<bool> {
    let parsed = PasswordHash::new(phc_hash)
        .map_err(|e| P2pError::Crypto(format!("Stored secret verifier invalid: {e}")))?;
    let normalized = normalize_secret_code(raw, case_sensitive);
    Ok(Argon2::default()
        .verify_password(normalized.as_bytes(), &parsed)
        .is_ok())
}

pub fn generate_recovery_code() -> String {
    let mut raw = [0u8; 16];
    OsRng.fill_bytes(&mut raw);
    let hex_str = hex::encode(raw);
    format!(
        "CLK-{}-{}-{}-{}",
        &hex_str[0..8],
        &hex_str[8..16],
        &hex_str[16..24],
        &hex_str[24..32]
    )
}

pub fn next_progressive_cooldown_secs(failed_attempts: u32) -> u64 {
    match failed_attempts {
        0..=2 => 0,
        3 => 2,
        4 => 5,
        5 => 15,
        n => {
            let exp = (n - 6).min(4);
            30u64.saturating_mul(1u64 << exp).min(300)
        }
    }
}

/// Validates untrusted local PDF input strictly before persisting or serving.
pub fn validate_pdf_document(filename: &str, bytes: &[u8]) -> P2pResult<(String, String)> {
    const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
    if bytes.is_empty() || bytes.len() > MAX_PDF_BYTES {
        return Err(P2pError::Validation(
            "PDF file must be non-empty and at most 64 MiB".into(),
        ));
    }
    let header_slice = &bytes[..bytes.len().min(1024)];
    let has_magic = header_slice.windows(5).any(|w| w == b"%PDF-");
    if !has_magic {
        return Err(P2pError::Validation(
            "Selected file does not have a valid %PDF- document header".into(),
        ));
    }
    let clean_name = crate::crypto::sanitize_attachment_filename(filename);
    let final_name = if clean_name.to_ascii_lowercase().ends_with(".pdf") {
        clean_name
    } else {
        format!("{clean_name}.pdf")
    };
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let sha = hex::encode(hasher.finalize());
    Ok((final_name, sha))
}

pub struct RuleEvalContext<'a> {
    pub in_app_modal_depth: u32,
    pub active_room_id: Option<&'a str>,
    pub ghost_mode_level: GhostModeLevel,
    pub ghost_clear_attachments: bool,
    pub ghost_destructive_confirmed: bool,
    pub now_ms: i64,
}

/// Pure deterministic rule engine resolving concurrent or conflicting privacy rules.
pub fn evaluate_privacy_rules(
    config: &StealthConfig,
    trigger: PrivacyTriggerKind,
    ctx: RuleEvalContext<'_>,
) -> RuleEvaluationDecision {
    let RuleEvalContext {
        in_app_modal_depth,
        active_room_id,
        ghost_mode_level,
        ghost_clear_attachments,
        ghost_destructive_confirmed,
        now_ms,
    } = ctx;
    if !config.enabled {
        // Explicit manual PDF Cover remains available even before full Stealth lock automation is armed.
        // It always requires entering the secret code to return to the workspace.
        if trigger == PrivacyTriggerKind::ManualSwitchToPdf {
            return RuleEvaluationDecision {
                matched_rule_ids: Vec::new(),
                visual_action: StealthVisualAction::SwitchToPdf,
                lock_action: LockAction::RequireUnlock,
                deletion_action: LocalDeletionAction::KeepAll,
                attachment_action: AttachmentPurgeAction::Keep,
                notification_action: config.notifications.pdf_mode_level,
                voice_action: config.calls.voice_action,
                camera_action: config.calls.camera_action,
                screen_share_action: config.calls.screen_share_action,
                arm_background_away_ms: None,
                supressed_by_modal: false,
            };
        }
        return RuleEvaluationDecision {
            matched_rule_ids: Vec::new(),
            visual_action: StealthVisualAction::None,
            lock_action: LockAction::None,
            deletion_action: LocalDeletionAction::KeepAll,
            attachment_action: AttachmentPurgeAction::Keep,
            notification_action: config.notifications.unlocked_level,
            voice_action: VoiceCallAction::Continue,
            camera_action: CameraAction::Continue,
            screen_share_action: ScreenShareAction::Continue,
            arm_background_away_ms: None,
            supressed_by_modal: false,
        };
    }

    // Never fire focus-loss/minimize/show-desktop transitions while an app-owned dialog or picker is open
    if in_app_modal_depth > 0
        && matches!(
            trigger,
            PrivacyTriggerKind::FocusLoss
                | PrivacyTriggerKind::AltTab
                | PrivacyTriggerKind::ClickOtherApp
                | PrivacyTriggerKind::Minimize
                | PrivacyTriggerKind::ShowDesktop
        )
    {
        return RuleEvaluationDecision {
            matched_rule_ids: Vec::new(),
            visual_action: StealthVisualAction::None,
            lock_action: LockAction::None,
            deletion_action: LocalDeletionAction::KeepAll,
            attachment_action: AttachmentPurgeAction::Keep,
            notification_action: config.notifications.unlocked_level,
            voice_action: VoiceCallAction::Continue,
            camera_action: CameraAction::Continue,
            screen_share_action: ScreenShareAction::Continue,
            arm_background_away_ms: None,
            supressed_by_modal: true,
        };
    }

    let trigger_toggle_ok = match trigger {
        PrivacyTriggerKind::FocusLoss => config.trigger_on_focus_loss,
        PrivacyTriggerKind::AltTab => config.trigger_on_alt_tab,
        PrivacyTriggerKind::ClickOtherApp => config.trigger_on_click_other_app,
        PrivacyTriggerKind::Minimize => config.trigger_on_minimize,
        PrivacyTriggerKind::ShowDesktop => config.trigger_on_show_desktop,
        PrivacyTriggerKind::VirtualDesktopSwitch => config.trigger_on_virtual_desktop,
        PrivacyTriggerKind::SessionLock => config.trigger_on_session_lock,
        PrivacyTriggerKind::WindowClose => config.trigger_on_window_close,
        PrivacyTriggerKind::AppRestart => config.trigger_on_restart,
        PrivacyTriggerKind::BackgroundAwayTimeout => config.timers.background_away_enabled,
        PrivacyTriggerKind::ForegroundInactivity => config.timers.foreground_idle_enabled,
        PrivacyTriggerKind::SystemIdle => config.timers.system_idle_enabled,
        PrivacyTriggerKind::PanicHotkey
        | PrivacyTriggerKind::ManualLock
        | PrivacyTriggerKind::ManualSwitchToPdf => true,
        PrivacyTriggerKind::SessionUnlock
        | PrivacyTriggerKind::RestoreTaskbar
        | PrivacyTriggerKind::RestoreTray => false,
    };

    if !trigger_toggle_ok {
        return RuleEvaluationDecision {
            matched_rule_ids: Vec::new(),
            visual_action: StealthVisualAction::None,
            lock_action: LockAction::None,
            deletion_action: LocalDeletionAction::KeepAll,
            attachment_action: AttachmentPurgeAction::Keep,
            notification_action: config.notifications.unlocked_level,
            voice_action: VoiceCallAction::Continue,
            camera_action: CameraAction::Continue,
            screen_share_action: ScreenShareAction::Continue,
            arm_background_away_ms: None,
            supressed_by_modal: false,
        };
    }

    let mut matching: Vec<&PrivacyRule> = config
        .rules
        .iter()
        .filter(|r| {
            r.enabled
                && r.trigger == trigger
                && (r.scope_room_id.is_none() || r.scope_room_id.as_deref() == active_room_id)
        })
        .collect();
    matching.sort_by_key(|a| std::cmp::Reverse(a.priority));

    let fallback_visual = if config.stealth_visual_action == StealthVisualAction::None {
        match config.launch_view {
            StealthLaunchView::PdfReader => StealthVisualAction::SwitchToPdf,
            StealthLaunchView::Messenger => StealthVisualAction::PrivacyShield,
        }
    } else {
        config.stealth_visual_action
    };

    let mut visual_action = matching
        .first()
        .map(|r| r.visual_action)
        .unwrap_or(fallback_visual);
    if trigger == PrivacyTriggerKind::ManualSwitchToPdf
        && matching.is_empty()
        && !matches!(
            visual_action,
            StealthVisualAction::SwitchToPdf
                | StealthVisualAction::SwitchToSelectedPdf
                | StealthVisualAction::GenericDocumentList
        )
    {
        visual_action = StealthVisualAction::SwitchToPdf;
    } else if trigger == PrivacyTriggerKind::PanicHotkey
        && visual_action == StealthVisualAction::None
    {
        visual_action = StealthVisualAction::SwitchToPdf;
    }

    let lock_action = matching.first().map(|r| r.lock_action).unwrap_or(
        if config.unlock.require_unlock_on_return || trigger == PrivacyTriggerKind::ManualSwitchToPdf {
            LockAction::RequireUnlock
        } else {
            LockAction::None
        },
    );

    let mut deletion_action = matching
        .iter()
        .map(|r| r.deletion_action)
        .max()
        .unwrap_or(LocalDeletionAction::KeepAll);

    // Apply timer deletion or Ghost Mode baseline only when requested or configured
    if trigger == PrivacyTriggerKind::BackgroundAwayTimeout
        && config.timers.background_away_deletion > deletion_action
    {
        deletion_action = config.timers.background_away_deletion;
    }

    let ghost_deletion = match ghost_mode_level {
        GhostModeLevel::Off | GhostModeLevel::PrivacyShield => LocalDeletionAction::KeepAll,
        GhostModeLevel::ClearViewed => LocalDeletionAction::DeleteViewedLocal,
        GhostModeLevel::ClearOpenConversation => LocalDeletionAction::DeleteActiveConversation,
    };
    if !matches!(
        trigger,
        PrivacyTriggerKind::BackgroundAwayTimeout
            | PrivacyTriggerKind::ForegroundInactivity
            | PrivacyTriggerKind::SystemIdle
    ) && ghost_deletion > deletion_action
    {
        deletion_action = ghost_deletion;
    }

    if deletion_action == LocalDeletionAction::DeleteActiveConversation
        && !ghost_destructive_confirmed
    {
        deletion_action = LocalDeletionAction::KeepAll;
    }

    let attachment_action = if matching
        .iter()
        .any(|r| r.attachment_action == AttachmentPurgeAction::PurgeRelated)
        || (deletion_action != LocalDeletionAction::KeepAll && ghost_clear_attachments)
    {
        AttachmentPurgeAction::PurgeRelated
    } else {
        AttachmentPurgeAction::Keep
    };

    let notification_action = matching
        .first()
        .and_then(|r| r.notification_action)
        .unwrap_or(config.notifications.pdf_mode_level);

    let voice_action = matching
        .first()
        .and_then(|r| r.voice_action)
        .unwrap_or(config.calls.voice_action);
    let camera_action = matching
        .first()
        .and_then(|r| r.camera_action)
        .unwrap_or(config.calls.camera_action);
    let screen_share_action = matching
        .first()
        .and_then(|r| r.screen_share_action)
        .unwrap_or(config.calls.screen_share_action);

    let arm_background_away_ms = if config.timers.background_away_enabled
        && matches!(
            trigger,
            PrivacyTriggerKind::FocusLoss
                | PrivacyTriggerKind::AltTab
                | PrivacyTriggerKind::ClickOtherApp
                | PrivacyTriggerKind::Minimize
                | PrivacyTriggerKind::ShowDesktop
                | PrivacyTriggerKind::VirtualDesktopSwitch
                | PrivacyTriggerKind::SessionLock
        ) {
        Some(now_ms + (config.timers.background_away_seconds as i64) * 1000)
    } else {
        None
    };

    RuleEvaluationDecision {
        matched_rule_ids: matching.into_iter().map(|r| r.id.clone()).collect(),
        visual_action,
        lock_action,
        deletion_action,
        attachment_action,
        notification_action,
        voice_action,
        camera_action,
        screen_share_action,
        arm_background_away_ms,
        supressed_by_modal: false,
    }
}

/// Safe Test Mode simulation demonstrating transitions without modifying real chats.
pub fn simulate_stealth_test_mode(
    config: &StealthConfig,
    trigger: PrivacyTriggerKind,
    disposable_total: usize,
    disposable_viewed: usize,
    ghost_mode_level: GhostModeLevel,
    ghost_destructive_confirmed: bool,
) -> StealthTestPreviewResult {
    let decision = evaluate_privacy_rules(
        config,
        trigger,
        RuleEvalContext {
            in_app_modal_depth: 0,
            active_room_id: None,
            ghost_mode_level,
            ghost_clear_attachments: true,
            ghost_destructive_confirmed,
            now_ms: 0,
        },
    );
    let cleared = match decision.deletion_action {
        LocalDeletionAction::KeepAll => 0,
        LocalDeletionAction::DeleteIncomingViewedLocal
        | LocalDeletionAction::DeleteOutgoingViewedLocal
        | LocalDeletionAction::DeleteViewedLocal => disposable_viewed.min(disposable_total),
        LocalDeletionAction::DeleteActiveConversation => disposable_total,
    };
    let remaining = disposable_total.saturating_sub(cleared);
    let surface = match decision.visual_action {
        StealthVisualAction::None => ActiveSurface::Messenger,
        StealthVisualAction::Blur | StealthVisualAction::PrivacyShield => {
            ActiveSurface::PrivacyShield
        }
        StealthVisualAction::LockScreen => ActiveSurface::LockScreen,
        StealthVisualAction::SwitchToPdf | StealthVisualAction::SwitchToSelectedPdf => {
            ActiveSurface::PdfReader
        }
        StealthVisualAction::GenericDocumentList => ActiveSurface::GenericDocList,
    };
    StealthTestPreviewResult {
        trigger,
        resulting_surface: surface,
        would_lock: decision.lock_action != LockAction::None,
        would_delete_messages: cleared > 0,
        deletion_policy: decision.deletion_action,
        disposable_messages_remaining: remaining,
        disposable_messages_cleared: cleared,
        note: "Test Mode simulation only; zero real SQLite rooms or messages touched.".into(),
    }
}
