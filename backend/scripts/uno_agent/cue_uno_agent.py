#!/usr/bin/env python3
"""
CUE Uno Agent — USB bridge locked to COM10.

Posts the same kit telemetry to every configured API target
(e.g. Render cloud + localhost) so online and local dashboards stay in sync.
Never scans Bluetooth/AMT/other COM ports.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
import queue
import threading
from datetime import datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    print("pip install requests", file=sys.stderr)
    raise SystemExit(1)

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("pip install pyserial", file=sys.stderr)
    raise SystemExit(1)

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
LOG_PATH = HERE / "uno_agent.log"

FLOW_RE = re.compile(
    r"Inlet \(S1\):\s*(?P<inlet>[-+]?\d*\.?\d+)\s*L/min\s*\|\s*"
    r"Outlet \(S2\):\s*(?P<outlet>[-+]?\d*\.?\d+)\s*L/min",
    re.I,
)
DV_RE = re.compile(
    r"dV_in:(?P<din>[-+]?\d*\.?\d+)mL\s+dV_out:(?P<dout>[-+]?\d*\.?\d+)mL",
    re.I,
)
PULSE_RE = re.compile(r"pulses:(?P<p1>\d+)/(?P<p2>\d+)", re.I)
# Per-target cooldown (dead cloud must not freeze local live).
_target_backoff_until: dict[str, float] = {}
# Keep HTTP off the serial thread. Prefer local posts; drop oldest when full.
_HTTP_TIMEOUT = 3.0
_HTTP_TIMEOUT_REMOTE = 2.5
_http_q: queue.Queue = queue.Queue(maxsize=12)


def _http_worker() -> None:
    while True:
        item = _http_q.get()
        try:
            if item is None:
                return
            target, path, payload, timeout = item
            _post_one(target, path, payload, timeout)
        except Exception:
            log.exception("http worker error")
        finally:
            _http_q.task_done()


threading.Thread(target=_http_worker, name="cue-http", daemon=True).start()

# Instant browser path: agent → SSE :8765 (skips Django round-trip for the live number).
LIVE_SSE_PORT = 8765
_live_lock = threading.Lock()
_live_clients: list[queue.Queue] = []
_live_latest: dict[str, Any] = {
    "type": "flow",
    "inlet_lpm": 0.0,
    "outlet_lpm": 0.0,
    "flow_rate": 0.0,
    "timestamp": "",
}


def publish_live(inlet: Decimal | float, outlet: Decimal | float) -> None:
    """Push flow to every open EventSource client immediately."""
    payload = {
        "type": "flow",
        "inlet_lpm": float(inlet),
        "outlet_lpm": float(outlet),
        "flow_rate": float(max(float(inlet), float(outlet))),
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    raw = json.dumps(payload)
    with _live_lock:
        global _live_latest
        _live_latest = payload
        dead: list[queue.Queue] = []
        for q in _live_clients:
            try:
                q.put_nowait(raw)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(raw)
                except queue.Full:
                    dead.append(q)
        for q in dead:
            if q in _live_clients:
                _live_clients.remove(q)


class _LiveSSEHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] in ("/live", "/live/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self._cors()
            self.end_headers()
            q: queue.Queue = queue.Queue(maxsize=64)
            with _live_lock:
                _live_clients.append(q)
                latest = json.dumps(_live_latest)
            try:
                self.wfile.write(f"data: {latest}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        msg = q.get(timeout=12.0)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        continue
                    self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                with _live_lock:
                    if q in _live_clients:
                        _live_clients.remove(q)
            return
        if self.path.split("?", 1)[0] in ("/health", "/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            with _live_lock:
                body = json.dumps({"ok": True, "latest": _live_latest})
            self.wfile.write(body.encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()


def start_live_sse(port: int = LIVE_SSE_PORT) -> None:
    def _run() -> None:
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), _LiveSSEHandler)
            log.info("Live SSE on http://127.0.0.1:%s/live (instant UI path)", port)
            httpd.serve_forever()
        except OSError as exc:
            log.warning("Live SSE failed to bind :%s (%s) — UI will use REST only", port, exc)

    threading.Thread(target=_run, name="cue-live-sse", daemon=True).start()


LEAK_RE = re.compile(
    r"^LEAK_ALERT:(?P<zone>[A-Za-z0-9_]+):(?P<inlet>[-+]?\d*\.?\d+):(?P<outlet>[-+]?\d*\.?\d+)\s*$"
)
ESTIMATE_RE = re.compile(
    r"^ESTIMATE:(?P<s1>[-+]?\d*\.?\d+):(?P<s2>[-+]?\d*\.?\d+):(?P<sev>[-+]?\d*\.?\d+)"
    r":(?P<length>[-+]?\d*\.?\d+):(?P<loss>[-+]?\d*\.?\d+)"
    r":(?P<qin>[-+]?\d*\.?\d+):(?P<qout>[-+]?\d*\.?\d+):(?P<band>\d+)\s*$"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("cue_uno_agent")

# Per-target: None=unknown, True=disconnect API works, False=old server
_OFFLINE_API_OK: dict[str, bool | None] = {}


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        example = HERE / "config.example.json"
        raise SystemExit(
            f"Missing {CONFIG_PATH}. Copy {example.name} -> config.json and fill targets."
        )
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))

    targets: list[dict[str, Any]] = []
    if isinstance(raw.get("targets"), list) and raw["targets"]:
        for t in raw["targets"]:
            if not t.get("enabled", True):
                continue
            if not t.get("api_base") or not t.get("api_key") or not t.get("device_id"):
                raise SystemExit("Each enabled targets[] entry needs api_base, device_id, api_key")
            # Skip placeholder / broken cloud configs
            base = str(t["api_base"]).rstrip("/")
            key = str(t["api_key"])
            if "YOUR_SERVICE" in base or key.startswith("PASTE_"):
                log.warning("Skipping placeholder target %s (%s)", t.get("name"), base)
                continue
            targets.append(
                {
                    "name": t.get("name") or base,
                    "api_base": base,
                    "device_id": t["device_id"],
                    "api_key": key,
                    "valve_id": int(t.get("valve_id") or raw.get("valve_id") or 1),
                    "enabled": True,
                }
            )
    else:
        if not raw.get("api_base") or not raw.get("api_key") or not raw.get("device_id"):
            raise SystemExit("config.json needs api_base/device_id/api_key or targets[]")
        targets.append(
            {
                "name": "primary",
                "api_base": str(raw["api_base"]).rstrip("/"),
                "device_id": raw["device_id"],
                "api_key": raw["api_key"],
                "valve_id": int(raw.get("valve_id") or 1),
                "enabled": True,
            }
        )

    cfg = {
        "port": (raw.get("port") or "COM10").strip() or "COM10",
        "baud": int(raw.get("baud") or 9600),
        "sensor_inlet": raw.get("sensor_inlet") or "S1",
        "sensor_outlet": raw.get("sensor_outlet") or "S2",
        "scan_interval_sec": float(raw.get("scan_interval_sec") or 2),
        "targets": [t for t in targets if t.get("enabled", True)],
        "_valve_id": int(raw.get("valve_id") or 1),
    }
    if not cfg["targets"]:
        raise SystemExit("No enabled API targets in config.json")
    return cfg


def headers(target: dict) -> dict:
    return {
        "Content-Type": "application/json",
        "X-Device-Id": target["device_id"],
        "X-Api-Key": target["api_key"],
    }


def port_present(port: str) -> bool:
    want = port.upper().strip()
    for p in list_ports.comports():
        if (p.device or "").upper() == want:
            return True
    return False


def probe_port(port: str, baud: int, timeout: float = 2.0) -> bool:
    try:
        with serial.Serial(port, baud, timeout=0.3) as ser:
            deadline = time.time() + timeout
            while time.time() < deadline:
                raw = ser.readline()
                if not raw:
                    continue
                text = raw.decode("utf-8", errors="replace")
                if FLOW_RE.search(text) or "S1" in text or "Inlet" in text or "CUE" in text.upper():
                    return True
            return True
    except Exception:
        return False


def find_uno_port(cfg: dict) -> str | None:
    """Prefer configured port (COM10); if missing, fall back to an Arduino USB device."""
    forced = (cfg.get("port") or "COM10").strip() or "COM10"
    if port_present(forced):
        log.info("Using configured port %s", forced)
        return forced

    log.info("Configured port %s not present — scanning for Arduino…", forced)
    for p in list_ports.comports():
        desc = f"{p.description or ''} {p.manufacturer or ''} {p.product or ''}".lower()
        # Skip Bluetooth / Intel AMT
        if "bluetooth" in desc or "standard serial over bluetooth" in desc:
            continue
        if "amt" in desc or "active management" in desc or "sol" == (p.description or "").lower():
            continue
        if "arduino" in desc or "usb serial" in desc or "ch340" in desc or "wch" in desc:
            log.info("Using Arduino port %s (%s)", p.device, p.description)
            return p.device
    return None


def _target_key(target: dict) -> str:
    return str(target.get("api_base") or target.get("name") or "")


def _target_cooling(target: dict) -> bool:
    return time.time() < _target_backoff_until.get(_target_key(target), 0.0)


def _cool_target(target: dict, seconds: float, reason: str) -> None:
    until = time.time() + seconds
    _target_backoff_until[_target_key(target)] = until
    log.warning(
        "[%s] cooling %.0fs (%s) — other targets keep running",
        target.get("name"),
        seconds,
        reason,
    )


def _is_local_target(target: dict) -> bool:
    base = str(target.get("api_base") or "")
    return "127.0.0.1" in base or "localhost" in base


def _timeout_for(target: dict) -> float:
    return _HTTP_TIMEOUT if _is_local_target(target) else _HTTP_TIMEOUT_REMOTE


def _post_one(
    target: dict, path: str, payload: dict, timeout: float | None = None
) -> requests.Response | None:
    if _target_cooling(target):
        return None
    if timeout is None:
        timeout = _timeout_for(target)
    url = target["api_base"] + path
    try:
        r = requests.post(url, headers=headers(target), json=payload, timeout=timeout)
        if r.status_code == 429:
            wait = 30.0
            try:
                detail = r.json().get("message") or ""
                m = re.search(r"available in (\d+)", detail)
                if m:
                    wait = min(float(m.group(1)), 60.0)
            except Exception:
                pass
            _cool_target(target, wait, "429")
        elif r.status_code >= 400:
            log.warning(
                "[%s] POST %s -> %s %s",
                target["name"],
                path,
                r.status_code,
                r.text[:160],
            )
        elif (
            "/iot/readings/" in path
            or "/iot/readings/bulk/" in path
            or "/iot/heartbeat/" in path
        ):
            log.info("[%s] OK %s -> %s", target["name"], path, r.status_code)
        return r
    except Exception as exc:
        # Don't let a slow cloud host freeze the kit / local UI.
        _cool_target(target, 45.0 if not _is_local_target(target) else 5.0, str(exc)[:80])
        return None


def _post_one_async(
    target: dict, path: str, payload: dict, timeout: float | None = None
) -> None:
    if _target_cooling(target):
        return
    if timeout is None:
        timeout = _timeout_for(target)
    item = (target, path, payload, timeout)
    # Prefer not dropping local posts when the queue is full of remote work.
    try:
        _http_q.put_nowait(item)
        return
    except queue.Full:
        pass
    try:
        old = _http_q.get_nowait()
        _http_q.task_done()
        # If we dropped a local item to make room for remote, put local back.
        if _is_local_target(old[0]) and not _is_local_target(target):
            try:
                _http_q.put_nowait(old)
                return
            except queue.Full:
                pass
    except queue.Empty:
        pass
    try:
        _http_q.put_nowait(item)
    except queue.Full:
        log.warning("HTTP queue full — dropping %s %s", target.get("name"), path)


def _get_one(
    target: dict, path: str, timeout: float | None = None
) -> requests.Response | None:
    if _target_cooling(target):
        return None
    if timeout is None:
        timeout = _timeout_for(target)
    url = target["api_base"] + path
    try:
        r = requests.get(url, headers=headers(target), timeout=timeout)
        if r.status_code >= 400:
            log.warning(
                "[%s] GET %s -> %s %s",
                target["name"],
                path,
                r.status_code,
                r.text[:160],
            )
        return r
    except Exception as exc:
        _cool_target(target, 45.0 if not _is_local_target(target) else 5.0, str(exc)[:80])
        return None


def fanout_post(
    cfg: dict, path: str, payload: dict, timeout: float = _HTTP_TIMEOUT
) -> None:
    for target in cfg["targets"]:
        _post_one_async(target, path, payload, timeout)


def post_reading(
    cfg: dict, sensor_id: str, flow: Decimal, volume: Decimal, pulse: int
) -> None:
    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for target in cfg["targets"]:
        payload = {
            "device_id": target["device_id"],
            "sensor_id": sensor_id,
            "flow_rate": str(flow),
            "volume": str(volume),
            "pulse_count": pulse,
            "timestamp": ts,
        }
        _post_one_async(target, "/iot/readings/", payload, _HTTP_TIMEOUT)


def post_kit_pair(
    cfg: dict,
    inlet: Decimal,
    outlet: Decimal,
    vol_in: Decimal,
    vol_out: Decimal,
    p1: int,
    p2: int,
) -> None:
    """Instant SSE to UI + one bulk POST to API (DB) per sample."""
    publish_live(inlet, outlet)
    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for target in cfg["targets"]:
        payload = {
            "readings": [
                {
                    "device_id": target["device_id"],
                    "sensor_id": cfg["sensor_inlet"],
                    "flow_rate": str(inlet),
                    "volume": str(vol_in),
                    "pulse_count": p1,
                    "timestamp": ts,
                },
                {
                    "device_id": target["device_id"],
                    "sensor_id": cfg["sensor_outlet"],
                    "flow_rate": str(outlet),
                    "volume": str(vol_out),
                    "pulse_count": p2,
                    "timestamp": ts,
                },
            ]
        }
        _post_one_async(target, "/iot/readings/bulk/", payload, _HTTP_TIMEOUT)


def post_warning(cfg: dict, title: str, message: str, severity: str = "CRITICAL") -> None:
    fanout_post(
        cfg,
        "/iot/devices/warnings/",
        {"title": title, "message": message, "severity": severity},
    )


def report_valve_status(cfg: dict, status: str) -> None:
    status = status.upper().strip()
    if status not in {"OPEN", "CLOSED"}:
        return
    for target in cfg["targets"]:
        vid = int(target.get("valve_id") or cfg.get("_valve_id") or 1)
        cfg["_valve_id"] = vid
        _post_one(target, f"/iot/valves/{vid}/status/", {"status": status})


def report_offline(cfg: dict, note: str = "COM port disconnected") -> None:
    """Mark kit offline on every target that supports disconnect heartbeats."""
    for target in cfg["targets"]:
        key = target["api_base"]
        if _OFFLINE_API_OK.get(key) is False:
            continue
        r = _post_one(
            target,
            "/iot/heartbeat/",
            {
                "device_id": target["device_id"],
                "status": "DISCONNECTED",
                "firmware_version": "uno-agent",
            },
        )
        if r is None:
            continue
        try:
            body = r.json() if r.content else {}
            conn = (body.get("data") or {}).get("connection_status")
            if conn == "DISCONNECTED" or "Disconnect" in (body.get("message") or ""):
                _OFFLINE_API_OK[key] = True
                _post_one(
                    target,
                    "/iot/devices/status/",
                    {"status": "DISCONNECTED", "note": note},
                )
                log.info("[%s] Reported OFFLINE (%s)", target["name"], note)
                continue
        except Exception:
            pass
        _OFFLINE_API_OK[key] = False
        log.warning(
            "[%s] disconnect heartbeat not supported yet — relying on timeout (%s)",
            target["name"],
            note,
        )


def heartbeat_ok(cfg: dict) -> None:
    for target in cfg["targets"]:
        _post_one_async(
            target,
            "/iot/heartbeat/",
            {
                "device_id": target["device_id"],
                "status": "OK",
                "firmware_version": "uno-agent",
            },
        )


def poll_valve_commands(cfg: dict, ser: serial.Serial) -> None:
    """Pull pending commands; poll local first and skip cooling remotes on the serial thread."""
    seen: set[Any] = set()
    ordered = sorted(cfg["targets"], key=lambda t: 0 if _is_local_target(t) else 1)
    for target in ordered:
        # Never block USB/serial on a slow cloud round-trip.
        if not _is_local_target(target) and _target_cooling(target):
            continue
        timeout = 1.5 if _is_local_target(target) else 2.0
        r = _get_one(target, "/iot/commands/pending/", timeout=timeout)
        if r is None or r.status_code >= 400:
            continue
        try:
            body = r.json()
        except Exception:
            continue
        data = body.get("data") or body
        cmds = (data or {}).get("commands") or []
        for cmd in cmds:
            cid = cmd.get("id")
            action = (cmd.get("command_type") or "").upper()
            if not cid or cid in seen or action not in {"CLOSE", "OPEN"}:
                continue
            seen.add(cid)
            if cmd.get("valve_id"):
                cfg["_valve_id"] = int(cmd["valve_id"])
            _post_one(target, f"/iot/commands/{cid}/acknowledge/", {})
            line = "CLOSE" if action == "CLOSE" else "RESET"
            try:
                ser.write((line + "\r\n").encode())
                ser.flush()
                log.info("[%s] TX %s (command %s)", target["name"], line, cid)
            except Exception:
                log.exception("serial TX failed for command %s", cid)
                _post_one(
                    target,
                    f"/iot/commands/{cid}/execute/",
                    {"success": False, "message": "Serial write failed"},
                )
                continue
            ok = False
            for _ in range(2):
                resp = _post_one(
                    target,
                    f"/iot/commands/{cid}/execute/",
                    {"success": True, "message": f"Sent {line} to Uno"},
                )
                if resp is not None and resp.status_code < 400:
                    ok = True
                    break
                time.sleep(1.2)
            if ok:
                report_valve_status(cfg, "CLOSED" if action == "CLOSE" else "OPEN")
            else:
                log.error("execute confirm failed for command %s", cid)


def session_on_port(cfg: dict, port: str) -> None:
    baud = int(cfg["baud"])
    vol_in = Decimal("0")
    vol_out = Decimal("0")
    pulse = 0
    pending_leak = None
    pending_estimate = None
    last_cmd_poll = 0.0
    last_heartbeat = 0.0

    with serial.Serial(port, baud, timeout=0.25) as ser:
        names = ", ".join(t["name"] for t in cfg["targets"])
        log.info("Connected %s @ %s — streaming to: %s", port, baud, names)
        heartbeat_ok(cfg)
        last_heartbeat = time.time()

        while True:
            now = time.time()
            if now - last_heartbeat >= 25.0:
                heartbeat_ok(cfg)
                last_heartbeat = now
            if now - last_cmd_poll > 5.0:
                poll_valve_commands(cfg, ser)
                last_cmd_poll = now

            raw = ser.readline()
            if not raw:
                continue
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            log.info("SERIAL: %s", text.encode("ascii", "replace").decode("ascii"))

            up = text.upper()
            if "ACK:RESET" in up or "WATER VALVE OPEN" in up or up.endswith("VALVE OPEN"):
                report_valve_status(cfg, "OPEN")
            elif "ACK:VALVE_CLOSED" in up or "WATER VALVE CLOSED" in up or "VALVE_CLOSED" in up:
                report_valve_status(cfg, "CLOSED")

            est = ESTIMATE_RE.match(text)
            if est:
                pending_estimate = est.groupdict()
                if pending_leak:
                    msg = (
                        f"Zone {pending_leak['zone']} inlet={pending_leak['inlet']} "
                        f"outlet={pending_leak['outlet']} estimate={pending_estimate}"
                    )
                    post_warning(cfg, "LEAK_ALERT from Uno", msg, "CRITICAL")
                    pending_leak = None
                    pending_estimate = None
                continue

            leak = LEAK_RE.match(text)
            if leak:
                pending_leak = {
                    "zone": leak.group("zone"),
                    "inlet": leak.group("inlet"),
                    "outlet": leak.group("outlet"),
                }
                continue

            m = FLOW_RE.search(text)
            if not m:
                if pending_leak and text.startswith("REPAIR:"):
                    post_warning(
                        cfg,
                        "LEAK_ALERT from Uno",
                        f"Zone {pending_leak['zone']} (no estimate)",
                        "CRITICAL",
                    )
                    pending_leak = None
                continue

            if pending_leak:
                post_warning(
                    cfg,
                    "LEAK_ALERT from Uno",
                    f"Zone {pending_leak['zone']} inlet={pending_leak['inlet']} "
                    f"outlet={pending_leak['outlet']}",
                    "CRITICAL",
                )
                pending_leak = None
                pending_estimate = None

            inlet = Decimal(m.group("inlet"))
            outlet = Decimal(m.group("outlet"))
            din = dout = Decimal("0")
            dv = DV_RE.search(text)
            if dv:
                din = Decimal(dv.group("din"))
                dout = Decimal(dv.group("dout"))
                if din < 4:
                    din = Decimal("0")
                if dout < 4:
                    dout = Decimal("0")
            vol_in += din / Decimal("1000")
            vol_out += dout / Decimal("1000")
            p1 = p2 = 0
            pr = PULSE_RE.search(text)
            if pr:
                p1 = int(pr.group("p1"))
                p2 = int(pr.group("p2"))
                pulse = max(pulse, p1 + p2)
            else:
                pulse += 1
            # Always post when there is flow or pulses; idle zeros at most every 5s.
            flowing = inlet > 0 or outlet > 0 or p1 > 0 or p2 > 0
            last_zero = getattr(session_on_port, "_last_zero_post", 0.0)
            if not flowing and (now - last_zero) < 5.0:
                continue
            if not flowing:
                session_on_port._last_zero_post = now  # type: ignore[attr-defined]
            try:
                post_kit_pair(
                    cfg, inlet, outlet, vol_in, vol_out, p1 or pulse, p2 or pulse
                )
            except Exception:
                log.exception("post readings failed — keep listening")


def main() -> None:
    cfg = load_config()
    preferred = cfg["port"]
    start_live_sse(LIVE_SSE_PORT)
    log.info(
        "CUE Uno Agent starting (prefer %s, Arduino USB fallback). Config=%s",
        preferred,
        CONFIG_PATH,
    )
    for t in cfg["targets"]:
        log.info("Target %-10s %s device=%s", t["name"], t["api_base"], t["device_id"])
    scan = float(cfg["scan_interval_sec"])
    was_online = False
    last_offline_post = 0.0

    while True:
        try:
            port = find_uno_port(cfg)
            if not port:
                now = time.time()
                if was_online or (now - last_offline_post) >= 30.0:
                    log.warning(
                        "No Uno on %s / Arduino USB — reporting OFFLINE", preferred
                    )
                    report_offline(cfg, f"{preferred} / Arduino not present")
                    last_offline_post = now
                    was_online = False
                else:
                    log.info(
                        "Waiting for %s or Arduino USB. Retry in %.0fs",
                        preferred,
                        scan,
                    )
                time.sleep(scan)
                continue
            try:
                was_online = True
                session_on_port(cfg, port)
            except serial.SerialException as exc:
                log.warning("%s disconnected (%s) — reporting OFFLINE", port, exc)
                report_offline(cfg, f"{port} disconnected: {exc}")
                was_online = False
                last_offline_post = time.time()
                time.sleep(scan)
            except KeyboardInterrupt:
                log.info("Stopped by user")
                break
        except KeyboardInterrupt:
            break
        except Exception:
            log.exception("agent loop error")
            time.sleep(scan)


if __name__ == "__main__":
    main()
