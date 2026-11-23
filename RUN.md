# Run CUE as one system

CUE monitors **liquid transport** (water, oil, and other pipe fluids) with the same differential flow / leak-locus algorithm.

```
cue-push/
  backend/              CUE Django API + DB (:8000)
  frontend/templates/   UI (:5500)
  IOT/firmware/         Arduino Uno code
  scripts/uno_agent/    USB bridge: COM10 → API → DB  (canonical)
```

## Data path (required)

```
Arduino Uno (COM10) → cue_uno_agent → POST /api/v1/iot/readings|heartbeat → Django DB → Dashboard
```

- Use **only** `scripts/uno_agent` as the bridge.
- Do **not** run `manage.py listen_uno` at the same time (COM port exclusive).
- Do **not** use `cue-backend\scripts\uno_agent` (disabled duplicate).

## Quick start (local)

```powershell
cd c:\Users\user\OneDrive\Documents\PlatformIO\Projects\cue-push

# First time (or after key rotation):
cd backend
python manage.py migrate
python manage.py provision_uno_agent --api-base "http://127.0.0.1:8000/api/v1" --port COM10 --write-config
cd ..

.\start_all.ps1
```

Or manually (3 processes):

```powershell
# 1 — API
cd backend
python manage.py runserver 127.0.0.1:8000

# 2 — Uno agent → DB
cd ..\scripts\uno_agent
python cue_uno_agent.py

# 3 — Frontend
cd ..\..\frontend\templates
python -m http.server 5500
```

- Landing: http://127.0.0.1:5500/
- Dashboard login: http://127.0.0.1:5500/login.html
- Credentials: `cueAdmin` / `CueAdmin@2026`
- Django admin: http://127.0.0.1:8000/admin/
- API docs: http://127.0.0.1:8000/api/docs/
- Kit device: `UNO-KIT-001` with sensors `S1` / `S2`
- Agent log: `scripts\uno_agent\uno_agent.log` (look for `OK /iot/readings/ -> 201`)
- Plug the Uno so Windows shows an Arduino COM port (prefers COM10; falls back to Arduino USB)

## Flash firmware (once)

```powershell
cd IOT\firmware
pio run -e uno -t upload
```

## Windows autostart (agent only)

```powershell
cd scripts\uno_agent
.\install_windows_autostart.ps1
```

## Multi-liquid guarantee

CUE’s differential leak algorithm is fluid-agnostic. Set `Pipeline.fluid_type` to one of:
`WATER`, `DIESEL`, `OIL_LIGHT`, `OIL_HEAVY`, `CHEMICAL_AQUEOUS`, `PROCESS_GENERIC`.

```powershell
cd backend
python manage.py simulate_liquid_scenarios
```

API catalog: `GET /api/v1/fluids/profiles/` (auth required).

**Guaranteed** when: compatible single-phase sensors, matched calibrated K-factor, inlet above arm threshold.  
**Not guaranteed:** multiphase/gas, YF-S201 on fuel/chemicals, one sensor offline.

## Hosted cloud (optional, after local works)

1. Provision a cloud device key on the hosted API.
2. Add a second `targets[]` entry in `scripts/uno_agent/config.json` with that `api_base` + `api_key`.
3. Keep `local` enabled first so the local DB always stays in sync.
