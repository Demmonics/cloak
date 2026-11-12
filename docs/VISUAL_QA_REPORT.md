# Cloak Visual QA Report

**Screenshots Directory:** `docs/visual-qa/`  
**Inspection Method:** Automated Playwright captures (`tests/e2e/cloak.spec.ts` and `tests/e2e/p2p-desktop.spec.ts`) directly inspected via image viewer, followed by targeted UI/layout repairs and re-verification.

---

## 1. Inspected Screenshots

| Artifact | Viewport / State | Observed Visual Verification |
|---|---|---|
| `01-onboarding-1920x1080.png` | `1920x1080` Web Onboarding | Clean hierarchy, legible contrast, `"Direct P2P"` and `"Open Archive"` action links aligned on a single non-wrapping line. |
| `02-workspace-1920x1080.png` | `1920x1080` Server Workspace | Balanced 3-pane layout + search drawer, decrypted markdown, inert escaped XSS string, reactions, encrypted attachment card. |
| `03-workspace-1366x768.png` | `1366x768` Server Workspace | Crisp typography, typing indicator visible above composer; top-right toast clears composer Send button & disappearing timer cleanly. |
| `04-export-modal-1920x1080.png` | `1920x1080` Export Modal | Native `<dialog>` centered cleanly; full `.cloakexport` option text unobstructed. |
| `05-mobile-390x844.png` | `390x844` Mobile Narrow | `#general` channel title stays visible; composer textarea stacks cleanly above controls with zero horizontal overflow. |
| `06-archive-viewer-unlocked.png` | `1920x1080` `/archive` Unlocked | Clean dark cards, `Integrity SHA-256 Verified` pill, sync metadata, deleted attachment warning card. |
| `07-p2p-desktop-1920x1080.png` | `1920x1080` Release `/p2p` Alice | Crisp local SQLite sidebar (`DPAPI`, LAN IPv4), `Direct Sanctuary`, copyable `cloakp2p://` ticket, signed message + SHA-256 file card, `Peer <id> Direct Revoke` in `Paired Peers (1)`, green archive export banner. |
| `08-p2p-desktop-1366x768.png` | `1366x768` Release `/p2p` Bob | Balanced layout with `DesktopAlice Direct Revoke`, verified P2P file receipt notification, signed message article, clean composer bar. |
| `09-p2p-desktop-1280x720.png` | `1280x720` Compact Desktop | Zero clipping or horizontal overflow across sidebar, header controls, message list, and composer. |
| `10-p2p-desktop-780x720-narrow.png` | `780x720` Narrow Desktop | Sidebar switches cleanly to hamburger menu toggle; top bar wraps cleanly without clipping controls; composer remains full-width usable. |
| `11-ghost-privacy-shield-pin.png` | `1280x800` Ghost Shield + PIN | Sidebar masks identity (`•••••• (Protected)`), room (`Protected Room`), and peer (`Verified Peer`); header shows `Protected Conversation` + `Ghost: Shield`; centered PIN card covers conversation with 0 message DOM elements. |
| `12-ghost-settings-modal.png` | `1280x800` Ghost Settings Modal | Clear 2-column trigger/hardening grid, mode radio cards, Argon2id PIN lock input, and fixed bottom `ModalDialog` footer with unobstructed `Cancel` & `Save Ghost Policy` buttons. |
| `13-ghost-cleared-state.png` | `1280x800` Ghost Cleared State | Ghost status banner (`Ghost (clear_viewed): cleared 1 local message(s)...`) visible above preserved unread message `Beta unread survives`; wiped message absent. |
| `14-webrtc-active-call-screen-share.png` | `1366x768` Direct WebRTC Stage | Active `Direct WebRTC` stage banner showing `ICE: connected`, live `RX 17.5 KiB · 320x180@21fps`, Share Screen, Mute, Deafen, Expand, Full, Restart ICE, End buttons, Self Preview card, and Mic/Camera/Speaker dropdowns. |

---

## 2. Visual Defects Caught & Fixed

1. **Ghost Settings Save/Cancel Clipping (`12-ghost-settings-modal.png`):** `Cancel` and `Save Ghost Policy` were inside the scrollable `<form>`, clipping the bottom actions at `1280x800`. Moved actions into `ModalDialog`'s fixed `footer` prop wired with `form="ghost-settings-form"`.
2. **Ghost Modal Draft Reset on Background Props Updates:** Opening modal could reset edits if background policy/override refreshed. Guarded draft initialization via `wasOpenRef` closed-to-open transition.
3. **WebRTC Black `<video>` After Idle->Connected Transition (`P2pMediaDock.tsx`):** `srcObject` effect omitted `callState` in its dependency array and lacked `.play().catch(...)`, causing streams received before stage mount to stay unbound. Added `callState` dependency + `.play()` calls.
4. **Search Filter Un-observing Viewed Messages (`P2pWorkspacePage.tsx`):** Clearing the search box remounted `[data-message-id]` articles without re-attaching `IntersectionObserver` dwell tracking. Added `searchQuery` to observer effect dependencies.
5. **Earlier Baseline Repairs (`01..06`):** Fixed `[object Promise]` markdown rendering, `"Open Archive"` button wrapping, `[popover].cloak-toast-region` bottom-right composer overlap, export dropdown clipping, and `390x844` mobile composer stacking.
