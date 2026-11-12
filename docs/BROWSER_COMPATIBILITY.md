# Cloak Browser & WebView Compatibility

---

## 1. Verified Runtime Targets

| Runtime | Verified Feature Scope | Notes |
|---|---|---|
| Chromium `1254` (Playwright) | Web E2EE onboarding, IndexedDB vault, WebSockets, File chunk encryption/download, Worker `.cloakexport`, `/archive` offline viewer, responsive `1920x1080` / `1366x768` / `390x844`, and `/p2p` desktop UI | Verified in both Playwright E2E specs |
| Microsoft Edge (`msedge.exe --app=...`) | Installed on host (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`), invoked by `cloak-desktop.exe` in isolated profile `--user-data-dir` | Same Chromium Blink/V8/WebRTC/WebCrypto/WASM engine; interactive two-machine GUI launch noted in `REMAINING_WORK.md` |

## 2. Feature-Specific Browser Requirements & Honest Limitations

- **Secure Context Required (`https://` or `http://127.0.0.1` / `localhost`):**
  - WebCrypto (`crypto.subtle` non-extractable AES-GCM wrapping key), `navigator.clipboard.writeText`, WebRTC `navigator.mediaDevices.getUserMedia`, and `getDisplayMedia` require HTTPS in remote browser deployments (`Caddyfile` handles TLS) or loopback (`127.0.0.1`) inside `cloak-desktop.exe`.
- **Sanitizer API vs DOMPurify Fallback:**
  - `apps/web/src/lib/sanitizeHtml.ts` prefers native `Element.prototype.setHTML` + `Sanitizer` when present, and falls back synchronously/asynchronously to strict `DOMPurify` (`ALLOW_ARIA_ATTR=false`, `ALLOW_DATA_ATTR=false`, `KEEP_CONTENT=false`) on browsers without native `Sanitizer`.
- **SVG Inline Preview Policy:**
  - SVG image attachments intentionally suppress inline `<img>` / preview rendering in `MessageList.tsx` to eliminate SVG script-execution vectors; users can inspect metadata and click `Save` to download.
- **Screen Sharing & Mobile Browsers:**
  - `getDisplayMedia` screen sharing and `MediaRecorder` voice notes depend on desktop browser/WebView support and OS permissions; mobile WebKit/Chromium browsers restrict `getDisplayMedia`.

