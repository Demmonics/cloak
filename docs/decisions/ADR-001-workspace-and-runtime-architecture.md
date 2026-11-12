# ADR-001: Monorepo, Backend Services, and Local/Production Infrastructure Parity

## Status
Accepted

## Context
Cloak requires a strict Rust + PostgreSQL + Redis + S3-compatible + LiveKit + React/TypeScript stack, deployable via Docker Compose + Caddy, and runnable locally during development and CI testing. On the current Windows development host, Rust (GNU toolchain), Node.js, Playwright Chromium, and PostgreSQL 18 are available locally while Docker Desktop, Redis, MinIO, and `livekit-server` are absent.

## Decision
1. Organize the repository into `apps/web`, `packages/{protocol,crypto,archive,ui,config}`, `services/{core,api,worker}`, `infrastructure/{docker,caddy,livekit}`, `tests/`, and `docs/`.
2. Require **PostgreSQL** (`sqlx`) in every environment, including local dev and integration tests (never mock SQL databases).
3. Abstract ephemeral rate-limit/presence state behind `StateStore` (`RedisStateStore` default; `InMemoryStateStore` allowed **only** when `CLOAK_ENV != production` and `CLOAK_DEV_ALLOW_IN_MEMORY_REDIS=true`) and encrypted attachment blob storage behind `ObjectStore` (`S3ObjectStore` SigV4 HTTP default; `LocalFsObjectStore` allowed **only** when `CLOAK_ENV != production` and `OBJECT_STORE_BACKEND=local`).
4. Fail closed on startup if `CLOAK_ENV=production` is paired with any dev fallback or insecure default secret.

## Consequences
- Production deployments always require real PostgreSQL, Redis, S3-compatible storage, and LiveKit.
- Local verification on hosts without Docker runs against real PostgreSQL 18, real Axum HTTP/WS, real client cryptography, real Web Workers, and real multi-context Playwright Chromium without misrepresenting unstarted external daemons.

