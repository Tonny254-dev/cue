# Run CUE as one system

```
cue-push/
  backend/     CUE Django API (:8000)
  frontend/    UI (:5500)
  IOT/firmware Arduino Uno code
```

## Connect kit

1. Plug Uno (COM10)
2. Flash once: `cd IOT\firmware && pio run -e uno -t upload`
3. Start everything:

```powershell
cd c:\Users\user\OneDrive\Documents\PlatformIO\Projects\cue-push
.\start_all.ps1
```

Or manually (3 terminals):

```powershell
# 1 — API
cd backend
python manage.py runserver 127.0.0.1:8000

# 2 — Uno bridge (writes into CUE DB)
cd backend
python manage.py listen_uno --port COM10

# 3 — Frontend
cd frontend\templates
python -m http.server 5500
```

- Landing (new CUE template, no auto-redirect): http://127.0.0.1:5500/
- Dashboard login: http://127.0.0.1:5500/login.html
- Django admin (only if you click Admin): http://127.0.0.1:8000/admin/
- Credentials: `admin` / `admin123`
- API docs: http://127.0.0.1:8000/api/docs/
- Kit device auto-created: `UNO-KIT-001` with sensors `S1` / `S2`
