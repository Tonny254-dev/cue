from django.db import models


class Sensor(models.Model):
    """Hardware sensor / kit node that POSTs to /iot/* endpoints."""

    slug = models.SlugField(max_length=64, unique=True)
    name = models.CharField(max_length=120)
    role = models.CharField(
        max_length=24,
        default="pair",
        help_text="inlet | outlet | pair",
    )
    enabled = models.BooleanField(default=True)
    sample_interval_sec = models.PositiveIntegerField(default=1)
    min_flow_arm_lpm = models.FloatField(default=2.0)
    pipe_length_m = models.FloatField(default=50.0)
    device_key = models.CharField(max_length=64, blank=True, default="")
    last_seen_at = models.DateTimeField(null=True, blank=True)
    last_inlet_lpm = models.FloatField(default=0.0)
    last_outlet_lpm = models.FloatField(default=0.0)
    online = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["slug"]

    def __str__(self):
        return f"{self.slug} ({self.role})"

    def as_dict(self):
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "role": self.role,
            "enabled": self.enabled,
            "sample_interval_sec": self.sample_interval_sec,
            "min_flow_arm_lpm": self.min_flow_arm_lpm,
            "pipe_length_m": self.pipe_length_m,
            "online": self.online,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
            "last_inlet_lpm": self.last_inlet_lpm,
            "last_outlet_lpm": self.last_outlet_lpm,
        }


class SystemState(models.Model):
    """Singleton live kit state."""

    inlet_lpm = models.FloatField(default=0.0)
    outlet_lpm = models.FloatField(default=0.0)
    inlet_liters_total = models.FloatField(default=0.0)
    outlet_liters_total = models.FloatField(default=0.0)
    valve_open = models.BooleanField(default=True)
    monitoring = models.BooleanField(default=True)
    serial_connected = models.BooleanField(default=False)
    last_serial_line = models.CharField(max_length=255, blank=True, default="")
    pending_command = models.CharField(max_length=32, blank=True, default="")
    last_command_at = models.DateTimeField(null=True, blank=True)
    last_command_result = models.CharField(max_length=120, blank=True, default="")
    # Live AI / locus fields (from firmware ESTIMATE or backend calc)
    ai_mode = models.CharField(max_length=24, blank=True, default="")  # LEARNING / READY / …
    learned_bias = models.FloatField(default=0.0)
    learn_samples = models.IntegerField(default=0)
    estimate_from_s1_m = models.FloatField(null=True, blank=True)
    estimate_from_s2_m = models.FloatField(null=True, blank=True)
    estimate_severity_pct = models.FloatField(null=True, blank=True)
    estimate_summary = models.CharField(max_length=255, blank=True, default="")
    pipe_length_m = models.FloatField(default=50.0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "System state"

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    @property
    def loss_lpm(self):
        return round(self.inlet_lpm - self.outlet_lpm, 3)

    @property
    def status(self):
        if not self.serial_connected:
            return "OFFLINE"
        if not self.valve_open:
            return "CLOSED"
        if self.inlet_lpm >= 2.0 and self.loss_lpm >= max(1.8, self.inlet_lpm * 0.20):
            return "LEAK"
        from iot.services.units import FLOW_NOISE_LPM

        if self.inlet_lpm < FLOW_NOISE_LPM and self.outlet_lpm < FLOW_NOISE_LPM:
            return "IDLE"
        return "MONITORING"

    def as_dict(self):
        from iot.services.localize import estimate_break
        from iot.services.units import format_flow, format_volume, pressure_proxy

        if self.estimate_from_s1_m is not None and self.estimate_summary:
            live_est = {
                "available": True,
                "distance_from_s1_m": self.estimate_from_s1_m,
                "distance_from_s2_m": self.estimate_from_s2_m,
                "severity_pct": self.estimate_severity_pct,
                "summary": self.estimate_summary,
                "length_m": self.pipe_length_m,
                "units": "L/min",
            }
        else:
            live_est = estimate_break(
                self.inlet_lpm, self.outlet_lpm, length_m=self.pipe_length_m
            )

        inlet_f = format_flow(self.inlet_lpm)
        outlet_f = format_flow(self.outlet_lpm)
        loss_f = format_flow(max(self.inlet_lpm - self.outlet_lpm, 0.0))
        vin = format_volume(self.inlet_liters_total)
        vout = format_volume(self.outlet_liters_total)
        lost = format_volume(max(self.inlet_liters_total - self.outlet_liters_total, 0.0))
        press = pressure_proxy(self.inlet_lpm, self.outlet_lpm)

        return {
            "inlet_lpm": inlet_f["lpm"],
            "outlet_lpm": outlet_f["lpm"],
            "loss_lpm": loss_f["lpm"],
            "inlet_display": inlet_f,
            "outlet_display": outlet_f,
            "loss_display": loss_f,
            "inlet_liters_total": vin["liters"],
            "outlet_liters_total": vout["liters"],
            "lost_liters_total": lost["liters"],
            "inlet_volume_display": vin,
            "outlet_volume_display": vout,
            "lost_volume_display": lost,
            "pressure": press,
            "units": {"flow": "L/min or mL/min", "volume": "L or mL", "pressure": "flow-balance proxy"},
            "valve_open": self.valve_open,
            "monitoring": self.monitoring,
            "serial_connected": self.serial_connected,
            "status": self.status,
            "pending_command": self.pending_command,
            "last_command_result": self.last_command_result,
            "last_serial_line": self.last_serial_line,
            "ai": {
                "mode": self.ai_mode
                or ("IDLE" if self.serial_connected else "OFFLINE"),
                "learned_bias": round(self.learned_bias, 2),
                "learn_samples": self.learn_samples,
                "note": "Self-improving: learns continuously; admin cannot wipe AI pattern",
            },
            "break_estimate": live_est,
            "history_means": [
                h.as_dict()
                for h in FlowHistoryMean.objects.all()[:12]
            ],
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class FlowReading(models.Model):
    inlet_lpm = models.FloatField()
    outlet_lpm = models.FloatField()
    loss_lpm = models.FloatField()
    delta_in_ml = models.FloatField(default=0.0)
    delta_out_ml = models.FloatField(default=0.0)
    valve_open = models.BooleanField(default=True)
    sensor = models.ForeignKey(
        Sensor,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="readings",
    )
    source = models.CharField(max_length=24, blank=True, default="serial")  # serial|http
    device_id = models.CharField(max_length=64, blank=True, default="")
    recorded_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-recorded_at"]


class FlowHistoryMean(models.Model):
    """Periodic window means for history (every ~10 flowing samples)."""

    window_sec = models.PositiveIntegerField(default=10)
    sample_count = models.PositiveIntegerField(default=0)
    mean_inlet_lpm = models.FloatField(default=0.0)
    mean_outlet_lpm = models.FloatField(default=0.0)
    mean_loss_lpm = models.FloatField(default=0.0)
    volume_in_ml = models.FloatField(default=0.0)
    volume_out_ml = models.FloatField(default=0.0)
    volume_lost_ml = models.FloatField(default=0.0)
    recorded_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-recorded_at"]

    def as_dict(self):
        return {
            "id": self.id,
            "window_sec": self.window_sec,
            "sample_count": self.sample_count,
            "mean_inlet_lpm": round(self.mean_inlet_lpm, 3),
            "mean_outlet_lpm": round(self.mean_outlet_lpm, 3),
            "mean_loss_lpm": round(self.mean_loss_lpm, 3),
            "volume_in_ml": round(self.volume_in_ml, 1),
            "volume_out_ml": round(self.volume_out_ml, 1),
            "volume_lost_ml": round(self.volume_lost_ml, 1),
            "recorded_at": self.recorded_at.isoformat(),
        }


class LeakEvent(models.Model):
    zone = models.CharField(max_length=32, default="ZONE_1")
    inlet_lpm = models.FloatField()
    outlet_lpm = models.FloatField()
    estimate_from_s1_m = models.FloatField(null=True, blank=True)
    estimate_from_s2_m = models.FloatField(null=True, blank=True)
    estimate_severity_pct = models.FloatField(null=True, blank=True)
    estimate_summary = models.CharField(max_length=255, blank=True, default="")
    raw_line = models.CharField(max_length=255, blank=True, default="")
    valve_closed = models.BooleanField(default=True)
    sms_sent = models.BooleanField(default=False)
    sms_response = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def loss_lpm(self):
        return round(self.inlet_lpm - self.outlet_lpm, 2)

    def as_dict(self):
        return {
            "id": self.id,
            "zone": self.zone,
            "inlet_lpm": self.inlet_lpm,
            "outlet_lpm": self.outlet_lpm,
            "loss_lpm": self.loss_lpm,
            "valve_closed": self.valve_closed,
            "sms_sent": self.sms_sent,
            "break_estimate": {
                "distance_from_s1_m": self.estimate_from_s1_m,
                "distance_from_s2_m": self.estimate_from_s2_m,
                "severity_pct": self.estimate_severity_pct,
                "summary": self.estimate_summary,
            },
            "created_at": self.created_at.isoformat(),
            "raw_line": self.raw_line,
        }
