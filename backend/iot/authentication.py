import hashlib

from django.contrib.auth.hashers import check_password
from django.core.cache import cache
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from devices.models import Device


class DevicePrincipal:
    """Lightweight principal representing a device."""

    is_authenticated = True
    is_anonymous = False
    role = "DEVICE"

    def __init__(self, device: Device):
        self.device = device
        self.id = device.id
        self.username = device.device_identifier


class DeviceAuthentication(BaseAuthentication):
    """Header: X-Device-Id + X-Api-Key.

    PBKDF2 check_password is intentionally slow (~seconds on free hosts).
    Cache successful auth so live ingest stays fast.
    """

    keyword = "X-Api-Key"
    CACHE_TTL = 900  # 15 minutes

    def authenticate(self, request):
        device_id = request.META.get("HTTP_X_DEVICE_ID")
        api_key = request.META.get("HTTP_X_API_KEY")
        if not device_id or not api_key:
            return None

        key_fingerprint = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:40]
        cache_key = f"cue:devauth:{device_id}:{key_fingerprint}"
        device_pk = cache.get(cache_key)
        if device_pk:
            try:
                device = Device.objects.get(pk=device_pk, is_active=True)
                return (DevicePrincipal(device), None)
            except Device.DoesNotExist:
                cache.delete(cache_key)

        try:
            device = Device.objects.get(device_identifier=device_id, is_active=True)
        except Device.DoesNotExist:
            raise AuthenticationFailed("Unknown device")
        if not device.api_key_hash or not check_password(api_key, device.api_key_hash):
            raise AuthenticationFailed("Invalid device key")

        cache.set(cache_key, device.id, self.CACHE_TTL)
        return (DevicePrincipal(device), None)
