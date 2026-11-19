from .models import Notification

def create_notification(title, message, notification_type, severity="INFO"):
    notif = Notification.objects.create(
        title=title, message=message,
        notification_type=notification_type, severity=severity,
    )
    try:
        from config.broadcast import broadcast_notification
        broadcast_notification(notif)
    except Exception:
        pass
    return notif