"""Parse Arduino serial telemetry into SystemState + FlowReading."""

from __future__ import annotations

import re

from django.db.models import F
from django.utils import timezone

from iot.models import FlowHistoryMean, FlowReading, SystemState
from iot.services.history import record_sample, reset_window
from iot.services.localize import estimate_break
from iot.services.units import FLOW_NOISE_LPM, gate_flow_lpm

FLOW_PATTERN = re.compile(
    r"Inlet \(S1\):\s*(?P<inlet>[-+]?\d*\.?\d+)\s*L/min\s*\|\s*"
    r"Outlet \(S2\):\s*(?P<outlet>[-+]?\d*\.?\d+)\s*L/min",
    re.IGNORECASE,
)
DV_PATTERN = re.compile(
    r"dV_in:(?P<din>[-+]?\d*\.?\d+)mL\s+dV_out:(?P<dout>[-+]?\d*\.?\d+)mL",
    re.I,
)
BIAS_PATTERN = re.compile(r"bias:\s*(?P<bias>[-+]?\d*\.?\d+)", re.I)
LEARN_PATTERN = re.compile(
    r"learn\s+(?P<n>\d+)\s*/\s*(?P<need>\d+)\s+(?P<mode>READY|TRAIN)",
    re.I,
)
ESTIMATE_PATTERN = re.compile(
    r"^ESTIMATE:(?P<s1>[-+]?\d*\.?\d+):(?P<s2>[-+]?\d*\.?\d+):(?P<sev>[-+]?\d*\.?\d+):(?P<length>[-+]?\d*\.?\d+)"
    r"(?::(?P<loss>[-+]?\d*\.?\d+):(?P<qin>[-+]?\d*\.?\d+):(?P<qout>[-+]?\d*\.?\d+):(?P<band>\d+))?\s*$"
)
MAX_READINGS = 3000


def mark_serial_connected(connected: bool = True) -> None:
    SystemState.objects.update_or_create(pk=1, defaults={"serial_connected": connected})


def _prune() -> None:
    ids = list(
        FlowReading.objects.order_by("-recorded_at").values_list("id", flat=True)[
            MAX_READINGS : MAX_READINGS + 200
        ]
    )
    if ids:
        FlowReading.objects.filter(id__in=ids).delete()


def update_from_serial_line(line: str) -> None:
    text = line.strip()
    SystemState.get_solo()

    est = ESTIMATE_PATTERN.match(text)
    if est:
        s1 = float(est.group("s1"))
        s2 = float(est.group("s2"))
        sev = float(est.group("sev"))
        length = float(est.group("length"))
        band_map = {"1": "near inlet (S1)", "2": "mid-segment", "3": "toward outlet (S2)"}
        band = band_map.get(est.group("band") or "", "band from measured loss")
        if est.group("loss") and est.group("qin") and est.group("qout"):
            loss = float(est.group("loss"))
            qin = float(est.group("qin"))
            qout = float(est.group("qout"))
            summary = (
                f"Measured Qin {qin:.2f} L/min, Qout {qout:.2f} L/min, loss {loss:.2f} L/min. "
                f"Likely {band}: ~{s1:.0f} m from S1 (~{s2:.0f} m from S2) "
                f"on a {length:.0f} m run. Units L/min only."
            )
        else:
            summary = (
                f"Measured-loss locus ~{s1:.0f} m from S1 (~{s2:.0f} m from S2) "
                f"on a {length:.0f} m run (severity {sev:.0f}%). Units L/min only."
            )
        SystemState.objects.filter(pk=1).update(
            last_serial_line=text[:255],
            serial_connected=True,
            estimate_from_s1_m=s1,
            estimate_from_s2_m=s2,
            estimate_severity_pct=sev,
            estimate_summary=summary[:255],
            pipe_length_m=length,
            ai_mode="TRIPPED",
        )
        return

    if text.startswith("AI: pattern ready"):
        SystemState.objects.filter(pk=1).update(
            last_serial_line=text[:255],
            serial_connected=True,
            ai_mode="READY",
        )
        return

    match = FLOW_PATTERN.search(text)
    if match:
        # Gate chatter. Volume ONLY from pulse dV_mL — never integrate L/min (that invented litres).
        inlet = gate_flow_lpm(float(match.group("inlet")))
        outlet = gate_flow_lpm(float(match.group("outlet")))
        loss = round(inlet - outlet, 3)
        din_ml = 0.0
        dout_ml = 0.0
        dv = DV_PATTERN.search(text)
        if dv:
            din_ml = max(float(dv.group("din")), 0.0)
            dout_ml = max(float(dv.group("dout")), 0.0)
            # Ignore tiny single-chatter residues under ~1 pulse (~2.2 mL)
            if din_ml < 4.0:
                din_ml = 0.0
            if dout_ml < 4.0:
                dout_ml = 0.0

        fields = {
            "last_serial_line": text[:255],
            "serial_connected": True,
            "inlet_lpm": inlet,
            "outlet_lpm": outlet,
            "monitoring": True,
        }
        flowing = din_ml > 0.0 or dout_ml > 0.0 or inlet >= FLOW_NOISE_LPM or outlet >= FLOW_NOISE_LPM
        if din_ml > 0.0:
            fields["inlet_liters_total"] = F("inlet_liters_total") + (din_ml / 1000.0)
        if dout_ml > 0.0:
            fields["outlet_liters_total"] = F("outlet_liters_total") + (dout_ml / 1000.0)

        bias_m = BIAS_PATTERN.search(text)
        if bias_m:
            fields["learned_bias"] = float(bias_m.group("bias"))
        learn_m = LEARN_PATTERN.search(text)
        if learn_m:
            fields["learn_samples"] = int(learn_m.group("n"))
            fields["ai_mode"] = "READY" if learn_m.group("mode").upper() == "READY" else "LEARNING"

        locus = estimate_break(inlet, outlet)
        if locus.get("available"):
            fields["estimate_from_s1_m"] = locus["distance_from_s1_m"]
            fields["estimate_from_s2_m"] = locus["distance_from_s2_m"]
            fields["estimate_severity_pct"] = locus["severity_pct"]
            fields["estimate_summary"] = locus["summary"][:255]
        else:
            fields["estimate_from_s1_m"] = None
            fields["estimate_from_s2_m"] = None
            fields["estimate_severity_pct"] = None
            fields["estimate_summary"] = (
                "Idle — volume counts pulse mL only (not L/min)"
                if not flowing
                else (locus.get("summary") or "")
            )
        SystemState.objects.filter(pk=1).update(**fields)

        if din_ml > 0.0 or dout_ml > 0.0:
            valve_open = (
                SystemState.objects.filter(pk=1).values_list("valve_open", flat=True).first()
            )
            reading = FlowReading.objects.create(
                inlet_lpm=round(inlet, 3),
                outlet_lpm=round(outlet, 3),
                loss_lpm=loss,
                delta_in_ml=round(din_ml, 2),
                delta_out_ml=round(dout_ml, 2),
                valve_open=bool(valve_open if valve_open is not None else True),
                source="serial",
                device_id="",
            )
            record_sample(inlet, outlet, delta_in_ml=din_ml, delta_out_ml=dout_ml)
            if reading.id % 100 == 0:
                _prune()
        return

    if text.startswith("LEAK_ALERT:"):
        SystemState.objects.filter(pk=1).update(
            last_serial_line=text[:255],
            serial_connected=True,
            valve_open=False,
            monitoring=False,
            ai_mode="TRIPPED",
        )
        return

    if text.startswith("ACK:RESET") or ("System Active" in text and "OPEN" in text):
        # Clear live totals / open valve — do NOT wipe learned AI pattern.
        fields = {
            "last_serial_line": text[:255],
            "serial_connected": True,
            "valve_open": True,
            "monitoring": True,
            "inlet_lpm": 0.0,
            "outlet_lpm": 0.0,
            "inlet_liters_total": 0.0,
            "outlet_liters_total": 0.0,
            "estimate_from_s1_m": None,
            "estimate_from_s2_m": None,
            "estimate_severity_pct": None,
                "estimate_summary": "Restarted — AI pattern kept, waiting for flow",
        }
        if text.startswith("ACK:RESET"):
            fields["last_command_result"] = "RESET"
            fields["pending_command"] = ""
        SystemState.objects.filter(pk=1).update(**fields)
        reset_window()
        return

    if text.startswith("ACK:VALVE_CLOSED"):
        SystemState.objects.filter(pk=1).update(
            last_serial_line=text[:255],
            serial_connected=True,
            valve_open=False,
            monitoring=False,
            last_command_result="CLOSE",
            pending_command="",
        )
        return

    if text.startswith("ACK:CALIBRATE"):
        # Pattern wipe disabled — ignore host calibrate, keep learning.
        SystemState.objects.filter(pk=1).update(
            last_serial_line="CALIBRATE ignored — AI keeps improving",
            serial_connected=True,
            pending_command="",
            last_command_result="CALIBRATE_IGNORED",
        )
        return

    SystemState.objects.filter(pk=1).update(
        last_serial_line=text[:255],
        serial_connected=True,
    )


def queue_command(command: str) -> SystemState:
    cmd = command.strip().upper()
    SystemState.get_solo()
    fields = {
        "pending_command": cmd,
        "last_command_at": timezone.now(),
        "last_command_result": cmd,
    }
    # Restart clears live totals + opens valve. Learned AI pattern is kept.
    if cmd in {"RESET", "RESTART", "UNLOCK"}:
        fields.update(
            {
                "valve_open": True,
                "monitoring": True,
                "inlet_lpm": 0.0,
                "outlet_lpm": 0.0,
                "inlet_liters_total": 0.0,
                "outlet_liters_total": 0.0,
                "estimate_from_s1_m": None,
                "estimate_from_s2_m": None,
                "estimate_severity_pct": None,
                "estimate_summary": "Restarted — totals cleared, valve OPEN (AI pattern kept)",
                "last_serial_line": "RESET queued: clear values + open valve (keep AI)",
            }
        )
        reset_window()
    elif cmd == "CLOSE":
        fields.update({"valve_open": False, "monitoring": False})
    SystemState.objects.filter(pk=1).update(**fields)
    return SystemState.get_solo()
