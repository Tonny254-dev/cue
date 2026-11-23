"""
Simulate leak / sensor / fluid scenarios across every fluid profile.

Usage:
  python manage.py simulate_liquid_scenarios
  python manage.py simulate_liquid_scenarios --json
"""

from __future__ import annotations

import json
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.utils import timezone

from devices.models import Device
from leak_detection.services import compare_pipeline
from monitoring.fluids import FLUID_PROFILES, OUT_OF_GUARANTEE, get_fluid_profile
from monitoring.models import FlowReading, Pipeline, Sensor
from system_settings.models import SystemSettings


def _ensure_lab_pipeline(fluid_code: str) -> Pipeline:
    code = f"SIM-{fluid_code}"
    pipe, _ = Pipeline.objects.get_or_create(
        pipeline_code=code,
        defaults={
            "pipeline_name": f"Sim {fluid_code}",
            "length_meters": Decimal("50"),
            "pipe_diameter": Decimal("20"),
            "fluid_type": fluid_code,
            "viscosity_class": get_fluid_profile(fluid_code).viscosity_class,
            "sensor_class": (
                "YF-S201"
                if get_fluid_profile(fluid_code).compatible_with_yf_s201
                else "oval_gear"
            ),
        },
    )
    pipe.fluid_type = fluid_code
    pipe.viscosity_class = get_fluid_profile(fluid_code).viscosity_class
    pipe.sensor_class = (
        "YF-S201"
        if get_fluid_profile(fluid_code).compatible_with_yf_s201
        else "oval_gear"
    )
    pipe.save()
    return pipe


def _ensure_sensors(pipe: Pipeline, device: Device, fluid_code: str):
    profile = get_fluid_profile(fluid_code)
    inlet, _ = Sensor.objects.get_or_create(
        sensor_identifier=f"SIM-{fluid_code}-S1",
        defaults={
            "sensor_name": f"Sim {fluid_code} inlet",
            "device": device,
            "sensor_position": Sensor.Position.INLET,
            "pipeline": pipe,
            "calibration_factor": profile.k_factor,
        },
    )
    outlet, _ = Sensor.objects.get_or_create(
        sensor_identifier=f"SIM-{fluid_code}-S2",
        defaults={
            "sensor_name": f"Sim {fluid_code} outlet",
            "device": device,
            "sensor_position": Sensor.Position.OUTLET,
            "pipeline": pipe,
            "calibration_factor": profile.k_factor,
        },
    )
    for s, pos in ((inlet, Sensor.Position.INLET), (outlet, Sensor.Position.OUTLET)):
        s.device = device
        s.pipeline = pipe
        s.sensor_position = pos
        s.calibration_factor = profile.k_factor
        s.status = Sensor.Status.ACTIVE
        s.save()
    return inlet, outlet


def _write_pair(device, inlet, outlet, q_in, q_out, pulse=1):
    ts = timezone.now()
    FlowReading.objects.create(
        sensor=inlet,
        device=device,
        flow_rate=Decimal(str(q_in)),
        volume=Decimal("0"),
        pulse_count=pulse,
        reading_timestamp=ts,
    )
    FlowReading.objects.create(
        sensor=outlet,
        device=device,
        flow_rate=Decimal(str(q_out)),
        volume=Decimal("0"),
        pulse_count=pulse,
        reading_timestamp=ts,
    )


def _run_case(name: str, pipe: Pipeline, expect_leak: bool | None, expect_error: str | None = None):
    result = compare_pipeline(pipe)
    ok = True
    detail = ""
    if expect_error:
        ok = "error" in result and expect_error.lower() in str(result.get("error", "")).lower()
        detail = result.get("error", "")
    elif expect_leak is None:
        ok = "error" not in result
        detail = "no hard leak assertion"
    else:
        got = bool(result.get("is_leak_candidate"))
        ok = got is expect_leak
        detail = (
            f"leak={got} diff={result.get('flow_difference')} "
            f"arm={result.get('settings', {}).get('min_flow_arm_lpm')}"
        )
    if "error" in result:
        payload = {"error": result.get("error")}
    else:
        payload = {
            k: (str(v) if isinstance(v, Decimal) else v)
            for k, v in result.items()
            if k != "settings"
        }
        payload["settings"] = {
            sk: (str(sv) if isinstance(sv, Decimal) else sv)
            for sk, sv in (result.get("settings") or {}).items()
        }
    return {
        "scenario": name,
        "fluid": getattr(pipe, "fluid_type", "?"),
        "pass": ok,
        "expect_leak": expect_leak,
        "detail": detail,
        "result": payload,
    }


class Command(BaseCommand):
    help = "Simulate multi-liquid leak/sensor scenarios and report pass/fail"

    def add_arguments(self, parser):
        parser.add_argument("--json", action="store_true", help="Print JSON report")

    def handle(self, *args, **options):
        SystemSettings.load()
        device, _ = Device.objects.get_or_create(
            device_identifier="SIM-MULTI-LIQUID",
            defaults={
                "device_name": "Multi-liquid simulator",
                "device_type": "SIMULATOR",
                "location": "lab",
                "connection_status": Device.ConnectionStatus.CONNECTED,
            },
        )
        device.mark_connected()

        report = {
            "guarantee": (
                "CUE differential leak detection works for ANY single-phase pipe liquid "
                "when both sensors are compatible, share a calibrated K-factor, and inlet "
                "flow is above the fluid arm threshold. Multiphase / wrong materials = out of guarantee."
            ),
            "out_of_guarantee": OUT_OF_GUARANTEE,
            "cases": [],
        }

        for fluid_code, profile in FLUID_PROFILES.items():
            pipe = _ensure_lab_pipeline(fluid_code)
            inlet, outlet = _ensure_sensors(pipe, device, fluid_code)

            # 1) Healthy balanced flow — must NOT leak
            _write_pair(device, inlet, outlet, 12.0, 11.9, pulse=10)
            report["cases"].append(
                _run_case(f"{fluid_code}:healthy_balanced", pipe, expect_leak=False)
            )

            # 2) Clear mid-line leak
            _write_pair(device, inlet, outlet, 12.0, 8.0, pulse=11)
            report["cases"].append(
                _run_case(f"{fluid_code}:clear_leak", pipe, expect_leak=True)
            )

            # 3) Dry / below noise — must NOT arm
            noise = float(profile.flow_noise_lpm)
            _write_pair(device, inlet, outlet, noise / 2, 0.0, pulse=12)
            report["cases"].append(
                _run_case(f"{fluid_code}:dry_pipe_noise", pipe, expect_leak=False)
            )

            # 4) Below arm threshold with fake delta — must NOT leak
            arm = float(profile.min_flow_arm_lpm)
            _write_pair(device, inlet, outlet, max(arm - 0.3, 0.5), 0.1, pulse=13)
            report["cases"].append(
                _run_case(f"{fluid_code}:below_arm", pipe, expect_leak=False)
            )

            # 5) Near-S1 heavy loss
            _write_pair(device, inlet, outlet, 15.0, 4.0, pulse=14)
            report["cases"].append(
                _run_case(f"{fluid_code}:near_s1_loss", pipe, expect_leak=True)
            )

            # 6) Near-S2 small relative loss still above thresholds
            _write_pair(device, inlet, outlet, 20.0, 16.5, pulse=15)
            report["cases"].append(
                _run_case(f"{fluid_code}:near_s2_loss", pipe, expect_leak=True)
            )

            # 7) Sensor material warning (informational — still runs algorithm)
            if not profile.compatible_with_yf_s201:
                report["cases"].append(
                    {
                        "scenario": f"{fluid_code}:sensor_compatibility_note",
                        "fluid": fluid_code,
                        "pass": True,
                        "expect_leak": None,
                        "detail": (
                            f"Profile rejects YF-S201; use {', '.join(profile.recommended_sensors)}"
                        ),
                        "result": {"compatible_with_yf_s201": False},
                    }
                )

        # Cross-cutting fault cases on WATER pipeline
        water = _ensure_lab_pipeline("WATER")
        inlet, outlet = _ensure_sensors(water, device, "WATER")

        # Missing outlet readings → error, not a false leak
        FlowReading.objects.filter(sensor__in=[inlet, outlet]).delete()
        ts = timezone.now()
        FlowReading.objects.create(
            sensor=inlet,
            device=device,
            flow_rate=Decimal("10"),
            volume=Decimal("0"),
            pulse_count=99,
            reading_timestamp=ts,
        )
        report["cases"].append(
            _run_case(
                "WATER:missing_outlet",
                water,
                expect_leak=None,
                expect_error="Insufficient",
            )
        )

        # Wrong K-factor both ends still match → differential still detects leak
        inlet.calibration_factor = Decimal("5.0")
        outlet.calibration_factor = Decimal("5.0")
        inlet.save()
        outlet.save()
        _write_pair(device, inlet, outlet, 14.0, 9.0, pulse=100)
        report["cases"].append(
            _run_case("WATER:matched_wrong_k_still_detects", water, expect_leak=True)
        )

        passed = sum(1 for c in report["cases"] if c["pass"])
        failed = sum(1 for c in report["cases"] if not c["pass"])
        report["summary"] = {
            "total": len(report["cases"]),
            "passed": passed,
            "failed": failed,
            "fluids": list(FLUID_PROFILES.keys()),
        }

        if options["json"]:
            self.stdout.write(json.dumps(report, indent=2, default=str))
        else:
            self.stdout.write(self.style.NOTICE(report["guarantee"]))
            self.stdout.write("")
            for c in report["cases"]:
                mark = self.style.SUCCESS("PASS") if c["pass"] else self.style.ERROR("FAIL")
                self.stdout.write(f"[{mark}] {c['scenario']} — {c['detail']}")
            self.stdout.write("")
            self.stdout.write(
                self.style.SUCCESS(
                    f"Summary: {passed}/{len(report['cases'])} passed, {failed} failed"
                )
            )
            self.stdout.write("Out of guarantee:")
            for g in OUT_OF_GUARANTEE:
                self.stdout.write(f"  - {g['id']}: {g['title']}")

        # Keep lab fixtures out of the live dashboard (LIVE prefers non-SIM pipelines).
        Pipeline.objects.filter(pipeline_code__startswith="SIM-").update(
            status=Pipeline.Status.INACTIVE
        )
        Sensor.objects.filter(sensor_identifier__startswith="SIM-").update(
            status=Sensor.Status.INACTIVE
        )

        if failed:
            raise SystemExit(1)
