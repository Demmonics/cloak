# Known issues and release blockers

## Confirmed/reported at scoped checkpoints

1. **Private content is publicly retrievable from the current local app build.** Codex's isolated audit at code commit `117cdce` reports unauthenticated HTTP retrieval of a bundled personal image and client-bundle puzzle content. This is a local loopback reproduction, not evidence that the unpushed implementation is deployed.
2. **The integration/release journey is incomplete.** Codex's `f7456bb` acceptance decision says the unified gateway, complete jigsaw, server-verified story unlock, multiple integrated destinations, and end-to-end recipient flow are not complete.
3. **Local history must not be pushed to the public repository.** The 16 commits ahead of `origin/main` contain personal-derived assets and private story/export data. Removing a file in a later commit would not remove it from reachable history.
4. **Current Stage 5 test claims are not independently reproduced.** The implementation progress report lists successful test totals, but no fresh suite was run for `360a827` in this documentation task.
5. **Current worktrees contain uncommitted changes.** Main has two untracked story-service files; the Codex integration worktree has changed screenshots. They are excluded from synchronization.

## Additional validation gaps

- No verified internet deployment, TLS/WSS, authenticated asset delivery, origin/abuse controls, or server-side puzzle authorization.
- The candidate integration inventory does not establish that archive projects are safe, complete, or consent-approved for release.
- Jigsaw geometry on the Codex branch is not a complete, authoritative game.
- Visual reports conflict in scope: implementation reports claim broader validation; Codex reports say full recipient flow, mobile/manual review, performance, and private-access tests remain incomplete.
- Print PDFs remain prototypes, not certified final artwork.
- No complete accessibility, performance/FPS, mobile-device, or production hosting audit.

## Safe handling

Keep local application and archived material on trusted storage. Never publish original archives, private media, letters, conversations, puzzle answers, backups, screenshots, or proof exports. The Copilot worker's path allowlist is a guardrail, not a replacement for human privacy review.
