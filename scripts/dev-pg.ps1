param(
    [ValidateSet("start", "stop", "status", "init")]
    [string]$Action = "start",
    [int]$Port = 55432
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PgBin = if ($env:PG_BIN) { $env:PG_BIN } else { "C:\Program Files\PostgreSQL\18\bin" }
$DataDir = Join-Path $RepoRoot ".cloak-dev\pgdata"
$LogFile = Join-Path $RepoRoot ".cloak-dev\postgres.log"
$PwFile = Join-Path $RepoRoot ".cloak-dev\.pgpass.tmp"

if (-not (Test-Path (Join-Path $PgBin "pg_ctl.exe"))) {
    throw "PostgreSQL binaries not found at $PgBin. Set PG_BIN environment variable."
}

New-Item -ItemType Directory -Force -Path (Split-Path $DataDir) | Out-Null

if ($Action -eq "init" -or ($Action -eq "start" -and -not (Test-Path (Join-Path $DataDir "PG_VERSION")))) {
    if (-not (Test-Path (Join-Path $DataDir "PG_VERSION"))) {
        Set-Content -Path $PwFile -Value "cloak_dev_pass_2026" -NoNewline -Encoding Ascii
        try {
            & (Join-Path $PgBin "initdb.exe") -D $DataDir -U cloak --auth=scram-sha-256 --encoding=UTF8 --pwfile=$PwFile
            if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE" }
        } finally {
            Remove-Item $PwFile -Force -ErrorAction SilentlyContinue
        }
    }
}

switch ($Action) {
    "status" {
        & (Join-Path $PgBin "pg_ctl.exe") -D $DataDir status
    }
    "stop" {
        & (Join-Path $PgBin "pg_ctl.exe") -D $DataDir stop -m fast
    }
    "start" {
        $statusOutput = & (Join-Path $PgBin "pg_ctl.exe") -D $DataDir status 2>&1
        if ($LASTEXITCODE -ne 0) {
            Remove-Item (Join-Path $DataDir "postmaster.pid") -Force -ErrorAction SilentlyContinue
            & (Join-Path $PgBin "pg_ctl.exe") -D $DataDir -l $LogFile -o "-p $Port -h 127.0.0.1" start
            if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed" }
        }
        $env:PGPASSWORD = "cloak_dev_pass_2026"
        $dbExists = & (Join-Path $PgBin "psql.exe") -h 127.0.0.1 -p $Port -U cloak -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='cloak_dev';"
        if ($dbExists -ne "1") {
            & (Join-Path $PgBin "createdb.exe") -h 127.0.0.1 -p $Port -U cloak cloak_dev
        }
        Write-Host "PostgreSQL dev cluster ready on 127.0.0.1:$Port (db=cloak_dev)"
    }
}

