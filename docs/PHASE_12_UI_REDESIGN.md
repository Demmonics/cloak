# Phase 12 UI Redesign, Diagnostics Consolidation & Bundle Optimization

## 1. Editorial UI Improvements (`apps/web/src/pages/P2pWorkspacePage.tsx`, `apps/web/src/index.css`)

1. **Collapsible Connection & Vault Diagnostics (`diagnosticsExpanded`, default `false`):**
   - Keeps a clean header card showing the user's editorial display name, `Local SQLite Vault` eyebrow, and live connection pill (`Local Ready` / `<N> Linked`) alongside `Strict Direct P2P` / `Assisted P2P`.
   - Moves technical fields (`Listen: 127.0.0.1:...`, `DPAPI` badge, `LAN IPv4` + IPv6 readiness, `Strict Direct-Only` toggle, optional STUN input, Windows Defender Firewall status, and `/archive` / `Server Mode` links) behind the accessible `"Advanced Connection & Vault Diagnostics"` (`aria-expanded`) toggle.
2. **Signed Single-Use Invitation Management UI:**
   - Direct Pairing panel displays authorized member count (`N authorized`), TTL selector (`10 min`, `15 min`, `1 hour`, `24 hour`), usage limit selector (`Single-use (1)`, `3 uses`, `10 uses`), expiration metadata strip (`Single-use · signed`), and an `Active Signed Invites` list showing `usesCount/maxUses` + expiry + `Revoke Invite` control.
3. **Grouped Consecutive Messages & Code Blocks:**
   - Adjacent messages from the same sender within a 5-minute window (without a reply header) set `data-grouped="true"`, collapsing redundant avatar/display-name headers and keeping compact timestamp + hover actions aligned (`pl-9`).
   - Fenced code blocks and inline code tokens render inside `.cloak-md pre` / `.cloak-md code` with horizontal overflow containment on narrow (`390px`) viewports.

## 2. Code-Splitting, Startup Time & Process-Tree Memory Benchmarks

### Bundle Split Architecture (`apps/web/src/App.tsx`, `apps/web/vite.config.ts`, `P2pWorkspacePage.tsx`)
- Lazy-loaded routes in `App.tsx` (`React.lazy` + `Suspense`): `WorkspacePage`, `ArchiveViewerPage`, `InviteLandingPage`, `P2pWorkspacePage`.
- Lazy-loaded `PdfReaderShell`, `P2pGhostSettingsModal`, and `P2pStealthSettingsModal` inside `P2pWorkspacePage.tsx` so PDF.js (~`432.70 KB` JS + `225.09 KB` CSS + `1,242.10 KB` worker) and modal code do not load until opened.
- Configured Vite `manualChunks` separating `pdfjs`, `livekit`, `icons`, and `markdown`.

### Measured BEFORE vs AFTER Bundle Sizes

| Asset | BEFORE | AFTER | Delta |
| :--- | :--- | :--- | :--- |
| Main entry JS (`index-*.js`) | `2,528.15 KB` | `956.33 KB` | **-62.2%** (`-1,571.82 KB`) |
| Main entry CSS (`index-*.css`) | `283.62 KB` | `58.93 KB` | **-79.2%** (`-224.69 KB`) |
| Lazy `P2pWorkspacePage-*.js` | (bundled) | `92.57 KB` | Loaded on `/p2p` |
| Lazy `PdfReaderShell-*.js` + `pdfjs-*.js` + `pdfjs-*.css` | (bundled) | `27.95 KB` + `432.70 KB` + `225.09 KB` | Loaded only when PDF decoy/reader mounts |
| Lazy `P2pStealthSettingsModal-*.js` / `P2pGhostSettingsModal-*.js` | (bundled) | `36.57 KB` / `12.58 KB` | Loaded only when modal opened |

### Measured Native `cloak-desktop.exe` Cold Startup & Full 9-Process Tree RAM

Measured with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9231"` on Windows 11 (`cloak-desktop.exe` + 8 child `msedgewebview2.exe` processes):

| Metric | BEFORE | AFTER | Delta |
| :--- | :--- | :--- | :--- |
| HTTP `/p2p/v1/status` ready (`httpReadyMs`) | `1,199.0 ms` | `615.0 ms` | **-48.7%** (`-584.0 ms`) |
| Embedded Edge WebView2 CDP ready (`cdpReadyMs`) | `1,817.1 ms` | `652.1 ms` | **-64.1%** (`-1,165.0 ms`) |
| Total Working Set (9 processes) | `546.96 MiB` | `542.32 MiB` | `-4.64 MiB` (`-0.8%`) |
| Total Private Bytes (9 processes) | `285.22 MiB` | `282.18 MiB` | `-3.04 MiB` (`-1.1%`) |
| `cloak-desktop.exe` alone | `49.49 MiB` WS / `10.61 MiB` Priv | `50.17 MiB` WS / `10.81 MiB` Priv | WebView2 Chromium baseline (`~492 MiB` WS) dominates runtime RAM |

