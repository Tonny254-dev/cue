from django.contrib import admin
from django.http import JsonResponse
from django.urls import path, include
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularSwaggerView,
    SpectacularRedocView,
)

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
    path("", include("msingi.urls")),
    path("", include("finance.urls")),
]


def api_index(_request):
    """Small discovery page so hitting / is not a 404."""
    return JsonResponse({
        "service": "CUE Water Monitoring API",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "api_root": "/api/v1/",
            "docs_swagger": "/api/docs/",
            "docs_redoc": "/api/redoc/",
            "schema": "/api/schema/",
            "admin": "/admin/",
            "websocket": "/ws/stream/?token=<access_token>",
        },
    })


urlpatterns = [
    path("", api_index, name="api-index"),
    path("admin/", admin.site.urls),
    path("api/v1/", include(api_patterns)),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
]