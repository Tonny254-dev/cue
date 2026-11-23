# Start CUE as one system: API + Uno agent (COM10 → DB) + frontend
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend\templates"
$AgentDir = Join-Path $Root "scripts\uno_agent"
$Agent = Join-Path $AgentDir "cue_uno_agent.py"
$Config = Join-Path $AgentDir "config.json"
$Py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $Py) { $Py = "C:\Users\user\AppData\Local\Programs\Python\Python311\python.exe" }

Write-Host "Starting CUE unified stack from $Root" -ForegroundColor Cyan

# Stop competing bridges / old servers on our ports
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'listen_uno|cue_uno_agent|http.server 5500|manage.py runserver 127.0.0.1:8000'
} | ForEach-Object {
  Write-Host "Stopping PID $($_.ProcessId)" -ForegroundColor Yellow
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

if (-not (Test-Path $Config)) {
  Write-Host "No agent config — provisioning UNO-KIT-001…" -ForegroundColor Yellow
  Push-Location $Backend
  & $Py manage.py migrate --noinput
  & $Py manage.py provision_uno_agent --api-base "http://127.0.0.1:8000/api/v1" --port COM10 --write-config
  Pop-Location
}

# 1 — API (Daphne ASGI so Django Channels WebSockets work)
Start-Process -FilePath $Py -ArgumentList @("-m", "daphne", "-b", "127.0.0.1", "-p", "8000", "config.asgi:application") -WorkingDirectory $Backend -WindowStyle Minimized
Start-Sleep -Seconds 4

# 2 — Uno agent (single COM10 → Django DB). Do NOT also run listen_uno.
Start-Process -FilePath $Py -ArgumentList @($Agent) -WorkingDirectory $AgentDir -WindowStyle Minimized

# 3 — Frontend
Start-Process -FilePath $Py -ArgumentList @("-m", "http.server", "5500") -WorkingDirectory $Frontend -WindowStyle Minimized

Write-Host ""
Write-Host "Backend API:  http://127.0.0.1:8000/api/docs/" -ForegroundColor Green
Write-Host "Landing UI:   http://127.0.0.1:5500/" -ForegroundColor Green
Write-Host "Login:        http://127.0.0.1:5500/login.html" -ForegroundColor Green
Write-Host "Uno agent:    $Agent (COM10 → /api/v1/iot/* → DB)" -ForegroundColor Green
Write-Host "Agent log:    $(Join-Path $AgentDir 'uno_agent.log')" -ForegroundColor Green
Write-Host "Firmware:     IOT\firmware (pio run -e uno -t upload)" -ForegroundColor Yellow
