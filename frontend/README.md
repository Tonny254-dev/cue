# AquaPulse – Frontend

Frontend for **AquaPulse**, an IoT-based water monitoring, leak detection,
and automated valve control system.

> This repository contains the **frontend only**. Backend, database and
> ESP32 firmware are developed by other team members.

## Status

| Stage | Description                        | Status         |
|-------|------------------------------------|----------------|
| 1     | Project foundation, root, homepage | ✅ Done        |
| 2     | Authentication (login, forgot pw)  | ✅ Done        |
| 3     | Dashboard overview                 | ⏳ In progress |
| 4     | Monitoring & analytics             | ⏳ Pending     |
| 5     | Leak detection & valve control     | ⏳ Pending     |
| 6     | Notifications, reports, admin      | ⏳ Pending     |
| 7     | Backend API preparation            | ⏳ Pending     |
| 8     | Testing & refinement               | ⏳ Pending     |

## Run locally

Requires only a static file server (no build step).

```bash
# Option A – Node.js installed
npm start           # serves on http://localhost:5500

# Option B – Python installed
python3 -m http.server 5500

# Option C – VS Code
# Install "Live Server" extension → right-click index.html → Open with Live Server