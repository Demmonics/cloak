# Copilot project memory

This directory is the sanitized, Copilot-owned status and recovery record for the 52-reasons project. It is intentionally kept separate from implementation-owned documents and does not copy private story, media, archive, or answer content.

## Read in this order

1. [Live status](LIVE_STATUS.md) - latest observed commits, pending sync, and worker state.
2. [Agent activity](AGENT_ACTIVITY.md) - branch evidence without guessing whether an agent is currently active.
3. [Recovery handoff](RECOVERY_HANDOFF.md) - safe resume instructions and current blockers.
4. [Feature matrix](FEATURE_MATRIX.md), [architecture index](ARCHITECTURE_INDEX.md), [test matrix](TEST_MATRIX.md), and [known issues](KNOWN_ISSUES.md).
5. [Security](SECURITY.md), [asset pipeline](ASSET_PIPELINE.md), [deployment](DEPLOYMENT.md), and [decisions](DECISIONS.md).
6. [Changelog](CHANGELOG.md) and [overnight progress](OVERNIGHT_PROGRESS.md) for concise checkpoint history.
7. [GitHub sync status](GITHUB_SYNC_STATUS.md) for publication policy and worker details.

## Evidence rules

Detailed implementation and QA notes cite the inspected checkpoint `360a827`. Local `main` has since advanced to `36a2b6f` (19 commits ahead of public `origin/main` at the last observation); those newer changes and the dirty worktree have not been independently reviewed or tested. Treat feature and architecture details as historical evidence at their cited commits, not as verified current behavior. Implementation-agent reports are not independent verification. Source presence, automated tests, visual inspection, security checks, and release acceptance are separate evidence.

The local implementation history contains private-derived assets and content. This documentation branch is based directly on the existing public `origin/main` and publishes only sanitized `docs/copilot/` documentation plus the constrained synchronization worker. It does not merge or publish local implementation branches.

## Ownership

Copilot maintains these status documents and `tools/copilot-sync.ps1` / `tools/copilot-sync.config.json`. Antigravity owns implementation; Codex owns independent QA and integration review. Never edit their worktrees, stage their files, or infer completion from an uncommitted file.
