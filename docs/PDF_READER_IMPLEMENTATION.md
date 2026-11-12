# Offline PDF Reader Decoy Implementation

**Components:**
- `apps/web/src/components/pdf/PdfReaderShell.tsx`
- `apps/desktop/src/server.rs` (`/pdf/documents`, `/pdf/documents/pick`, `/pdf/documents/sample`, `/pdf/documents/{id}/content`, `/pdf/documents/{id}`)
- `crates/cloak-p2p/src/stealth_storage.rs` (`pdf_library` SQLite table + `%LOCALAPPDATA%/.../pdfs/` byte store)

## Genuine Offline Rendering (`pdfjs-dist` v6)

- Uses `pdfjs-dist` and a bundled local module worker (`new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`), packaged inside Vite `apps/web/dist` and embedded directly in `cloak-desktop.exe` via `include_dir!`.
- Zero external network requests, CDNs, or telemetry calls are made at runtime (verified by Playwright `externalRequests === []`).
- Valid PDF validation (`validate_pdf_document` in `crates/cloak-p2p/src/stealth.rs`) checks non-empty `%PDF-` magic header and bounded file size before storing into the local `pdf_library` catalog. Corrupt or non-PDF payloads are rejected before persistence.
- Built-in local sample PDF generator (`build_valid_sample_pdf_bytes()` in `apps/desktop/src/server.rs`) creates a 3-page reference PDF (`q3-architecture-notes.pdf`) with clean line-wrapped text so PDF.js thumbnails, text layer, and search work even without importing external files.

## Interactive Reader Capabilities

- **Library & Multi-Tab Viewing:** Import local `.pdf` files via native `rfd` file picker (`/pdf/documents/pick`) or file upload (`/pdf/documents`), drag-and-drop onto the viewport, manage multiple open document tabs, and delete saved documents.
- **Navigation, Zoom & Rotation:** Page backward/forward and direct page input, zoom presets (`fit_width`, `fit_page`, `actual_size`, `custom`), zoom +/- controls, and 90° page rotation.
- **Persistence:** `PATCH /p2p/v1/pdf/documents/{id}` persists `lastPage`, `zoomMode`, `zoomPercent`, `rotationDeg`, `bookmarks`, and `lastOpenedAt` in `pdf_library` (supporting `PdfReturnBehavior::LastOpened`, `LastPagePosition`, or `AlwaysDefault`).
- **Sidebar Tabs & Popovers:** `Pages` thumbnail strip, `Outline` document outline tree, `Saved` bookmarks panel, `Library` manager, `Document Properties` popover (title, filename, page count, byte size, SHA-256 prefix), and Light/Dark PDF chrome themes.
- **In-Document Text Search + Secret Code Routing:** Pressing Enter on the `Search in document` form checks Stealth unlock via `p2pApi.unlockStealth('pdf_search', query)` when `pdf_search` is enabled; if the query does not match a configured secret code, it executes local PDF.js text search across pages without leaking failed-unlock noise into ordinary reading.
- **No Sensitive Metadata Leaks:** While concealed during a voice call, the status bar renders at most a neutral `Audio Session Active` pill (configurable via `showCallIndicatorInPdf`), with zero Cloak branding or peer/room names.

