# Cloak Verification & Test Results

**Executed Against:** `recovery/p2p-desktop` working tree  
**Host OS & Toolchain:** Windows (`stable-x86_64-pc-windows-gnu`, MinGW `gcc`), Node.js/npm workspaces, Playwright Chromium  

---

## 1. Automated Verification Matrix

| Check | Command | Observed Result |
|---|---|---|
| TypeScript Typechecks | `npm run typecheck` | `@cloak/protocol`, `@cloak/crypto`, `@cloak/archive`, `@cloak/config`, `@cloak/ui`, `@cloak/web` — **0 errors** |
| ESLint | `npm run lint` | `apps packages tests` — **0 errors, 0 warnings** |
| Production Web Build | `npm run build` | Compiled workspace TS libs + Vite bundle (`dist/index.html`, `dist/sw.js`) in `888ms` |
| Unit & Component Tests | `npm run test:unit` | **3/3 files, 15/15 tests passed** (`crypto.test.ts` 6, `archive.test.ts` 6, `ComposerAndExport.test.tsx` 3) |
| Rust Formatting | `cargo +stable-x86_64-pc-windows-gnu fmt --check` | **0 diffs** (`cargo fmt` applied before final package build) |
| Rust Clippy Lints | `cargo +stable-x86_64-pc-windows-gnu clippy -p cloak-p2p -p cloak-desktop --all-targets -- -D warnings` | `cloak-p2p`, `cloak-desktop` — **0 warnings** |
| Rust Unit & Integration Tests | `cargo +stable-x86_64-pc-windows-gnu test -p cloak-p2p -p cloak-desktop -- --test-threads=1` | **7/7 tests passed**: `cloak-desktop` (`1/1`) + `cloak-p2p` (`6/6`: ClearViewed non-resurrection, FullWipe+Revocation+Pinning, TimedDisappear+ZeroDHRejection, OfflineOutbox, StrictDirectOnly, TwoPeers+File+WebRTC) |
| Windows Release Packaging | `scripts/package-windows.ps1` | `cloak-desktop.exe` (`17.79 MiB`), `Cloak-Setup-x64.exe` (`19.12 MiB`), `Cloak-Portable-win64.zip` (`5.92 MiB`), `SHA256SUMS.txt` |
| Playwright Desktop E2E Suite | `npx playwright test tests/e2e/p2p-desktop.spec.ts --repeat-each=2` | **6/6 consecutive runs passed (42.6s)**: `Spec 1` (`12.6s` / `12.4s`), `Spec 2` (`5.2s` / `4.9s`), `Spec 3` (`2.9s` / `2.8s`) |
| OS Installer + Uninstaller Audit | `Cloak-Setup-x64.exe /S --install-dir ...` + `uninstall.exe /S --uninstall --install-dir ... --keep-data` | `SetupExit=0`, `InstalledExe=True`, `RegKey=True`, `StartShortcut=True`, `UninstallExit=0`, `RegAfter=False`, `ShortcutAfter=False`, `DesktopShortcutAfter=False`, `LeftoverTemps=0`, `LeftoverProcs=0` |
| Live Win32 HWND Ghost Mode Check | Installed/release WebView2 window (`HWND` `WM_ACTIVATEAPP` + `ShowWindow SW_MINIMIZE`) | `HWND` visible -> `AfterBlur: shielded=True focused=False captureProt=True` -> `AfterFocus: shielded=False focused=True` -> `AfterMinimize: minimized=True shielded=True` |

*(Note: `cloak-api`, `cloak-core`, and `cloak-worker` relay services were preserved from the earlier recovery baseline without Phase 9 modifications; only `-p cloak-p2p -p cloak-desktop` were re-tested in Phase 9, and Playwright Phase 9 ran `tests/e2e/p2p-desktop.spec.ts` rather than legacy web `cloak.spec.ts`.)*

---

## 2. Measured Desktop Benchmarks (`scripts/bench-desktop.ps1`)

Executed directly against `target/release/cloak-desktop.exe`:

- **Release Binary Size (`cloak-desktop.exe` with embedded frontend + SQLite + WebView2/tray shell):** `17.79 MiB`
- **Native WebView2 GUI HTTP-Ready Startup:** `708.8 ms` (`NativeGuiWorkingSetMiB: 46.79 MiB`)
- **Headless Daemon Startup (`--headless`):** `523.5 ms` (`HeadlessIdleRamMiB: 13.95 MiB`)
- **50 Sequential Encrypted + Ed25519-Signed + SQLite-Persisted + Direct P2P Messages:** `234.6 ms` (`50 / 50` synced on peer)
- **2 MiB (2,097,152 bytes) Chunked SHA-256 P2P File Transfer:** `1105.6 ms` (`2,097,152 / 2,097,152` verified bytes on peer)

---

## 3. Not Verified Live on Host Hardware

- Two separate physical computers pairing across LAN Wi-Fi/Ethernet, Tailscale, or public WAN NATs.
- Real physical USB/integrated webcams and microphones across two separate PCs (`Spec 3` verified real Chromium WebRTC stack using synthetic fake capture devices on localhost + Win32 desktop `capture.rs` BMP bridge).
- Authenticode EV code-signing for Windows SmartScreen suppression.
