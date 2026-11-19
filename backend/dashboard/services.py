from django.utils import timezone
from datetime import timedelta
from django.db.models import Count
from devices.models import Device
from leak_detection.models import LeakEvent
from notifications.models import Notification
from monitoring.models import FlowReading
from monitoring.services import current_flow_rate, consumption_today

def overview() -> dict:
    active_alerts = LeakEvent.objects.exclude(detection_status=LeakEvent.DetectionStatus.RESOLVED).count()
    unread = Notification.objects.filter(is_read=False).count()
    total_devices = Device.objects.count()
    connected_devices = Device.objects.filter(connection_status=Device.ConnectionStatus.CONNECTED).count()
    system_health = "HEALTHY" if connected_devices == total_devices and active_alerts == 0 else "DEGRADED"
    return {
        "current_water_flow": {"value": current_flow_rate(), "unit": "L/min"},
        "todays_consumption": {"value": consumption_today(), "unit": "L"},
        "system_health": system_health,
        "active_alerts": active_alerts,
        "unread_notifications": unread,
        "devices": {"total": total_devices, "connected": connected_devices},
    }

def flow_trend(hours: int = 24) -> list:
    since = timezone.now() - timedelta(hours=hours)
    qs = FlowReading.objects.filter(reading_timestamp__gte=since).order_by("reading_timestamp")
    return [
        {"timestamp": r.reading_timestamp.isoformat(),
         "flow_rate": float(r.flow_rate),
         "sensor": r.sensor_id}
        for r in qs
    ]

def consumption_overview(days: int = 7) -> list:
    from monitoring.services import calculate_consumption_window
    from monitoring.models import Pipeline
    result = []
    today = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
    for i in range(days, 0, -1):
        start = today - timedelta(days=i)
        end = start + timedelta(days=1)
        total = sum((calculate_consumption_window(p, start, end) for p in Pipeline.objects.all()),
                    start=__import__("decimal").Decimal("0"))
        result.append({"date": start.date().isoformat(), "consumption": float(total)})
    return result