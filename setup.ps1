# VaultCeaser setup script (Windows PowerShell)
# Run from the repo root: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $RepoDir "data"
$WebDir  = Join-Path $RepoDir "web"
$EnvFile = Join-Path $WebDir ".env"

Write-Host "=== VaultCeaser Setup ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoDir"

# 1. Create data dir
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Write-Host "[1/4] Created data/ at $DataDir" -ForegroundColor Green

# 2. Python backend deps
Write-Host "[2/4] Installing Python deps..." -ForegroundColor Yellow
pip install -r "$RepoDir\requirements.txt"
Write-Host "      Python deps done." -ForegroundColor Green

# 3. Node deps + build
# Clear npm cache first to free disk space, then install
Write-Host "[3/4] Clearing npm cache to free disk space..." -ForegroundColor Yellow
npm cache clean --force
Write-Host "[3/4] Installing Node deps..." -ForegroundColor Yellow
Set-Location $WebDir
npm install --no-audit --no-fund

Write-Host "[3/4] Building Next.js..." -ForegroundColor Yellow
$env:DATABASE_PATH = Join-Path $DataDir "db.sqlite"
$env:BACKEND_URL   = "http://localhost:8080"
if (-not $env:SESSION_SECRET) {
    # Generate a random 32-byte hex secret
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $env:SESSION_SECRET = [System.BitConverter]::ToString($bytes).Replace("-","").ToLower()
}
npm run build
Write-Host "      Next.js build done." -ForegroundColor Green

# 4. Init SQLite tables
Write-Host "[4/4] Creating database tables..." -ForegroundColor Yellow
npx drizzle-kit push
Write-Host "      Database ready at $($env:DATABASE_PATH)" -ForegroundColor Green

# Write .env if missing
if (-not (Test-Path $EnvFile)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [System.BitConverter]::ToString($bytes).Replace("-","").ToLower()
    @"
BACKEND_URL=http://localhost:8080
DATABASE_PATH=$DataDir\db.sqlite
SESSION_SECRET=$secret
"@ | Set-Content $EnvFile -Encoding UTF8
    Write-Host "Created $EnvFile" -ForegroundColor Green
} else {
    Write-Host "$EnvFile already exists, skipping." -ForegroundColor Gray
}

Set-Location $RepoDir

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host "Run: powershell -ExecutionPolicy Bypass -File start.ps1" -ForegroundColor White
