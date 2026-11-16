# Test matrix

## Current confidence

No application suite was run in this documentation cycle. The latest observed implementation branch is `main` at `36a2b6f`; its code and dirty worktree were not inspected. Results below are historical evidence for the named checkpoints, not current test claims.

| Area | Evidence / command | Recorded result | Status and limits |
|---|---|---|---|
| Production build | Antigravity Stage 5 report at `360a827`: `npm run build` | Reported passing | Report only; not independently rerun. |
| Node game tests | Stage 5 report at `360a827` | 11/11 reported passing | Report only; not independently rerun. |
| Vitest | Stage 5 report at `360a827` | 2/2 reported passing | Report only; not independently rerun. |
| Playwright | Stage 5 report at `360a827` | 6/6 reported passing | Report only; not independently rerun. |
| Codex local unit/server/browser checks | Codex QA at `117cdce` | Passes reported | Independent QA report; not a current-main run. The same audit reproduced unauthenticated access to bundled image and client puzzle data. |
| Print/export | Project QA reports and `scripts/printing.test.mjs` at earlier checkpoints | Historical test evidence | PDFs still need privacy, visual, physical alignment, and print-production review. |
| Accessibility, device, and performance | No complete test evidence found | Not verified | Keyboard/screen-reader review, target-device checks, and performance benchmarks remain outstanding. |
| Internet deployment and privacy | No production test | Not verified; release blocked | No authenticated public deployment, TLS/WSS, abuse controls, or consent-gated media delivery is accepted. |

## Commands

Commands observed in the implementation package configuration and QA notes at the inspected checkpoint include:

```powershell
npm ci
npm test
npm run build
npm run dev
npm run server
npm run test:e2e
node --test server/game.test.mjs server/network.test.mjs
node --test scripts/printing.test.mjs
```

Run tests only in an isolated worktree. Check port ownership before E2E tests because the Playwright setup may reuse an existing server. Do not copy screenshots, print jobs, exports, or personal media into this public documentation branch.

## Evidence discipline

For each new result, record branch, exact commit, command, exit result, test count, environment, and warnings. Separate source presence, automated checks, visual inspection, security review, and release acceptance. Do not promote historical or agent-reported passes to `TESTED` without reproducing them on the target commit.
