# Privacy Rule Engine Architecture

**Primary Files:** `crates/cloak-p2p/src/stealth.rs`, `crates/cloak-p2p/src/stealth_controller.rs`, `apps/web/src/components/stealth/P2pStealthSettingsModal.tsx`

## Rule Model (`PrivacyRule`)

Each rule expresses a deterministic declarative automation tuple:
- **WHEN (`trigger: PrivacyTriggerKind`):** `FocusLoss`, `AltTab`, `ClickOtherApp`, `Minimize`, `ShowDesktop`, `VirtualDesktopSwitch`, `SessionLock`, `WindowClose`, `AppRestart`, `BackgroundAwayTimeout`, `ForegroundIdleTimeout`, `SystemIdleTimeout`, `PanicHotkey`, `ManualSwitchToPdf`, `ManualLock`, `IncomingMessageWhileLocked`.
- **Visual Surface (`visual_action: StealthVisualAction`):** `SwitchToPdf`, `NeutralPlaceholder`, `MinimizeWindow`, `HideToTray`, `StayNormal`.
- **Lock Behavior (`lock_action: LockAction`):** `HardLock` (require re-unlock and enforce HTTP `423 Locked`), `KeepUnlocked` (conceal visually without locking credentials), `PromptBeforeUnlock`.
- **Local Deletion (`deletion_action: LocalDeletionAction`):** `KeepAll`, `DeleteViewedLocal`, `DeleteViewedPreserveUnread`, `DeleteOpenConversation`, `DeleteAllLocal`.
- **Attachments (`attachment_action: AttachmentPurgeAction`):** `KeepBlobs` or `PurgeRelated`.
- **Call / Notification Overrides:** Optional `notification_action`, `voice_action`, `camera_action`, `screen_share_action`, optional `scope_room_id`, and `priority`.

## Conflict Resolution (`evaluate_privacy_rules`)

1. All enabled rules matching the firing `PrivacyTriggerKind` are evaluated.
2. Highest `priority` wins on visual surface (`visual_action`) when rules tie or conflict; stricter lock/deletion actions (`HardLock`, higher local deletion severity, `PurgeRelated`, more restrictive notification/media policies) take precedence safely rather than silently downgrading protection.
3. Unmatched triggers fall back to the top-level `StealthConfig` defaults (e.g., `stealth_visual_action`, global Ghost policy).

## Non-Destructive Safe Test Mode Sandbox (`POST /p2p/v1/stealth/test-preview`)

- Accessible in tab 6 (`Rules & Test Mode`) of `P2pStealthSettingsModal`.
- Accepts a simulated trigger, mock viewed message count, mock unread message count, and fallback deletion policy (`TestModePreviewRequest`).
- Evaluates the exact same rule engine (`evaluate_privacy_rules`) against in-memory mock counts to report resulting surface, lock state, mock cleared/remaining counts, and call/notification outcomes without mutating real SQLite rooms, messages, or runtime state.
