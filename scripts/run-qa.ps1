$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$env:CARGO_HTTP_MULTIPLEXING = "false"
if (-not $env:DATABASE_URL) {
    $env:DATABASE_URL = "postgres://cloak:cloak_dev_pass_2026@127.0.0.1:55432/cloak_dev"
}

Write-Host "==> 1/5 ESLint"
npm run lint
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 2/5 TypeScript Typecheck"
npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 3/5 Vitest Unit Tests"
npm run test:unit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 4/5 Full Production Build"
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 5/5 Rust Workspace Tests (cloak-core, cloak-api, cloak-worker)"
cargo +stable-x86_64-pc-windows-gnu test --workspace -- --test-threads=1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "All lint, typecheck, unit, build, and Rust integration checks passed."

