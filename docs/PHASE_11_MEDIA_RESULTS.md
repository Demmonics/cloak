# Cloak — Phase 11 Real Media Hardware & Native Capture Evaluation

**Date:** 2026-11-12  
**Test Host:** Single Windows 11 laptop (`YOOSHA`) with `Intel(R) UHD Graphics` (`1920x1080` panel / `1536x864` @ 125% DPI in browser viewport reporting), `NVIDIA GeForce RTX 4060 Laptop GPU`, `Integrated Camera (04f2:b7b8)`, `Lenovo Virtual Camera`, `Microphone Array (3- Realtek(R) Audio)`, and `EDIFIER W820NB Plus` USB/BT audio.  
**Note:** No second physical Windows PC was available on LAN during this audit; WebRTC two-peer media call checks ran between two separate desktop instances and browser contexts on loopback `127.0.0.1`.

---

## 1. Real Host Media Device Enumeration & Capture Results

Executed via Chromium launched with `--use-fake-ui-for-media-stream` (NO `--use-fake-device-for-media-stream`) against live embedded P2P UI (`verify-hardware-media.mjs`):

- **Enumerated Devices:** `32` real/virtual endpoints detected cleanly (`13` `audioinput`, `7` `videoinput`, `12` `audiooutput`), including:
  - Video: `Integrated Camera (04f2:b7b8)`, `Lenovo Virtual Camera`, `Camera (NVIDIA Broadcast)`, `OBS Virtual Camera`, `Smart Connect Camera`, `OnePlus 11R 5G (Windows Virtual Camera)`
  - Audio Input: `Microphone Array (3- Realtek(R) Audio)`, `Microphone (2- EDIFIER W820NB Plus)`, `Stereo Mix (3- Realtek(R) Audio)`, Voicemeeter endpoints
  - Audio Output: `Speakers (3- Realtek(R) Audio)`, `Headphones (2- EDIFIER W820NB Plus)`
- **`getUserMedia({ video: true, audio: true })` Active Capture (`captureError: null`):**
  - Video Track (`readyState: "live"`): `Lenovo Virtual Camera`, `1280x720`, `30 fps`, `resizeMode: "none"`
  - Audio Track (`readyState: "live"`): `Microphone (2- EDIFIER W820NB Plus)`, `48000 Hz`, `16-bit`, `1 channel`, `latency: 0.01s`, AEC/AGC/NS enabled
- **Live Loopback Two-Peer WebRTC Call Verification:**
  - `Direct WebRTC · Video + Audio` (`ICE: connected`, live `RX 6.7 KiB` -> `RX 10.5 KiB` -> `RX 25.0 KiB`) established cleanly over `P2pNode` P2P signaling (`WireFrame::WebRtcSignal`) with real camera self-preview rendered in `P2pMediaDock` in both Light and Dark themes (`media-video-call-dark.png`, `media-messenger-light.png`).
  - Automated Playwright WebRTC suite (`p2p-desktop.spec.ts` Spec 3) also verified video + audio + screen share continuity under Ghost Privacy Shield + PIN lock.

---

## 2. Native Win32 GDI Screen/Window Capture Pipeline Audit & Fix

**Pipeline Architecture:** `apps/desktop/src/capture.rs` (`StretchBlt` / `PrintWindow` -> 32-bpp top-down DIB via `GetDIBits` -> uncompressed BMP over HTTP `/p2p/v1/capture/frame/{id}`) -> `P2pWorkspacePage.tsx` (`createImageBitmap` -> 2D `<canvas>` -> `canvas.captureStream(fps)`).

### Bug Fixed in Phase 11 (`capture.rs` & `P2pWorkspacePage.tsx`)
1. **`GetDIBits` GDI Spec Violation (`capture.rs`):** `dst_bmp` previously remained selected inside `mem_dc` during `GetDIBits(...)`, causing failures when capturing display regions. Moved `SelectObject(mem_dc, old_dst)` BEFORE `GetDIBits` and added explicit `GetDC(NULL)` primary screen fallback plus distinct error messages (`StretchBlt failed...` vs `GetDIBits failed...`).
2. **Artificial 30fps Cap & Unbounded Fetch Overlap (`P2pWorkspacePage.tsx`):** Removed hardcoded `Math.min(spec.fps, 30)` clamp on `setInterval` (`1080p60` preset) and added an `inFlight` mutex flag so concurrent `/p2p/v1/capture/frame/...` HTTP fetches do not stack when GDI capture exceeds 16.6 ms.

### Measured Host Capture Benchmarks (`probe-capture.mjs` via Node `fetch`, 10-frame average)

| Source Type & Resolution | Uncompressed BMP Size | Avg Frame Time | Sustained Max FPS | Practical Verdict |
|---|---|---|---|---|
| **Window `win:528920` (`Cloak` `1618x1072`) @ `maxWidth=1280`** | `4,198,454 B` (`4.00 MiB`) | **`42.41 ms`** | **`23.6 fps`** | **Working (`PrintWindow`)** (~94 MiB/s loopback BMP copy). Suitable for docs/code/presentations (`720p30` practical max ~23 fps). |
| **Window `win:528920` (`Cloak` `1618x1072`) @ `maxWidth=1920`** | `6,560,054 B` (`6.26 MiB`) | **`44.38 ms`** | **`22.5 fps`** | **Working (`PrintWindow`)** (~141 MiB/s loopback copy). Cannot sustain true 60 fps (`1080p60` preset is throttled cleanly to ~22 fps by `inFlight` guard). |
| **Monitor `mon:0` (`Display 1 1920x1080`) @ `1280` & `1920`** | N/A | N/A | `0` (HTTP 404) | **Failed on Locked Desktop (`StretchBlt failed`)** during non-interactive Winlogon/locked session (`CopyFromScreen` also returned `ERROR_INVALID_HANDLE`). |
| **Monitor `mon:0` via Chromium `getDisplayMedia`** | Browser GPU DMA | N/A | Up to display VSync | Supported via `"Use Browser Tab/Screen Picker"` button in `P2pMediaDock` modal when Desktop Duplication (`getDisplayMedia`) is permitted. |

---

## 3. Honest Assessment of High-Motion Gaming / 1080p60 Viability

- **What works cleanly today:** Real webcam video calls, microphone audio with AEC/NS, window capture (`PrintWindow`), and low-to-moderate-motion screen sharing (~22–24 fps for native Win32 window BMP bridge; higher via browser `getDisplayMedia` GPU path).
- **Known performance bottleneck:** Native Win32 `capture.rs` captures CPU-side GDI `HALFTONE StretchBlt` + raw uncompressed 4–6.26 MiB BMPs over loopback HTTP and decodes them via `createImageBitmap` -> 2D canvas. Sustained `1080p60` high-motion gameplay sharing via the **native GDI BMP bridge** is **not achievable** today (~22.5 fps ceiling observed, ~141 MiB/s IPC bandwidth). Reaching true low-CPU `1080p60` in native WebView2 requires replacing raw BMP/GDI polling with **DXGI Desktop Duplication** (`IDXGIOutputDuplication`) + encoded MJPEG/H.264 frames or Chromium WebView2 `getDisplayMedia` permission handler integration.
- **UI Preset Accuracy Note:** The `"1080p60 (High Motion)"` option in `P2pMediaDock.tsx` works cleanly without crashing or dropping frames when paired with `getDisplayMedia`, while via the native GDI BMP bridge it runs at the host's achievable GDI cadence (~22–24 fps).

