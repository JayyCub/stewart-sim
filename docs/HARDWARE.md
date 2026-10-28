# Hardware

## Parts on hand

| Part | Spec (from the listings) | Notes |
| --- | --- | --- |
| 6 × Deegoo-FPV MG996R servos | Metal gear, 12 kg·cm at 6 V / 13 kg·cm at 7.2 V; 0.17 s/60° at 4.8 V no load; body ~40.7 × 19.7 × 42.9 mm | Standard 25T spline horns |
| Dorhea PCA9685 16-ch PWM board | I²C, 12-bit; servo power terminal 5–10 V (onboard cap rated 10 V) | Keeps PWM timing off the Uno |
| Arduino Uno | ATmega328P, 2 KB RAM, 32 KB flash | Tight for FreeRTOS and on-board show storage |
| Litoexpe M3 × 150 mm threaded rod, 10 pk | 304 stainless, fully threaded | Pushrods; need 6 |
| uxcell M3 ball-head rod ends, 29 mm | Centre hole 3.0 mm, M3 threaded bottom hole | Need 12 (2 per leg); extras on hand |
| Hapric 600-pc M3 screw kit | 6–30 mm socket caps, nuts, washers | Joints and mounting |
| Arkare 5 V 1 A adapter | 5 W max | Too small for a loaded rig (see Power) |

## Power

An MG996R can pull ~2.5 A at stall; six under load can draw 5–10 A combined. An unloaded sweep
on the 1 A adapter worked earlier, but a loaded platform draws much more.

- Use a **5–6 V supply rated 10 A or more** on the PCA9685 V+ screw terminal.
- Do not power servos from the Uno's 5 V pin. Tie all grounds together.
- Stay at or below 6 V (the board's capacitor is rated 10 V; the servos are happiest ≤ 6 V).
- Symptoms of an undersized supply: jitter, sagging, the Uno resetting mid-motion.

## Build approach

Iterate geometry in software, not in plastic. Everything that sets range of motion is either a
flat plate or adjustable:

- **Plates**: 1/4" (6 mm) plywood, MDF or HDPE, drilled from a 1:1 printed template exported by
  the sim. Laser-cut acrylic/aluminium (SendCutSend, Ponoko, a makerspace) later from the same
  2D drawing.
- **Horn length**: choose the horn hole; drill it out to 3 mm for an M3 bolt.
- **Rod length**: thread depth into the ball ends; lock with jam nuts.
- **Adjustability**: radial slots for servo mounts and two or three rings of holes on the top
  plate let one set of plates test several geometries.
- **Servo mounts** are the only 3D part, and they don't depend on geometry: one MG996R cradle
  printed ×6 (e.g. https://www.printables.com/model/11782-hobby-servo-holder-for-mg996r), or wood
  blocks / aluminium L-brackets.
- Servos stand upright, shaft horizontal and radial, horns swinging in the plane tangent to the
  base circle. Pairs are mirrored, horns pointing away from each other.
- Ball links bind at roughly ±25–30° on cheap parts, often before the servos run out of travel:
  measure it.

## Starting geometry (placeholder in rig.json)

Typical hobby MG996R builds land around these; confirm with the sim once measurements are in.

| Parameter | Value |
| --- | --- |
| Base radius (centre to horn pivot) | 85 mm |
| Platform radius (centre to top joint) | 60 mm |
| Servo pair half-spacing | 15° |
| Top joint half-spacing | 30° |
| Horn length | 22 mm |
| Rod length (ball centre to ball centre) | 120 mm |

With these and limits of ±70° servo / 30° ball swivel the sim gives: home height 116.7 mm;
single-axis reach about x −34/+39 mm, y ±33 mm, z ±21 mm, roll ±16°, pitch −19/+19°, yaw ±46°.
At 15° half-spacing the inner ends of paired servo bodies nearly touch; check clearance before
cutting.

## Phase 0 measurement checklist

- [ ] Horn hole radius you will use (`geometry.hornLength`)
- [ ] Rod ball-centre to ball-centre with ends threaded on (`geometry.rodLength`)
- [ ] Ball-joint tilt before binding, both directions (`limits.ballSwivelDeg`)
- [ ] Servo travel either side of level (`limits.servoMinDeg`, `limits.servoMaxDeg`)
- [ ] Pulse width at each end of travel, per servo (`servos[].centerUs`, `servos[].usPerDeg`)
- [ ] MG996R body dimensions and shaft offset (for the 3D model and collision check)

Set `"measured": true` in rig.json once every value is real.
