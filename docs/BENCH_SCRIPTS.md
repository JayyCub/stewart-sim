# Bench scripts

Command-line tools for driving the real rig from the laptop. Run them from the repo root.

## One-time setup

```
brew install arduino-cli
arduino-cli core install arduino:avr
arduino-cli lib install "Adafruit PWM Servo Driver Library"
python3 -m pip install pyserial
```

Flash the bench firmware (once, or after changing it):

```
arduino-cli board list                                            # find the port
arduino-cli compile --fqbn arduino:avr:uno firmware/servo_test
arduino-cli upload -p <port> --fqbn arduino:avr:uno firmware/servo_test
```

Surge, sway, roll, pitch, yaw, circle, figure8 and lissajous also need Node 22 (`nvm use`), because they use the TypeScript kinematics.

## Conventions

- **Servo numbers are the numbers written on the servos (1–6).** `rig.json` maps each to its
  channel (`servos[].label`), so you never use channel or leg numbers.
- **Horn angles** are degrees from level. Positive raises the horn tip.
- **Directions:** +x (surge) is the front: between servos 1 and 6 (back: between 3 and 4). +y (sway)
  is 90° counter-clockwise from +x seen from above, toward servo 5 (-y toward servo 2). The front is
  set by `geometry.frontDeg` in `rig.json` (60 = the gap between servos 1 and 6; 0 = the 1/2 pair). Roll, pitch and yaw turn about the centre
  of the top plate at ball-joint height.
- **Stopping a wave:** Ctrl+C eases back to home and holds. The ease starts after the half second
  of motion already queued on the Uno (see Timing below). A second Ctrl+C flushes that queue, so the
  servos hold where they are at once. `pkill -f scripts/<name>` from another terminal works like the
  first Ctrl+C.
- **One script at a time.** Each script resets the Uno when it connects (about 2 s).

## Commands

| Command | Arguments | What it does |
|---|---|---|
| `scripts/move_servo SERVO DEG` | `SERVO` 1–6; `DEG` horn angle, or `off` | Moves one servo, or lets it go limp. |
| `scripts/servo_reset` | none | Sets all horns to 0° in one frame. No easing, because the scripts can't read where the horns are. |
| `scripts/heave AMP PERIOD` | `AMP` horn degrees either side of level; `PERIOD` seconds per cycle | All horns rise and fall together (vertical motion). |
| `scripts/surge AMP PERIOD` | `AMP` mm either side of home; `PERIOD` seconds per cycle | Slides the platform back and forth along x. |
| `scripts/sway AMP PERIOD` | `AMP` mm either side of home; `PERIOD` seconds per cycle | Slides the platform side to side along y. |
| `scripts/circle RADIUS PERIOD` | `RADIUS` mm; `PERIOD` seconds per lap | Moves the platform centre around a horizontal circle, staying level, at home height and without turning. Spirals out over the first lap and back in on Ctrl+C. |
| `scripts/figure8 SIZE PERIOD` | `SIZE` mm of surge either side of home (other axes scale with it); `PERIOD` seconds per figure 8 | A 3D figure 8 using all six axes: surge ×1, sway ×2, heave ×2 (up at the crossing), roll banking into each loop, pitch ×2 and yaw. `--flat` keeps only surge and sway. |
| `scripts/lissajous PERIOD --AXIS SPEC …` | `PERIOD` seconds per cycle; one `--x/--y/--z/--roll/--pitch/--yaw AMP[:HARMONIC[:PHASE]]` per axis | Build your own motion: each axis gets a sine wave with its own amplitude (mm or degrees), harmonic (1–6 repeats per cycle) and phase (degrees). |
| `scripts/roll AMP PERIOD` | `AMP` degrees either side of level; `PERIOD` seconds per cycle | Tips the platform side to side about x. Positive raises the +y side (servo 5) and lowers the servo 2 side. |
| `scripts/pitch AMP PERIOD` | `AMP` degrees; `PERIOD` seconds per cycle | Tips the platform front to back about y. Positive lowers the front (servos 1/6) and raises the back (3/4). |
| `scripts/yaw AMP PERIOD` | `AMP` degrees; `PERIOD` seconds per cycle | Twists the platform about the vertical axis. Positive is counter-clockwise from above. |

### Options

| Option | Scripts | Meaning |
|---|---|---|
| `--cycles N` | all wave and path scripts | Stops by itself after N cycles or laps (fractions allowed). |
| `--clockwise` | circle | Goes clockwise seen from above. The default is counter-clockwise, from +x toward +y. |
| `--flat` | figure8 | Surge and sway only: a level figure 8. |
| `--hold-at PHASE` | circle, figure8, lissajous | Instead of looping, move smoothly (within the `rig.json` speed limit) to that point of the full-size path, in degrees of phase as shown in refusals, and hold until Ctrl+C. Prints the model's horn angle and horn-to-rod angle for each servo there, to compare with the real rig. |
| `--ignore-limits` | all except servo_reset | Warns instead of refusing when a `rig.json` limit is exceeded (horn range, horn speed, ball-joint angle, collisions). |
| `--port PATH` | all | Serial port. By default the script finds the Uno itself, or uses `$STEWART_PORT`. |

### Examples

```
scripts/move_servo 3 15          # servo 3 horn up 15°
scripts/move_servo 3 off
scripts/servo_reset
scripts/heave 10 4               # ±10° at the horns, 4 s per cycle
scripts/surge 20 6 --cycles 3    # ±20 mm, 6 s per cycle, stop after 3
scripts/sway 50 4 --ignore-limits
scripts/circle 20 6               # 20 mm radius, 6 s per lap
scripts/circle 30 8 --clockwise --cycles 2
scripts/figure8 15 8              # 3D figure 8, all six axes
scripts/lissajous 8 --roll 6 --pitch 6:1:90        # tilt that wobbles round in a circle
scripts/lissajous 8 --z 6:2 --yaw 10 --x 10:1:90   # mix anything
scripts/roll 5 6                 # ±5° roll, 6 s per cycle
scripts/yaw 10 8 --cycles 2
```

## Live control from the sim

`pnpm dev`, open http://localhost:5173 in desktop Chrome or Edge, and use the **Hardware** panel
(top of the right rail). Same firmware (`servo_test` v3) as the scripts; close the serial monitor
and any running script first.

1. **Connect to Uno…** picks the port (the Uno resets, as with the scripts).
2. **Level horns and go live**: every horn to 0° in one frame (like `servo_reset`), then the rig
   follows the Pose sliders and the roll × pitch map.
3. **Stop** (or **Esc**, or switching tabs) flushes the queue: the rig holds where it is and the
   sliders jump to that pose. **Resume following** continues from it.
4. **Release (limp)** turns all six channels off; **Disconnect** closes the port (servos keep holding).

Checks: IK, servo range, ball swivel and collisions on the *loaded* rig.json (slider edits to
geometry or limits are not used), horn speed capped at the panel's speed × `motion.maxHornDegPerSec`,
pulses inside 500-2500 us. A slider pose that fails is ignored (the rig stays at the last valid
pose). Loading a different rig.json, or any serial error, stops and requires Level again.
Frames stream through the 48-frame queue with ~80 ms queued, so the rig lags the sliders by that. The speed slider starts at 100% of
`motion.maxHornDegPerSec`; that rig.json value is the real ceiling.

## Finding the real limits (Servo limits panel)

The **Servo limits** panel (under Hardware in the sim) jogs one servo at a time so you can find
where the rig physically stops, mark it, and turn the marks into rig.json values. Only one panel
can hold the port; disconnect the other first.

1. **Connect**, then **Level horns** (all to 0° at once, like `servo_reset`).
2. If a horn doesn't look level at 0°, jog it until it is and press **Horn is level**. That sets
   its `trimUs`, and every other mark is then measured from the true level.
3. Each servo has a slider (labelled with the number written on it; shaded = rig.json servo range).
   The servo follows its slider at the jog speed. For fine moves, click a slider and use the arrow
   keys (0.2° per press). The last slider touched is the servo a mark applies to. By default
   the panel stops just before the model's own limit and says which one. Tick **Go past software
   limits** to keep going to the real stop (the bench version of `--ignore-limits`; the 500-2500 µs
   window still applies). Near contact use the arrow keys and stop at **first touch**: an MG996R
   pushing on a hard stop draws stall current and can strip its gears.
4. Choose what stopped it (hard stop, rod on horn, rod on servo, lower/upper ball joint, binding)
   and press **Upper stop** or **Lower stop**. The mark stores the pulses on all six channels.
5. **Ramp all to level** between servos. The 3D view shows the model's pose for the current horn
   angles (forward kinematics), so you can compare it with the real rig while you jog.

The log re-runs the model at each mark and says whether the software would have let the rig go
further than the real contact (unsafe) or stops short. **Suggested rig.json** takes the most
restrictive mark per limit, less the margin (2° / 0.5 mm by default):

| Cause | Sets | Measured at the mark |
|---|---|---|
| Hard stop | `limits.servoMaxDeg` / `servoMinDeg` | horn angle |
| Lower / upper ball joint | `limits.ballSwivelDeg` | rod tilt off the stud's perpendicular, jogged leg |
| Rod on horn | `collision.hornRodMinDeg` | horn-rod angle at the bottom ball |
| Rod on servo | `collision.rodRadius` | rod centre line to nearest servo body |
| Binding / other | nothing | shown for the record |

One limit covers all six servos, so a suggestion that *loosens* a limit warns until every servo has
a mark. A joint mark far from the current limit (>10° / 3 mm) is flagged: more likely the cause or
the geometry is wrong than the limit. **Apply to sim** loads the result (only while servos are
released or disconnected, since new trims shift every horn); **Copy rig.json** puts it on the
clipboard to paste over `packages/rig-config/rig.json`. Marks live in the browser until cleared;
**Export log** saves `limit-marks-<date>.json` for the repo, and **Import log** loads one back.

## Safety checks

Before anything moves, every script checks:

- **Horn range:** `limits.servoMinDeg`/`servoMaxDeg` in `rig.json` (±99.8° since 2026-11-21, swept clear on servo 1 only).
- **Horn speed:** `motion.maxHornDegPerSec` (90°/s; raised from 60 on 2026-11-18, not yet tried on the rig). When a request is too fast, the refusal says
  the shortest period that would work. While running, if any horn would go faster, the motion slows
  down along its path, so every frame is still a checked pose.
- **Every motion except heave:** every pose the motion can reach (home out to full size, the whole
  cycle) is solved with the shared IK and checked for servo range, ball-joint angle and collisions:
  `scripts/plan_axis.ts` for single-axis waves, `scripts/plan_path.ts` for multi-axis paths. A
  refusal says how far the rig can actually reach (e.g. "Try SIZE up to 20.9").
- **The firmware's 500–2500 µs pulse window.** Checked on the laptop and again on the Uno.
  `--ignore-limits` does not override it, and poses with no IK solution are always refused.

Waves start gently: the first cycle ramps up from zero.

## Checking the model against the rig

The limits are only as good as `rig.json`. When a refusal names a servo and a phase (e.g. "servo 5
rod-hits-horn at phase 275 deg"), freeze the rig there and compare:

```
scripts/figure8 22 3 --ignore-limits --hold-at 282
```

It prints what the model expects (horn angle from level, and the angle between horn and rod at the
bottom ball) for every servo. Measure the real ones: a phone level app on the horn works. If the
horn angles differ, the servo calibration (`usPerDeg`, `trimUs`) is off. If the horn angles match
but the horn-to-rod angles don't, the geometry (ball centre positions) is off. If the rig clearly
has room where the model says it doesn't, a placeholder limit (`hornRodMinDeg`, `ballSwivelDeg`)
is too strict.

## Timing

The motion scripts compute every frame on the laptop but don't send them live. They keep about
0.5 s of upcoming frames queued on the Uno (up to 48 frames), and the Uno plays one frame every
20 ms on its own clock. A laptop or USB stall shorter than the queued time doesn't reach the servos.
If the queue runs dry anyway (an underrun), the servos hold the last frame, which is a checked pose,
and carry on once frames arrive again. If the laptop or cable goes away entirely, the Uno plays out
what it has (under a second, all checked) and holds.

Every run ends with a timing line, for example:

```
Timing: Uno played 610 frames on its 50 Hz clock, smooth, no underruns. Worst laptop stall: 425 ms; queue never below 100 ms (target 500 ms).
```

Underruns mean the servos actually paused. A low "queue never below" with no underruns means the
queue did its job.

## Files

| File | Role |
|---|---|
| `scripts/rig_serial.py` | Reads `rig.json`; serial link to the Uno; degree→pulse conversion; label lookup. |
| `scripts/wave_runner.py` | Shared motion loop: ramp-in, slowing down along the path at the speed limit, keeping the Uno's queue topped up, Ctrl+C easing, timing report. |
| `scripts/axis_wave.py` | Surge, sway, roll, pitch, yaw: runs `plan_axis.ts`, then plays the wave from its table. |
| `scripts/path_wave.py` | Circle, figure8, lissajous: runs `plan_path.ts` for a spec (one sine per axis), checks speed, then plays the path from its table. New multi-axis scripts are a spec plus a few lines here. |
| `scripts/plan_axis.ts` | Solves and checks 401 poses along one axis with `packages/kinematics`; prints a JSON table. |
| `scripts/plan_path.ts` | Solves and checks a 41 (size) × 360 (phase) grid over everything a multi-axis path can reach; prints a JSON table, or on refusal the largest scale that fits. |
| `apps/sim/src/hardware/link.ts` | Live control's serial link (Web Serial): the browser version of `rig_serial.py`, same protocol and READY check. |
| `apps/sim/src/hardware/live.ts` | Live control: connect, level, follow the sim pose through the queue, stop/hold, release. |
| `packages/kinematics/src/follow.ts` | One validated, speed-limited step from the pose sent last toward the slider pose (used by live control). |
| `firmware/servo_test/` | Uno sketch (v3). Serial at 115200 baud. Immediate: `S <ch> <us>`, `A <us0>…<us5>` (all six at once, rejected whole if any value is bad), `O <ch>` (off). Streaming: `Q <us0>…<us5>` (queue a frame), `?` (status), `E` (end of stream), `F` (flush). Immediate commands are refused while queued frames are playing. |
