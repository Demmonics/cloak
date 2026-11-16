# Recovery handoff

**Last observed:** 2026-11-17. Snapshot is not a live process monitor.

## Current checkpoint

- Local implementation: `main` at `360a827`, 16 commits ahead of public `origin/main` (`ac1a76a`) at last comparison.
- Local main has two untracked files under `52-reasons/server/` related to story work. They are uncommitted and were deliberately not read, staged, or modified.
- Codex integration/QA worktree: `codex/archive-integration` at `f7456bb`; several generated screenshot files are modified. Preserve them.
- Older Codex review worktree: `qa/overnight-review` at `fcd80f6`.
- Copilot publishing worktree: `copilot/documentation-sync`, created from the clean public `origin/main` baseline. It contains only sanitized Copilot docs and the restricted worker.

## What is verified and what is not

- **Source inspection:** current main includes the local editor, multiplayer game, personalized 3D texture overlays, generated sound, and multiplayer UI/test changes.
- **Agent-reported:** Stage 5 lists Node 11/11, Vitest 2/2, Playwright 6/6 and build success at `360a827`.
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
5. Restart the user-level monitor with `pwsh.exe -NoProfile -File "C:\Users\yoosh\AppData\Local\CopilotSync\cloak-documentation-sync\tools\copilot-sync.ps1" -InstallTask`. Stop it with the same script and `-UninstallTask`.

No merge to `main` is authorized by the sync worker. If remote history diverges, it skips and records the condition; do not rebase or force-push automatically.
