$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

& (Join-Path $PSScriptRoot "dev-pg.ps1") -Action start -Port 55432

$env:CARGO_HTTP_MULTIPLEXING = "false"
$env:CLOAK_ENV = "development"
$env:API_HOST = "127.0.0.1"
$env:API_PORT = "8080"
$env:ALLOWED_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173"
$env:DATABASE_URL = "postgres://cloak:cloak_dev_pass_2026@127.0.0.1:55432/cloak_dev"
$env:CLOAK_DEV_ALLOW_IN_MEMORY_REDIS = "true"
$env:OBJECT_STORE_BACKEND = "local"
$env:LOCAL_OBJECT_STORE_DIR = ".cloak-dev/objects"
$env:SESSION_JWT_SECRET = "dev-only-insecure-session-secret-change-in-production-min-32-bytes"
$env:LIVEKIT_URL = "ws://127.0.0.1:7880"
$env:LIVEKIT_HTTP_URL = "http://127.0.0.1:7880"
$env:LIVEKIT_API_KEY = "devkey"
$env:LIVEKIT_API_SECRET = "devsecret_must_be_at_least_32_characters_long_for_livekit"

$apiProc = Start-Process -FilePath "cargo" -ArgumentList @("+stable-x86_64-pc-windows-gnu", "run", "-p", "cloak-api") -PassThru
$workerProc = Start-Process -FilePath "cargo" -ArgumentList @("+stable-x86_64-pc-windows-gnu", "run", "-p", "cloak-worker") -PassThru

Write-Host "Started cloak-api (PID $($apiProc.Id)) and cloak-worker (PID $($workerProc.Id))."
Write-Host "Starting Vite dev server on http://127.0.0.1:5173 (Ctrl+C stops frontend)..."

try {
    npm run dev:web
} finally {
    if ($apiProc -and -not $apiProc.HasExited) { Stop-Process -Id $apiProc.Id -Force -ErrorAction SilentlyContinue }
    if ($workerProc -and -not $workerProc.HasExited) { Stop-Process -Id $workerProc.Id -Force -ErrorAction SilentlyContinue }
}

