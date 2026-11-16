# Recovery handoff

**Last observed:** 2026-11-17. Snapshot is not a live process monitor.

## Current checkpoint

- Latest verified public baseline: `origin/main` at `ac1a76a`.
- Local Antigravity branch: `main` at `807cd5e`, 17 commits ahead of `origin/main` at the last ref check. The worktree has uncommitted/untracked changes; their contents were not inspected, staged, or modified. The newer commits have not been reviewed or tested here.
- Last inspected implementation checkpoint: `360a827`. Feature, architecture, and Stage 5 test references below are historical evidence for that checkpoint.
- Codex integration worktree: `codex/archive-integration` at `429e1bf`; no new code or reports were inspected in this cycle.
- Older Codex review worktree: `qa/overnight-review` at `fcd80f6`.
- Copilot publishing worktree: `copilot/documentation-sync`, based on public `origin/main`; checkpoint `b8f3cf4` was verified on the remote. It contains sanitized Copilot docs and the restricted worker.

## What is verified and what is not

- **Source inspection:** checkpoint `360a827` included the local editor, multiplayer game, personalized 3D texture overlays, generated sound, and multiplayer UI/test changes. Current `main` at `807cd5e` has not been inspected.
- **Agent-reported:** Stage 5 lists Node 11/11, Vitest 2/2, Playwright 6/6 and build success at `360a827`; this is not evidence that the newer `main` checkpoint passes.
- **Codex-reported:** at code checkpoint `117cdce`, local game tests and browser tests passed, but direct unauthenticated retrieval of a bundled image and client-visible puzzle content failed the release security gate.
- **Not accepted:** full birthday gateway, secure puzzle unlock, jigsaw recipient flow, archive destination integration, internet multiplayer security, private deployment, final print production, and complete device/accessibility/performance QA.

## Branch ownership and publication

- Antigravity: `main` implementation. Its private-content history is not eligible for public push.
- Codex: `codex/archive-integration` and `qa/overnight-review`. These are not on the publisher allowlist; do not merge or push automatically.
- Copilot: `copilot/documentation-sync`. This branch is based on the existing public remote baseline and is the only branch the worker may publish, subject to strict path, commit-trailer, and secret checks.

## Resume safely

1. Run `git worktree list --porcelain` and `git status --short --branch` from the repository root.
2. Read this file, `LIVE_STATUS.md`, `AGENT_ACTIVITY.md`, and `GITHUB_SYNC_STATUS.md`.
3. Do not inspect or stage the shared untracked story files unless their owner hands them off.
4. For app setup, use the commands in the implementation branch's `52-reasons/README.md`; run tests only in an isolated worktree and record the exact commit.
5. Check the `Worker task` field in `LIVE_STATUS.md`. Restart the user-level monitor with `pwsh.exe -NoProfile -File "C:\Users\yoosh\AppData\Local\CopilotSync\cloak-documentation-sync\tools\copilot-sync.ps1" -InstallTask` only if no task is installed. Stop it with the same script and `-UninstallTask`.

No merge to `main` is authorized by the sync worker. If remote history diverges, it skips and records the condition; do not rebase or force-push automatically.
