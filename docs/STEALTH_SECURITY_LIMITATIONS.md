# Stealth & Security Limitations

Honest documentation of threat-model boundaries observed in the current Phase 10 Windows implementation:

1. **Local Process Memory & Unlocked WebView2 State:**
   - While unlocked, active messages, peer names, and cryptographic keys live in memory inside `cloak-desktop.exe` and the WebView2 renderer process. Locking triggers `clearSensitiveTransientState(true)` in React and switches private HTTP routes to `423 Locked`, but OS administrators or local kernel debuggers inspecting live RAM while unlocked (or capturing WebView2 process heaps before GC) remain outside application-level secrecy.
2. **Process & Window Class Observability:**
   - Stealth Mode updates the Win32 top-level window title (`window.set_title(&boot.window_title)`, default `"Document Reader"`) and tray tooltip when concealed, and suppresses notifications (`PdfMode` / `WindowsLocked`). However, Task Manager still identifies the binary process name (`cloak-desktop.exe`) and executable metadata on disk.
3. **Loopback Localhost Architecture (`127.0.0.1`):**
   - The native WebView2 shell loads `apps/web/dist` served from an ephemeral loopback HTTP port with a per-launch random `32`-byte bearer token passed via `window.__CLOAK_SESSION_TOKEN__` (`main.rs`, `native_shell.rs`, `server.rs`). Other unprivileged processes under the same Windows user account cannot read the bearer token via unauthenticated HTTP calls (`401 Unauthorized` without Bearer token), though another process running as the same user with debug privileges can inspect process memory or command-line args if tokens/flags are passed explicitly.
4. **Windows Hello Availability:**
   - Real WinRT `UserConsentVerifier::CheckAvailabilityAsync` is queried at startup (`crates/cloak-p2p/src/stealth_controller.rs`). On machines or VM environments without biometric/PIN enrollment, `windows_hello_available` reports `false` (`Unavailable (DeviceNotPresent)`) honestly rather than faking biometric success, and `unlock` falls back to Argon2id passcodes/PIN/passphrase/recovery keys.
5. **WebView2 & Win32 Capture Protection Scope:**
   - `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` (`0x11`) blocks screen capture of the Cloak window when enabled (`captureProtection = true` in Ghost settings), verified on Windows via `GetWindowDisplayAffinity`. OS screen readers, elevated kernel drivers, or physical cameras pointed at the monitor cannot be blocked by User32 flags.
6. **Peer Copy Persistence & Disappearing vs. Local Wipe:**
   - Direct P2P messaging replicates encrypted payloads onto paired peers' local SQLite stores; local Ghost/Stealth wipe only deletes the local device's rows and suppresses local re-sync (`local_suppressions`). It cannot force-wipe an adversary's disk.

