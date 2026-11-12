use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;

use crate::error::{P2pError, P2pResult};
use crate::model::NodeEvent;
use crate::stealth::{
    ActiveCallPrivacySummary, ActiveSurface, CameraAction, LocalDeletionAction, LockAction,
    PdfDocumentRecord, PdfReaderTheme, PrivacyTriggerKind, RuleEvalContext, ScreenShareAction,
    SecretCodeAction, StealthBootstrapState, StealthConfig, StealthLaunchView,
    StealthLifecycleState, StealthPdfReturnBehavior, StealthVisualAction, UnlockMethod,
    UnlockOutcome, VoiceCallAction, evaluate_privacy_rules,
};
use crate::stealth_storage::StealthRuntimeCheckpoint;
use crate::storage::LocalVault;

#[derive(Debug, Clone)]
pub struct StealthRuntime {
    pub locked: bool,
    pub lifecycle_state: StealthLifecycleState,
    pub active_surface: ActiveSurface,
    pub visual_action: StealthVisualAction,
    pub window_focused: bool,
    pub minimized: bool,
    pub session_locked: bool,
    pub in_app_modal_depth: u32,
    pub active_room_id: Option<String>,
    pub active_channel_id: Option<String>,
    pub away_started_ms: Option<i64>,
    pub away_deadline_ms: Option<i64>,
    pub away_purged_for_cycle: bool,
    pub foreground_last_input_ms: i64,
    pub foreground_idle_fired: bool,
    pub system_idle_seconds: u64,
    pub system_idle_fired: bool,
    pub pending_step1_factor: bool,
    pub pending_action: Option<SecretCodeAction>,
    pub pending_target_room_id: Option<String>,
    pub pending_open_privacy_settings: bool,
    pub call_summary: ActiveCallPrivacySummary,
    pub windows_hello_available: bool,
    pub windows_hello_status: String,
    pub last_transition_at_ms: i64,
    pub pdf_search_misses_ms: Vec<i64>,
    pub pdf_search_cooldown_until_ms: Option<i64>,
}

impl Default for StealthRuntime {
    fn default() -> Self {
        let now_ms = Utc::now().timestamp_millis();
        Self {
            locked: false,
            lifecycle_state: StealthLifecycleState::MessengerUnlocked,
            active_surface: ActiveSurface::Messenger,
            visual_action: StealthVisualAction::None,
            window_focused: true,
            minimized: false,
            session_locked: false,
            in_app_modal_depth: 0,
            active_room_id: None,
            active_channel_id: None,
            away_started_ms: None,
            away_deadline_ms: None,
            away_purged_for_cycle: false,
            foreground_last_input_ms: now_ms,
            foreground_idle_fired: false,
            system_idle_seconds: 0,
            system_idle_fired: false,
            pending_step1_factor: false,
            pending_action: None,
            pending_target_room_id: None,
            pending_open_privacy_settings: false,
            call_summary: ActiveCallPrivacySummary::default(),
            windows_hello_available: false,
            windows_hello_status: "Not checked".into(),
            last_transition_at_ms: now_ms,
            pdf_search_misses_ms: Vec::new(),
            pdf_search_cooldown_until_ms: None,
        }
    }
}

#[derive(Clone)]
pub struct StealthController {
    vault: Arc<Mutex<LocalVault>>,
    runtime: Arc<Mutex<StealthRuntime>>,
    test_clock_offset_ms: Arc<AtomicI64>,
    events: tokio::sync::broadcast::Sender<NodeEvent>,
}

impl StealthController {
    pub fn new(
        vault: Arc<Mutex<LocalVault>>,
        events: tokio::sync::broadcast::Sender<NodeEvent>,
    ) -> Self {
        let now_ms = Utc::now().timestamp_millis();
        let (config, checkpoint) = {
            let v = vault.lock().unwrap();
            let cfg = v.get_stealth_config().unwrap_or_default();
            let cp = v.get_runtime_checkpoint().ok();
            (cfg, cp)
        };

        // Process overdue away deadlines that elapsed while the app was closed or suspended
        let mut initial_locked = false;
        let mut away_deadline = None;
        if let Some(cp) = checkpoint {
            if let Some(dl) = cp.away_deadline_ms {
                if dl <= now_ms {
                    let room_and_chan = {
                        let v = vault.lock().unwrap();
                        v.list_rooms()
                            .ok()
                            .and_then(|rooms| rooms.into_iter().next())
                            .and_then(|r| {
                                v.list_channels(&r.id)
                                    .ok()
                                    .and_then(|chs| chs.into_iter().next())
                                    .map(|c| (r.id, c.id))
                            })
                    };
                    if let Some((rid, cid)) = room_and_chan {
                        let _ = vault.lock().unwrap().execute_local_deletion(
                            &rid,
                            &cid,
                            config.timers.background_away_deletion,
                            true,
                        );
                    }
                    initial_locked = true;
                } else {
                    away_deadline = Some(dl);
                }
            }
            if cp.locked {
                initial_locked = true;
            }
        }

        if config.enabled
            && (config.launch_view == StealthLaunchView::PdfReader || config.unlock.lock_on_restart)
        {
            initial_locked = true;
        }

        let initial_surface = if initial_locked {
            match config.launch_view {
                StealthLaunchView::PdfReader => ActiveSurface::PdfReader,
                StealthLaunchView::Messenger => match config.stealth_visual_action {
                    StealthVisualAction::SwitchToPdf | StealthVisualAction::SwitchToSelectedPdf => {
                        ActiveSurface::PdfReader
                    }
                    StealthVisualAction::GenericDocumentList => ActiveSurface::GenericDocList,
                    StealthVisualAction::LockScreen => ActiveSurface::LockScreen,
                    _ => ActiveSurface::PrivacyShield,
                },
            }
        } else if config.enabled && config.launch_view == StealthLaunchView::PdfReader {
            ActiveSurface::PdfReader
        } else {
            ActiveSurface::Messenger
        };

        let initial_lifecycle = if initial_locked {
            StealthLifecycleState::DecoyLocked
        } else {
            StealthLifecycleState::MessengerUnlocked
        };

        let (hello_avail, hello_status) = query_windows_hello_availability_sync();

        let rt = StealthRuntime {
            locked: initial_locked,
            lifecycle_state: initial_lifecycle,
            active_surface: initial_surface,
            visual_action: if initial_locked {
                config.stealth_visual_action
            } else {
                StealthVisualAction::None
            },
            away_deadline_ms: away_deadline,
            foreground_last_input_ms: now_ms,
            windows_hello_available: hello_avail,
            windows_hello_status: hello_status,
            last_transition_at_ms: now_ms,
            ..StealthRuntime::default()
        };

        {
            let v = vault.lock().unwrap();
            let _ = v.save_runtime_checkpoint(&StealthRuntimeCheckpoint {
                locked: initial_locked,
                away_deadline_ms: away_deadline,
                last_wall_ms: now_ms,
                locked_reason: if initial_locked {
                    Some("startup_restore".into())
                } else {
                    None
                },
            });
        }

        Self {
            vault,
            runtime: Arc::new(Mutex::new(rt)),
            test_clock_offset_ms: Arc::new(AtomicI64::new(0)),
            events,
        }
    }

    pub fn now_ms(&self) -> i64 {
        Utc::now().timestamp_millis() + self.test_clock_offset_ms.load(Ordering::Relaxed)
    }

    pub fn is_locked(&self) -> bool {
        self.runtime.lock().unwrap().locked
    }

    pub fn advance_clock_ms(&self, delta_ms: i64) -> P2pResult<StealthBootstrapState> {
        self.test_clock_offset_ms
            .fetch_add(delta_ms, Ordering::SeqCst);
        self.tick_timers()?;
        Ok(self.bootstrap_state())
    }

    pub fn get_config(&self) -> P2pResult<StealthConfig> {
        self.vault.lock().unwrap().get_stealth_config()
    }

    pub fn update_config(&self, config: StealthConfig) -> P2pResult<StealthConfig> {
        let updated = self.vault.lock().unwrap().update_stealth_config(config)?;
        {
            let mut rt = self.runtime.lock().unwrap();
            if !updated.enabled {
                rt.locked = false;
                rt.lifecycle_state = StealthLifecycleState::MessengerUnlocked;
                rt.active_surface = ActiveSurface::Messenger;
                rt.visual_action = StealthVisualAction::None;
                rt.away_deadline_ms = None;
                rt.away_started_ms = None;
                rt.pending_step1_factor = false;
            }
        }
        self.persist_checkpoint_and_broadcast(Some("config_updated".into()));
        Ok(updated)
    }

    pub fn update_call_summary(&self, summary: ActiveCallPrivacySummary) -> StealthBootstrapState {
        let changed = {
            let mut rt = self.runtime.lock().unwrap();
            let same = rt.call_summary.in_call == summary.in_call
                && rt.call_summary.mic_active == summary.mic_active
                && rt.call_summary.mic_muted == summary.mic_muted
                && rt.call_summary.camera_active == summary.camera_active
                && rt.call_summary.screen_sharing_active == summary.screen_sharing_active;
            if same {
                false
            } else {
                rt.call_summary = summary;
                true
            }
        };
        let snap = self.bootstrap_state();
        if changed {
            let _ = self
                .events
                .send(NodeEvent::StealthStateChanged(snap.clone()));
        }
        snap
    }

    pub fn set_active_conversation(&self, room_id: Option<&str>, channel_id: Option<&str>) {
        let mut rt = self.runtime.lock().unwrap();
        rt.active_room_id = room_id.map(ToOwned::to_owned);
        rt.active_channel_id = channel_id.map(ToOwned::to_owned);
    }

    pub fn set_modal_open(&self, open: bool) {
        let mut rt = self.runtime.lock().unwrap();
        if open {
            rt.in_app_modal_depth = rt.in_app_modal_depth.saturating_add(1);
        } else {
            rt.in_app_modal_depth = rt.in_app_modal_depth.saturating_sub(1);
        }
    }

    /// Resets the foreground inactivity clock strictly on interactive user actions inside the messenger window.
    pub fn record_foreground_activity(&self) {
        let now_ms = self.now_ms();
        let mut rt = self.runtime.lock().unwrap();
        if !rt.locked
            && rt.active_surface == ActiveSurface::Messenger
            && rt.window_focused
            && !rt.minimized
        {
            rt.foreground_last_input_ms = now_ms;
            rt.foreground_idle_fired = false;
        }
    }

    /// Receives Windows `GetLastInputInfo` OS idle elapsed time without touching app-away timers.
    pub fn report_system_idle_ms(&self, system_idle_ms: u64) -> P2pResult<()> {
        let config = self.get_config()?;
        let should_fire = {
            let mut rt = self.runtime.lock().unwrap();
            rt.system_idle_seconds = system_idle_ms / 1000;
            if system_idle_ms < 2000 {
                rt.system_idle_fired = false;
                false
            } else {
                config.enabled
                    && config.timers.system_idle_enabled
                    && !rt.system_idle_fired
                    && system_idle_ms >= config.timers.system_idle_seconds.saturating_mul(1000)
            }
        };
        if should_fire {
            {
                let mut rt = self.runtime.lock().unwrap();
                rt.system_idle_fired = true;
            }
            self.handle_trigger(PrivacyTriggerKind::SystemIdle)?;
        }
        Ok(())
    }

    pub fn notify_window_focus_restored(
        &self,
        from_tray_or_taskbar: bool,
    ) -> P2pResult<StealthBootstrapState> {
        let _ = from_tray_or_taskbar;
        let config = self.get_config()?;
        {
            let mut rt = self.runtime.lock().unwrap();
            rt.window_focused = true;
            rt.minimized = false;
            rt.session_locked = false;
            if config.timers.background_away_cancel_on_return
                && !config.timers.background_away_preserve_deadline
                && !rt.locked
            {
                rt.away_deadline_ms = None;
                rt.away_started_ms = None;
            }
            if !rt.locked {
                rt.foreground_last_input_ms = self.now_ms();
                rt.lifecycle_state = StealthLifecycleState::MessengerFocused;
            }
        }
        self.persist_checkpoint_and_broadcast(None);
        Ok(self.bootstrap_state())
    }

    /// Evaluates background-away and foreground inactivity deadlines using real + controllable test clock.
    pub fn tick_timers(&self) -> P2pResult<()> {
        let now_ms = self.now_ms();
        let config = self.get_config()?;
        if !config.enabled {
            return Ok(());
        }

        let (fire_away, fire_fg_idle) = {
            let mut rt = self.runtime.lock().unwrap();
            let away = if config.timers.background_away_enabled
                && !rt.away_purged_for_cycle
                && let Some(dl) = rt.away_deadline_ms
                && now_ms >= dl
            {
                rt.away_purged_for_cycle = true;
                true
            } else {
                false
            };

            let fg = if config.timers.foreground_idle_enabled
                && !rt.locked
                && rt.active_surface == ActiveSurface::Messenger
                && rt.window_focused
                && !rt.minimized
                && !rt.foreground_idle_fired
                && now_ms.saturating_sub(rt.foreground_last_input_ms)
                    >= (config.timers.foreground_idle_seconds as i64) * 1000
            {
                rt.foreground_idle_fired = true;
                true
            } else {
                false
            };

            (away, fg)
        };

        if fire_away {
            self.handle_trigger(PrivacyTriggerKind::BackgroundAwayTimeout)?;
        }
        if fire_fg_idle {
            self.handle_trigger(PrivacyTriggerKind::ForegroundInactivity)?;
        }
        Ok(())
    }

    pub fn handle_trigger(&self, trigger: PrivacyTriggerKind) -> P2pResult<StealthBootstrapState> {
        if matches!(
            trigger,
            PrivacyTriggerKind::RestoreTaskbar
                | PrivacyTriggerKind::RestoreTray
                | PrivacyTriggerKind::SessionUnlock
        ) {
            return self.notify_window_focus_restored(matches!(
                trigger,
                PrivacyTriggerKind::RestoreTaskbar | PrivacyTriggerKind::RestoreTray
            ));
        }

        let now_ms = self.now_ms();
        let config = self.get_config()?;
        let (modal_depth, active_room_id, active_chan_id) = {
            let rt = self.runtime.lock().unwrap();
            (
                rt.in_app_modal_depth,
                rt.active_room_id.clone(),
                rt.active_channel_id.clone(),
            )
        };
        let ghost_policy = self.vault.lock().unwrap().get_ghost_policy()?;
        let decision = evaluate_privacy_rules(
            &config,
            trigger,
            RuleEvalContext {
                in_app_modal_depth: modal_depth,
                active_room_id: active_room_id.as_deref(),
                ghost_mode_level: ghost_policy.mode,
                ghost_clear_attachments: ghost_policy.clear_attachments,
                ghost_destructive_confirmed: ghost_policy.destructive_confirmed,
                now_ms,
            },
        );

        if decision.supressed_by_modal {
            return Ok(self.bootstrap_state());
        }

        // Execute local deletion atomically & idempotently if configured by rule or timer
        if decision.deletion_action != LocalDeletionAction::KeepAll
            && let (Some(rid), Some(cid)) = (active_room_id.as_deref(), active_chan_id.as_deref())
        {
            let clear_att =
                decision.attachment_action == crate::stealth::AttachmentPurgeAction::PurgeRelated;
            let _ = self.vault.lock().unwrap().execute_local_deletion(
                rid,
                cid,
                decision.deletion_action,
                clear_att,
            )?;
            let _ = self.events.send(NodeEvent::HistoryChanged {
                room_id: rid.to_string(),
                scope: "stealth_ghost_clear".into(),
            });
        }

        {
            let mut rt = self.runtime.lock().unwrap();
            match trigger {
                PrivacyTriggerKind::FocusLoss
                | PrivacyTriggerKind::AltTab
                | PrivacyTriggerKind::ClickOtherApp
                | PrivacyTriggerKind::ShowDesktop
                | PrivacyTriggerKind::VirtualDesktopSwitch => {
                    rt.window_focused = false;
                }
                PrivacyTriggerKind::Minimize => {
                    rt.window_focused = false;
                    rt.minimized = true;
                }
                PrivacyTriggerKind::SessionLock => {
                    rt.window_focused = false;
                    rt.session_locked = true;
                }
                PrivacyTriggerKind::BackgroundAwayTimeout => {
                    rt.away_deadline_ms = None;
                }
                _ => {}
            }

            if let Some(next_dl) = decision.arm_background_away_ms {
                let keep_existing = config.timers.background_away_preserve_deadline
                    && rt.away_deadline_ms.is_some();
                if !keep_existing {
                    rt.away_deadline_ms = Some(next_dl);
                    rt.away_started_ms = Some(now_ms);
                    rt.away_purged_for_cycle = false;
                }
            }

            if decision.visual_action != StealthVisualAction::None
                || decision.lock_action != LockAction::None
            {
                rt.visual_action = decision.visual_action;
                rt.active_surface = match decision.visual_action {
                    StealthVisualAction::None => rt.active_surface,
                    StealthVisualAction::Blur | StealthVisualAction::PrivacyShield => {
                        ActiveSurface::PrivacyShield
                    }
                    StealthVisualAction::LockScreen => ActiveSurface::LockScreen,
                    StealthVisualAction::SwitchToPdf | StealthVisualAction::SwitchToSelectedPdf => {
                        ActiveSurface::PdfReader
                    }
                    StealthVisualAction::GenericDocumentList => ActiveSurface::GenericDocList,
                };
                if decision.lock_action != LockAction::None {
                    rt.locked = true;
                    rt.lifecycle_state = StealthLifecycleState::DecoyLocked;
                    rt.pending_step1_factor = false;
                    rt.pending_action = None;
                    rt.pending_target_room_id = None;
                    rt.pending_open_privacy_settings = false;
                } else {
                    rt.lifecycle_state = StealthLifecycleState::MessengerBackgrounded;
                }
            }

            // Apply configured active call media actions immediately in summary
            if rt.call_summary.in_call {
                match decision.voice_action {
                    VoiceCallAction::AutoMute => rt.call_summary.mic_muted = true,
                    VoiceCallAction::EndCall => {
                        rt.call_summary = ActiveCallPrivacySummary::default();
                    }
                    VoiceCallAction::Continue | VoiceCallAction::AskBeforeEnding => {}
                }
                if !matches!(decision.camera_action, CameraAction::Continue) {
                    rt.call_summary.camera_active = false;
                }
                if matches!(
                    decision.screen_share_action,
                    ScreenShareAction::StopImmediately
                ) {
                    rt.call_summary.screen_sharing_active = false;
                }
            }

            rt.last_transition_at_ms = now_ms;
        }

        self.persist_checkpoint_and_broadcast(Some(format!("{trigger:?}")));
        Ok(self.bootstrap_state())
    }

    pub fn verify_and_unlock(
        &self,
        method: UnlockMethod,
        secret: &str,
        pin_or_additional: Option<&str>,
    ) -> P2pResult<UnlockOutcome> {
        let now_ms = self.now_ms();
        let config = self.get_config()?;

        if !config.unlock.enabled_methods.contains(&method) {
            return Ok(UnlockOutcome {
                matched: false,
                unlocked: false,
                action: None,
                target_room_id: None,
                open_privacy_settings: false,
                needs_additional_factor: false,
                lockout_remaining_seconds: 0,
                message: "Selected unlock method is disabled in Stealth settings.".into(),
                bootstrap: self.bootstrap_state(),
            });
        }

        let rate = self.vault.lock().unwrap().get_rate_limit_state()?;
        if let Some(until) = rate.cooldown_until_ms
            && until > now_ms
        {
            let rem = ((until - now_ms) / 1000).max(1) as u64;
            return Ok(UnlockOutcome {
                matched: false,
                unlocked: false,
                action: None,
                target_room_id: None,
                open_privacy_settings: false,
                needs_additional_factor: false,
                lockout_remaining_seconds: rem,
                message: format!("Too many failed attempts. Try again in {rem}s."),
                bootstrap: self.bootstrap_state(),
            });
        }

        if method == UnlockMethod::PdfSearch {
            let throttled = {
                let mut rt = self.runtime.lock().unwrap();
                if let Some(until) = rt.pdf_search_cooldown_until_ms {
                    if until > now_ms {
                        true
                    } else {
                        rt.pdf_search_cooldown_until_ms = None;
                        false
                    }
                } else {
                    false
                }
            };
            if throttled {
                return Ok(UnlockOutcome {
                    matched: false,
                    unlocked: false,
                    action: None,
                    target_room_id: None,
                    open_privacy_settings: false,
                    needs_additional_factor: false,
                    lockout_remaining_seconds: 0,
                    message: "No document matches found.".into(),
                    bootstrap: self.bootstrap_state(),
                });
            }
        }

        let mut matched_action: Option<SecretCodeAction> = None;
        let mut target_room: Option<String> = None;
        let mut needs_add_auth = config.unlock.require_additional_auth;

        let verified = match method {
            UnlockMethod::PdfSearch
            | UnlockMethod::HiddenShortcutInput
            | UnlockMethod::DiscreetCommand => {
                let res = self
                    .vault
                    .lock()
                    .unwrap()
                    .verify_secret_code_against_store(secret, config.unlock.case_sensitive)?;
                if let Some(m) = res {
                    matched_action = Some(m.action);
                    target_room = m.target_room_id;
                    if m.require_additional_auth {
                        needs_add_auth = true;
                    }
                    true
                } else {
                    false
                }
            }
            UnlockMethod::Passphrase => {
                let ok = self
                    .vault
                    .lock()
                    .unwrap()
                    .verify_stealth_passphrase(secret)?;
                if ok {
                    matched_action = Some(SecretCodeAction::OpenMessenger);
                }
                ok
            }
            UnlockMethod::Pin => {
                let ok = self.vault.lock().unwrap().verify_ghost_pin(secret)?;
                if ok {
                    matched_action = Some(SecretCodeAction::OpenMessenger);
                }
                ok
            }
            UnlockMethod::WindowsHello => {
                let ok = request_windows_hello_verification_sync()?;
                if ok {
                    matched_action = Some(SecretCodeAction::OpenMessenger);
                }
                ok
            }
        };

        if !verified {
            // Separate passive PDF search misses from explicit auth lockouts so normal PDF reading
            // never locks out the user, while still throttling rapid PDF-search brute-force bursts (>= 8/2m).
            if method == UnlockMethod::PdfSearch {
                {
                    let mut rt = self.runtime.lock().unwrap();
                    rt.pdf_search_misses_ms.retain(|t| *t >= now_ms - 120_000);
                    rt.pdf_search_misses_ms.push(now_ms);
                    if rt.pdf_search_misses_ms.len() >= 8 {
                        rt.pdf_search_cooldown_until_ms = Some(now_ms + 30_000);
                        rt.pdf_search_misses_ms.clear();
                    }
                }
                return Ok(UnlockOutcome {
                    matched: false,
                    unlocked: false,
                    action: None,
                    target_room_id: None,
                    open_privacy_settings: false,
                    needs_additional_factor: false,
                    lockout_remaining_seconds: 0,
                    message: "No document matches found.".into(),
                    bootstrap: self.bootstrap_state(),
                });
            }
            let next_rl = self
                .vault
                .lock()
                .unwrap()
                .record_failed_unlock_attempt(now_ms)?;
            let rem = next_rl
                .cooldown_until_ms
                .map(|u| ((u - now_ms) / 1000).max(0) as u64)
                .unwrap_or(0);
            let snap = self.bootstrap_state();
            return Ok(UnlockOutcome {
                matched: false,
                unlocked: false,
                action: None,
                target_room_id: None,
                open_privacy_settings: false,
                needs_additional_factor: false,
                lockout_remaining_seconds: rem,
                message: if rem > 0 {
                    format!("Verification failed. Cooldown active for {rem}s.")
                } else {
                    "Verification failed.".into()
                },
                bootstrap: snap,
            });
        }

        // Check secondary factor when required (skip secondary check for ReturnToPdf / PanicLock!)
        let action = matched_action.unwrap_or(SecretCodeAction::OpenMessenger);
        if matches!(
            action,
            SecretCodeAction::ReturnToPdf | SecretCodeAction::PanicLock
        ) {
            self.vault.lock().unwrap().reset_unlock_rate_limit()?;
            let boot = self.handle_trigger(if action == SecretCodeAction::PanicLock {
                PrivacyTriggerKind::PanicHotkey
            } else {
                PrivacyTriggerKind::ManualSwitchToPdf
            })?;
            return Ok(UnlockOutcome {
                matched: true,
                unlocked: false,
                action: Some(action),
                target_room_id: None,
                open_privacy_settings: false,
                needs_additional_factor: false,
                lockout_remaining_seconds: 0,
                message: "Stealth cover activated.".into(),
                bootstrap: boot,
            });
        }

        if needs_add_auth
            && matches!(
                method,
                UnlockMethod::PdfSearch
                    | UnlockMethod::HiddenShortcutInput
                    | UnlockMethod::DiscreetCommand
            )
        {
            let second_ok = match pin_or_additional {
                Some(extra) if !extra.is_empty() => {
                    let v = self.vault.lock().unwrap();
                    v.verify_stealth_passphrase(extra).unwrap_or(false)
                        || (v
                            .get_ghost_policy()
                            .map(|p| p.has_pin_configured)
                            .unwrap_or(false)
                            && v.verify_ghost_pin(extra).unwrap_or(false))
                }
                _ => false,
            };
            if !second_ok {
                {
                    let mut rt = self.runtime.lock().unwrap();
                    rt.pending_step1_factor = true;
                    rt.pending_action = Some(action);
                    rt.pending_target_room_id = target_room.clone();
                    rt.lifecycle_state = StealthLifecycleState::Authenticating;
                }
                return Ok(UnlockOutcome {
                    matched: true,
                    unlocked: false,
                    action: Some(action),
                    target_room_id: target_room,
                    open_privacy_settings: false,
                    needs_additional_factor: true,
                    lockout_remaining_seconds: 0,
                    message: "Additional passphrase or PIN required to complete unlock.".into(),
                    bootstrap: self.bootstrap_state(),
                });
            }
        }

        self.vault.lock().unwrap().reset_unlock_rate_limit()?;
        let open_privacy = action == SecretCodeAction::OpenPrivacySettings;

        {
            let mut rt = self.runtime.lock().unwrap();
            rt.locked = false;
            rt.lifecycle_state = StealthLifecycleState::MessengerUnlocked;
            rt.active_surface = ActiveSurface::Messenger;
            rt.visual_action = StealthVisualAction::None;
            rt.window_focused = true;
            rt.minimized = false;
            rt.session_locked = false;
            rt.away_deadline_ms = None;
            rt.away_started_ms = None;
            rt.away_purged_for_cycle = false;
            rt.foreground_last_input_ms = now_ms;
            rt.foreground_idle_fired = false;
            rt.pending_step1_factor = false;
            rt.pending_action = None;
            rt.pending_target_room_id = target_room.clone();
            rt.pending_open_privacy_settings = open_privacy;
            rt.last_transition_at_ms = now_ms;
            rt.pdf_search_misses_ms.clear();
            rt.pdf_search_cooldown_until_ms = None;
        }
        self.persist_checkpoint_and_broadcast(None);
        let snap = self.bootstrap_state();

        Ok(UnlockOutcome {
            matched: true,
            unlocked: true,
            action: Some(action),
            target_room_id: target_room,
            open_privacy_settings: open_privacy,
            needs_additional_factor: false,
            lockout_remaining_seconds: 0,
            message: "Unlocked.".into(),
            bootstrap: snap,
        })
    }

    pub fn recover_unlock_with_recovery_code(
        &self,
        recovery_code: &str,
    ) -> P2pResult<UnlockOutcome> {
        let ok = self
            .vault
            .lock()
            .unwrap()
            .verify_recovery_code(recovery_code)?;
        if !ok {
            return Err(P2pError::PeerRejected(
                "Invalid Stealth recovery key".into(),
            ));
        }
        let now_ms = self.now_ms();
        self.vault.lock().unwrap().reset_unlock_rate_limit()?;
        {
            let mut rt = self.runtime.lock().unwrap();
            rt.locked = false;
            rt.lifecycle_state = StealthLifecycleState::MessengerUnlocked;
            rt.active_surface = ActiveSurface::Messenger;
            rt.visual_action = StealthVisualAction::None;
            rt.window_focused = true;
            rt.minimized = false;
            rt.session_locked = false;
            rt.away_deadline_ms = None;
            rt.away_started_ms = None;
            rt.away_purged_for_cycle = false;
            rt.pending_step1_factor = false;
            rt.pending_action = None;
            rt.foreground_last_input_ms = now_ms;
            rt.foreground_idle_fired = false;
            rt.last_transition_at_ms = now_ms;
        }
        self.persist_checkpoint_and_broadcast(None);
        Ok(UnlockOutcome {
            matched: true,
            unlocked: true,
            action: Some(SecretCodeAction::OpenPrivacySettings),
            target_room_id: None,
            open_privacy_settings: true,
            needs_additional_factor: false,
            lockout_remaining_seconds: 0,
            message: "Recovered via recovery code.".into(),
            bootstrap: self.bootstrap_state(),
        })
    }

    pub fn switch_to_messenger_if_unlocked(&self) -> P2pResult<StealthBootstrapState> {
        {
            let mut rt = self.runtime.lock().unwrap();
            if rt.locked {
                return Err(P2pError::PeerRejected(
                    "Messenger is locked; authenticate first".into(),
                ));
            }
            rt.active_surface = ActiveSurface::Messenger;
            rt.lifecycle_state = StealthLifecycleState::MessengerUnlocked;
            rt.visual_action = StealthVisualAction::None;
            rt.foreground_last_input_ms = self.now_ms();
        }
        self.persist_checkpoint_and_broadcast(None);
        Ok(self.bootstrap_state())
    }

    pub fn select_default_pdf_id(
        &self,
        docs: &[PdfDocumentRecord],
        cfg: &StealthConfig,
    ) -> Option<String> {
        match cfg.pdf_reader.return_behavior {
            StealthPdfReturnBehavior::NeutralWelcome
            | StealthPdfReturnBehavior::DocumentLibrary => None,
            StealthPdfReturnBehavior::ConfiguredDefault => cfg
                .pdf_reader
                .default_document_id
                .clone()
                .or_else(|| {
                    docs.iter()
                        .find(|d| d.is_default_decoy)
                        .map(|d| d.id.clone())
                })
                .or_else(|| docs.first().map(|d| d.id.clone())),
            StealthPdfReturnBehavior::LastOpened => docs.first().map(|d| d.id.clone()),
        }
    }

    pub fn bootstrap_state(&self) -> StealthBootstrapState {
        let now_ms = self.now_ms();
        let (cfg, rl, docs, has_pass, has_pin) = {
            let v = self.vault.lock().unwrap();
            (
                v.get_stealth_config().unwrap_or_default(),
                v.get_rate_limit_state().unwrap_or_default(),
                v.list_pdf_documents().unwrap_or_default(),
                v.has_stealth_passphrase().unwrap_or(false),
                v.get_ghost_policy()
                    .map(|p| p.has_pin_configured)
                    .unwrap_or(false),
            )
        };

        let rt = self.runtime.lock().unwrap();
        let lockout_rem = rl
            .cooldown_until_ms
            .map(|u| ((u - now_ms) / 1000).max(0) as u64)
            .unwrap_or(0);
        let away_rem = rt
            .away_deadline_ms
            .map(|dl| ((dl - now_ms) / 1000).max(0) as u64);
        let fg_rem = if cfg.enabled && cfg.timers.foreground_idle_enabled && !rt.locked {
            let elapsed = (now_ms.saturating_sub(rt.foreground_last_input_ms) / 1000).max(0) as u64;
            Some(cfg.timers.foreground_idle_seconds.saturating_sub(elapsed))
        } else {
            None
        };

        let notif_now = if cfg.notifications.dnd_enabled {
            cfg.notifications.dnd_level
        } else if rt.call_summary.screen_sharing_active {
            cfg.notifications.screen_sharing_level
        } else if rt.session_locked {
            cfg.notifications.windows_locked_level
        } else if rt.minimized {
            cfg.notifications.minimized_level
        } else if rt.locked || rt.active_surface == ActiveSurface::PdfReader {
            cfg.notifications.pdf_mode_level
        } else {
            cfg.notifications.unlocked_level
        };

        let window_title = if rt.active_surface == ActiveSurface::Messenger && !rt.locked {
            "Cloak".to_string()
        } else {
            cfg.pdf_reader.neutral_window_title.clone()
        };

        StealthBootstrapState {
            stealth_enabled: cfg.enabled,
            locked: rt.locked,
            lifecycle_state: rt.lifecycle_state,
            active_surface: rt.active_surface,
            visual_action: rt.visual_action,
            launch_view: cfg.launch_view,
            pdf_return_behavior: cfg.pdf_reader.return_behavior,
            default_pdf_id: self.select_default_pdf_id(&docs, &cfg),
            pdf_theme: if cfg.enabled {
                cfg.pdf_reader.theme
            } else {
                PdfReaderTheme::Light
            },
            window_title,
            enabled_unlock_methods: cfg.unlock.enabled_methods.clone(),
            require_additional_auth: cfg.unlock.require_additional_auth,
            has_passphrase_configured: has_pass,
            has_pin_configured: has_pin,
            hidden_shortcut: cfg.unlock.hidden_shortcut.clone(),
            panic_shortcut: cfg.unlock.panic_shortcut.clone(),
            lockout_remaining_seconds: lockout_rem,
            failed_attempts: rl.failed_attempts,
            windows_hello_available: rt.windows_hello_available,
            windows_hello_status: rt.windows_hello_status.clone(),
            call_summary: if cfg.calls.show_call_indicator_in_pdf || !rt.locked {
                rt.call_summary.clone()
            } else {
                ActiveCallPrivacySummary::default()
            },
            notification_level_now: notif_now,
            away_deadline_ms: rt.away_deadline_ms,
            away_remaining_seconds: away_rem,
            foreground_idle_remaining_seconds: fg_rem,
            system_idle_seconds: rt.system_idle_seconds,
            pending_navigation_target: rt.pending_target_room_id.clone(),
            pending_open_privacy_settings: rt.pending_open_privacy_settings,
        }
    }

    fn persist_checkpoint_and_broadcast(&self, reason: Option<String>) {
        let now_ms = self.now_ms();
        let (locked, away_dl) = {
            let rt = self.runtime.lock().unwrap();
            (rt.locked, rt.away_deadline_ms)
        };
        {
            let v = self.vault.lock().unwrap();
            let _ = v.save_runtime_checkpoint(&StealthRuntimeCheckpoint {
                locked,
                away_deadline_ms: away_dl,
                last_wall_ms: now_ms,
                locked_reason: reason,
            });
        }
        let snap = self.bootstrap_state();
        let _ = self.events.send(NodeEvent::StealthStateChanged(snap));
    }
}

#[cfg(target_os = "windows")]
mod winrt_hello {
    use core::ffi::c_void;
    use std::time::{Duration, Instant};

    use crate::error::{P2pError, P2pResult};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const IID_IUSER_CONSENT_VERIFIER_STATICS: Guid = Guid {
        data1: 0xaf4f3f91,
        data2: 0x564c,
        data3: 0x4ddc,
        data4: [0xb8, 0xb5, 0x97, 0x34, 0x47, 0x62, 0x7c, 0x65],
    };
    const IID_IASYNC_INFO: Guid = Guid {
        data1: 0x00000036,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    const RO_INIT_MULTITHREADED: u32 = 1;
    const RPC_E_CHANGED_MODE: i32 = -2147417850; // 0x80010106

    #[repr(C)]
    struct ComVtblHeader {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32,
        _add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        _get_iids: unsafe extern "system" fn(*mut c_void, *mut u32, *mut *mut Guid) -> i32,
        _get_runtime_class_name: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
        _get_trust_level: unsafe extern "system" fn(*mut c_void, *mut i32) -> i32,
    }

    #[repr(C)]
    struct IUserConsentVerifierStaticsVtbl {
        base: ComVtblHeader,
        check_availability_async: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
        request_verification_async:
            unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> i32,
    }

    #[repr(C)]
    struct IAsyncInfoVtbl {
        base: ComVtblHeader,
        _id: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
        status: unsafe extern "system" fn(*mut c_void, *mut i32) -> i32,
        error_code: unsafe extern "system" fn(*mut c_void, *mut i32) -> i32,
        _cancel: unsafe extern "system" fn(*mut c_void) -> i32,
        _close: unsafe extern "system" fn(*mut c_void) -> i32,
    }

    #[repr(C)]
    struct IAsyncOperationU32Vtbl {
        base: ComVtblHeader,
        _put_completed: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32,
        _get_completed: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
        get_results: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
    }

    type FnRoInitialize = unsafe extern "system" fn(u32) -> i32;
    type FnRoUninitialize = unsafe extern "system" fn();
    type FnRoGetActivationFactory =
        unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32;
    type FnWindowsCreateString =
        unsafe extern "system" fn(*const u16, u32, *mut *mut c_void) -> i32;
    type FnWindowsDeleteString = unsafe extern "system" fn(*mut c_void) -> i32;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryA(lp_lib_file_name: *const u8) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const u8) -> *const c_void;
    }

    struct CombaseFns {
        ro_initialize: FnRoInitialize,
        ro_uninitialize: FnRoUninitialize,
        ro_get_activation_factory: FnRoGetActivationFactory,
        windows_create_string: FnWindowsCreateString,
        windows_delete_string: FnWindowsDeleteString,
    }

    unsafe fn load_combase() -> P2pResult<CombaseFns> {
        let hmod = unsafe { LoadLibraryA(c"combase.dll".as_ptr() as *const u8) };
        if hmod.is_null() {
            return Err(P2pError::Protocol("combase.dll unavailable".into()));
        }
        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                let p = unsafe { GetProcAddress(hmod, $name.as_ptr() as *const u8) };
                if p.is_null() {
                    return Err(P2pError::Protocol(format!(
                        "Missing combase symbol {}",
                        $name.to_string_lossy()
                    )));
                }
                unsafe { std::mem::transmute::<*const c_void, $ty>(p) }
            }};
        }
        Ok(CombaseFns {
            ro_initialize: sym!(c"RoInitialize", FnRoInitialize),
            ro_uninitialize: sym!(c"RoUninitialize", FnRoUninitialize),
            ro_get_activation_factory: sym!(c"RoGetActivationFactory", FnRoGetActivationFactory),
            windows_create_string: sym!(c"WindowsCreateString", FnWindowsCreateString),
            windows_delete_string: sym!(c"WindowsDeleteString", FnWindowsDeleteString),
        })
    }

    unsafe fn release_com(ptr: *mut c_void) {
        if !ptr.is_null() {
            let vtbl = unsafe { *(ptr as *const *const ComVtblHeader) };
            unsafe { ((*vtbl).release)(ptr) };
        }
    }

    unsafe fn make_hstring(fns: &CombaseFns, text: &str) -> P2pResult<*mut c_void> {
        let wide: Vec<u16> = text.encode_utf16().collect();
        let mut hstr: *mut c_void = std::ptr::null_mut();
        let hr =
            unsafe { (fns.windows_create_string)(wide.as_ptr(), wide.len() as u32, &mut hstr) };
        if hr < 0 || hstr.is_null() {
            return Err(P2pError::Protocol(format!(
                "WindowsCreateString failed (0x{:08x})",
                hr as u32
            )));
        }
        Ok(hstr)
    }

    unsafe fn await_async_u32(op: *mut c_void, timeout: Duration) -> P2pResult<u32> {
        let vtbl = unsafe { *(op as *const *const ComVtblHeader) };
        let mut async_info: *mut c_void = std::ptr::null_mut();
        let hr_qi = unsafe { ((*vtbl).query_interface)(op, &IID_IASYNC_INFO, &mut async_info) };
        if hr_qi < 0 || async_info.is_null() {
            return Err(P2pError::Protocol(format!(
                "IAsyncInfo QI failed (0x{:08x})",
                hr_qi as u32
            )));
        }
        let info_vtbl = unsafe { *(async_info as *const *const IAsyncInfoVtbl) };
        let deadline = Instant::now() + timeout;
        let final_status = loop {
            let mut status = 0i32;
            let hr_st = unsafe { ((*info_vtbl).status)(async_info, &mut status) };
            if hr_st < 0 {
                unsafe { release_com(async_info) };
                return Err(P2pError::Protocol(format!(
                    "IAsyncInfo::Status failed (0x{:08x})",
                    hr_st as u32
                )));
            }
            if status != 0 {
                break status;
            }
            if Instant::now() >= deadline {
                unsafe { release_com(async_info) };
                return Err(P2pError::Protocol("WinRT operation timed out".into()));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        if final_status != 1 {
            let mut err_code = 0i32;
            let _ = unsafe { ((*info_vtbl).error_code)(async_info, &mut err_code) };
            unsafe { release_com(async_info) };
            return Err(P2pError::Protocol(format!(
                "WinRT async status={final_status} err=0x{:08x}",
                err_code as u32
            )));
        }
        unsafe { release_com(async_info) };
        let op_vtbl = unsafe { *(op as *const *const IAsyncOperationU32Vtbl) };
        let mut result = 0u32;
        let hr_res = unsafe { ((*op_vtbl).get_results)(op, &mut result) };
        if hr_res < 0 {
            return Err(P2pError::Protocol(format!(
                "IAsyncOperation::GetResults failed (0x{:08x})",
                hr_res as u32
            )));
        }
        Ok(result)
    }

    fn run_on_mta<F, T>(f: F) -> P2pResult<T>
    where
        F: FnOnce(&CombaseFns, *mut c_void) -> P2pResult<T> + Send + 'static,
        T: Send + 'static,
    {
        std::thread::spawn(move || unsafe {
            let fns = load_combase()?;
            let hr_init = (fns.ro_initialize)(RO_INIT_MULTITHREADED);
            let should_uninit = hr_init >= 0;
            if hr_init < 0 && hr_init != RPC_E_CHANGED_MODE {
                return Err(P2pError::Protocol(format!(
                    "RoInitialize failed (0x{:08x})",
                    hr_init as u32
                )));
            }

            let res = (|| {
                let class_id =
                    make_hstring(&fns, "Windows.Security.Credentials.UI.UserConsentVerifier")?;
                let mut factory: *mut c_void = std::ptr::null_mut();
                let hr_fac = (fns.ro_get_activation_factory)(
                    class_id,
                    &IID_IUSER_CONSENT_VERIFIER_STATICS,
                    &mut factory,
                );
                let _ = (fns.windows_delete_string)(class_id);
                if hr_fac < 0 || factory.is_null() {
                    return Err(P2pError::Protocol(format!(
                        "RoGetActivationFactory failed (0x{:08x})",
                        hr_fac as u32
                    )));
                }
                let out = f(&fns, factory);
                release_com(factory);
                out
            })();

            if should_uninit {
                (fns.ro_uninitialize)();
            }
            res
        })
        .join()
        .map_err(|_| P2pError::Protocol("WinRT worker thread panicked".into()))?
    }

    pub fn check_availability() -> (bool, String) {
        let res = run_on_mta(|_fns, factory| unsafe {
            let vtbl = *(factory as *const *const IUserConsentVerifierStaticsVtbl);
            let mut op: *mut c_void = std::ptr::null_mut();
            let hr = ((*vtbl).check_availability_async)(factory, &mut op);
            if hr < 0 || op.is_null() {
                return Err(P2pError::Protocol(format!(
                    "CheckAvailabilityAsync failed (0x{:08x})",
                    hr as u32
                )));
            }
            let val = await_async_u32(op, Duration::from_secs(4));
            release_com(op);
            val
        });
        match res {
            Ok(0) => (true, "Available (Windows Hello configured)".into()),
            Ok(1) => (false, "Unavailable (DeviceNotPresent)".into()),
            Ok(2) => (false, "Unavailable (NotConfiguredForUser)".into()),
            Ok(3) => (false, "Unavailable (DisabledByPolicy)".into()),
            Ok(4) => (false, "Unavailable (DeviceBusy)".into()),
            Ok(other) => (false, format!("Unavailable (code {other})")),
            Err(err) => (false, format!("Unavailable ({err})")),
        }
    }

    pub fn request_verification() -> P2pResult<bool> {
        run_on_mta(|fns, factory| unsafe {
            let msg = make_hstring(fns, "Unlock Cloak Private Workspace")?;
            let vtbl = *(factory as *const *const IUserConsentVerifierStaticsVtbl);
            let mut op: *mut c_void = std::ptr::null_mut();
            let hr = ((*vtbl).request_verification_async)(factory, msg, &mut op);
            let _ = (fns.windows_delete_string)(msg);
            if hr < 0 || op.is_null() {
                return Err(P2pError::Protocol(format!(
                    "RequestVerificationAsync failed (0x{:08x})",
                    hr as u32
                )));
            }
            let val = await_async_u32(op, Duration::from_secs(60));
            release_com(op);
            Ok(val? == 0)
        })
    }
}

#[cfg(target_os = "windows")]
fn query_windows_hello_availability_sync() -> (bool, String) {
    winrt_hello::check_availability()
}

#[cfg(not(target_os = "windows"))]
fn query_windows_hello_availability_sync() -> (bool, String) {
    (false, "Unavailable (Windows only)".into())
}

#[cfg(target_os = "windows")]
fn request_windows_hello_verification_sync() -> P2pResult<bool> {
    winrt_hello::request_verification()
}

#[cfg(not(target_os = "windows"))]
fn request_windows_hello_verification_sync() -> P2pResult<bool> {
    Ok(false)
}

#[cfg(test)]
mod winrt_hello_tests {
    use super::query_windows_hello_availability_sync;
    use std::time::Instant;

    #[test]
    fn windows_hello_native_winrt_probe_is_fast_and_well_formed() {
        let start = Instant::now();
        let (available, detail) = query_windows_hello_availability_sync();
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_secs_f64() < 1.5,
            "Native WinRT hello probe took unexpectedly long: {elapsed:?}"
        );
        assert!(
            available && detail.starts_with("Available")
                || !available && detail.starts_with("Unavailable"),
            "Unexpected availability tuple: ({available}, {detail})"
        );
    }
}
