"""Hardware endpoints: Arduino / ESP8266 → Django (separate from frontend /api/*)."""

from __future__ import annotations

import json
from typing import Any

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from iot.models import FlowReading, Sensor, SystemState
from iot.services.localize import estimate_break


def _json_body(request) -> dict[str, Any]:
    try:
        return json.loads(request.body.decode() or "{}")
    except json.JSONDecodeError:
        return {}


def _parse_reading(item: dict[str, Any]) -> tuple[float, float, bool] | JsonResponse:
    try:
        inlet = float(item["inlet_lpm"])
        outlet = float(item["outlet_lpm"])
    except (KeyError, TypeError, ValueError):
        return JsonResponse(
            {
                "success": False,
                "message": "Need inlet_lpm and outlet_lpm numbers",
            },
            status=400,
        )
    valve_open = bool(item.get("valve_open", True))
    return inlet, outlet, valve_open


def _apply_live_state(
    *,
    inlet: float,
    outlet: float,
    valve_open: bool,
    sensor: Sensor | None = None,
    device_id: str = "",
    raw_note: str = "",
) -> SystemState:
    loss = round(inlet - outlet, 3)
    note = raw_note or f"HW POST S1={inlet} S2={outlet}"
    if sensor:
        note = f"HW sensor={sensor.slug} S1={inlet} S2={outlet}"
        Sensor.objects.filter(pk=sensor.pk).update(
            last_seen_at=timezone.now(),
            last_inlet_lpm=inlet,
            last_outlet_lpm=outlet,
            online=True,
        )

    SystemState.objects.filter(pk=1).update(
        inlet_lpm=inlet,
        outlet_lpm=outlet,
        valve_open=valve_open,
        monitoring=valve_open,
        serial_connected=True,
        last_serial_line=note[:255],
    )
    if device_id:
        SystemState.objects.filter(pk=1).update(
            last_serial_line=f"{note} device={device_id}"[:255]
        )

    FlowReading.objects.create(
        inlet_lpm=round(inlet, 3),
        outlet_lpm=round(outlet, 3),
        loss_lpm=loss,
        valve_open=valve_open,
        sensor=sensor,
        source="http",
        device_id=(device_id or "")[:64],
    )

    state = SystemState.get_solo()
    est = estimate_break(inlet, outlet, length_m=state.pipe_length_m)
    if est.get("available"):
        SystemState.objects.filter(pk=1).update(
            estimate_from_s1_m=est["distance_from_s1_m"],
            estimate_from_s2_m=est["distance_from_s2_m"],
            estimate_severity_pct=est["severity_pct"],
            estimate_summary=est["summary"][:255],
        )
    else:
        SystemState.objects.filter(pk=1).update(
            estimate_from_s1_m=None,
            estimate_from_s2_m=None,
            estimate_severity_pct=None,
            estimate_summary=(est.get("summary") or "")[:255],
        )
    return SystemState.get_solo()


def _ensure_default_sensors() -> None:
    defaults = [
        ("s1", "Inlet S1", "inlet"),
        ("s2", "Outlet S2", "outlet"),
        ("kit", "Zone 1 kit (S1+S2 pair)", "pair"),
    ]
    for slug, name, role in defaults:
        Sensor.objects.get_or_create(
            slug=slug,
            defaults={
                "name": name,
                "role": role,
                "enabled": True,
                "sample_interval_sec": 1,
                "min_flow_arm_lpm": 2.0,
                "pipe_length_m": 50.0,
            },
        )


@csrf_exempt
@require_POST
def iot_readings(request):
    """POST /iot/readings/ — single water-flow reading from hardware."""
    body = _json_body(request)
    parsed = _parse_reading(body)
    if isinstance(parsed, JsonResponse):
        return parsed
    inlet, outlet, valve_open = parsed
    device_id = str(body.get("device_id") or body.get("device") or "")
    state = _apply_live_state(
        inlet=inlet,
        outlet=outlet,
        valve_open=valve_open,
        device_id=device_id,
    )
    return JsonResponse(
        {
            "success": True,
            "message": "Reading stored",
            "data": {
                "inlet_lpm": inlet,
                "outlet_lpm": outlet,
                "loss_lpm": round(inlet - outlet, 3),
                "pending_command": state.pending_command or None,
                "status": state.status,
            },
        },
        status=201,
    )


@csrf_exempt
@require_POST
def iot_readings_bulk(request):
    """POST /iot/readings/bulk/ — multiple readings in one request."""
    body = _json_body(request)
    items = body.get("readings")
    if not isinstance(items, list) or not items:
        return JsonResponse(
            {"success": False, "message": "Body needs readings: [ {...}, ... ]"},
            status=400,
        )
    if len(items) > 200:
        return JsonResponse(
            {"success": False, "message": "Max 200 readings per bulk request"},
            status=400,
        )

    device_id = str(body.get("device_id") or "")
    stored = 0
    last_state = SystemState.get_solo()
    for item in items:
        if not isinstance(item, dict):
            continue
        parsed = _parse_reading(item)
        if isinstance(parsed, JsonResponse):
            continue
        inlet, outlet, valve_open = parsed
        last_state = _apply_live_state(
            inlet=inlet,
            outlet=outlet,
            valve_open=valve_open,
            device_id=device_id or str(item.get("device_id") or ""),
            raw_note="HW BULK",
        )
        stored += 1

    if stored == 0:
        return JsonResponse(
            {"success": False, "message": "No valid readings in bulk payload"},
            status=400,
        )
    return JsonResponse(
        {
            "success": True,
            "message": f"Stored {stored} readings",
            "count": stored,
            "data": {
                "pending_command": last_state.pending_command or None,
                "status": last_state.status,
                "live": last_state.as_dict(),
            },
        },
        status=201,
    )


@csrf_exempt
@require_POST
def iot_sensor_readings(request, sensor_id: str):
    """POST /iot/sensors/{id}/readings/ — reading for a specific sensor."""
    _ensure_default_sensors()
    sensor = (
        Sensor.objects.filter(pk=sensor_id).first()
        if str(sensor_id).isdigit()
        else None
    )
    if sensor is None:
        sensor = get_object_or_404(Sensor, slug=sensor_id)

    if not sensor.enabled:
        return JsonResponse(
            {"success": False, "message": f"Sensor {sensor.slug} is disabled"},
            status=403,
        )

    body = _json_body(request)

    # Pair kit: expect both inlet/outlet. Single role: map one value.
    if sensor.role == "pair" or ("inlet_lpm" in body and "outlet_lpm" in body):
        parsed = _parse_reading(body)
        if isinstance(parsed, JsonResponse):
            return parsed
        inlet, outlet, valve_open = parsed
    else:
        try:
            value = float(body.get("flow_lpm", body.get("value")))
        except (TypeError, ValueError):
            return JsonResponse(
                {
                    "success": False,
                    "message": "Need flow_lpm (or inlet_lpm+outlet_lpm for pair)",
                },
                status=400,
            )
        state = SystemState.get_solo()
        valve_open = bool(body.get("valve_open", state.valve_open))
        if sensor.role == "inlet":
            inlet, outlet = value, state.outlet_lpm
        else:
            inlet, outlet = state.inlet_lpm, value

    device_id = str(body.get("device_id") or "")
    state = _apply_live_state(
        inlet=inlet,
        outlet=outlet,
        valve_open=valve_open,
        sensor=sensor,
        device_id=device_id,
    )
    return JsonResponse(
        {
            "success": True,
            "message": "Sensor reading stored",
            "sensor": sensor.as_dict(),
            "data": {
                "inlet_lpm": inlet,
                "outlet_lpm": outlet,
                "loss_lpm": round(inlet - outlet, 3),
                "pending_command": state.pending_command or None,
                "status": state.status,
            },
        },
        status=201,
    )


@require_GET
def iot_sensor_configuration(request, sensor_id: str):
    """GET /iot/sensors/{id}/configuration/ — config for hardware to pull."""
    _ensure_default_sensors()
    sensor = (
        Sensor.objects.filter(pk=sensor_id).first()
        if str(sensor_id).isdigit()
        else None
    )
    if sensor is None:
        sensor = get_object_or_404(Sensor, slug=sensor_id)

    state = SystemState.get_solo()
    return JsonResponse(
        {
            "success": True,
            "sensor": sensor.as_dict(),
            "configuration": {
                "enabled": sensor.enabled,
                "sample_interval_sec": sensor.sample_interval_sec,
                "min_flow_arm_lpm": sensor.min_flow_arm_lpm,
                "pipe_length_m": sensor.pipe_length_m,
                "report_url": "/iot/sensors/{}/readings/".format(sensor.slug),
                "bulk_url": "/iot/readings/bulk/",
                "baud": 9600,
            },
            "device": {
                "pending_command": state.pending_command or None,
                "valve_open": state.valve_open,
                "ai_mode": state.ai_mode,
                "status": state.status,
            },
        }
    )
