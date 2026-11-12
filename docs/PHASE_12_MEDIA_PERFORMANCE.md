# Phase 12 Media & Screen-Share Performance Report

## 1. Bottlenecks Identified in Phase 11 Capture Pipeline

In the pre-Phase 12 capture implementation (`apps/desktop/src/capture.rs` & `apps/web/src/pages/P2pWorkspacePage.tsx`):
1. Every HTTP request `GET /p2p/v1/capture/frame/{source_id}` allocated fresh GDI DCs and bitmaps (`CreateCompatibleDC`, `CreateCompatibleBitmap` twice for windows), performed slow multi-tap software `HALFTONE` `StretchBlt`, extracted scanlines with `GetDIBits` into a `4–6.3 MiB` heap buffer, copied into a second BMP buffer, and streamed uncompressed BMP over HTTP/1.1.
2. On the frontend, `handleStartNativeCapture` issued repeated HTTP `fetch()` calls on `setInterval`, allocated BMP `Blob`s, and ran async `createImageBitmap(blob)` + canvas letterbox copies on every frame.

## 2. Phase 12 Native Capture & Transport Architecture

- **`CaptureSession` (`apps/desktop/src/capture.rs`):**
  - Reuses persistent `HDC` and top-down 32-bpp `CreateDIBSection` mapped buffer (`dst_bits`) across frames, only reallocating if `(dst_w, dst_h)` changes (`Drop` releases all GDI handles cleanly).
  - Eliminates `GetDIBits` copies (synchronizes via `GdiFlush()` and reads `dst_bits` directly).
  - Bypasses intermediate `full_dc` + `StretchBlt` when `src_w == dst_w && src_h == dst_h` (e.g., `PrintWindow` renders straight into the DIB at native resolution) and uses `COLORONCOLOR` when scaling.
- **Binary WebSocket RGBA Stream (`/p2p/v1/capture/stream/{source_id}` in `apps/desktop/src/server.rs`):**
  - Runs under both loopback auth and Stealth lock middleware (terminating immediately if Stealth locks mid-share).
  - Dedicated `spawn_blocking` worker maintains one thread-affine `CaptureSession` and sends `[w: u32_le][h: u32_le][RGBA8...]` binary frames over a bounded `mpsc::channel(2)` for zero queue bloat, respecting `fps` (`5..=60`).
- **Frontend Canvas Bridge (`apps/web/src/pages/P2pWorkspacePage.tsx`):**
  - Connects via `p2pApi.openCaptureStreamSocket(source.id, spec.width, spec.fps)`, reuses a single `ImageData` buffer + `ctx.putImageData` (eliminating HTTP framing, `Blob` creation, and `createImageBitmap`), and falls back automatically to the improved DIB-backed HTTP BMP endpoint if the WebSocket fails before first frame.

## 3. Measured Benchmarks (`cloak-desktop.exe` `--release`, target `win:<hwnd> Cloak 1618x1072`)

### HTTP BMP Baseline vs Optimized `CreateDIBSection` HTTP BMP (30 frames each)

| Profile | BEFORE (Legacy GDI `HALFTONE` + `GetDIBits`) | AFTER (`CreateDIBSection` + `COLORONCOLOR`) | Delta |
| :--- | :--- | :--- | :--- |
| `maxWidth=1280` HTTP BMP | `74.49 ms/frame` (`13.40 fps`), `4.00 MiB/frame`, CPU `0.688 s` | `40.47 ms/frame` (`24.65 fps`), `4.00 MiB/frame`, CPU `0.172 s` | **+84.0% FPS**, **4.0x lower host CPU** |
| `maxWidth=1920` HTTP BMP | `107.10 ms/frame` (`9.33 fps`), `6.26 MiB/frame`, CPU `0.922 s` | `46.30 ms/frame` (`21.59 fps`), `6.26 MiB/frame`, CPU `0.219 s` | **+131.4% FPS**, **4.2x lower host CPU** |

### Binary WebSocket RGBA Stream (`/p2p/v1/capture/stream/{source_id}`)

| Requested Profile | Captured Dimensions | Avg Frame Interval | Achieved FPS | Loopback Bandwidth | Host Process CPU |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **720p30** (`maxWidth=1280&fps=30`, 44 measured frames) | `1280x820` | `33.10 ms/frame` | **30.21 fps** | `1014.8 Mbps` | `0.25 s` |
| **1080p30** (`maxWidth=1920&fps=30`, 44 measured frames) | `1600x1025` | `33.80 ms/frame` | **29.58 fps** | `1552.5 Mbps` | `0.344 s` |
| **1080p60** (`maxWidth=1920&fps=60`, 59 measured frames) | `1600x1025` | `19.48 ms/frame` | **51.34 fps** | `2694.4 Mbps` | `0.453 s` |

## 4. Honest Hardware Limits & Caveats

1. **Observed 1080p60 Ceiling:** With GDI `PrintWindow` + full-frame RGBA readback, `1080p60` sustained **51.34 fps** (`19.48 ms/frame`) on this host rather than 60.0 fps (`16.67 ms`). Reaching locked 60.0 fps+ on larger `4K` / high-refresh displays requires DXGI Desktop Duplication (`IDXGIOutputDuplication`) / GPU texture sharing in a future phase.
2. **Locked Workstation Monitor Capture (`mon:0`):** While window capture (`win:*` via `PrintWindow`) succeeded and Playwright `Spec 3` verified two-peer WebRTC signaling + native Win32 capture wiring, full monitor region capture (`mon:0` via `GetDC(NULL)`/`StretchBlt`) returned `404 NotFound` (`StretchBlt failed capturing screen region (desktop locked or protected?)`) while the local Windows interactive console was locked during headless benchmarking. Physical monitor `mon:0` FPS on an unlocked interactive console remains **Not verified** on unlocked session here.
3. **Two-PC LAN WebRTC Media:** Real two-peer WebRTC audio/video/screen-share (`Spec 3`) is **Automated-tested** on one physical PC; cross-PC LAN bitrate/jitter/packet-loss remains **Blocked — Pending Physical Hardware**.

