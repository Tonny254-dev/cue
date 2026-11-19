from rest_framework.views import APIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
from rest_framework_simplejwt.tokens import RefreshToken
from core.utils import success_response, error_response
from .serializers import (
    UserSerializer, ProfileUpdateSerializer, ChangePasswordSerializer,
)

class LoginView(TokenObtainPairView):
    permission_classes = [AllowAny]

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        if response.status_code == 200:
            user = self._get_user(request)
            if user:
                from activity_logs.services import log_action
                log_action(user=user, action="LOGIN", description="User logged in",
                           category="AUTH", ip_address=self._client_ip(request))
                response.data = {
                    "success": True,
                    "message": "Login successful",
                    "data": {
                        "access": response.data["access"],
                        "refresh": response.data["refresh"],
                        "user": UserSerializer(user).data,
                    },
                }
        return response

    @staticmethod
    def _client_ip(request):
        xff = request.META.get("HTTP_X_FORWARDED_FOR")
        return xff.split(",")[0] if xff else request.META.get("REMOTE_ADDR")

    @staticmethod
    def _get_user(request):
        from django.contrib.auth import authenticate
        username = request.data.get("username")
        password = request.data.get("password")
        return authenticate(username=username, password=password)


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        refresh = request.data.get("refresh")
        if refresh:
            try:
                RefreshToken(refresh).blacklist()
            except Exception:
                return error_response("Invalid refresh token.")
        from activity_logs.services import log_action
        log_action(user=request.user, action="LOGOUT", description="User logged out",
                   category="AUTH")
        return success_response(message="Logged out successfully")


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return success_response(UserSerializer(request.user).data)

    def patch(self, request):
        serializer = ProfileUpdateSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return success_response(UserSerializer(request.user).data, "Profile updated")


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        request.user.set_password(serializer.validated_data["new_password"])
        request.user.save()
        return success_response(message="Password changed successfully")