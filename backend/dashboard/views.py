from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from core.utils import success_response
from activity_logs.models import ActivityLog
from activity_logs.serializers import ActivityLogSerializer
from .services import overview, flow_trend, consumption_overview

class OverviewView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        return success_response(overview())

class FlowTrendView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        hours = int(request.query_params.get("hours", 24))
        return success_response(flow_trend(hours))

class ConsumptionOverviewView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        days = int(request.query_params.get("days", 7))
        return success_response(consumption_overview(days))

class RecentActivityView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        qs = ActivityLog.objects.select_related("user", "device")[:20]
        return success_response(ActivityLogSerializer(qs, many=True).data)

class SummaryView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        return success_response({
            "overview": overview(),
            "flow_trend_last_6h": flow_trend(6),
            "consumption_last_7_days": consumption_overview(7),
        })