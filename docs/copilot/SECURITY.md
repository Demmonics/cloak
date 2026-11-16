# Security and privacy

## Data handled

The inspected application handles personal relationship content. Editor uploads and project state were stored in the current browser profile's IndexedDB. Browser storage and exported backups are not substitutes for encryption, access control, or secure retention.

## Verified findings at cited checkpoints

- **Static media:** card images under `public/assets/cards/` are built as static files and served without game-room authorization. Codex reported successful unauthenticated retrieval at `aa0f08f`.
- **Story content:** story text, puzzle answers, and unlock logic were delivered to clients in the inspected implementation; a UI gate is not a confidentiality boundary.
- **Game rooms:** random room codes and seat tokens function as bearer credentials. No account identity binding or production authentication was verified; room state is in memory.
- **Transport and hosting:** local defaults were loopback-oriented. Production TLS/WSS, origin restrictions, rate limiting, abuse monitoring, and hardened deployment controls were not verified.
- **Exports:** backups, print jobs, PDFs, and screenshots may contain private content. Keep them out of public branches and third-party services.
- **Git history:** local implementation history includes private-derived media and content. Deleting a file from the tip would not remove reachable history; do not publish local implementation history.

These are findings for named historical checkpoints, including `117cdce` and `360a827`. Local `main` is now observed at `36a2b6f`, but current changes have not been inspected or security-tested.

## Safe operating rules

1. Keep local development loopback-only unless an approved security design exists.
2. Do not publish original archives, private photographs, messages, letters, exports, or hidden puzzle solutions.
3. Before any push, inspect all outgoing commits and added files. The worker is restricted to sanitized Copilot documentation and its own configuration/script; it never pushes implementation branches.
4. Keep public documentation free of personal names, private messages, image previews, and answer strings.
5. Treat derived media and story content as private unless specific material is explicitly approved for release.

## Release gate

Public or private internet deployment remains **BLOCKED** pending an approved media-consent model, safe publication history, authenticated media handling, server-side authorization for secrets, hardened transport and abuse controls, and security testing against the target deployment.
