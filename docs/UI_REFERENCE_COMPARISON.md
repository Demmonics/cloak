# Cloak UI/UX Redesign — Reference Comparison & Visual QA Report

## 1. Art Direction Source & Translation Approach
- **Reference:** User-provided **Selvester's Camera** (`media_1794484726554_e8d2dbb2.png`) screenshot — a retro-modern editorial studio website built around light stone gray surfaces, muted sage bands, deep forest typography, warm mineral off-white cards/pills, and editorial pullquotes.
- **Adaptation Principle (Option 2):** Translated Selvester's **aesthetic, palette, typography, card geometry, and tranquil spatial pacing** into Cloak's existing native desktop P2P messenger architecture without reproducing e-commerce storefront sections or altering any cryptographic, storage, networking, WebRTC, Ghost Mode, or Stealth/PDF decoy behavior.
- **Strict Decoy Preservation:** `apps/web/src/components/pdf/PdfReaderShell.tsx` was left visually plain and ordinary (verified in `docs/visual-qa/ui-redesign/after-15-pdf-decoy.png`) so cover switching preserves complete plausible deniability.

---

## 2. Visual System Comparison

| Element | Reference ("Selvester's Camera") | Previous Cloak UI (`before-*.png`) | Redesigned Cloak UI (`after-*.png`) |
| --- | --- | --- | --- |
| **Default Canvas & Surface Palette** | Stone gray canvas (`#D8DAD8`), muted sage greens (`#5F6F63`), warm mineral paper cards (`#EEEDE9`), deep forest ink (`#0E1A18`) | Generic dark Discord-slate (`#0b0d13`, `#141722`) with indigo/purple (`#7c6cff`) accents | **Stone & Sage Light** out-of-the-box (`#D8DAD8` void, `#CFD3CF` sidebar folio, `#EEEDE9` mineral cards, `#5F6F63` sage masthead, `#182C27` forest accent pill, `#0E1A18` ink) |
| **Dark Theme Companion** | Deep forest ink contrast surfaces | Only legacy slate dark | **Deep Forest Dark** (`#0E1A18` void, `#8FA392` patina sage accent, `#ECEBE5` warm stone ink) via 3-way `ThemeToggle` (`Stone` / `Auto` / `Forest`) using CSS `light-dark()` |
| **Typography** | Expressive serif display headlines paired with clean readable body sans-serif | Uniform monospace/sans utility hierarchy (`#7c6cff` badges) | **Offline system serif** (`Georgia`, `Sitka Display`, `Palatino Linotype`, `Times New Roman`) for `<h1>` conversation headings, node nameplate, modal headings, room titles, reply pullquotes, and empty state; clean readable sans-serif (`Segoe UI Variable Text`) for messages & controls; tabular monospace (`Cascadia Mono`) for IPs, epochs, and timestamps — zero external font network requests |
| **Buttons & Controls** | Soft off-white pill buttons (`rounded-full`) with subtle borders | Boxy `rounded-[7px]` dark slate rectangles | Soft `rounded-full` pill buttons and pill inputs (`packages/ui/src/Button.tsx`), segmented `ThemeToggle`, subtle hover shifts |
| **Message Cards & Timeline** | Spacious mineral paper blocks with editorial pullquotes | Dense list rows on `#0b0d13` | Centered `max-w-[920px]` editorial column; distinct own-message subtle sage wash (`var(--cloak-bg-sage-soft)`) vs incoming warm off-white mineral cards (`var(--cloak-bg-card)`); italic editorial blockquote styling for replies; hover actions + right-click context menu |
| **Inline Media & Call Stage** | Framed photography on dark olive/forest backdrop | Raw file download chip only | `P2pAttachmentItem.tsx` renders verified inline image thumbnails, audio/video controls, and a `ModalDialog` lightbox preview; `P2pMediaDock.tsx` uses deep `#0D1815` cinema framing and pill controls |
| **Motion & Transitions** | Calm, deliberate transitions | Instant mount/unmount | CSS `@starting-style` + `transition-behavior: allow-discrete` + `overlay` dialog transitions and compositor-only keyframes (`opacity`, `transform`), gating under `@media (prefers-reduced-motion: reduce)` |

---

## 3. Defects Caught & Fixed During Visual QA

1. **Left Sidebar Flex Compression at 720p / 150% DPI (`after-04` / `after-06` iteration 1):**
   - *Root Cause:* Flex children inside `<aside className="flex-col overflow-y-auto">` shrank vertically when viewport height dropped to `720px` (especially at 150% DPI), clipping the bottom of the sage Identity card.
   - *Fix:* Added `shrink-0` to all 5 sidebar cards in `apps/web/src/pages/P2pWorkspacePage.tsx`. Re-verified cleanly in `after-04-messenger-1280x720.png`, `after-06-messenger-dpi-150pct.png`, and `after-00-native-webview2-1440x900.png`.
2. **Orphan Header Action Wrap at `1280x720`:**
   - *Root Cause:* The right header cluster wrapped only the `Burn` button onto a third line at `1280px`.
   - *Fix:* Tightened header gap (`gap-2`), horizontal padding (`px-4 sm:px-5`), and search pill width (`w-32 xl:w-44`). Re-verified cleanly in `after-04-messenger-1280x720.png` and `after-06-messenger-dpi-150pct.png`.
3. **Remaining Legacy Hardcoded Hex Colors in Shared/Call Components:**
   - Replaced remaining legacy `#7c6cff`, `#141722`, `#1f2536`, and `#dc2626` hardcoded classes in `VoiceDockBar.tsx`, `CallStageView.tsx`, `MessageComposer.tsx`, `LeftRail.tsx`, and `ChannelSidebar.tsx` with semantic `--cloak-*` CSS custom properties.

---

## 4. Responsive & DPI Verification Results

Measured against compiled `cloak-desktop.exe` (`apps/web/dist` embedded into Windows binary):
- `1920x1080` (Stone Light & Deep Forest Dark): Clean proportions, balanced two-column desktop reading cadence.
- `1600x900`: `scrollWidth = 1600 === clientWidth = 1600` (zero horizontal overflow).
- `1366x768`: `scrollWidth = 1366 === clientWidth = 1366` (zero horizontal overflow).
- `1280x720`: `scrollWidth = 1280 === clientWidth = 1280` (zero horizontal overflow; single consolidated action row).
- `780x720` narrow: `scrollWidth = 780 === clientWidth = 780` (collapsible mobile drawer hamburger + compact composer).
- `1280x720 @ 150% DPI` (`deviceScaleFactor: 1.5`): `scrollWidth = 1280 === clientWidth = 1280` (unclipped identity card & readable contrast).
- Live Windows Edge WebView2 (`tao` + `wry`) window via CDP at `1440x900` and `780x720`: Rendered offline serif typography (`Atelier Vault`, `Seline`) and Stone/Sage palette identically to Chromium QA captures.

---

## 5. Screenshot Inventory (`docs/visual-qa/ui-redesign/`)

### Before Baseline
- `before-01-messenger-1920x1080.png`
- `before-02-ghost-shield.png`
- `before-03-ghost-settings.png`
- `before-04-webrtc-call.png`
- `before-05-stealth-settings.png`

### After Redesign
- `after-00-native-webview2-1440x900.png` — Live Windows Edge WebView2 native desktop window (`1440x900`)
- `after-00b-native-webview2-narrow.png` — Live Windows Edge WebView2 native desktop window narrow (`780x720`)
- `after-01-messenger-1920x1080.png` — Primary Stone & Sage Light theme (`1920x1080`)
- `after-01b-messenger-dark-1920x1080.png` — Deep Forest Dark theme (`1920x1080`)
- `after-02-messenger-1600x900.png` — Desktop viewport (`1600x900`)
- `after-03-messenger-1366x768.png` — Laptop viewport (`1366x768`)
- `after-04-messenger-1280x720.png` — Compact HD viewport (`1280x720`)
- `after-05-messenger-narrow-780x720.png` — Narrow viewport (`780x720`)
- `after-06-messenger-dpi-150pct.png` — Windows `150%` DPI scaling check (`deviceScaleFactor: 1.5`)
- `after-07-empty-state.png` — Editorial empty conversation pullquote
- `after-08-context-menu-and-search.png` — Message search filter & right-click context menu
- `after-09-attachment-lightbox.png` — Inline attachment preview lightbox dialog
- `after-10-burn-confirm-dialog.png` — Destructive Burn Room `ConfirmDialog`
- `after-11-ghost-settings.png` — Ghost Mode settings modal
- `after-12-ghost-shield.png` — Ghost Privacy Shield lock overlay
- `after-13-webrtc-call.png` — Active Direct WebRTC call stage with self-preview & device controls
- `after-13b-webrtc-screen-picker.png` — Native Win32 Display/Window Capture Picker modal
- `after-14-stealth-settings.png` — Privacy, Stealth Mode & Ghost Automation 6-tab modal
- `after-15-pdf-decoy.png` — Ordinary Document Reader PDF cover (preserved non-Cloak styling)

