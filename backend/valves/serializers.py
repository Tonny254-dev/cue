from rest_framework import serializers
from .models import Valve, ValveCommand

class ValveSerializer(serializers.ModelSerializer):
    class Meta:
        model = Valve
        fields = ["id", "valve_name", "valve_identifier", "device", "pipeline",
                  "current_status", "control_mode", "last_updated"]
        read_only_fields = ["current_status", "last_updated"]

class ValveCommandSerializer(serializers.ModelSerializer):
    requested_by_username = serializers.CharField(source="requested_by.username", read_only=True)

    class Meta:
        model = ValveCommand
        fields = "__all__"