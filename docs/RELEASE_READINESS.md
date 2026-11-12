# Cloak Release Readiness Assessment (Phase 9)

**Branch:** `recovery/p2p-desktop`  
**Release Artifacts (`dist-windows/`):**
- `cloak-desktop.exe` — **17.79 MiB** (native `tao` + `wry` embedded WebView2 desktop binary)
- `Cloak-Setup-x64.exe` — **19.12 MiB** (self-extracting Windows user installer + uninstaller)
- `Cloak-Portable-win64.zip` — **5.92 MiB** (portable archive + checksums in `SHA256SUMS.txt`)

---

## Readiness Verdict: **Verified Ready for Single-Host OS Desktop Usage & Controlled Two-PC LAN Pilot Testing; Public Distribution Pending Physical Multi-PC LAN/WAN QA & Authenticode Signing**

### Verified & Passing Gates (Observed on Current Tree)
- **Static Analysis & Hygiene:** `npm run typecheck` (0 errors), `npm run lint` (0 errors, 0 warnings), `npm run build` (`vite` 888ms), `cargo fmt --check` (0 diffs), `cargo clippy -p cloak-p2p -p cloak-desktop --all-targets -- -D warnings` (0 warnings).
- **Automated Tests:**
  - JS/TS Vitest unit suite: **3/3 files, 15/15 tests passed**
  - Rust native P2P & Desktop tests (`cloak-p2p` 6/6 + `cloak-desktop` 1/1): **7/7 tests passed**
  - Playwright Phase 9 E2E (`tests/e2e/p2p-desktop.spec.ts --repeat-each=2`): **6/6 consecutive runs passed (42.6s)** covering loopback auth guard, `DirectOnly` failure, real P2P messaging + SHA-256 attachment + `.cloakexport`, multi-viewport layouts (`1920x1080`, `1366x768`, `1280x720`, `780x720`), Ghost Mode Privacy Shield + Argon2id PIN lock, `ClearViewed` preserving unread & peer copy, modal guard, anti-resurrection, `ClearOpenConversation`, peer revocation, and two-peer WebRTC video/audio + native Win32 capture + Ghost shield call continuity.
- **Native Windows OS & HWND Verification:** Verified `Cloak-Setup-x64.exe /S` install, `cloak-desktop.exe` WebView2 HWND visibility, live Win32 `WM_ACTIVATEAPP` blur/focus + `ShowWindow(SW_MINIMIZE)` + `SetWindowDisplayAffinity` Ghost transitions, and silent `uninstall.exe /S --uninstall --keep-data` cleanup (zero leftover shortcuts, registry keys, temp dirs, or background processes).
- **Visual QA:** **14/14 screenshots** captured (`docs/visual-qa/01..14`) and inspected with all Phase 9 layout/modal/media defects resolved.
- **Measured Release Benchmarks (`scripts/bench-desktop.ps1`):** `708.8 ms` native GUI HTTP-ready (`46.79 MiB` working set), `523.5 ms` headless startup (`13.95 MiB` idle RAM), `234.6 ms` for 50 P2P SQLite+TCP messages, `1105.6 ms` for 2 MiB SHA-256 file transfer.

### Remaining External Steps Before Public Release
1. Execute the two-PC physical LAN/Wi-Fi & public WAN QA checklist in `docs/FIREWALL_AND_LAN_SETUP.md` (including physical webcams/mics).
2. Obtain an Authenticode certificate to sign `cloak-desktop.exe` and `Cloak-Setup-x64.exe` for Windows SmartScreen trust.
3. Optional: Verify `services/*` + `docker-compose.yml` on a Linux server host if deploying optional relay infrastructure.
