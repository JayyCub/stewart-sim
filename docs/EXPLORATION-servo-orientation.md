# Exploration: servo orientation

_Branch `explore/servo-orientation`, 2026-10-27. Placeholder part sizes and limits (servo ±70°,
ball swivel 30°, MG996R listing dimensions); rerun once the Phase 0 measurements are in._

## Question

Would turning or tilting the servos (like rigs that mount each pair side by side on a wall) give
more motion, or let the servos tuck in tighter?

## What the model can now do

Three optional geometry angles (0 when omitted, so existing rig files and the original test vectors
are unchanged):

| Field | Meaning |
| --- | --- |
| `servoYawDeg` | Turn each servo about the vertical through its horn pivot, mirrored within a pair. Equal to `baseHalfAngleDeg` gives parallel shafts: both servos on one flat wall. |
| `servoTiltDeg` | Tilt each shaft out of horizontal; positive = outward and up, which leans the horn's swing plane inward. The bottom ball stud follows the shaft. |
| `topStudTiltDeg` | Tilt each top ball stud; positive = outward and up. |

IK, limit checks, collisions (now a 3D box-vs-box test), workspace, tilt map, sweep, 3D view and
templates all use them. `test-vectors/ik-orient-v1.json` covers a turned + tilted rig for the
firmware port.

## Findings

Score = geometric mean of the six single-axis spans over reference spans (see `REACH_REF`).
"Tilt area" = reachable cells of the ±35° roll × pitch map at home (71 × 71 grid).

**Placeholder layout, only the angles varied:**

| | Score | Tilt area | x / y / z span (mm) | roll / pitch / yaw span (°) |
| --- | --- | --- | --- | --- |
| Radial (today) | 1.19 | 940 | 73 / 67 / 39 | 33 / 38 / 93 |
| Turn only | 1.19 | 940 | (best turn is 0°) | |
| Tilts only (servo 15°, stud 10°) | 1.47 | 1372 | 104 / 99 / 42 | 40 / 46 / 99 |
| Turn 20°, servo tilt 20°, stud 10° | 1.51 | 1500 | 102 / 102 / 42 | 41 / 48 / 103 |

**Whole layout re-swept** (pair spacing, top spacing, platform radius, plus the angles):

| Rod | | Score | Tilt area | x / y / z (mm) | roll / pitch / yaw (°) | Layout |
| --- | --- | --- | --- | --- | --- | --- |
| 120 | best radial | 1.37 | 640 | 129 / 118 / 41 | 27 / 32 / 94 | pair ½ 22°, top ½ 28°, platform r 85 |
| 120 | best with angles | 1.63 | 2354 | 98 / 92 / 43 | 53 / 59 / 120 | pair ½ 30°, top ½ 19°, platform r 45, turn 0°, servo tilt 25°, stud 20° |
| 150 | best radial | 1.49 | 650 | 152 / 149 / 41 | 27 / 32 / 106 | pair ½ 22°, top ½ 28°, platform r 85 |
| 150 | best with angles | 1.70 | 2503 | 110 / 103 / 42 | 53 / 62 / 120 | pair ½ 10°, top ½ 28°, platform r 45, turn 25°, servo tilt 25°, stud 20° |

## What it means

- **Tilting is where the gain is.** Tilting shafts and top studs outward-and-up squares the ball
  joints to the rods at home (each joint used ~13° of its 30° swivel at home before), so roll and
  pitch roughly double and the reachable roll × pitch area grows 2.5–4×.
- **Turning the servos is a packaging tool, not a reach tool.** On its own it buys nothing, but it
  lets a pair sit much closer: radial pairs clash below ~14.5° half-spacing, parallel ones fit down
  to ~7°. The best rod-150 layout uses this (10° spacing, 25° turn).
- **The trade:** the angled layouts give up some surge/sway (≈110 mm span instead of ≈150 mm) for
  double the roll/pitch. For a ride or flight-style motion base that is usually the right trade.
- **Simplest build that gets most of it:** rod 120, no turn, servo tilt 25°, stud tilt 20° (score
  1.63 vs 1.70). One plain wedge angle under each servo and an angled washer or bracket under each top
  stud; no compound angles.

## Caveats before trusting this

- Ball swivel (30°) and servo travel are placeholders. The gain comes mostly from freeing the ball
  joints, so measure `ballSwivelDeg` first.
- The rod is modelled in the horn plane (the ball stud's sideways offset is ignored).
- Single-axis reach and the roll × pitch map don't capture combined motions or load. Torque per
  servo isn't checked yet; tilted servos change the load path.
- Tilted mounts are a new part to make accurately (printed cradle with the angle built in, or cut
  wedges). The templates draw each tilted body's outline seen from above, not the wedge itself.

## Whole-design optimiser (`pnpm optimize`)

Later on the same branch: `scripts/optimize.ts` searches all nine geometry and mount parameters at
once (differential evolution, then a pattern-search polish; ~50 s, seed-repeatable) and adds what
the sweep lacked:

- **Servo torque.** Rod forces from statics for a payload at the platform centre (`legTorques`,
  cross-checked against virtual work through the IK Jacobian), checked at home and at 80% of each
  axis's reach. Designs over the limit are penalised by (limit / torque)⁴.
- **Weights** per axis (config: roll and pitch 1.5, heave 1, surge/sway 0.75, yaw 0.5).
- **Servo clearance** (3 mm) and discrete horn holes.
- Three variants, each seeded with the previous winners: radial, tilt only, turn + tilt.

Results with the default config (1 kg payload, 5.5 kg·cm usable torque):

| | Score | x / y / z (mm) | roll / pitch / yaw (°) | Tilt area | Max torque |
| --- | --- | --- | --- | --- | --- |
| Placeholder layout | 0 | (servos within 3 mm; and needs 43 kg·cm off home) | | 19% | 42.7 kg·cm |
| Best radial | 1.78 | 125 / 112 / 43 | 54 / 65 / 120 | 53% | 1.2 kg·cm |
| Best tilt only | 1.97 | 151 / 147 / 47 | 57 / 67 / 120 | 58% | 2.2 kg·cm |
| Best turn + tilt | 1.97 | 151 / 147 / 47 | 58 / 67 / 120 | 58% | 4.9 kg·cm |

What changed from the hand sweeps above:

- **The placeholder layout must not be built.** Away from home it is close to a singular pose:
  15–27 mm of surge or sway needs 26–43 kg·cm to hold 1 kg, far past an MG996R. The optimised
  radial layouts need ~1.2 kg·cm.
- **Tilt still helps, but less than the torque-blind sweep said:** ~8–9° wedges under the servos and
  ~9° under the top studs, about +10% score and +20% surge/sway over the best radial design.
- **Turning the servos isn't worth building.** Turn + tilt ties tilt-only, at more torque.
- **Several parameters sit on their limits** (rod 170 mm, horn 25 mm, base radius ~65 mm), so the
  real answer depends on what the parts allow. Set those ranges from measurements in
  `scripts/optimize.config.json`, then rerun.

## If this is adopted

Merge the branch. After the Phase 0 measurements: put the measured limits in rig.json, set the rod,
horn-hole and plate-size ranges in `scripts/optimize.config.json`, run `pnpm optimize`, load the
winning `optimized/tilt-1.rig.json` (or `radial-1` for the simplest build) in the sim, and check it
on the tilt map before printing templates.
