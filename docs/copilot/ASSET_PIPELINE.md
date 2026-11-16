# Asset pipeline

## Inputs and application use

- Card definitions and references were located under `src/data/`; rendering components under `src/cards/`.
- Static card images under `public/assets/cards/` are copied into the Vite output and served as ordinary files by the application server. A public path is not access control.
- The 3D model and textures were located under `public/assets/models/`. Preserve colocated license and attribution files whenever redistributing those assets.
- User-uploaded photos were stored as blobs in browser IndexedDB through `src/photos/`; this does not protect committed static images.
- No reproducible source-to-derived-photo generation script was verified in the inspected package configuration. Do not assume existing images can be regenerated or redistributed safely.

These paths describe the inspected implementation checkpoint `360a827`. Current `main` at `36a2b6f` has not been inspected.

## Print and export

1. The Print Studio creates a JSON job from project state; exports can contain personal photos, letters, and answer material.
2. The documented CLI at the inspected checkpoint is `node scripts/export-pdf.mjs <job.json> <output-directory>`.
3. The exporter uses Playwright/Chromium to create prototype PDFs. Read `src/printing/README.md` before use.
4. Treat source jobs, backups, screenshots, and PDFs as private data. Do not add them to a public branch without explicit content review.

Current output is not final or certified print-shop artwork. Color management, clipping, embedded fonts, physical alignment, duplex behavior, and printer tolerances require review and a physical proof.

## Release controls

- Separate private media from static public assets and use an explicitly approved publication workflow.
- Do not rely on obscurity of filenames; use access-controlled delivery for private media.
- Preserve third-party asset licenses and verify their redistribution terms.
- Review export jobs for privacy leakage, resolution, clipping, safe margins, color, and physical print quality before production.
