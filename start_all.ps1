# Start CUE + Uno serial bridge + frontend together
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"

Write-Host "Starting CUE unified stack from $Root" -ForegroundColor Cyan

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd `"$Backend`"; `$env:PYTHONUNBUFFERED=1; python manage.py runserver 127.0.0.1:8000"
) | Out-Null

Start-Sleep -Seconds 3

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd `"$Backend`"; `$env:PYTHONUNBUFFERED=1; python manage.py listen_uno --port COM10"
) | Out-Null

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd `"$Frontend\templates`"; python -m http.server 5500"
) | Out-Null

Write-Host ""
Write-Host "Backend API:  http://127.0.0.1:8000/api/docs/" -ForegroundColor Green
Write-Host "Frontend UI:  http://127.0.0.1:5500/login.html" -ForegroundColor Green
Write-Host "Uno bridge:   listen_uno on COM10 (device UNO-KIT-001)" -ForegroundColor Green
Write-Host "Firmware:     IOT\firmware (pio run -e uno -t upload)" -ForegroundColor Yellow
