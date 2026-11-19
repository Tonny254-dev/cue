import json

from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from iot.models import FlowHistoryMean, FlowReading, LeakEvent, SystemState
from iot.services.telemetry import queue_command


def demo(request):
    return render(request, "demo.html", {"state": SystemState.get_solo()})


@require_GET
def api_status(request):
    state = SystemState.get_solo()
    return JsonResponse({"success": True, "data": state.as_dict()})


@require_GET
def api_readings(request):
    try:
        limit = min(int(request.GET.get("limit", 100)), 1000)
    except ValueError:
        limit = 100
    rows = list(FlowReading.objects.all()[:limit])
    return JsonResponse(
        {
            "success": True,
            "count": FlowReading.objects.count(),
            "data": [
                {
                    "id": r.id,
                    "inlet_lpm": r.inlet_lpm,
                    "outlet_lpm": r.outlet_lpm,
                    "loss_lpm": r.loss_lpm,
                    "valve_open": r.valve_open,
                    "recorded_at": r.recorded_at.isoformat(),
                }
                for r in rows
            ],
        }
    )


@require_GET
def api_events(request):
    rows = list(LeakEvent.objects.all()[:100])
    return JsonResponse(
        {"success": True, "count": len(rows), "data": [e.as_dict() for e in rows]}
    )


@require_GET
def api_history(request):
    """Stored window means (flow + pulse volume) for charts / review."""
    try:
        limit = min(int(request.GET.get("limit", 50)), 200)
    except ValueError:
        limit = 50
    rows = list(FlowHistoryMean.objects.all()[:limit])
    return JsonResponse(
        {"success": True, "count": len(rows), "data": [r.as_dict() for r in rows]}
    )


@csrf_exempt
@require_POST
def api_command(request):
    """Queue RESET / CLOSE / STATUS for the serial bridge. AI pattern is never cleared."""
    try:
        body = json.loads(request.body.decode() or "{}")
    except json.JSONDecodeError:
        body = {}
    command = (body.get("command") or request.POST.get("command") or "").strip().upper()
    # CALIBRATE / ZERO_BIAS intentionally not exposed — AI keeps improving itself.
    allowed = {"RESET", "RESTART", "UNLOCK", "CLOSE", "STATUS"}
    if command in {"CALIBRATE", "ZERO_BIAS"}:
        return JsonResponse(
            {
                "success": False,
                "message": "AI pattern reset is disabled — the kit keeps learning continuously",
            },
            status=403,
        )
    if command not in allowed:
        return JsonResponse(
            {"success": False, "message": f"command must be one of {sorted(allowed)}"},
            status=400,
        )
    state = queue_command(command)
    return JsonResponse(
        {
            "success": True,
            "message": f"Queued {command}",
            "data": state.as_dict(),
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def api_ingest(request):
    """Optional HTTP push of a kit reading (for simulators / other backends)."""
    try:
        body = json.loads(request.body.decode() or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"success": False, "message": "Invalid JSON"}, status=400)

    try:
        inlet = float(body["inlet_lpm"])
        outlet = float(body["outlet_lpm"])
    except (KeyError, TypeError, ValueError):
        return JsonResponse(
            {"success": False, "message": "Need inlet_lpm and outlet_lpm numbers"},
            status=400,
        )

    valve_open = bool(body.get("valve_open", True))
    loss = round(inlet - outlet, 3)
    SystemState.get_solo()
    SystemState.objects.filter(pk=1).update(
        inlet_lpm=inlet,
        outlet_lpm=outlet,
        valve_open=valve_open,
        monitoring=valve_open,
        serial_connected=True,
        last_serial_line=f"INGEST S1={inlet} S2={outlet}",
    )
    FlowReading.objects.create(
        inlet_lpm=round(inlet, 3),
        outlet_lpm=round(outlet, 3),
        loss_lpm=loss,
        valve_open=valve_open,
        source="http",
        device_id="",
    )
    return JsonResponse({"success": True, "data": SystemState.get_solo().as_dict()})
