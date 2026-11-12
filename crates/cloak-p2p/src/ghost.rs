use chrono::Utc;

use crate::model::{
    GhostDeletionSummary, GhostModeLevel, GhostPolicy, GhostRoomOverride, GhostRuntimeState,
    GhostTriggerKind,
};

/// Evaluates effective Ghost Mode settings combining global policy and optional per-room overrides.
pub fn resolve_effective_mode(
    policy: &GhostPolicy,
    room_override: Option<&GhostRoomOverride>,
) -> (bool, GhostModeLevel, bool) {
    if let Some(ov) = room_override {
        let enabled = ov.enabled && ov.mode != GhostModeLevel::Off;
        let clear_att = ov.clear_attachments.unwrap_or(policy.clear_attachments);
        // Destructive ClearOpenConversation still requires explicit user opt-in confirmation
        let effective =
            if ov.mode == GhostModeLevel::ClearOpenConversation && !policy.destructive_confirmed {
                GhostModeLevel::PrivacyShield
            } else {
                ov.mode
            };
        return (enabled, effective, clear_att);
    }
    let enabled = policy.enabled && policy.mode != GhostModeLevel::Off;
    let effective =
        if policy.mode == GhostModeLevel::ClearOpenConversation && !policy.destructive_confirmed {
            GhostModeLevel::PrivacyShield
        } else {
            policy.mode
        };
    (enabled, effective, policy.clear_attachments)
}

/// Determines whether an incoming lifecycle event should activate UI masking and/or destructive wipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GhostActionDecision {
    pub should_shield: bool,
    pub should_clear_local_history: bool,
    pub clear_level: GhostModeLevel,
}

pub fn evaluate_trigger(
    policy: &GhostPolicy,
    effective_enabled: bool,
    effective_mode: GhostModeLevel,
    state: &GhostRuntimeState,
    kind: GhostTriggerKind,
) -> GhostActionDecision {
    if !effective_enabled || effective_mode == GhostModeLevel::Off {
        return GhostActionDecision {
            should_shield: false,
            should_clear_local_history: false,
            clear_level: GhostModeLevel::Off,
        };
    }

    // Never clear history while an app-owned dialog / file picker / device selection modal is open
    if state.in_app_modal_depth > 0
        && matches!(
            kind,
            GhostTriggerKind::ExternalFocusLoss | GhostTriggerKind::Minimize
        )
    {
        return GhostActionDecision {
            should_shield: false,
            should_clear_local_history: false,
            clear_level: GhostModeLevel::Off,
        };
    }

    let trigger_allowed = match kind {
        GhostTriggerKind::ExternalFocusLoss => policy.triggers.on_focus_loss,
        GhostTriggerKind::Minimize => policy.triggers.on_minimize,
        GhostTriggerKind::SessionLock => policy.triggers.on_session_lock,
        GhostTriggerKind::AppClose => policy.triggers.on_close,
        GhostTriggerKind::ManualLock => true,
        GhostTriggerKind::RestoreFocus | GhostTriggerKind::Unlock => false,
    };

    if !trigger_allowed {
        return GhostActionDecision {
            should_shield: matches!(kind, GhostTriggerKind::ManualLock),
            should_clear_local_history: false,
            clear_level: GhostModeLevel::Off,
        };
    }

    let should_clear = matches!(
        effective_mode,
        GhostModeLevel::ClearViewed | GhostModeLevel::ClearOpenConversation
    );

    GhostActionDecision {
        should_shield: true,
        should_clear_local_history: should_clear,
        clear_level: if should_clear {
            effective_mode
        } else {
            GhostModeLevel::PrivacyShield
        },
    }
}

pub fn make_cleanup_summary(
    room_id: String,
    channel_id: String,
    mode: GhostModeLevel,
    deleted_messages: usize,
    deleted_attachments: usize,
    preserved_unread: usize,
) -> GhostDeletionSummary {
    GhostDeletionSummary {
        room_id,
        channel_id,
        mode,
        deleted_messages,
        deleted_attachments,
        preserved_unread,
        completed_at: Utc::now(),
    }
}
