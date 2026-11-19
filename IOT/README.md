# CUE IOT

All IoT code for this Flow project lives here.

```
IOT/
  firmware/     Arduino Uno (S1/S2 + valve) — PlatformIO
  backend/      Django demo + API + serial bridge
```

## How the backend connects to the kit

```
Arduino Uno (COM10, 9600 baud)
        │  USB serial lines: Inlet/Outlet, LEARN, LEAK_ALERT, ESTIMATE, ACK
        ▼
python manage.py listen_serial --port COM10
        │  parses lines → SystemState / FlowReading / LeakEvent
        │  sends host commands: RESET, CLOSE, CALIBRATE, STATUS
        ▼
Django API  (http://127.0.0.1:8000)
        │  Frontend: /api/*
        │  Hardware: /iot/*  (ESP8266 / WiFi kit POST readings)
        ▼
Demo UI     http://127.0.0.1:8000/
```

Serial settings are in `backend/.env`:

```
SERIAL_PORT=COM10
SERIAL_BAUD=9600
```

`platformio.ini` uses the same port for upload/monitor.

## 1. Flash firmware

```powershell
cd IOT\firmware
pio run -e uno -t upload
```

## 2. Run backend + serial bridge (two terminals)

```powershell
cd IOT\backend
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 127.0.0.1:8000
```

```powershell
cd IOT\backend
python manage.py listen_serial --port COM10
```

Open http://127.0.0.1:8000/ — live S1/S2, AI learn mode, leak locus estimate.

## Commands (backend → Arduino)

| Command    | Effect                          |
|------------|---------------------------------|
| RESET      | Open valve, resume monitoring   |
| CLOSE      | Close valve                     |
| CALIBRATE  | Clear learned S1/S2 pattern     |
| STATUS     | Ask firmware for STATUS line    |

## Hardware endpoints (Arduino / ESP8266 → Django)

Different from frontend `/api/*`. Use these from WiFi/ESP boards:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/iot/readings/` | Submit water flow reading |
| POST | `/iot/readings/bulk/` | Submit multiple readings |
| POST | `/iot/sensors/{id}/readings/` | Reading for sensor `s1` / `s2` / `kit` (or numeric id) |
| GET | `/iot/sensors/{id}/configuration/` | Pull sensor config + pending command |

```powershell
# Single reading
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:8000/iot/readings/ `
  -ContentType application/json `
  -Body '{"inlet_lpm":12.5,"outlet_lpm":11.8,"valve_open":true,"device_id":"esp-01"}'

# Bulk
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:8000/iot/readings/bulk/ `
  -ContentType application/json `
  -Body '{"device_id":"esp-01","readings":[{"inlet_lpm":12.4,"outlet_lpm":12.1},{"inlet_lpm":12.6,"outlet_lpm":12.0}]}'

# Per-sensor
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:8000/iot/sensors/kit/readings/ `
  -ContentType application/json `
  -Body '{"inlet_lpm":12.5,"outlet_lpm":11.8,"valve_open":true}'

# Config (also returns pending_command for the device)
Invoke-RestMethod http://127.0.0.1:8000/iot/sensors/kit/configuration/
```

Default sensors: `s1` (inlet), `s2` (outlet), `kit` (S1+S2 pair).

## Frontend APIs (dashboard)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/status/` | Live state + AI + locus |
| GET | `/api/readings/?limit=100` | History |
| GET | `/api/events/` | Leak events |
| POST | `/api/command/` | Queue RESET/CLOSE/CALIBRATE/STATUS |
| POST | `/api/ingest/` | Legacy HTTP ingest (same idea as `/iot/readings/`) |
