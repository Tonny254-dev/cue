from rest_framework.views import APIView
from rest_framework import generics
from rest_framework.permissions import IsAuthenticated
from core.permissions import RoleReadOnlyOrAdmin
from core.utils import success_response
from .models import Device, DeviceCommunicationLog
from .serializers import DeviceSerializer, DeviceCommunicationLogSerializer

class DeviceListView(generics.ListAPIView):
    queryset = Device.objects.all()
    serializer_class = DeviceSerializer
    permission_classes = [IsAuthenticated, RoleReadOnlyOrAdmin]
    filterset_fields = ["connection_status", "device_type", "is_active"]
    search_fields = ["device_name", "device_identifier", "location"]
    ordering_fields = ["created_at", "last_communication", "device_name"]

class ConnectedDeviceListView(generics.ListAPIView):
    queryset = Device.objects.filter(connection_status=Device.ConnectionStatus.CONNECTED)
    serializer_class = DeviceSerializer
    permission_classes = [IsAuthenticated]

class DisconnectedDeviceListView(generics.ListAPIView):
    queryset = Device.objects.filter(connection_status=Device.ConnectionStatus.DISCONNECTED)
    serializer_class = DeviceSerializer
    permission_classes = [IsAuthenticated]

class DeviceDetailView(generics.RetrieveAPIView):
    queryset = Device.objects.all()
    serializer_class = DeviceSerializer
    permission_classes = [IsAuthenticated]

class DeviceStatusView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request, pk):
        d = Device.objects.get(pk=pk)
        return success_response({
            "id": d.id, "device_identifier": d.device_identifier,
            "connection_status": d.connection_status,
            "last_communication": d.last_communication,
        })

class DeviceHealthView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request, pk):
        d = Device.objects.get(pk=pk)
        sensors = list(d.sensors.values("id", "sensor_name", "status", "sensor_position"))
        valves = list(d.valves.values("id", "valve_name", "current_status"))
        healthy = d.connection_status == Device.ConnectionStatus.CONNECTED and d.is_active
        return success_response({
            "device": d.device_identifier,
            "healthy": healthy,
            "connection_status": d.connection_status,
            "last_communication": d.last_communication,
            "firmware_version": d.firmware_version,
            "sensors": sensors,
            "valves": valves,
        })

class DeviceCommunicationsView(generics.ListAPIView):
    serializer_class = DeviceCommunicationLogSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return DeviceCommunicationLog.objects.filter(device_id=self.kwargs["pk"])