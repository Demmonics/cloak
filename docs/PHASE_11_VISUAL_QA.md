# Cloak — Phase 11 Visual QA & Native WebView2 Rendering Report

**Date:** 2026-11-12  
**Inspected Surfaces:** Real Windows 11 `tao`/`wry` Edge WebView2 native desktop window (`PrintWindow` captures) + Chromium real-hardware desktop & mobile/desktop E2E captures (`1280x720`, `1366x820`, `1920x1080`, Light/Dark/Auto modes).

---

## 1. Visual Surfaces Verified via Image Inspection

1. **Native WebView2 Messenger Shell (`native-gui-messenger.png`)**
   - Custom Signal Teal `cloak_rgba_32x32` window/tray icon (`#2DD4BF` shield + `#0EA5E9` visor, fixed from legacy purple in `apps/desktop/src/native_shell.rs`) renders cleanly alongside native Win32 `"Cloak"` titlebar.
   - Left vault rail renders `LOCAL SQLITE VAULT`, `DPAPI` badge, P2P listen address, `LAN IPv4: 192.168.29.241 · IPv6 ready`, `Strict Direct-Only`, and honest Windows Defender Firewall warning text.
   - Header displays `Ghost: Off`, `Stealth & PDF`, and segmented `Light / Auto / Dark` theme switcher. Zero horizontal overflow or clipped labels.
2. **Native WebView2 Stealth PDF Decoy (`native-gui-stealth-pdf.png`)**
   - Native Win32 titlebar dynamically flips to `"Document Reader"`.
   - Offline bundled PDF.js renders `Q3 Architecture & Compliance Notes` (3 pages) with sharp Helvetica typography, left thumbnail strip (`Page 1`, `Page 2`, `Page 3`), Outline/Saved/Library tabs, zoom/rotation controls, and search input (`Search in document`).
   - Zero Cloak messenger names, room titles, peers, or chat text appear anywhere in the DOM or titlebar.
3. **Real Hardware Video Call — Dark Theme (`media-video-call-dark.png`)**
   - Obsidian dark surface renders active `Direct WebRTC · Video + Audio` dock (`ICE: connected`, live `RX 10.5 KiB` counter), live `Lenovo Virtual Camera` self-preview tile, device selectors (`Default Mic (13)`, `Default Camera (7)`, `Default Speaker (12)`), and responsive controls (`Share Screen`, Mute, Deaf/Speaker, Expand, Full, Refresh, End) without overlap or horizontal scroll.
4. **Real Hardware Video Call — Light Theme (`media-messenger-light.png`)**
   - Paper-light CSS token surface (`#FAF9F7` / `#FFFFFF` cards, crisp Signal Teal primary CTAs, accessible slate borders) preserves identical spacing, contrast, and functional parity across all header buttons, WebRTC dock, sidebar controls, and message composer.
5. **Native Screen Picker Dialog & Active Share (`media-screen-picker.png`, `media-screen-share-active.png`)**
   - Modal overlay centers cleanly with `Stream Quality` preset selector (`720p · 30 fps`, etc.), enumerated source cards (`Display 1 (1536x864 · \\.\DISPLAY1)`), fallback `"Use Browser Tab/Screen Picker"` CTA, and active `"Live screen share active"` green status banner (`RX 25.0 KiB`) upon launch.

---

## 2. Visual Defects Found & Fixed / Documented

- **Fixed in Phase 11 (`apps/desktop/src/native_shell.rs`):** Updated `cloak_rgba_32x32` window/tray bitmap palette from legacy indigo `(124, 108, 255)` to Cloak Signal Teal `(45, 212, 191)` / visor `(14, 165, 233)` to match the refreshed Light/Dark UI design tokens (`228f280`).
- **Observed Win32 Limitation:** Enabling Ghost Mode `captureProtection` (`SetWindowDisplayAffinity(hwnd, 0x11)`) causes standard OS screen capture tools to render a black rectangle (`WDA_EXCLUDEFROMCAPTURE` working as designed); screenshots of the PDF/messenger content must be captured with capture protection disabled.
- **No horizontal overflow:** `p2p-desktop.spec.ts` and `stealth-mode.spec.ts` assert zero horizontal scroll overflow at both `1280x720` and `1920x1080` across PDF reader, Stealth settings, pairing, and unlocked messenger views.

