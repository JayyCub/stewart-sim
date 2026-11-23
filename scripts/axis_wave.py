"""Single-axis platform wave (surge, sway, roll, pitch, yaw) using the shared TypeScript kinematics.

scripts/plan_axis.ts solves and checks a table of poses covering the whole swing
(servo range, ball swivel, collisions) before anything moves; this module then plays
a sine wave along that axis through wave_runner, interpolating horn angles from the
table. IK lives only in packages/kinematics, never in Python.
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from rig_serial import IGNORE_LIMITS_HELP, check_channels, label, load_rig, outside_firmware_window
from wave_runner import run_motion

REPO = Path(__file__).resolve().parent.parent
PLANNER = REPO / "scripts" / "plan_axis.ts"


def run_planner(planner: Path, args: list[str], ignore_limits: bool) -> dict:
    """Run a TypeScript planner (plan_axis.ts, plan_path.ts) and return its JSON."""
    cmd = ["node", "--experimental-strip-types", "--no-warnings", str(planner), *args]
    if ignore_limits:
        cmd.append("--ignore-limits")
    try:
        res = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        sys.exit("node not found. The planner needs Node 22 (see .nvmrc; `nvm use`).")
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        sys.exit(f"Planner failed (needs Node 22, see .nvmrc):\n{res.stderr.strip() or res.stdout.strip()}")


def plan(axis: str, amplitude: float, ignore_limits: bool) -> dict:
    return run_planner(PLANNER, [axis, repr(amplitude)], ignore_limits)


ROTATIONS = ("roll", "pitch", "yaw")


def main(axis: str, name: str, direction_note: str) -> int:
    unit = "deg" if axis in ROTATIONS else "mm"
    motion = f"rotate it back and forth about {axis}" if axis in ROTATIONS else f"slide it back and forth along {axis}"
    ap = argparse.ArgumentParser(prog=name, description=f"{name.capitalize()} the platform: {motion} ({direction_note}).")
    ap.add_argument(
        "amplitude",
        type=float,
        help="platform rotation either side of home, degrees" if axis in ROTATIONS else "platform travel either side of home, mm",
    )
    ap.add_argument("period", type=float, help="seconds per full back-and-forth cycle")
    ap.add_argument("--cycles", type=float, help="stop by itself after this many cycles")
    ap.add_argument("--port", help="serial port (default: auto-detect, or $STEWART_PORT)")
    ap.add_argument("--ignore-limits", action="store_true", help=IGNORE_LIMITS_HELP + "; poses with no IK solution are always refused")
    args = ap.parse_args()

    amp, period = args.amplitude, args.period
    if amp <= 0 or period <= 0:
        ap.error("amplitude and period must be positive")
    if args.cycles is not None and args.cycles <= 0:
        ap.error("--cycles must be positive")

    rig = load_rig()
    servos = rig["servos"]
    msg = check_channels(servos)
    if msg:
        print(msg, file=sys.stderr)
        return 2

    p = plan(axis, amp, args.ignore_limits)
    if not p["ok"]:
        hint = "" if "cannot be overridden" in p["error"] else " Pass --ignore-limits to override."
        print(f"Refused: {p['error']}.{hint}", file=sys.stderr)
        return 2
    for w in p["warnings"]:
        print(f"Warning: {w} (--ignore-limits).", file=sys.stderr)

    samples, table = p["samples"], p["alphaDeg"]
    columns = [[row[i] for row in table] for i in range(len(servos))]
    msg = outside_firmware_window(servos, [[min(c), max(c)] for c in columns])
    if msg:
        print(msg, file=sys.stderr)
        return 2

    # Peak horn speed = steepest horn change per unit of motion * peak platform speed.
    slope = p["maxSlopeDegPerUnit"]
    vmax = rig.get("motion", {}).get("maxHornDegPerSec")
    peak_rate = 2 * math.pi * amp / period
    peak_horn = slope * peak_rate
    if vmax is None:
        if not args.ignore_limits:
            print("Refused: rig.json has no motion.maxHornDegPerSec. Pass --ignore-limits to override.", file=sys.stderr)
            return 2
        print("Warning: rig.json has no motion.maxHornDegPerSec (--ignore-limits).", file=sys.stderr)
    elif peak_horn > vmax:
        min_period = 2 * math.pi * amp * slope / vmax
        text = (
            f"peak horn speed would be about {peak_horn:.0f} deg/s, over the rig.json limit of {vmax:g} deg/s "
            f"(a period of at least {min_period:.1f} s keeps +/-{amp:g} {unit} inside it)"
        )
        if not args.ignore_limits:
            print(f"Refused: {text}. Pass --ignore-limits to override.", file=sys.stderr)
            return 2
        print(f"Warning: {text} (--ignore-limits).", file=sys.stderr)
    if vmax is None or peak_horn > vmax:
        vmax = 1.25 * peak_horn  # overridden: follow the requested wave (ramp adds up to 25%)

    n = len(samples)
    lo, step = samples[0], (samples[-1] - samples[0]) / (n - 1)

    def degs_at(q: float) -> list[float]:
        # Linear interpolation between validated neighbouring poses.
        f = min(max((q - lo) / step, 0.0), n - 1.0)
        k = min(int(f), n - 2)
        w = f - k
        return [a + (b - a) * w for a, b in zip(table[k], table[k + 1])]

    by_label = sorted(range(len(servos)), key=lambda i: label(servos, i))
    swing = ", ".join(f"{label(servos, i)}: {min(columns[i]):+.1f}..{max(columns[i]):+.1f}" for i in by_label)
    banner = (
        f"{name.capitalize()} +/-{amp:g} {unit} every {period:g} s (peak about {peak_horn:.0f} deg/s at the horns).\n"
        f"  Horn swing per servo, deg: {swing}."
    )
    return run_motion(
        port=args.port,
        servos=servos,
        degs_at=lambda s, phi: degs_at(amp * s * math.sin(phi)),
        period=period,
        horn_speed_limit=vmax,
        cycles=args.cycles,
        status=lambda s, phi: f"{axis} {amp * s * math.sin(phi):+7.2f} {unit}",
        banner=banner,
    )
