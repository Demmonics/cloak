# Cloak Known Limitations

1. **NAT Traversal in Strict `DirectOnly` Mode:**
   - By design, `ConnectivityMode::DirectOnly` never routes traffic through external relays. If both computers sit behind symmetric NATs or blocking firewalls without LAN reachability, WireGuard/Tailscale, or forwarded `--p2p-bind` TCP ports, direct pairing fails explicitly with `DirectConnectivityBlocked` diagnostic text.
2. **Loopback-Only Multi-Peer & WebRTC Verification on Host:**
   - Multi-peer TCP P2P, Ghost Mode E2E flows, and two-peer WebRTC media were verified across independent processes and isolated SQLite vaults on `127.0.0.1` loopback using Playwright Chromium fake media devices + native Win32 BMP capture on a single Windows PC. Two separate physical PCs over Wi-Fi/LAN or public WAN NATs have **not yet been tested**.
3. **Optional Relay Services Excluded from Local Docker Run:**
   - Docker Desktop, standalone `redis-server`, MinIO, and `livekit-server` SFU binaries are absent on this host, so browser relay services (`services/*`) were kept preserved rather than exercised against external LiveKit/Redis containers during Phase 9.
4. **Native Desktop Shell vs Fallback Modes:**
   - Primary Windows GUI runs inside an embedded WebView2 window via `tao` + `wry` (`native_shell.rs`) with tray menu, native file pickers (`rfd`), Win32 `WM_ACTIVATEAPP`/`SW_MINIMIZE`/`WM_WTSSESSION_CHANGE` Ghost hooks, and `SetWindowDisplayAffinity`. `--headless` and legacy `--edge-app` fallback remain supported for automation/environments without WebView2 Runtime.
5. **Single-Key Room Epoch Model in `crates/cloak-p2p`:**
   - `crates/cloak-p2p` enforces per-room symmetric `XChaCha20-Poly1305` keys + Ed25519 sender authentication + `Burn` epoch increments (`burn_room_history`), while browser relay mode in `apps/web` implements multi-member X25519 wrapped epoch key distribution (`packages/crypto`).
6. **Uninstaller Filename Invocation:**
   - Running `uninstall.exe` via Windows Add/Remove Programs (`UninstallString`) passes `--uninstall --install-dir <dir>` and removes shortcuts, `HKCU` uninstall registry entries, executables, and install folder cleanly. Launching `uninstall.exe` manually without `--uninstall` defaults to installer arguments unless `--uninstall` is supplied.
