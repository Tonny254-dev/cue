from django.contrib import admin
from .models import Notification


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("id", "created_at", "title", "notification_type", "severity", "is_read")
    list_filter = ("notification_type", "severity", "is_read")
    search_fields = ("title", "message")
    readonly_fields = ("created_at", "updated_at")