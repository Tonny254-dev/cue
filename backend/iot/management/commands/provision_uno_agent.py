"""Create/ensure UNO-KIT-001 + S1/S2 + valve and write agent config.json."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Provision UNO-KIT-001 API key + write scripts/uno_agent/config.json"

    def add_arguments(self, parser):
        parser.add_argument(
            "--api-base",
            default="http://127.0.0.1:8000/api/v1",
            help="CUE API base the Windows agent will POST to",
        )
        parser.add_argument(
            "--port",
            default="COM10",
            help="Locked USB serial port for the Uno (default COM10)",
        )
        parser.add_argument(
            "--write-config",
            action="store_true",
            help="Write cue-push/scripts/uno_agent/config.json with the new key",
        )

    def handle(self, *args, **options):
        from devices.models import Device
        from monitoring.models import Pipeline, Sensor
        from valves.models import Valve

        device, _ = Device.objects.get_or_create(
            device_identifier="UNO-KIT-001",
            defaults={
                "device_name": "CUE Uno Kit",
                "device_type": Device.DeviceType.ARDUINO_ESP,
                "location": "USB serial COM10",
                "is_active": True,
            },
        )
        pipe, _ = Pipeline.objects.get_or_create(
            pipeline_code="ZONE1",
            defaults={
                "pipeline_name": "Zone 1 S1-S2",
                "length_meters": Decimal("50.00"),
                "location": "S1 inlet to S2 outlet",
            },
        )
        for sid, name, pos in (
            ("S1", "Inlet S1", Sensor.Position.INLET),
            ("S2", "Outlet S2", Sensor.Position.OUTLET),
        ):
            s, _ = Sensor.objects.get_or_create(
                sensor_identifier=sid,
                defaults={
                    "sensor_name": name,
                    "device": device,
                    "sensor_position": pos,
                    "pipeline": pipe,
                },
            )
            changed = []
            if s.device_id != device.id:
                s.device = device
                changed.append("device")
            if s.pipeline_id != pipe.id:
                s.pipeline = pipe
                changed.append("pipeline")
            if changed:
                s.save(update_fields=changed)

        valve, _ = Valve.objects.get_or_create(
            valve_identifier="UNO-KIT-001-VALVE",
            defaults={
                "valve_name": "CUE Kit Valve",
                "device": device,
                "pipeline": pipe,
                "current_status": Valve.Status.OPEN,
                "control_mode": Valve.ControlMode.MANUAL,
            },
        )
        vchanged = []
        if valve.device_id != device.id:
            valve.device = device
            vchanged.append("device")
        if valve.pipeline_id != pipe.id:
            valve.pipeline = pipe
            vchanged.append("pipeline")
        if vchanged:
            valve.save(update_fields=vchanged)

        raw = Device.generate_api_key()
        device.set_api_key(raw)
        device.is_active = True
        device.save()

        api_base = options["api_base"].rstrip("/")
        port = (options["port"] or "COM10").strip() or "COM10"
        cfg = {
            "port": port,
            "baud": 9600,
            "sensor_inlet": "S1",
            "sensor_outlet": "S2",
            "scan_interval_sec": 2,
            "valve_id": valve.id,
            "targets": [
                {
                    "name": "local",
                    "api_base": api_base,
                    "device_id": "UNO-KIT-001",
                    "api_key": raw,
                    "valve_id": valve.id,
                    "enabled": True,
                }
            ],
        }

        self.stdout.write(self.style.SUCCESS("UNO-KIT-001 provisioned"))
        self.stdout.write("device_id: UNO-KIT-001")
        self.stdout.write(f"valve_id:  {valve.id}")
        self.stdout.write(self.style.WARNING(f"api_key:  {raw}"))
        self.stdout.write(f"api_base:  {api_base}")
        self.stdout.write(f"port:      {port}")
        self.stdout.write("Store the api_key now — it cannot be shown again.")

        if options["write_config"]:
            # backend/iot/management/commands -> parents[3]=backend, [4]=cue-push
            root = Path(__file__).resolve().parents[4]
            out = root / "scripts" / "uno_agent" / "config.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
            self.stdout.write(self.style.SUCCESS(f"Wrote {out}"))
