# Architecture index

## Local implementation snapshot

The implementation observed at `360a827` lives in `Rust Arcade/52-reasons/` on local `main`; that source tree is not present on the current public `origin/main` baseline. Local `main` has since advanced to `807cd5e`, whose changes have not been inspected in this cycle; the entries below describe the older inspected checkpoint only.

| Area | Entry points | Current shape / caveat |
|---|---|---|
| Frontend | `src/main.tsx`, `src/app/App.tsx` | React 19, TypeScript, Vite; local editor, cards, map, puzzle, letter, print studio |
| Local project state | `src/store/`, `src/photos/` | Zustand and IndexedDB; uploaded photos are browser-profile local |
| Game client | `src/game/Game.tsx`, `src/game/Table.tsx`, `src/game/audio.ts` | Socket.IO client, React Three Fiber/Three.js; glTF geometry with separate custom face/back texture overlays; synthesized Web Audio |
| Game service | `server/index.mjs`, `server/game.mjs` | Node HTTP/Socket.IO; in-memory two-seat rooms and authoritative rules; server also serves `dist/` static assets without room authorization |
| Card data/art | `src/data/`, `src/cards/`, `public/assets/cards/` | Card content and images; sensitive material is present in local history and public asset paths |
| 3D assets | `public/assets/models/` | glTF and textures with colocated licenses |
| Story/map/letter | `src/puzzle/`, `src/map/`, `src/letter/` | Client-rendered and client-visible; UI unlock does not secure answers |
| Print | `src/printing/`, `scripts/export-pdf.mjs` | Browser/Chromium prototype PDFs, not press-ready |
| Tests | `src/**/*.test.ts`, `server/*.test.mjs`, `scripts/*.test.mjs`, `tests/` | Vitest, Node test runner, Playwright |

## Planned larger experience and integration

Codex's inventory on `codex/archive-integration` identifies candidate birthday, arcade, polygon, hunt, word-search, video, letter, streaming, and Valentine's projects. They are not verified integrated destinations. Protected source archives remain outside this branch and must stay read-only. The report states no unified authenticated gateway, server-verified puzzle completion, or full recipient journey is complete.

The `src/jigsaw/model.ts` geometry work is on Codex's branch, not the current main snapshot; it is not an authoritative or complete jigsaw service.

## Technology declarations

The implementation `package.json` declares React 19, TypeScript 5.7 range, Vite 6, Three 0.187 range, React Three Fiber 9, Drei 10, Zustand 5, Socket.IO 4, Vitest 3, and Playwright 1.50 range. This documentation branch does not contain that package manifest; versions were read from local `main`.
