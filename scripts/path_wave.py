"""Multi-axis periodic paths (circle, figure8, lissajous) using the shared TypeScript kinematics.

A path is a spec: {axis: [amplitude, harmonic, phase_deg]}, one sine per axis
(x/y/z in mm, roll/pitch/yaw in degrees). scripts/plan_path.ts solves and checks every
pose the motion can reach (home out to full size, the whole cycle) before anything
moves; this module then plays it through wave_runner, interpolating the horn angles
from the planner's (size, phase) table. IK lives only in packages/kinematics.
"""

import argparse
import json
import math
import sys
from collections.abc import Callable
from pathlib import Path

from axis_wave import run_planner
from rig_serial import IGNORE_LIMITS_HELP, check_channels, label, load_rig, outside_firmware_window
from wave_runner import run_motion

PLANNER = Path(__file__).resolve().parent / "plan_path.ts"
AXES = ("x", "y", "z", "roll", "pitch", "yaw")
UNITS = {"x": "mm", "y": "mm", "z": "mm", "roll": "deg", "pitch": "deg", "yaw": "deg"}

Spec = dict[str, list[float]]


def add_common_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--cycles", type=float, help="stop by itself after this many cycles")
    ap.add_argument("--port", help="serial port (default: auto-detect, or $STEWART_PORT)")
    ap.add_argument("--ignore-limits", action="store_true", help=IGNORE_LIMITS_HELP + "; poses with no IK solution are always refused")
    ap.add_argument(
        "--hold-at",
        type=float,
        metavar="PHASE",
        help="instead of looping, move smoothly to this point of the full-size path (degrees of phase, "
        "0-360, as shown in refusals and the status line), hold until Ctrl+C, and print what the model "
        "predicts there for each servo, to compare with the real rig",
    )


def describe(spec: Spec) -> str:
    parts = []
    for axis in AXES:
        if axis in spec and spec[axis][0] > 0:
            amp, harmonic, phase = spec[axis]
            extra = (f" x{harmonic:g}" if harmonic != 1 else "") + (f" @{phase:g} deg" if phase else "")
            parts.append(f"{axis} +/-{amp:g} {UNITS[axis]}{extra}")
    return ", ".join(parts)


def run_path(
    *,
    name: str,
    spec: Spec,
    period: float,
    args: argparse.Namespace,
    fits_hint: Callable[[float], str],
    status: Callable[[float, float], str] | None = None,
) -> int:
    """Plan, check and play one path. fits_hint(scale) turns the planner's largest fitting
    amplitude multiplier into advice in the script's own terms (e.g. "SIZE up to 18")."""
    if period <= 0:
        print("Refused: period must be positive.", file=sys.stderr)
        return 2
    if args.cycles is not None and args.cycles <= 0:
        print("Refused: --cycles must be positive.", file=sys.stderr)
        return 2

    rig = load_rig()
    servos = rig["servos"]
    msg = check_channels(servos)
    if msg:
        print(msg, file=sys.stderr)
        return 2

    p = run_planner(PLANNER, [json.dumps(spec)], args.ignore_limits)
    if not p["ok"]:
        hint = "" if "cannot be overridden" in p["error"] else " Pass --ignore-limits to override."
        fit = f" Try {fits_hint(p['fitsScale'])}." if p.get("fitsScale") else ""
        print(f"Refused: {p['error']}.{fit}{hint}", file=sys.stderr)
        return 2
    for w in p["warnings"]:
        print(f"Warning: {w} (--ignore-limits).", file=sys.stderr)

    table, rings, spokes = p["alphaDeg"], p["rings"], p["spokes"]
    columns = [[a[i] for ring in table for a in ring] for i in range(len(servos))]
    msg = outside_firmware_window(servos, [[min(c), max(c)] for c in columns])
    if msg:
        print(msg, file=sys.stderr)
        return 2

    omega = 2 * math.pi / period
    peak_horn = p["maxDegPerRad"] * omega
    vmax = rig.get("motion", {}).get("maxHornDegPerSec")
    if vmax is None:
        if not args.ignore_limits:
            print("Refused: rig.json has no motion.maxHornDegPerSec. Pass --ignore-limits to override.", file=sys.stderr)
            return 2
        print("Warning: rig.json has no motion.maxHornDegPerSec (--ignore-limits).", file=sys.stderr)
    elif peak_horn > vmax:
        min_period = 2 * math.pi * p["maxDegPerRad"] / vmax
        text = (
            f"peak horn speed would be about {peak_horn:.0f} deg/s, over the rig.json limit of {vmax:g} deg/s "
            f"(a period of at least {min_period:.1f} s keeps this path inside it)"
        )
        if not args.ignore_limits:
            print(f"Refused: {text}. Pass --ignore-limits to override.", file=sys.stderr)
            return 2
        print(f"Warning: {text} (--ignore-limits).", file=sys.stderr)
    if vmax is None or peak_horn > vmax:
        vmax = 1.25 * peak_horn  # overridden: follow the requested path (the ramp-in adds a little)

    def degs_at(s: float, phi: float) -> list[float]:
        # Bilinear interpolation on the (size, phase) grid, wrapping around the cycle.
        fr = min(max(s, 0.0), 1.0) * rings
        k = min(int(fr), rings - 1)
        wr = fr - k
        fa = (phi % (2 * math.pi)) / (2 * math.pi) * spokes
        j = int(fa) % spokes
        wa = fa - int(fa)
        j2 = (j + 1) % spokes
        a00, a01, a10, a11 = table[k][j], table[k][j2], table[k + 1][j], table[k + 1][j2]
        return [
            (1 - wr) * ((1 - wa) * a + wa * b) + wr * ((1 - wa) * c + wa * d)
            for a, b, c, d in zip(a00, a01, a10, a11)
        ]

    def default_status(s: float, phi: float) -> str:
        return f"size {s * 100:3.0f}%  phase {math.degrees(phi) % 360:5.1f} deg"

    by_label = sorted(range(len(servos)), key=lambda i: label(servos, i))

    if args.hold_at is not None:
        # Straight out from home to one point of the full-size path (s ramps 0 -> 1 at a fixed
        # phase, all inside the validated grid), then hold until Ctrl+C eases back.
        phase = args.hold_at % 360
        phi0 = math.radians(phase)
        horns = degs_at(1.0, phi0)
        spoke = round(phase / 360 * spokes) % spokes
        horn_rod = p["outerHornRodDeg"][spoke]
        rows = "\n".join(
            f"    servo {label(servos, i)}: horn {horns[i]:+6.1f} deg from level   horn-to-rod angle {horn_rod[i]:5.1f} deg"
            + ("   <- under the rig.json minimum" if horn_rod[i] < p["hornRodMinDeg"] else "")
            for i in by_label
        )
        banner = (
            f"{name}: {describe(spec)}. Moving to phase {phase:g} deg of the full-size path and holding.\n"
            f"  The model predicts (rig.json minimum horn-to-rod angle: {p['hornRodMinDeg']:g} deg):\n{rows}\n"
            "  Compare with the rig: horn angle from level (phone level app), and the angle at the bottom ball\n"
            "  between the horn and the rod. Holding until you press Ctrl+C, then easing back home."
        )
        # A hold has no reason to be quick: always move out and back within the rig.json speed limit,
        # even when --ignore-limits raised it for the looping path.
        rig_vmax = rig.get("motion", {}).get("maxHornDegPerSec") or vmax
        return run_motion(
            port=args.port,
            servos=servos,
            degs_at=lambda s, phi: degs_at(s, phi0),
            period=period,
            horn_speed_limit=min(vmax, rig_vmax),
            cycles=None,
            status=lambda s, phi: f"{s * 100:3.0f}% of the way to phase {phase:g} deg",
            banner=banner,
        )

    swing = ", ".join(f"{label(servos, i)}: {min(columns[i]):+.1f}..{max(columns[i]):+.1f}" for i in by_label)
    banner = (
        f"{name}: {describe(spec)}; {period:g} s per cycle (peak about {peak_horn:.0f} deg/s at the horns).\n"
        f"  Horn swing per servo, deg: {swing}."
    )
    return run_motion(
        port=args.port,
        servos=servos,
        degs_at=degs_at,
        period=period,
        horn_speed_limit=vmax,
        cycles=args.cycles,
        status=status or default_status,
        banner=banner,
    )
