# CUE IOT backend

Django demo + REST API for the Arduino kit.

## Connect to firmware

1. Flash `../firmware` to the Uno (COM10).
2. Set `SERIAL_PORT` / `SERIAL_BAUD` in `.env` (defaults COM10 / 9600).
3. Run:

```powershell
python manage.py runserver 127.0.0.1:8000
python manage.py listen_serial --port COM10
```

Demo: http://127.0.0.1:8000/

See [`../README.md`](../README.md) for the full connection diagram and APIs.
