# Deployment

## Status: BLOCKED

No production URL or deployment target is documented or verified. Do not deploy the inspected application snapshot: the cited audit found public static media and client-visible puzzle content, and production authentication and operations were not established. These findings are historical; current `main` at `36a2b6f` has not been reviewed.

## Local development at the inspected checkpoint

From `Rust Arcade/52-reasons/`, the recorded setup was:

```powershell
npm ci
npm run build
npm run server
```

Use `npm run dev` in a separate terminal for UI development. The inspected Node server defaulted to loopback port 3001, with `HOST` and `PORT` overrides. `npm run preview` is a local Vite preview; it does not establish a production Socket.IO deployment.

Verify commands against the current branch's package configuration before use. Keep local services loopback-only.

## Requirements before deployment

- Remove or isolate private content and approve a history/publication plan.
- Define identity, room access, consent, and private-media delivery.
- Move private media and puzzle secrets out of public static files and client bundles; enforce authorization on the server.
- Design TLS/WSS, origin restrictions, rate limits, room lifecycle/persistence, privacy-safe logs, backups, and monitoring.
- Validate the intended host's runtime, build/start commands, static and Socket.IO routing, secret management, and recovery procedures.
- Complete security, privacy, cross-device, accessibility, and print/content review.

No provider, domain, deployment target, or URL is assumed.
