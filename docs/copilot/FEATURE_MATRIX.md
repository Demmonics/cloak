# Feature matrix

This matrix describes local source at `360a827` unless a branch/commit is named. Local `main` has since advanced to `807cd5e`; its newer commits and dirty worktree have not been reviewed or tested in this cycle. Treat these statuses as findings at the cited checkpoints, not as verification of current `main`. Implementation-agent reports are labeled as reported, not independently verified. The release/security gate is **BLOCKED**.

| Feature | Status | Source / evidence | Validation and limitations |
|---|---|---|---|
| 52-card deck and two additional cards | IMPLEMENTED | `52-reasons/src/data/`; Stage 5 QA report | Card integrity tests were reported; current commit was not independently retested. Content is private and client-visible. |
| Photo library and card editor | IMPLEMENTED | `src/app/`, `src/photos/`, `src/cards/` | Browser storage and photo assignment had earlier E2E coverage; committed public images are not access-controlled. |
| Personalized 3D card faces and backs | IMPLEMENTED | `src/game/Table.tsx`; commit `9c92299` | Source composites personalized front/back textures over model geometry. Current visual correctness and per-card asset access have not been independently rechecked. |
| Candlelit 3D table and card hover motion | IMPLEMENTED | `src/game/Table.tsx`; `abc2fa5` | Source verified; visual and performance evidence is incomplete. |
| Game sound effects and ambience | IMPLEMENTED | `src/game/audio.ts`, `src/game/Game.tsx`; `abc2fa5` | Source verified; no independent audio/device, preference, or accessibility test found. |
| Crazy Eights rules and edge cases | IMPLEMENTED | `server/game.mjs`, `server/game.test.mjs`; `360a827` | Antigravity reports 11 Node tests passing. Codex's earlier local suite passed on `117cdce`; latest main suite not independently rerun. |
| Two-player rooms, private hands, turns | IMPLEMENTED | `server/index.mjs`, `server/network.test.mjs`, `src/game/Game.tsx` | Stage 5 reports browser and socket checks; internet hosting and authentication are not verified. |
| Reconnection and rematch | IMPLEMENTED | Server network test/report at `360a827` | Agent-reported local test coverage; no remote-device or restart persistence. |
| Story puzzle and letter UI | IMPLEMENTED | `src/puzzle/`, `src/letter/` | Basic phrase unlock was tested in earlier E2E; answers/content are delivered to clients, so the unlock is not confidential. |
| Server-authorized story unlock | BLOCKED | No committed server authorization at `360a827` | Two untracked story files were present but are not part of the committed implementation snapshot and were not inspected. |
| Jigsaw | IN PROGRESS | `codex/archive-integration` commit `3a5c67a`, `src/jigsaw/model.ts` on that branch | Codex reports group geometry only; not a complete jigsaw, not integrated into main, no recipient-flow verification. |
| Birthday gateway / unified hub | BLOCKED | Codex archive integration report at `f7456bb` | No complete authenticated gateway or end-to-end entry/return journey verified. |
| Couples Arcade | BLOCKED | Candidate identified in Codex `INTEGRATION_INVENTORY.md` | Derived-copy tests were reported, but no integration or production-server/browser verification. |
| YOURPOLY | BLOCKED | Candidate identified in Codex inventory | Not integrated; browser and access checks pending. |
| Pokémon hunt | BLOCKED | Candidate identified in Codex inventory | Playability, models, integration, and authorization not independently verified. |
| Word Search | BLOCKED | Candidate identified in Codex inventory | Candidate tests reported in a derived copy; no integrated recipient-flow verification. |
| Ourflix | BLOCKED | Candidate identified in Codex inventory | Backend, data, authentication, and access boundary not verified. |
| Valentine's site | BLOCKED | Candidate variants identified in Codex inventory | No variant selected or authenticated integration verified. |
| Letters and archived destinations | BLOCKED | Candidate paths in Codex inventory | Content completeness, privacy, and protected delivery are not verified. |
| Print export | IMPLEMENTED | `src/printing/`, `scripts/export-pdf.mjs` | Prototype PDF tests reported; not final artwork or certified production output. |
| Mobile / accessibility | IN PROGRESS | `src/style.css`, `src/game/game.css`; Stage 5 report | Responsive E2E screenshots reported; full device/touch/screen-reader review not independently verified. |
| Privacy/authentication | BROKEN | `server/index.mjs`, public build assets, client puzzle code | Codex reproduced unauthenticated access to a bundled image and client puzzle data at `117cdce`. No production-safe boundary. |
| Production deployment | BLOCKED | Codex release acceptance at `f7456bb` | No deployment approved; direct access, missing hub journey, and incomplete integrations fail the release gate. |

## Test provenance

- **Reported by Antigravity:** `STAGE_5_MULTIPLAYER_QA.md` at `360a827` reports Node 11/11, Vitest 2/2, Playwright 6/6, and a passing build. Not independently rerun in this session.
- **Codex release audit:** `codex/archive-integration`, tested code commit `117cdce`, reports unit, server/print, and E2E passes but a failing private-asset authorization check and a release verdict of NOT READY.
- **Codex integration inventory:** `f7456bb` says the larger recipient journey and candidate integrations remain incomplete. Its archive-derived tests do not establish production authorization.
