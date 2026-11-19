"""Bridge Arduino USB serial <-> Django IoT state."""

from __future__ import annotations

import logging
import time

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import close_old_connections
from django.utils import timezone

logger = logging.getLogger(__name__)
# AI pattern wipe (CALIBRATE) not accepted — kit keeps improving itself.
VALID = {"RESET", "RESTART", "UNLOCK", "CLOSE", "STATUS"}


class Command(BaseCommand):
    help = "Listen to Uno serial and apply kit readings / commands"

    def add_arguments(self, parser):
        parser.add_argument("--port", default=settings.SERIAL_PORT)
        parser.add_argument("--baud", type=int, default=settings.SERIAL_BAUD)

    def handle(self, *args, **options):
        try:
            import serial
            from serial.tools import list_ports
        except ImportError as exc:
            raise SystemExit("pip install pyserial") from exc

        from iot.models import SystemState
        from iot.services.leaks import handle_serial_line
        from iot.services.telemetry import mark_serial_connected

        port, baud = options["port"], options["baud"]
        self.stdout.write("Ports:")
        for p in list_ports.comports():
            self.stdout.write(f"  {p.device}: {p.description}")
        self.stdout.write(self.style.SUCCESS(f"Listening {port} @ {baud}"))

        def pop_cmd() -> str:
            close_old_connections()
            row = (
                SystemState.objects.filter(pk=1)
                .exclude(pending_command="")
                .values_list("pending_command", flat=True)
                .first()
            )
            if not row:
                return ""
            cmd = row.strip().upper()
            if cmd not in VALID:
                SystemState.objects.filter(pk=1).update(pending_command="")
                return ""
            SystemState.objects.filter(pk=1).update(
                pending_command="",
                last_command_at=timezone.now(),
                last_command_result=cmd,
            )
            return cmd

        while True:
            try:
                with serial.Serial(port, baud, timeout=0.15) as ser:
                    mark_serial_connected(True)
                    self.stdout.write(self.style.SUCCESS(f"Connected {port}"))
                    while True:
                        def send(cmd: str):
                            # Soft RESET only (no DTR hard-reset — that drops COM and shows OFFLINE).
                            line = "RESET" if cmd in {"RESET", "RESTART", "UNLOCK"} else cmd
                            # CR+LF so Arduino Serial parser always sees end-of-line
                            ser.write((line + "\r\n").encode())
                            ser.flush()
                            if line == "RESET":
                                SystemState.objects.filter(pk=1).update(
                                    valve_open=True,
                                    monitoring=True,
                                    inlet_lpm=0.0,
                                    outlet_lpm=0.0,
                                    inlet_liters_total=0.0,
                                    outlet_liters_total=0.0,
                                    estimate_from_s1_m=None,
                                    estimate_from_s2_m=None,
                                    estimate_severity_pct=None,
                                    estimate_summary="Restarted — totals cleared, valve OPEN (AI kept)",
                                    last_command_result="RESET",
                                    serial_connected=True,
                                    last_serial_line="TX RESET",
                                )
                            self.stdout.write(self.style.WARNING(f"TX {line}"))

                        # Poll pending commands even when Arduino is quiet
                        cmd = pop_cmd()
                        if cmd:
                            send(cmd)
                        raw = ser.readline()
                        if not raw:
                            continue
                        line = raw.decode("utf-8", errors="replace").strip()
                        if not line:
                            continue
                        safe = line.encode("ascii", errors="replace").decode("ascii")
                        self.stdout.write(f"SERIAL: {safe}")
                        cmd = pop_cmd()
                        if cmd:
                            send(cmd)
                        event = handle_serial_line(line)
                        if event:
                            self.stdout.write(
                                self.style.WARNING(
                                    f"LEAK {event.zone} loss={event.loss_lpm} L/min"
                                )
                            )
            except serial.SerialException as exc:
                mark_serial_connected(False)
                self.stderr.write(self.style.ERROR(f"{port}: {exc} — retry 2s"))
                time.sleep(2)
            except KeyboardInterrupt:
                mark_serial_connected(False)
                break
