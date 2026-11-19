from django.urls import include, path

urlpatterns = [
    path("", include("iot.urls")),
]
