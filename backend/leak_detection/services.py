from decimal import Decimal
from datetime import timedelta
from django.utils import timezone
from django.db import transaction
from monitoring.models import Sensor, FlowReading, Pipeline, PipelineSection
from system_settings.models import SystemSettings
from .models import LeakEvent

def _latest_near(sensor: Sensor, at, window_seconds: int = 30):
    """Return the latest reading for a sensor near a timestamp."""
    lo = at - timedelta(seconds=window_seconds)
    hi = at + timedelta(seconds=window_seconds)
    return (FlowReading.objects
            .filter(sensor=sensor, reading_timestamp__gte=lo, reading_timestamp__lte=hi)
            .order_by("-reading_timestamp")
            .first())

def compare_pipeline(pipeline: Pipeline, window_seconds: int = 30) -> dict:
    settings = SystemSettings.load()
    inlet = Sensor.objects.filter(pipeline=pipeline, sensor_position=Sensor.Position.INLET).first()
    outlet = Sensor.objects.filter(pipeline=pipeline, sensor_position=Sensor.Position.OUTLET).first()
    if not inlet or not outlet:
        return {"error": "Pipeline requires inlet and outlet sensors"}

    ref = timezone.now()
    inlet_r = _latest_near(inlet, ref, window_seconds) or inlet.readings.order_by("-reading_timestamp").first()
    outlet_r = _latest_near(outlet, ref, window_seconds) or outlet.readings.order_by("-reading_timestamp").first()
    if not inlet_r or not outlet_r:
        return {"error": "Insufficient readings to compare"}

    inlet_flow = Decimal(inlet_r.flow_rate)
    outlet_flow = Decimal(outlet_r.flow_rate)
    difference = inlet_flow - outlet_flow
    pct = (difference / inlet_flow * Decimal("100")) if inlet_flow > 0 else Decimal("0")

    tolerance = Decimal(settings.sensor_difference_tolerance)
    flow_threshold = Decimal(settings.leak_trigger_flow_difference)
    pct_threshold = Decimal(settings.leak_trigger_percentage)

    is_leak = (abs(difference) > tolerance
               and abs(difference) >= flow_threshold
               and abs(pct) >= pct_threshold)

    return {
        "inlet_sensor_id": inlet.id,
        "outlet_sensor_id": outlet.id,
        "inlet_flow_rate": inlet_flow,
        "outlet_flow_rate": outlet_flow,
        "flow_difference": difference,
        "difference_percentage": pct,
        "is_leak_candidate": is_leak,
        "settings": {
            "tolerance": tolerance,
            "flow_threshold": flow_threshold,
            "pct_threshold": pct_threshold,
            "duration": settings.leak_detection_duration,
        },
    }

def _severity_for(pct: Decimal) -> str:
    if pct >= Decimal("50"):
        return LeakEvent.Severity.CRITICAL
    if pct >= Decimal("30"):
        return LeakEvent.Severity.HIGH
    if pct >= Decimal("15"):
        return LeakEvent.Severity.MEDIUM
    return LeakEvent.Severity.LOW

@transaction.atomic
def evaluate_pipeline(pipeline: Pipeline) -> LeakEvent | None:
    """Evaluate a pipeline and update/create a leak event."""
    settings = SystemSettings.load()
    if not settings.automatic_leak_detection:
        return None

    result = compare_pipeline(pipeline)
    if "error" in result:
        return None

    active = (LeakEvent.objects
              .filter(pipeline=pipeline)
              .exclude(detection_status=LeakEvent.DetectionStatus.RESOLVED)
              .order_by("-started_at")
              .first())

    if result["is_leak_candidate"]:
        # Persist if persists beyond duration
        duration_cut = timezone.now() - timedelta(seconds=settings.leak_detection_duration)
        recent_persistent = FlowReading.objects.filter(
            sensor_id__in=[result["inlet_sensor_id"], result["outlet_sensor_id"]],
            reading_timestamp__gte=duration_cut,
        ).count()
        if recent_persistent < 2:
            # Not enough evidence yet; mark suspected
            pass

        if active:
            # Update existing event
            active.inlet_flow_rate = result["inlet_flow_rate"]
            active.outlet_flow_rate = result["outlet_flow_rate"]
            active.flow_difference = result["flow_difference"]
            active.difference_percentage = result["difference_percentage"]
            active.severity = _severity_for(abs(result["difference_percentage"]))
            if active.detection_status == LeakEvent.DetectionStatus.SUSPECTED \
                    and recent_persistent >= 2:
                active.detection_status = LeakEvent.DetectionStatus.CONFIRMED
                _notify_confirmed(active)
                _maybe_shutdown(active, settings)
            active.save()
            return active

        event = LeakEvent.objects.create(
            pipeline=pipeline,
            inlet_sensor_id=result["inlet_sensor_id"],
            outlet_sensor_id=result["outlet_sensor_id"],
            inlet_flow_rate=result["inlet_flow_rate"],
            outlet_flow_rate=result["outlet_flow_rate"],
            flow_difference=result["flow_difference"],
            difference_percentage=result["difference_percentage"],
            detection_status=LeakEvent.DetectionStatus.SUSPECTED,
            severity=_severity_for(abs(result["difference_percentage"])),
            started_at=timezone.now(),
            description="Flow difference exceeded threshold.",
        )
        from notifications.services import create_notification
        create_notification(
            title="Suspected leak detected",
            message=f"Pipeline {pipeline.pipeline_name} flow difference "
                    f"{result['flow_difference']} L/min.",
            notification_type="LEAK_SUSPECTED",
            severity="WARNING",
        )
        return event

    # Normal - resolve active event if stable
    if active:
        active.detection_status = LeakEvent.DetectionStatus.RESOLVED
        active.resolved_at = timezone.now()
        active.save()
        from notifications.services import create_notification
        create_notification(
            title="Leak resolved",
            message=f"Pipeline {pipeline.pipeline_name} has returned to normal flow.",
            notification_type="LEAK_RESOLVED",
            severity="INFO",
        )
    return None

def _notify_confirmed(event: LeakEvent):
    from notifications.services import create_notification
    create_notification(
        title="Confirmed leak",
        message=f"Confirmed leak on pipeline {event.pipeline.pipeline_name}.",
        notification_type="LEAK_CONFIRMED",
        severity="CRITICAL",
    )

def _maybe_shutdown(event: LeakEvent, settings):
    if not settings.automatic_valve_shutdown:
        return
    from valves.models import Valve, ValveCommand
    from valves.services import request_command
    for valve in Valve.objects.filter(pipeline=event.pipeline, control_mode=Valve.ControlMode.AUTOMATIC):
        request_command(valve, ValveCommand.CommandType.CLOSE, user=None)