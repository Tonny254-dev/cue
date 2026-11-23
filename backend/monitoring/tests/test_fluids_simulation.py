import pytest
from decimal import Decimal

from devices.models import Device
from leak_detection.services import compare_pipeline
from monitoring.fluids import FLUID_PROFILES, get_fluid_profile
from monitoring.models import FlowReading, Pipeline, Sensor
from django.utils import timezone


@pytest.mark.django_db
def test_every_fluid_profile_detects_clear_leak_and_ignores_dry_noise():
    device = Device.objects.create(
        device_name="t",
        device_identifier="T-FLUID",
        device_type="SIM",
    )
    for code, profile in FLUID_PROFILES.items():
        pipe = Pipeline.objects.create(
            pipeline_name=code,
            pipeline_code=f"T-{code}",
            fluid_type=code,
            viscosity_class=profile.viscosity_class,
            sensor_class="oval_gear",
            length_meters=50,
        )
        inlet = Sensor.objects.create(
            sensor_name="in",
            sensor_identifier=f"T-{code}-S1",
            device=device,
            sensor_position=Sensor.Position.INLET,
            pipeline=pipe,
            calibration_factor=profile.k_factor,
        )
        outlet = Sensor.objects.create(
            sensor_name="out",
            sensor_identifier=f"T-{code}-S2",
            device=device,
            sensor_position=Sensor.Position.OUTLET,
            pipeline=pipe,
            calibration_factor=profile.k_factor,
        )
        ts = timezone.now()
        FlowReading.objects.create(
            sensor=inlet,
            device=device,
            flow_rate=Decimal("12"),
            volume=0,
            pulse_count=1,
            reading_timestamp=ts,
        )
        FlowReading.objects.create(
            sensor=outlet,
            device=device,
            flow_rate=Decimal("8"),
            volume=0,
            pulse_count=1,
            reading_timestamp=ts,
        )
        leak = compare_pipeline(pipe)
        assert leak["is_leak_candidate"] is True
        assert leak["fluid_type"] == code

        # dry / noise
        FlowReading.objects.create(
            sensor=inlet,
            device=device,
            flow_rate=profile.flow_noise_lpm / 2,
            volume=0,
            pulse_count=2,
            reading_timestamp=timezone.now(),
        )
        FlowReading.objects.create(
            sensor=outlet,
            device=device,
            flow_rate=Decimal("0"),
            volume=0,
            pulse_count=2,
            reading_timestamp=timezone.now(),
        )
        dry = compare_pipeline(pipe)
        assert dry["is_leak_candidate"] is False


@pytest.mark.django_db
def test_water_profile_defaults():
    p = get_fluid_profile("WATER")
    assert p.compatible_with_yf_s201 is True
    assert p.k_factor == Decimal("7.5")
