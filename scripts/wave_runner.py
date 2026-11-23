"""Shared motion loop for the bench scripts (heave, surge, sway, circle, roll, pitch, yaw).

A motion is a periodic path described by two numbers: a size s (0 = home, 1 = full
size) and a phase phi (radians, advancing 2*pi per period). The caller supplies
degs_at(s, phi) -> six horn angles, and must have validated every pose the path can
reach for s in [0, 1] before calling run_motion.

Timing: the laptop does not drive the servos frame by frame. It computes frames at
exact 20 ms steps along the path and keeps the Uno's frame queue about half full
(TARGET_FILL); the Uno plays one frame every 20 ms on its own clock. A laptop or USB
stall shorter than the queued time never reaches the servos. If the queue does run
dry (an underrun), the servos hold the last frame, which is a validated pose.

Behaviour shared by all scripts:
  - The first period ramps s from 0 up to 1, so motion starts gently from home.
  - Speed limit: no horn moves more than horn_speed_limit * 20 ms between frames; the
    path slows down rather than cut corners, so every frame is a pose on the path.
  - Ctrl+C or SIGTERM: s eases back to 0 (home) while phi keeps advancing. The ease
    starts after the frames already queued (about TARGET_FILL * 20 ms). The loop waits
    for the Uno to finish playing, then returns 0 with the platform holding home.
  - A second Ctrl+C flushes the queue: the servos hold where they are; returns 130.
  - A serial error stops the loop. The Uno plays out what it has queued (validated
    frames, under a second) and then holds.
  - On every exit, prints a timing report: underruns, the worst laptop stall the queue
    absorbed, and the lowest the queue got.
"""

import math
import signal
import sys
import time
from collections.abc import Callable

from rig_serial import FRAME_S, QUEUE_LEN, Link, LinkError, PortOpenError, find_port, frame_us

TARGET_FILL = 25  # frames kept queued on the Uno: 0.5 s of cushion
STATUS_HZ = 10
assert TARGET_FILL < QUEUE_LEN


class TimingStats:
    """What the queue absorbed: laptop stalls between sends, and the lowest queue level."""

    def __init__(self) -> None:
        self.worst_gap = 0.0
        self.min_queued: int | None = None  # tracked once the queue first reaches TARGET_FILL
        self.filled = False
        self.underruns = 0
        self.played = 0
        self._last: float | None = None

    def sent(self, queued: int, underruns: int) -> None:
        now = time.monotonic()
        if self._last is not None:
            self.worst_gap = max(self.worst_gap, now - self._last)
        self._last = now
        self.underruns = underruns
        if queued >= TARGET_FILL:
            self.filled = True
        if self.filled:
            self.min_queued = queued if self.min_queued is None else min(self.min_queued, queued)

    def report(self) -> str:
        if self._last is None:
            return "Timing: no frames sent."
        ms = lambda v: f"{v * 1000:.0f} ms"
        cushion = "n/a" if self.min_queued is None else ms(self.min_queued * FRAME_S)
        if self.underruns == 0:
            verdict = "smooth, no underruns"
        else:
            verdict = f"{self.underruns} underrun(s): the servos paused for {ms(self.underruns * FRAME_S)} in total"
        played = f"Uno played {self.played} frames on its 50 Hz clock, " if self.played else ""
        return (
            f"Timing: {played}{verdict}. Worst laptop stall: {ms(self.worst_gap)}; "
            f"queue never below {cushion} (target {ms(TARGET_FILL * FRAME_S)})."
        )


def run_motion(
    *,
    port: str | None,
    servos: list[dict],
    degs_at: Callable[[float, float], list[float]],
    period: float,
    horn_speed_limit: float,
    cycles: float | None,
    status: Callable[[float, float], str],
    banner: str,
) -> int:
    stop_requests = 0

    def on_signal(_sig, _frame):
        nonlocal stop_requests
        stop_requests += 1

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    omega = 2 * math.pi / period
    ease_len = max(1.0, period / 2)  # path time to ease back home
    dt = FRAME_S
    tau_stop: float | None = None  # path time when the ease began
    s_stop = 0.0

    def size(tau: float) -> float:
        if tau_stop is None:
            return 0.5 * (1 - math.cos(math.pi * tau / period)) if tau < period else 1.0
        u = min(1.0, (tau - tau_stop) / ease_len)
        return s_stop * 0.5 * (1 + math.cos(math.pi * u))

    tau = 0.0  # path time of the last frame queued; advances <= 20 ms per frame
    current = degs_at(0.0, 0.0)
    timing = TimingStats()
    allowed = horn_speed_limit * dt  # largest horn step between two frames

    def flush_and_hold(link: Link, why: str) -> int:
        link.flush()
        _, timing.underruns, timing.played = link.status()
        print(f"\n{why} Queue flushed; servos holding where they are.")
        return 130

    try:
        with Link(find_port(port)) as link:
            queued, underruns = link.queue_frame(frame_us(servos, current))
            timing.sent(queued, underruns)
            print(banner + " Ctrl+C to stop.")
            last_status = 0.0
            while True:
                if stop_requests >= 2:
                    return flush_and_hold(link, "Stopped at once.")
                if tau_stop is None and (stop_requests or (cycles and tau >= cycles * period)):
                    s_stop, tau_stop = size(tau), tau
                    print(f"\nReturning to home after the {queued * dt:.1f} s already queued... (Ctrl+C again to stop at once)")

                # Next frame, exactly 20 ms further along the path, or less if a horn would go too fast.
                d_tau = dt
                for _ in range(4):
                    target = degs_at(size(tau + d_tau), omega * (tau + d_tau))
                    step = max(abs(a - b) for a, b in zip(target, current))
                    if step <= allowed * 1.001 or step == 0:
                        break
                    d_tau *= allowed / step
                else:
                    target = degs_at(size(tau + d_tau), omega * (tau + d_tau))  # keep target on the path at tau + d_tau
                tau += d_tau
                current = target
                done = tau_stop is not None and tau - tau_stop >= ease_len
                if done:
                    current = degs_at(0.0, omega * tau)

                queued, underruns = link.queue_frame(frame_us(servos, current))
                timing.sent(queued, underruns)

                now = time.monotonic()
                if now - last_status >= 1.0 / STATUS_HZ:
                    print(f"\r  {status(size(tau), omega * tau)}   ", end="", flush=True)
                    last_status = now

                if done:
                    link.end_stream()
                    while True:  # let the Uno finish playing before reporting home
                        if stop_requests >= 2:
                            return flush_and_hold(link, "Stopped at once.")
                        queued, timing.underruns, timing.played = link.status()
                        if queued == 0:
                            break
                        time.sleep(min(0.1, queued * dt))
                    print("\nStopped. Platform at home, horns level and holding.")
                    return 0

                # Keep about TARGET_FILL frames queued: sleep while the Uno plays the surplus.
                if queued >= TARGET_FILL:
                    time.sleep((queued - TARGET_FILL + 1) * dt)
    except PortOpenError as e:
        print(f"\n{e}", file=sys.stderr)
        return 1
    except LinkError as e:
        print(
            f"\n{e}\nThe Uno plays out the frames it already has (validated, under a second) and then holds.",
            file=sys.stderr,
        )
        return 1
    finally:
        print(timing.report())
