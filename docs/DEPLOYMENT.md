# Cloak Deployment Guide

Cloak supports two deployment modes:
1. **Primary Mode — Native Local-First P2P Windows Desktop (`cloak-desktop.exe`)** (no server or database installation required).
2. **Optional Self-Hosted Relay Mode** (for browser access when direct P2P endpoints are offline or across strict firewalls).

---

## 1. Native Windows Desktop P2P Mode (No Central Infrastructure)

### Prerequisites
- Microsoft Windows with Microsoft Edge (`msedge.exe` — preinstalled on Windows 10/11).
- Pre-built `target/release/cloak-desktop.exe` (or build from source after building `apps/web/dist`):

```powershell
npm install
npm run build
$env:CARGO_HTTP_MULTIPLEXING = "false"
cargo +stable-x86_64-pc-windows-gnu build --release -p cloak-desktop
```

### Running
```powershell
.\target\release\cloak-desktop.exe --name "Alice" --p2p-bind 0.0.0.0:14900
```

Options:
- `--data-dir <path>`: Overrides local SQLite DB + blob storage location (defaults to `%LOCALAPPDATA%\CloakDesktop`).
- `--p2p-bind <ip:port>`: Direct P2P TCP listener address (defaults to `0.0.0.0:0` ephemeral port). Configure static port & allow inbound Windows Defender Firewall if pairing across LAN/port-forwarded WAN.
- `--http-port <port>`: Loopback UI server port (defaults to `127.0.0.1:0`).
- `--name <display_name>`: Local device display nickname.
- `--headless`: Runs without opening the Edge App Mode window (for background nodes or automated verification).

---

## 2. Optional Self-Hosted Server Stack (Docker / Caddy)

Templates are provided in `infrastructure/docker/` (`Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.web`, `docker-compose.yml`), `infrastructure/caddy/Caddyfile`, and `infrastructure/livekit/livekit.yaml`.

> **Verification Note:** These Docker/Caddy/LiveKit deployment templates were authored alongside the Rust API/worker services, but full `docker compose up` container orchestration was **not** executed on this Windows host (Docker Desktop is not installed locally). Verify `.env` secrets (`SESSION_JWT_SECRET`, PostgreSQL credentials, Redis URL, LiveKit keys, `ALLOWED_ORIGINS`) on a Linux Docker host before public exposure.

