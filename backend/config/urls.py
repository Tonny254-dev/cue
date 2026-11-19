from django.contrib import admin
from django.urls import path, include
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView

api_patterns = [
    path("", include("accounts.urls")),
    path("", include("dashboard.urls")),
    path("", include("monitoring.urls")),
    path("", include("analytics.urls")),
    path("", include("devices.urls")),
    path("", include("valves.urls")),
    path("", include("leak_detection.urls")),
    path("", include("notifications.urls")),
    path("", include("activity_logs.urls")),
    path("", include("system_settings.urls")),
    path("", include("iot.urls")),
]

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include(api_patterns)),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema")),
    path("api/redoc/", SpectacularRedocView.as_view(url_name="schema")),
]