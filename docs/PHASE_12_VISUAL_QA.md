# Phase 12 Visual QA & Native WebView2 Inspection

## 1. Live Native Edge WebView2 CDP Verification (`phase12-native-qa.mjs`)

Executed directly against `target/release/cloak-desktop.exe` (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9233"`) using Playwright `chromium.connectOverCDP` and Win32 `EnumWindows` + `GetWindowTextW`:

- **Live Win32 HWND Title Transition:**
  - Initial Messenger HWND / DOM Title: `"Cloak"` / `"Cloak"`
  - After Stealth Lock (`manual_lock`): `"Document Reader"` / `"Document Reader"`
  - After PDF Search Secret Unlock (`#phase12-unlock`): `"Cloak"` / `"Cloak"` (confirms Phase 12 `native_shell.rs` title sync fix works end-to-end on Windows!)
- **Layout Overflow & Grouping Assertions:**
  - `overflowLightDesktop` (`1380x880`): `false` (`scrollWidth <= innerWidth`)
  - `overflowMobile` (`390x844`): `false` (`scrollWidth <= innerWidth`)
  - `groupedCount`: `2` grouped consecutive messages rendered via `[data-grouped="true"]`

## 2. Inspected Phase 12 Native WebView2 Screenshots (`docs/visual-qa/phase12/`)

| Screenshot | Dimensions / State | Visual Inspection Outcome |
| :--- | :--- | :--- |
| [wv2-light-collapsed.png](file:///c:/D%20drive/Personal%20Project/dIscord%20clone/docs/visual-qa/phase12/wv2-light-collapsed.png) | `1380x880`, Light Stone (`#D8DAD8`), diagnostics collapsed | Verified crisp Selvester sage vault plate, `Local Ready` badge, collapsed `"Advanced Connection & Vault Diagnostics"`, single-use signed ticket controls + `Active Signed Invites` (`Revoke Invite`), grouped consecutive message cards, and fenced Rust code block |
| [wv2-light-diagnostics-expanded.png](file:///c:/D%20drive/Personal%20Project/dIscord%20clone/docs/visual-qa/phase12/wv2-light-diagnostics-expanded.png) | `1380x880`, Light Stone, diagnostics expanded | Verified `Listen`, `DPAPI` badge, `LAN IPv4: 192.168.29.241 · IPv6 ready`, `Strict Direct-Only`, Defender Firewall note, and `/archive` / `Server Mode` links expand cleanly without clipping |
| [wv2-dark-workspace.png](file:///c:/D%20drive/Personal%20Project/dIscord%20clone/docs/visual-qa/phase12/wv2-dark-workspace.png) | `1380x880`, Deep Forest (`#0E1A18`) dark theme | Verified high contrast text/code blocks/chips, clean `Viewed` status indicators, zero illegible overlays |
| [wv2-mobile-narrow.png](file:///c:/D%20drive/Personal%20Project/dIscord%20clone/docs/visual-qa/phase12/wv2-mobile-narrow.png) | `390x844`, Light Stone narrow viewport | Verified clean drawer button toggle, wrapping pill toolbar, zero page horizontal scroll (`pre` code blocks scroll cleanly inside their card) |
| [wv2-stealth-pdf.png](file:///c:/D%20drive/Personal%20Project/dIscord%20clone/docs/visual-qa/phase12/wv2-stealth-pdf.png) | `1380x880`, Locked Stealth PDF Decoy (`"Document Reader"`) | Verified offline PDF.js rendering (`Q3 Architecture & Compliance...`, Page 1-3 thumbnails, toolbar & search input `"Search in document..."`) with zero leaked messenger UI |
| [wv2-unlocked-messenger.png](file:///c:/D drive/Personal%20Project/dIscord%20clone/docs/visual-qa/phase12/wv2-unlocked-messenger.png) | `1380x880`, Post-Unlock Messenger (`"Cloak"`) | Verified full workspace restoration after `#phase12-unlock` + `Stealth: PDF Armed` header badge |

In addition, `npx playwright test` regenerated Chromium multi-viewport visual QA artifacts under `docs/visual-qa/stealth-mode/`.

