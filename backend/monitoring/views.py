from datetime import timedelta
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework import generics
from rest_framework.permissions import IsAuthenticated
from core.permissions import RoleReadOnlyOrAdmin
from core.utils import success_response
from devices.models import Device
from .models import Sensor, Pipeline, PipelineSection, FlowReading, Consumption
from .serializers import (SensorSerializer, PipelineSerializer, PipelineSectionSerializer,
                          FlowReadingSerializer, ConsumptionSerializer)
from .services import latest_reading_for_sensor, consumption_today, current_flow_rate
from .fluids import list_fluid_profiles, OUT_OF_GUARANTEE

# ---------- Devices & Sensors management endpoints ----------
class SensorListView(generics.ListAPIView):
    queryset = Sensor.objects.select_related("device", "pipeline")
    serializer_class = SensorSerializer
    permission_classes = [IsAuthenticated, RoleReadOnlyOrAdmin]
    filterset_fields = ["sensor_position", "status", "device", "pipeline"]
    search_fields = ["sensor_name", "sensor_identifier"]

class SensorDetailView(generics.RetrieveAPIView):
    queryset = Sensor.objects.select_related("device", "pipeline")
    serializer_class = SensorSerializer
    permission_classes = [IsAuthenticated]

class SensorReadingsView(generics.ListAPIView):
    serializer_class = FlowReadingSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return FlowReading.objects.filter(sensor_id=self.kwargs["pk"])

class SensorStatusView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request, pk):
        s = Sensor.objects.get(pk=pk)
        last = latest_reading_for_sensor(s)
        return success_response({
            "sensor": s.sensor_identifier,
            "status": s.status,
            "sensor_position": s.sensor_position,
            "last_reading": FlowReadingSerializer(last).data if last else None,
        })

# ---------- Pipelines ----------
class PipelineListView(generics.ListAPIView):
    queryset = Pipeline.objects.all()
    serializer_class = PipelineSerializer
    permission_classes = [IsAuthenticated]
    filterset_fields = ["status"]

class PipelineSectionListView(generics.ListAPIView):
    queryset = PipelineSection.objects.select_related("pipeline", "inlet_sensor", "outlet_sensor")
    serializer_class = PipelineSectionSerializer
    permission_classes = [IsAuthenticated]


class FluidProfilesView(APIView):
    """Catalog of supported pipe liquids + explicit non-guarantees."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return success_response(
            {
                "profiles": list_fluid_profiles(),
                "out_of_guarantee": OUT_OF_GUARANTEE,
                "guarantee": (
                    "Differential leak detection works for any single-phase pipe liquid "
                    "when both sensors are fluid-compatible, share a calibrated K-factor, "
                    "and inlet flow is above the fluid arm threshold."
                ),
            }
        )


# ---------- Live Monitoring ----------
def _primary_pipeline(pipeline_id=None):
    """Prefer the real kit line; ignore SIM-* lab pipelines unless explicitly requested."""
    if pipeline_id:
        return Pipeline.objects.filter(pk=pipeline_id).first()
    real = (
        Pipeline.objects.exclude(pipeline_code__startswith="SIM-")
        .exclude(status=Pipeline.Status.INACTIVE)
        .order_by("id")
        .first()
    )
    if real:
        return real
    return Pipeline.objects.exclude(status=Pipeline.Status.INACTIVE).order_by("id").first()


class LiveMonitoringView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        pipeline = _primary_pipeline(request.query_params.get("pipeline"))
        data = {
            "pipeline_id": pipeline.id if pipeline else None,
            "pipeline_code": getattr(pipeline, "pipeline_code", None) if pipeline else None,
            "fluid_type": getattr(pipeline, "fluid_type", None) if pipeline else None,
            "current_flow_rate": current_flow_rate(pipeline),
            "unit": "L/min",
            "consumption_today": consumption_today(pipeline),
            "sensors": [],
        }
        if pipeline:
            for s in Sensor.objects.filter(pipeline=pipeline).exclude(
                sensor_identifier__startswith="SIM-"
            ):
                last = latest_reading_for_sensor(s)
                data["sensors"].append({
                    "sensor": s.sensor_identifier,
                    "position": s.sensor_position,
                    "last_reading": FlowReadingSerializer(last).data if last else None,
                })
        return success_response(data)

class FlowRateView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        pipeline = _primary_pipeline(request.query_params.get("pipeline"))
        return success_response({
            "flow_rate": current_flow_rate(pipeline),
            "unit": "L/min",
            "as_of": timezone.now(),
        })

class ConsumptionTodayView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        pipeline = _primary_pipeline(request.query_params.get("pipeline"))
        return success_response({
            "consumption_volume": consumption_today(pipeline),
            "unit": "L",
        })

class SensorStatusListView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        data = []
        qs = Sensor.objects.select_related("device").exclude(
            sensor_identifier__startswith="SIM-"
        ).exclude(device__device_identifier__startswith="SIM-")
        for s in qs:
            last = latest_reading_for_sensor(s)
            data.append({
                "sensor_id": s.id,
                "sensor": s.sensor_identifier,
                "name": s.sensor_name,
                "position": s.sensor_position,
                "device": s.device.device_identifier,
                "device_status": s.device.connection_status,
                "status": s.status,
                "last_reading_at": last.reading_timestamp if last else None,
            })
        return success_response(data)

class ConnectivityView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        devices = list(Device.objects.values(
            "id", "device_name", "device_identifier", "connection_status", "last_communication"))
        return success_response({"devices": devices})

class HistoryView(generics.ListAPIView):
    serializer_class = FlowReadingSerializer
    permission_classes = [IsAuthenticated]
    filterset_fields = ["sensor"]

    def get_queryset(self):
        qs = FlowReading.objects.all()
        start = self.request.query_params.get("start")
        end = self.request.query_params.get("end")
        if start:
            qs = qs.filter(reading_timestamp__gte=start)
        if end:
            qs = qs.filter(reading_timestamp__lte=end)
        return qs.order_by("-reading_timestamp")