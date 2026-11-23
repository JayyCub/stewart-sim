"""Shared helpers for the bench scripts (move_servo, heave).

Reads packages/rig-config/rig.json and talks to firmware/servo_test over USB serial.
All rig numbers (channels, calibration, limits) come from rig.json.
"""

import json
import os
import sys
import time
from pathlib import Path

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    sys.exit("pyserial is missing: python3 -m pip install pyserial")

RIG_PATH = Path(__file__).resolve().parent.parent / "packages" / "rig-config" / "rig.json"
BAUD = 115200
BOOT_TIMEOUT_S = 5.0
REPLY_TIMEOUT_S = 1.0
ARDUINO_VIDS = {0x2341, 0x2A03, 0x1A86}  # Arduino LLC, Arduino SRL, CH340 clones
# Absolute pulse window enforced by firmware/servo_test (ABS_MIN_US / ABS_MAX_US there).
# Checked here too so a request outside it is refused up front, even with --ignore-limits.
FIRMWARE_MIN_US = 500
FIRMWARE_MAX_US = 2500
# Firmware handshake and frame queue (QUEUE_LEN and FRAME_US in firmware/servo_test).
FIRMWARE_READY = "READY servo_test v3"
QUEUE_LEN = 48
FRAME_S = 0.020

IGNORE_LIMITS_HELP = (
    "skip the rig.json limit checks and warn instead "
    f"(the Uno still refuses pulses outside {FIRMWARE_MIN_US}-{FIRMWARE_MAX_US} us)"
)


def label(servos: list[dict], leg: int) -> int:
    """Number written on the servo for this leg (rig.json servos[leg].label, default leg + 1)."""
    return servos[leg].get("label", leg + 1)


def leg_for_label(servos: list[dict], number: int) -> int | None:
    """Leg index of the servo with this written number, or None."""
    for i in range(len(servos)):
        if label(servos, i) == number:
            return i
    return None


def outside_firmware_window(servos: list[dict], degs_per_servo: list[list[float]], legs: list[int] | None = None) -> str | None:
    """Return a message if any horn angle maps outside the firmware pulse window.

    degs_per_servo[k] lists the angles servos[k] will be sent. Pass `legs` when servos
    is a subset of rig.json's list, so the message can name each servo by its label.
    """
    for k, (s, degs) in enumerate(zip(servos, degs_per_servo)):
        name = s.get("label", (legs[k] if legs else k) + 1)
        for d in degs:
            us = deg_to_us(s, d)
            if not FIRMWARE_MIN_US <= us <= FIRMWARE_MAX_US:
                return (
                    f"Refused: {d:.1f} deg is {us} us on servo {name}, outside the firmware window "
                    f"{FIRMWARE_MIN_US}-{FIRMWARE_MAX_US} us (cannot be overridden)."
                )
    return None


def check_channels(servos: list[dict]) -> str | None:
    """All-servo frames ("A") need the six servos on channels 0-5."""
    channels = sorted(s["channel"] for s in servos)
    if channels != list(range(len(servos))):
        return f"Refused: all-servo commands need servos on channels 0-5, rig.json has {channels}."
    return None


def frame_us(servos: list[dict], degs: list[float]) -> list[int]:
    """Horn angles per servo (rig.json order) -> pulse widths indexed by channel, for Link.set_all_us."""
    us = [0] * len(servos)
    for s, d in zip(servos, degs):
        us[s["channel"]] = deg_to_us(s, d)
    return us


class LinkError(Exception):
    """The Uno did not answer, or answered with ERR."""


class PortOpenError(LinkError):
    """The serial port could not be opened, so nothing was sent to the Uno."""


def load_rig() -> dict:
    rig = json.loads(RIG_PATH.read_text())
    if not rig.get("measured", False):
        print("Note: rig.json calibration is placeholder (measured: false).", file=sys.stderr)
    return rig


def deg_to_us(servo: dict, deg: float) -> int:
    """Horn angle from level (degrees, + raises the horn) -> pulse width for that servo."""
    return round(servo["centerUs"] + servo["trimUs"] + servo["direction"] * servo["usPerDeg"] * deg)


def find_port(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("STEWART_PORT")
    if env:
        return env
    ports = [p for p in serial.tools.list_ports.comports() if p.vid in ARDUINO_VIDS]
    if len(ports) == 1:
        return ports[0].device
    if not ports:
        raise LinkError("No Arduino found. Plug it in, or pass --port / set STEWART_PORT.")
    raise LinkError("Several Arduinos found, pick one with --port: " + ", ".join(p.device for p in ports))


class Link:
    """Serial link to firmware/servo_test. Resets the Uno on open and waits for READY."""

    def __init__(self, port: str):
        self.port = port
        try:
            self.ser = serial.Serial(port, BAUD, timeout=0.05)
        except serial.SerialException as e:
            if getattr(e, "errno", None) == 16 or "busy" in str(e).lower():
                raise PortOpenError(
                    f"{port} is in use by another program. Only one can hold the Uno's port: press Disconnect in the sim's "
                    "Hardware or Servo limits panel (or close that tab), close the Arduino serial monitor, and stop any other "
                    "bench script. Nothing was sent to the servos."
                ) from None
            raise PortOpenError(f"Could not open {port}: {e}. Nothing was sent to the servos.") from None
        # Opening the port does not reliably reset the Uno, so pulse DTR to force a
        # fresh boot and a fresh READY line.
        self.ser.dtr = False
        time.sleep(0.1)
        self.ser.reset_input_buffer()
        self.ser.dtr = True
        deadline = time.monotonic() + BOOT_TIMEOUT_S
        while True:
            line = self._read_line(deadline)
            if line is None:
                self.close()
                raise LinkError(f"No READY from {port}. Is firmware/servo_test flashed?")
            if line.startswith("READY"):
                break
        if "ERR" in line:
            self.close()
            raise LinkError(line)
        if not line.startswith(FIRMWARE_READY):
            self.close()
            raise LinkError(
                f"Unexpected firmware ({line}); these scripts need {FIRMWARE_READY}. Re-flash firmware/servo_test "
                "(arduino-cli compile/upload, see docs/BENCH_SCRIPTS.md)."
            )

    def _read_line(self, deadline: float) -> str | None:
        buf = b""
        while time.monotonic() < deadline:
            buf += self.ser.readline()
            if buf.endswith(b"\n"):
                return buf.decode(errors="replace").strip()
        return None

    def command(self, cmd: str) -> str:
        """Send one command line, return the OK reply, raise LinkError otherwise."""
        self.ser.write((cmd + "\n").encode())
        reply = self._read_line(time.monotonic() + REPLY_TIMEOUT_S)
        if reply is None:
            raise LinkError(f"No reply from the Uno to '{cmd}'.")
        if not reply.startswith("OK"):
            raise LinkError(reply)
        return reply

    def set_all_us(self, us_by_channel: list[int]) -> None:
        """Set all six channels now (refused by the Uno while queued frames are playing)."""
        self.command("A " + " ".join(str(u) for u in us_by_channel))

    def queue_frame(self, us_by_channel: list[int]) -> tuple[int, int]:
        """Append a frame to the Uno's 50 Hz playback queue. Returns (frames queued, underruns)."""
        _, _, queued, underruns = self.command("Q " + " ".join(str(u) for u in us_by_channel)).split()
        return int(queued), int(underruns)

    def status(self) -> tuple[int, int, int]:
        """(frames queued, underruns, frames played) for the current or last stream."""
        _, _, queued, underruns, played = self.command("?").split()
        return int(queued), int(underruns), int(played)

    def end_stream(self) -> None:
        """No more frames coming: the Uno plays out its queue, then holds."""
        self.command("E")

    def flush(self) -> int:
        """Drop queued frames; the servos hold the frame playing now. Returns frames dropped."""
        return int(self.command("F").split()[2])

    def close(self) -> None:
        if self.ser.is_open:
            self.ser.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
