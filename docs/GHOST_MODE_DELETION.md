# Ghost Mode Deletion & Stealth Independence

**Primary Files:** `crates/cloak-p2p/src/ghost.rs`, `crates/cloak-p2p/src/storage.rs`, `crates/cloak-p2p/src/transport.rs`, `crates/cloak-p2p/src/stealth_controller.rs`

## Local-Only Erasure Semantics

- Ghost Mode (`GhostPolicy`, `GhostRuntimeState`) acts strictly on the local SQLite database (`cloak_local.db`) and local attachment blob directory (`attachments`).
- Clearing viewed messages (`clear_viewed`), open conversations (`clear_open_conversation`), or full wipes never sends remote revocation frames or erases messages held on a peer's device — verified in Rust tests and Playwright (`StealthBob` still sees `Alpha classified note (viewed)` even after `StealthAlice`'s 60s `BackgroundAwayTimeout` executes `delete_viewed_local`).

## Anti-Resurrection & Unread Preservation

1. **Viewed Tracking (`mark_viewed`):** Messages become eligible for `clear_viewed` only after observed in the active channel viewport (`IntersectionObserver` dwell threshold) or configured outgoing viewed policy (`immediate_after_dwell`, `preserve_outgoing`, `immediate_on_send`).
2. **Unread Preservation:** Incoming messages delivered over P2P while concealed/blurred (for example `Beta unread message` sent while Alice is locked in PDF cover) are stored encrypted locally with `viewed_at = NULL`, so `DeleteViewedLocal` / `DeleteViewedPreserveUnread` preserves them until viewed after unlocking.
3. **Suppression Registry (`local_suppressions` table):** Deleted local message IDs are recorded inside `local_suppressions` before deleting rows from `messages` / `attachments`. When peers reconnect or replay sync frames, P2P ingestion checks `local_suppressions` so erased local history never resurrects on reconnect or restart.
4. **Decoupled from Stealth Cover:** Triggering `ManualSwitchToPdf`, `FocusLoss`, `Minimize`, or `PanicHotkey` visually switches to the PDF reader and/or locks routes without touching local `messages` when `deletion_action == KeepAll`. Conversely, privacy rules or away-timer expiry can invoke Ghost local deletion directly while staying locked in the decoy surface.
