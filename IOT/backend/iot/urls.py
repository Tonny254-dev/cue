from django.urls import path

from iot import hw_views, views

urlpatterns = [
    path("", views.demo, name="demo"),
    # Frontend / dashboard APIs
    path("api/status/", views.api_status, name="api_status"),
    path("api/readings/", views.api_readings, name="api_readings"),
    path("api/events/", views.api_events, name="api_events"),
    path("api/history/", views.api_history, name="api_history"),
    path("api/command/", views.api_command, name="api_command"),
    path("api/ingest/", views.api_ingest, name="api_ingest"),
    # Hardware APIs (Arduino / ESP8266 → Django)
    path("iot/readings/", hw_views.iot_readings, name="iot_readings"),
    path("iot/readings/bulk/", hw_views.iot_readings_bulk, name="iot_readings_bulk"),
    path(
        "iot/sensors/<str:sensor_id>/readings/",
        hw_views.iot_sensor_readings,
        name="iot_sensor_readings",
    ),
    path(
        "iot/sensors/<str:sensor_id>/configuration/",
        hw_views.iot_sensor_configuration,
        name="iot_sensor_configuration",
    ),
]
