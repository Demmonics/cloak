# Phase 10 Stealth Mode Verification & Benchmark Results

All checks below ran directly against the current workspace after final code and UI builds on `recovery/p2p-desktop`.

## 1. Automated Test & Static Analysis Summary

| Check | Command | Observed Result |
|---|---|---|
| TypeScript check (all 6 workspaces) | `npm run typecheck` | **Passed** (`exit 0`: `@cloak/protocol`, `@cloak/crypto`, `@cloak/archive`, `@cloak/config`, `@cloak/ui`, `@cloak/web`) |
| ESLint | `npm run lint` | **Passed** (`exit 0`: `eslint apps packages tests`) |
| Vitest unit suite | `npm run test:unit` | **3/3 files, 15/15 tests passed** (`crypto.test.ts` 6/6, `archive.test.ts` 6/6, `ComposerAndExport.test.tsx` 3/3) |
| Rust formatting | `cargo +stable-x86_64-pc-windows-gnu fmt --all -- --check` | **Passed** (`exit 0`) |
| Rust Clippy lints | `cargo +stable-x86_64-pc-windows-gnu clippy --all-targets -- -D warnings` | **Passed** (`0 warnings` across all workspace targets) |
| Rust `cloak-desktop` integration tests | `cargo +stable-x86_64-pc-windows-gnu test -p cloak-desktop -- --test-threads=1` | **2/2 passed** (`desktop_embedded_ui_security_guard_and_two_instance_p2p_flow`, `stealth_locked_blocks_private_routes_until_secret_code_unlock`) |
| Rust `cloak-p2p` core + stealth tests | `cargo +stable-x86_64-pc-windows-gnu test -p cloak-p2p -- --test-threads=1` | **10/10 passed** (`4/4` `stealth_tests::*` + `6/6` `tests::*`) |
| Playwright Phase 9 + Phase 10 E2E suites | `npx playwright test tests/e2e/p2p-desktop.spec.ts tests/e2e/stealth-mode.spec.ts` | **4/4 passed** in `32.6s` (3 Phase 9 specs + 1 full Phase 10 Stealth/PDF/Timer/Visual-QA spec; `externalRequests === []`) |

## 2. Live Windows OS Win32 HWND Verification

Executed against non-headless `target\release\cloak-desktop.exe` using Win32 `EnumWindows`, `GetWindowText`, `GetWindowDisplayAffinity`, and `ShowWindow(hwnd, SW_MINIMIZE)`:
- Visible top-level window acquired (`HWND=3081040`), initial title `'Cloak'`, initial affinity `0x0`.
- Enabled `captureProtection` (`PUT /p2p/v1/ghost/policy`) -> `GetWindowDisplayAffinity` returned **`0x11`** (`WDA_EXCLUDEFROMCAPTURE`).
- Minimized real HWND via `ShowWindow(hwnd, 6)` -> `stealth/bootstrap` transitioned to `activeSurface='pdf_reader'`, `locked=True`, and `GetWindowText` updated to **`'Document Reader'`**.

## 3. Release Packaging & Benchmarks (`scripts/package-windows.ps1` & `scripts/bench-desktop.ps1`)

| Artifact / Metric | Measured Result |
|---|---|
| `target\release\cloak-desktop.exe` | **20.9 MiB** (`SHA256: 0D06AC2651464CD8215B0DAE16555C96578B0A7D45507D7D77AD2435D22DC003`) |
| `dist-windows\Cloak-Setup-x64.exe` | **22.23 MiB** (`SHA256: 7CAC12F1363A4AB086E4F6343EAD30119EBAC1B113412FE9A6691859435C9591`) |
| `dist-windows\Cloak-Portable-win64.zip` | **6.71 MiB** (`SHA256: 4A9D03517A177FD177B37AA9C21633F1B5392895A4B5B61E0B75B2978A5C1596`) |
| Native WebView2 GUI cold HTTP ready | **1169.3 ms** (`NativeGuiWorkingSetMiB: 49.3 MiB`) |
| Headless cold startup | **1050.5 ms** (`HeadlessIdleRamMiB: 14.77 MiB`) |
| 50 sequential encrypted SQLite + P2P messages | **198.5 ms** (`SyncedMessagesOnPeer: 50`) |
| 2 MiB localhost file transfer | **914.5 ms** (`VerifiedBytesOnPeer: 2097152` bytes) |
