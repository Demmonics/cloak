# Stealth Mode Architecture (Phase 10)

**Branch:** `recovery/p2p-desktop`  
**Primary Modules:**
- `crates/cloak-p2p/src/stealth.rs` — Domain structs (`StealthConfig`, `StealthBootstrapState`, `StealthVisualAction`, `StealthLaunchView`, `PrivacyTriggerKind`, `PrivacyRule`, `UnlockPreferences`, `PdfReaderSettings`, `TimerPreferences`, `CallPrivacySettings`, `NotificationPrivacySettings`), Argon2id hashing/verification, progressive cooldown math, and PDF header validation.
- `crates/cloak-p2p/src/stealth_controller.rs` — `StealthController` thread-safe runtime state machine, trigger dispatch, multi-factor/two-step unlock orchestration, Windows Hello WinRT probe/prompt helpers, and `NodeEvent::StealthStateChanged` broadcasting.
- `crates/cloak-p2p/src/stealth_storage.rs` — SQLite tables in `cloak_local.db` (`stealth_settings`, `stealth_secret_codes`, `stealth_passphrase`, `stealth_rate_limit`, `stealth_runtime_checkpoint`, `pdf_library`).
- `apps/desktop/src/server.rs` — Locked route isolation middleware (`require_unlocked_stealth`), loopback session-token guard (`require_loopback_auth`), WebSocket event streaming (`/p2p/v1/ws`), and embedded static assets.
- `apps/desktop/src/native_shell.rs` — Native `tao`/`wry` Win32/WebView2 window lifecycle hooks (`WM_ACTIVATEAPP`, minimize/restore, `WTSRegisterSessionNotification` for `WM_WTSSESSION_CHANGE`, `GetLastInputInfo` OS idle polling, `SetWindowDisplayAffinity`, neutral window title + tray tooltip).
- `apps/web/src/components/pdf/PdfReaderShell.tsx` & `apps/web/src/components/stealth/P2pStealthSettingsModal.tsx` — Offline PDF.js v6 decoy interface and 6-tab Settings UI.

## Surface Lifecycle & Strict Boundary

1. **Dual-Surface State Machine (`StealthLifecycleState`):**
   - `UnlockedMessenger`: Active private Cloak workspace. Private `/p2p/v1/*` routes (status, peers, rooms, messages, files, capture, settings) are accessible.
   - `ConcealedUnlocked`: Visual decoy surface (`pdf_reader`, `neutral_placeholder`, `minimized`, or `hidden_to_tray`) without locking credentials (`LockAction::KeepUnlocked`).
   - `DecoyLocked`: Locked decoy surface; `StealthBootstrapState.locked == true`.

2. **HTTP & WebSocket Isolation When Locked (`apps/desktop/src/server.rs`):**
   - `private_routes` use `middleware::from_fn_with_state(..., require_unlocked_stealth)` which rejects any request with `423 Locked` whenever `node.stealth().is_locked()` is true.
   - `locked_safe_routes` expose only cover-surface endpoints (`/stealth/bootstrap`, `/stealth/unlock`, `/stealth/recover`, `/stealth/trigger`, `/stealth/foreground-activity`, `/stealth/system-idle`, `/stealth/call-summary`, `/stealth/return-messenger`, `/stealth/test-clock-advance`, `/pdf/documents*`, and `/ws`).
   - On transition into concealment/lock, `P2pWorkspacePage.tsx` calls `clearSensitiveTransientState(next.locked)` so rooms, peers, messages, and search state are scrubbed from React state immediately.

3. **Separation of Visual Concealment vs. Local Erasure:**
   - Stealth Mode manages *visual cover* and *UI locking*; Ghost Mode manages *local SQLite and attachment blob erasure*.
   - A trigger can conceal to the PDF reader while keeping all local messages intact (`LocalDeletionAction::KeepAll`), or combine concealment with `DeleteViewedLocal` / `DeleteOpenConversation` / `DeleteAllLocal` through `PrivacyRule` or timer expiry actions.
