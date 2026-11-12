# Inactivity & Background-Away Timer Design

**Primary Files:** `crates/cloak-p2p/src/stealth.rs` (`TimerPreferences`), `crates/cloak-p2p/src/stealth_controller.rs` (`tick_timers`, `notify_window_focus_restored`, `report_foreground_activity`, `report_system_idle_ms`, `advance_test_clock_ms`), `crates/cloak-p2p/src/stealth_storage.rs` (`stealth_runtime_checkpoint`)

## Three Distinct Timers

1. **Background-Away Timer (`backgroundAwayEnabled`, `backgroundAwaySeconds`):**
   - Armed when the Cloak window loses focus, is minimized, or switches away (`is_away == true`).
   - Records an absolute deadline (`away_deadline_ms = now_ms + backgroundAwaySeconds * 1000`) persisted inside `stealth_runtime_checkpoint`.
   - **Crucially:** continuing to use the mouse/keyboard in other applications or on the OS desktop does **not** reset this timer.
   - Configurable return behavior:
     - `backgroundAwayCancelOnReturn`: cancels the pending deadline when focus returns before expiry.
     - `backgroundAwayPreserveDeadline`: keeps the original absolute deadline across brief focus returns.
   - Supports independent expiry local deletion via `backgroundAwayDeletion` (e.g., `KeepAll` vs. `DeleteViewedLocal` preserving unread incoming messages).

2. **Foreground App Inactivity Timer (`foregroundIdleEnabled`, `foregroundIdleSeconds`):**
   - Tracks interaction inside the Cloak window itself via `last_foreground_activity_ms`.
   - Triggered only while Cloak is in focus; suppressed when paused inside guarded modals (`in_app_modal_depth > 0`) unless explicitly locked.

3. **Windows OS System Idle Timer (`systemIdleEnabled`, `systemIdleSeconds`):**
   - Driven by native Win32 `GetLastInputInfo` sampling in `apps/desktop/src/native_shell.rs` every 2 seconds (or `/p2p/v1/stealth/system-idle`).
   - Reflects global keyboard/mouse idle across all Windows applications.

## Crash / Restart Recovery & Deterministic Clock Testing

- `stealth_runtime_checkpoint` persists `away_deadline_ms`, `locked`, and `active_surface` into SQLite whenever runtime state changes.
- On cold boot (`StealthController::new`), overdue deadlines elapsed while powered off or closed are detected and evaluated (`BackgroundAwayTimeout`) immediately rather than silently dropped.
- `test_clock_offset_ms` (`POST /p2p/v1/stealth/test-clock-advance`) shifts controller time deterministically for fast, flake-free unit and Playwright verification (e.g., advancing `+65_000 ms` across a `60s` away timer).

