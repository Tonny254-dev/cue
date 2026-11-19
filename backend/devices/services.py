from django.utils import timezone
from datetime import timedelta
import os
from .models import Device

def heartbeat_timeout_seconds():
    return int(os.getenv("DEVICE_HEARTBEAT_TIMEOUT_SECONDS", "120"))

def sweep_disconnected_devices() -> int:
    """Mark devices disconnected if last_communication exceeded timeout."""
    cutoff = timezone.now() - timedelta(seconds=heartbeat_timeout_seconds())
    updated = 0
    for device in Device.objects.filter(is_active=True,
                                        connection_status=Device.ConnectionStatus.CONNECTED):
        if not device.last_communication or device.last_communication < cutoff:
            device.connection_status = Device.ConnectionStatus.DISCONNECTED
            device.save(update_fields=["connection_status", "updated_at"])
            from notifications.services import create_notification
            create_notification(
                title="Device disconnected",
                message=f"{device.device_name} has been disconnected.",
                notification_type="DEVICE_DISCONNECTED",
                severity="WARNING",
            )
            from activity_logs.services import log_action
            log_action(device=device, action="DEVICE_DISCONNECTED",
                       description=f"Device {device.device_name} disconnected",
                       category="DEVICE")
            updated += 1
    return updated