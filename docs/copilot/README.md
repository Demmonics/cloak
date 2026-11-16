# Copilot project memory

This directory is the sanitized, Copilot-owned status and recovery record for the 52-reasons project. It is intentionally kept separate from implementation-owned documents and does not copy private story, media, archive, or answer content.

## Read in this order

1. [Live status](LIVE_STATUS.md) - latest observed commits, pending sync, and worker state.
2. [Agent activity](AGENT_ACTIVITY.md) - branch evidence without guessing whether an agent is currently active.
3. [Recovery handoff](RECOVERY_HANDOFF.md) - safe resume instructions and current blockers.
4. [Feature matrix](FEATURE_MATRIX.md), [architecture index](ARCHITECTURE_INDEX.md), and [known issues](KNOWN_ISSUES.md).
5. [GitHub sync status](GITHUB_SYNC_STATUS.md) for publication policy and worker details.

## Evidence rules

This snapshot describes local project source at `360a827`; `origin/main` is an older public baseline. Test statements are labeled by source and exact commit. Implementation-agent reports are not independent verification. Source presence, automated tests, visual inspection, security checks, and release acceptance are separate evidence.

The local implementation history contains private-derived assets and content. This documentation branch is based directly on the existing public `origin/main` and publishes only sanitized `docs/copilot/` documentation plus the constrained synchronization worker. It does not merge or publish local implementation branches.

## Ownership

Copilot maintains these status documents and `tools/copilot-sync.ps1` / `tools/copilot-sync.config.json`. Antigravity owns implementation; Codex owns independent QA and integration review. Never edit their worktrees, stage their files, or infer completion from an uncommitted file.
