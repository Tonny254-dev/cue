from rest_framework import generics
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from core.utils import success_response
from .models import Notification
from .serializers import NotificationSerializer

class NotificationListView(generics.ListAPIView):
    queryset = Notification.objects.all()
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]
    filterset_fields = ["is_read", "severity", "notification_type"]

class UnreadListView(generics.ListAPIView):
    queryset = Notification.objects.filter(is_read=False)
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

class NotificationDetailView(generics.RetrieveAPIView):
    queryset = Notification.objects.all()
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

class MarkReadView(APIView):
    permission_classes = [IsAuthenticated]
    def patch(self, request, pk):
        Notification.objects.filter(pk=pk).update(is_read=True)
        return success_response(message="Marked as read")

class MarkAllReadView(APIView):
    permission_classes = [IsAuthenticated]
    def post(self, request):
        Notification.objects.filter(is_read=False).update(is_read=True)
        return success_response(message="All notifications marked as read")

class NotificationPreferencesView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        return success_response({"email_notifications": True, "push_notifications": True})
    def patch(self, request):
        return success_response(request.data, "Preferences updated")