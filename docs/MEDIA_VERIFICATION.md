# Cloak WebRTC & Native Media Verification

---

## 1. Architecture Verified

- **Direct P2P Signaling (`crates/cloak-p2p` + `P2pWorkspacePage.tsx`):** `RTCPeerConnection` SDP offers, answers, and ICE candidates travel directly inside encrypted `WireFrame::WebRtcSignal` frames over the authenticated TCP peer session (`POST /p2p/v1/webrtc/signal` -> `NodeEvent::WebRtcSignal` over authenticated `/p2p/v1/ws`), requiring zero third-party signaling servers.
- **Early ICE Buffering:** `P2pWorkspacePage.tsx` buffers incoming `ice_candidate` frames in `pendingIceRef` until `setRemoteDescription` completes on either offer or answer, eliminating race-condition `addIceCandidate` errors.
- **Stage & Device Controls (`P2pMediaDock.tsx`):** Mic, Camera, and Speaker output selection (`HTMLAudioElement.setSinkId` when supported by Chromium/WebView2), mute/deafen toggles, theater expand, fullscreen toggle, manual `restartIce()`, live RTP stats polling (`inbound-rtp` bytes received, frame dimensions, FPS, packet loss), and `callState`-synced `srcObject` + `.play()` attachment.
- **Native Win32 Capture Bridge (`apps/desktop/src/capture.rs`):** Enumerates top-level visible windows (`EnumWindows`) and displays (`EnumDisplayMonitors`), renders BMP thumbnails/frames (`PrintWindow(..., PW_RENDERFULLCONTENT)` with `StretchBlt` scaling), and feeds Chromium `HTMLCanvasElement.captureStream(fps)` via `track.replaceTrack` at selectable `720p30`, `1080p30`, or `1080p60` quality presets alongside `navigator.mediaDevices.getDisplayMedia`.

---

## 2. Observed Test Results

| Check | Status | Observed Result |
|---|---|---|
| Two-Peer Direct WebRTC Video + Audio (Chromium Fake Media Devices) | **Tested on localhost** (`Spec 3`) | Both peers open `Direct WebRTC Media Stage`; `ICE: connected`; Bob displays active `<video data-testid="remote-video">` with `videoWidth > 0`, non-zero `RX` bytes, and live resolution/FPS (`RX 17.5 KiB · 320x180@21fps` captured in `14-webrtc-active-call-screen-share.png`). |
| Native Win32 Capture Bridge Inside Active Call | **Tested on localhost** (`Spec 3`) | Desktop `/p2p/v1/capture/sources` returns live windows/monitors; `/p2p/v1/capture/frame` returns valid BMP bitmap; switching into screen share updates remote call state cleanly without dropping connection. |
| Ghost Privacy Shield Call Continuity | **Tested on localhost** (`Spec 3`) | Locking Alice into Ghost Privacy Shield hides conversation message DOM nodes while showing `"Direct encrypted call remains connected."` and keeping `Direct WebRTC Media Stage` active; unlocking resumes chat view cleanly (`3 passed` total E2E runtime `22.7s`, `Spec 3` `2.9s`). |
| Physical Hardware Camera / Mic / Screen Audio Loop Across Two Physical PCs | **Not yet verified** | Tested with Chromium fake capture devices on single host; real hardware UVC webcams, acoustics/echo cancellation, and Win32 GDI screen share smoothness at 1080p60 across physical Wi-Fi require two-PC testing. |

