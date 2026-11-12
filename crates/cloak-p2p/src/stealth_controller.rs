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
            rt.away_deadline_ms = None;
            rt.pending_step1_factor = false;
            rt.foreground_last_input_ms = now_ms;
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
fn query_windows_hello_availability_sync() -> (bool, String) {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let ps = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()
$t = $asTaskGeneric.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @($op))
Write-Output $t.Result
"#;
    let utf16: Vec<u8> = ps.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let encoded = STANDARD.encode(utf16);
    if let Ok(out) = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded,
        ])
        .output()
    {
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if stdout.contains("Available") {
            return (true, "Available (Windows Hello configured)".into());
        }
        if !stdout.is_empty() {
            return (false, format!("Unavailable ({stdout})"));
        }
    }
    (false, "Unavailable on this Windows session".into())
}

#[cfg(not(target_os = "windows"))]
fn query_windows_hello_availability_sync() -> (bool, String) {
    (false, "Unavailable (Windows only)".into())
}

#[cfg(target_os = "windows")]
fn request_windows_hello_verification_sync() -> P2pResult<bool> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let ps = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync("Unlock Cloak Private Workspace")
$t = $asTaskGeneric.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))
Write-Output $t.Result
"#;
    let utf16: Vec<u8> = ps.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let encoded = STANDARD.encode(utf16);
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .output()
        .map_err(|e| P2pError::Protocol(format!("Windows Hello invocation failed: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(stdout.contains("Verified"))
}

#[cfg(not(target_os = "windows"))]
fn request_windows_hello_verification_sync() -> P2pResult<bool> {
    Ok(false)
}
