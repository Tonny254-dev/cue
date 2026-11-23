import logging
import threading

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

log = logging.getLogger(__name__)


def _send(group: str, event: str, payload: dict):
    """Fire-and-forget so IoT ingest is not blocked on WebSocket fanout."""
    layer = get_channel_layer()
    if layer is None:
        return

    def _do():
        try:
            async_to_sync(layer.group_send)(
                group,
                {"type": "broadcast.event", "event": event, "payload": payload},
            )
        except Exception:
            log.debug("broadcast to %s failed", group, exc_info=True)

    threading.Thread(target=_do, name=f"ws-{group}", daemon=True).start()

def broadcast_flow_reading(reading):
    payload = {
        "sensor_id": reading.sensor_id,
        "flow_rate": float(reading.flow_rate),
        "volume": float(reading.volume),
        "timestamp": reading.reading_timestamp.isoformat(),
    }
    _send("monitoring", "flow_reading_updated", payload)
    _send("dashboard", "flow_reading_updated", payload)


def broadcast_kit_flow(inlet_reading, outlet_reading):
    """Push S1/S2 pair from the Uno serial bridge to live UIs."""
    payload = {
        "sensor_id": inlet_reading.sensor_id,
        "flow_rate": float(inlet_reading.flow_rate),
        "inlet_lpm": float(inlet_reading.flow_rate),
        "outlet_lpm": float(outlet_reading.flow_rate),
        "volume": float(inlet_reading.volume),
        "timestamp": inlet_reading.reading_timestamp.isoformat(),
        "source": "serial",
    }
    _send("monitoring", "flow_reading_updated", payload)
    _send("dashboard", "flow_reading_updated", payload)

def broadcast_notification(notif):
    _send("notifications", "new_notification", {
        "id": notif.id, "title": notif.title, "message": notif.message,
        "severity": notif.severity, "created_at": notif.created_at.isoformat(),
    })