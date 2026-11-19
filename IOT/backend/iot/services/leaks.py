"""Handle LEAK_ALERT from firmware; SMS with leak locus pin-point."""

from __future__ import annotations

import json
import logging
import re
import threading
import time

import requests
from django.conf import settings

from iot.models import LeakEvent, SystemState
from iot.services.localize import estimate_break
from iot.services.sms_format import format_leak_sms
from iot.services.telemetry import update_from_serial_line

logger = logging.getLogger(__name__)

LEAK_PATTERN = re.compile(
    r"^LEAK_ALERT:(?P<zone>[A-Za-z0-9_]+):(?P<inlet>[-+]?\d*\.?\d+):(?P<outlet>[-+]?\d*\.?\d+)\s*$"
)


def _send_sms(message: str) -> list[dict]:
    key = settings.TEXTSMS_API_KEY
    partner = settings.TEXTSMS_PARTNER_ID
    phones = list(settings.ALERT_PHONES)
    if not key or not partner or not phones:
        return [{"ok": False, "error": "SMS not configured"}]
    results = []
    for phone in phones:
        mobile = "".join(ch for ch in str(phone) if ch.isdigit() or ch == "+")
        if mobile.startswith("+"):
            mobile = mobile[1:]
        if mobile.startswith("0"):
            mobile = "254" + mobile[1:]
        elif len(mobile) == 9 and mobile.startswith("7"):
            mobile = "254" + mobile
        try:
            resp = requests.post(
                settings.TEXTSMS_API_URL,
                json={
                    "apikey": key,
                    "partnerID": partner,
                    "message": message,
                    "shortcode": settings.TEXTSMS_SHORTCODE,
                    "mobile": mobile,
                },
                timeout=30,
            )
            data = resp.json() if resp.content else {}
            ok = resp.ok
            rows = data.get("responses") or []
            if rows:
                code = rows[0].get("respose-code") or rows[0].get("response-code")
                ok = ok and int(code) == 200
            results.append({"mobile": mobile, "ok": ok, "body": data})
        except Exception as exc:
            results.append({"mobile": mobile, "ok": False, "error": str(exc)})
    return results


def _build_locus(inlet: float, outlet: float, state: SystemState) -> dict:
    length = state.pipe_length_m or 50.0
    locus = estimate_break(inlet, outlet, length_m=length)
    # Firmware ESTIMATE (if already parsed) wins for pin metres.
    if state.estimate_from_s1_m is not None:
        locus = {
            **locus,
            "available": True,
            "distance_from_s1_m": state.estimate_from_s1_m,
            "distance_from_s2_m": state.estimate_from_s2_m,
            "severity_pct": state.estimate_severity_pct
            if state.estimate_severity_pct is not None
            else locus.get("severity_pct"),
            "summary": state.estimate_summary or locus.get("summary"),
        }
        if not locus.get("distance_from_s1_range_m") and state.estimate_from_s1_m is not None:
            half = max(length * 0.12, 2.0)
            mid = float(state.estimate_from_s1_m)
            locus["distance_from_s1_range_m"] = [
                max(mid - half, 0.0),
                min(mid + half, length),
            ]
            if mid / length <= 0.35:
                locus["band_label"] = "near inlet (S1)"
            elif mid / length >= 0.65:
                locus["band_label"] = "toward outlet (S2)"
            else:
                locus["band_label"] = "mid-segment"
    return locus


def handle_serial_line(line: str) -> LeakEvent | None:
    update_from_serial_line(line)
    match = LEAK_PATTERN.match(line.strip())
    if not match:
        return None

    zone = match.group("zone")
    inlet = float(match.group("inlet"))
    outlet = float(match.group("outlet"))
    state = SystemState.get_solo()
    locus = _build_locus(inlet, outlet, state)

    summary = locus.get("summary") or ""
    s1 = locus.get("distance_from_s1_m")
    s2 = locus.get("distance_from_s2_m")
    sev = locus.get("severity_pct")

    event = LeakEvent.objects.create(
        zone=zone,
        inlet_lpm=inlet,
        outlet_lpm=outlet,
        estimate_from_s1_m=s1,
        estimate_from_s2_m=s2,
        estimate_severity_pct=sev,
        estimate_summary=(summary or "")[:255],
        raw_line=line.strip()[:255],
        valve_closed=True,
        sms_sent=False,
        sms_response="sending",
    )
    SystemState.objects.filter(pk=1).update(
        valve_open=False,
        monitoring=False,
        inlet_lpm=inlet,
        outlet_lpm=outlet,
        ai_mode="TRIPPED",
        estimate_summary=(summary or "")[:255],
        estimate_from_s1_m=s1,
        estimate_from_s2_m=s2,
        estimate_severity_pct=sev,
    )

    def worker(event_id: int, zone_name: str, qin: float, qout: float):
        from django.db import close_old_connections

        close_old_connections()
        try:
            # Wait briefly so firmware ESTIMATE: line is parsed into SystemState.
            time.sleep(1.5)
            close_old_connections()
            state2 = SystemState.get_solo()
            locus2 = _build_locus(qin, qout, state2)
            msg = format_leak_sms(
                zone=zone_name,
                inlet=qin,
                outlet=qout,
                locus=locus2,
                from_s1_m=locus2.get("distance_from_s1_m"),
                from_s2_m=locus2.get("distance_from_s2_m"),
                severity_pct=locus2.get("severity_pct"),
                length_m=state2.pipe_length_m or 50.0,
            )
            LeakEvent.objects.filter(pk=event_id).update(
                estimate_from_s1_m=locus2.get("distance_from_s1_m"),
                estimate_from_s2_m=locus2.get("distance_from_s2_m"),
                estimate_severity_pct=locus2.get("severity_pct"),
                estimate_summary=(locus2.get("summary") or "")[:255],
            )
            results = _send_sms(msg)
            ok = any(r.get("ok") for r in results)
            LeakEvent.objects.filter(pk=event_id).update(
                sms_sent=ok,
                sms_response=json.dumps(
                    {"message": msg, "results": results},
                    default=str,
                ),
            )
        except Exception:
            logger.exception("SMS failed")
        finally:
            close_old_connections()

    threading.Thread(
        target=worker, args=(event.id, zone, inlet, outlet), daemon=True
    ).start()
    return event
