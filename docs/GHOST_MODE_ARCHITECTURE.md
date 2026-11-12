# Cloak Ghost Mode Architecture

Ghost Mode is a local-first privacy and ephemeral-history subsystem implemented in `crates/cloak-p2p` and surfaced natively through `apps/desktop` (`native_shell.rs`) and `apps/web` (`P2pGhostSettingsModal.tsx`, `P2pWorkspacePage.tsx`).

**Core Design Invariant:** Ghost Mode acts strictly on the local device's SQLite vault (`crates/cloak-p2p/src/storage.rs`) and desktop window. Deleting or masking messages locally never deletes messages from remote peers (`clear_viewed` / `clear_open_conversation` write to `local_suppressions` locally instead of broadcasting `WireFrame::Tombstone`).

---

## 1. Privacy Levels (`GhostModeLevel`)

1. **`off`** — Standard encrypted SQLite persistence. Window blur/minimize does not mask or erase messages.
2. **`privacy_shield`** — Conceals decrypted conversation UI on trigger (unmounts message DOM nodes cleanly behind a full shield overlay and optionally masks room/peer names when `hideSensitiveNames` is set) and optionally locks view behind an Argon2id PIN (`requirePinUnlock` + `hasPinConfigured`). Keeps local encrypted SQLite messages intact. Live WebRTC calls remain connected while shielded.
3. **`clear_viewed`** — Snapchat-style selective local purge: on trigger (`ExternalFocusLoss`, `Minimize`, `SessionLock`, `AppClose`, or `ManualLock`), deletes only messages that already have a `viewed_at` timestamp (verified by viewport dwell) in the active channel while preserving unread local messages and purging orphaned local attachment blobs if `clearAttachments` is enabled.
4. **`clear_open_conversation`** — Destructive local wipe: requires explicit `destructiveConfirmed` opt-in (`clear_open_conversation` automatically downgrades to `privacy_shield` in `resolve_effective_mode` if `destructiveConfirmed == false`). On trigger, deletes all local messages (read and unread) in the active open channel.

Per-room overrides (`GhostRoomOverride`, stored in SQLite table `ghost_room_overrides`) allow overriding the global mode per conversation. Unchecking the room override deletes the `ghost_room_overrides` row so the global policy applies cleanly.

---

## 2. Native Win32 Triggers & Guardrails

- **Win32 App Activation Subclassing (`apps/desktop/src/native_shell.rs::cloak_wnd_subclass`):** Intercepts `WM_ACTIVATEAPP` on the WebView2 host window so focus transitions caused by clicking away from child WebView2 HWNDs accurately invoke `GhostTriggerKind::ExternalFocusLoss` (`wParam == 0`) and `RestoreFocus` (`wParam != 0`).
- **Minimize (`ShowWindow(..., SW_MINIMIZE)`):** Tao `WindowEvent::Resized` checks Win32 `IsIconic(hwnd)` and dispatches `GhostTriggerKind::Minimize`.
- **Windows Session Lock (`Win+L`):** `WTSRegisterSessionNotification(..., NOTIFY_FOR_THIS_SESSION)` catches `WM_WTSSESSION_CHANGE` (`WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`) and dispatches `SessionLock` / `Unlock`.
- **App Exit (`AppClose`):** Dispatched on window/tray close.
- **Screen Capture Exclusion (`SetWindowDisplayAffinity`):** When `captureProtection` is enabled, toggles `WDA_EXCLUDEFROMCAPTURE` on the desktop HWND.
- **In-App Modal Guard (`in_app_modal_depth`):** Opening Ghost Settings, Export, Native File Picker, or Screen Share Picker increments `in_app_modal_depth` via `/p2p/v1/ghost/modal`. `evaluate_trigger` ignores `ExternalFocusLoss` and `Minimize` while `in_app_modal_depth > 0` so legitimate modal/picker focus switches do not wipe active chats.

---

## 3. Authoritative Dwell & Anti-Resurrection

- **Viewport Dwell (`P2pWorkspacePage.tsx`):** `IntersectionObserver` (`threshold: [0.5]`, `viewedDwellMs >= 200ms`) observes unviewed rendered `[data-message-id]` articles (re-attaching across search filter toggles) only while `document.visibilityState === 'visible'` and `!isMasked`, then calls `POST /p2p/v1/ghost/viewed` (`mark_messages_viewed`).
- **Local Suppression (`local_suppressions` in `storage.rs`):** When Ghost Mode deletes local messages (or `on_leave` / `after_view` ephemeral messages expire locally), their IDs are recorded in `local_suppressions`. Subsequent `SyncBatch` or re-delivery frames skip suppressed message IDs (`is_suppressed_locally`) so locally wiped history cannot silently resurrect from an online peer.
- **Argon2id PIN Lock (`crypto.rs`):** Configured via `POST /p2p/v1/ghost/pin` using `argon2` default parameters + random salt; verified via `POST /p2p/v1/ghost/unlock`. Failed attempts return `Incorrect Ghost Mode PIN`.

