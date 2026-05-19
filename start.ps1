# VaultCeaser start script (Windows PowerShell)
# Starts FastAPI backend + Next.js frontend in two windows.
# Run: powershell -ExecutionPolicy Bypass -File start.ps1

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WebDir  = Join-Path $RepoDir "web"
$EnvFile = Join-Path $WebDir ".env"

# Load .env
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match "^\s*([^#=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process")
        }
    }
}

if (-not $env:DATABASE_PATH) {
    $env:DATABASE_PATH = Join-Path $RepoDir "data\db.sqlite"
}
if (-not $env:BACKEND_URL) {
    $env:BACKEND_URL = "http://localhost:8080"
}

Write-Host "Starting FastAPI backend on :8080..." -ForegroundColor Yellow
$api = Start-Process -PassThru -FilePath "python" `
    -ArgumentList "server.py" `
    -WorkingDirectory $RepoDir `
    -WindowStyle Normal

Write-Host "Starting Next.js frontend on :3456..." -ForegroundColor Yellow
$web = Start-Process -PassThru -FilePath "cmd" `
    -ArgumentList "/c npm start" `
    -WorkingDirectory $WebDir `
    -WindowStyle Normal

Write-Host ""
Write-Host "Both services started." -ForegroundColor Cyan
Write-Host "  Backend PID:  $($api.Id)"
Write-Host "  Frontend PID: $($web.Id)"
Write-Host ""
Write-Host "Open: http://localhost:3456" -ForegroundColor Green
Write-Host "Press Enter to stop both services..."
Read-Host

Stop-Process -Id $api.Id -ErrorAction SilentlyContinue
Stop-Process -Id $web.Id -ErrorAction SilentlyContinue
Write-Host "Services stopped." -ForegroundColor Red
