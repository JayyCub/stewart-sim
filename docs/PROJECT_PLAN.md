# Project plan

One browser app designs the rig, previews every motion before the hardware runs it, and later
programs shows. It shares one kinematics definition with the firmware, so the sim predicts the
machine instead of approximating it.

Goals:

- Pick base and platform geometry in software, so plywood is cut once.
- Check every motion against servo and ball-joint limits before it reaches the rig.
- Author shows on a keyframe timeline, synced to audio.
- Portfolio piece: a validated digital twin with fault injection.

Principles across every phase:

1. **One rig config, one set of test vectors.** Geometry, limits and trims live in `rig.json`;
   both IK implementations must pass the same test-vector file.
2. **Limits are data, not code.** Servo range, ball-joint swivel and speed limits come from
   measurements in the config.
3. **Nothing unvalidated reaches the hardware.** The app refuses failing motions; firmware clamps
   again as a second line of defense.
4. **Ship each phase as a working tool.**

## Architecture

```
Browser app (React + Three.js)                 Arduino Uno firmware
  Geometry designer   Motion preview   <-- Web Serial -->  Serial handler
  Show editor         Fault panel                          IK port (C++)
  Kinematics core (TypeScript)                             Safety: clamp + watchdog
              ^                                                   |  I2C
              |                                                   v
        rig.json + test vectors  ---- codegen rig_config.h ---> PCA9685 -> 6 x MG996R
```

| Layer | Choice | Why |
| --- | --- | --- |
| UI | React + TypeScript + Vite | Familiar stack, fast builds |
| 3D | Three.js via react-three-fiber | Declarative scene that fits React state |
| State | Zustand | Small, works outside React for the sim loop |
| Kinematics | Pure TypeScript package | No DOM, easy to unit test |
| Tests | Vitest + GitHub Actions | Shared vectors run on every push |
| Firmware | Arduino C++, Adafruit PWM Servo Driver library | Standard PCA9685 support |
| Hardware link | Web Serial API | Browser talks straight to the Uno |
| Hosting | GitHub Pages | Free public link for the portfolio |

Data formats: `rig.json` (geometry, limits, trims), `show.json` (keyframes, easing, cues),
and a framed binary serial protocol (Phase 3).

## Phase 0: Setup and measurements

- [x] pnpm monorepo, Vite + React + TS app with a Three.js canvas
- [x] Vitest wired; GitHub Actions CI green
- [x] Deploy the app to GitHub Pages (https://jayycub.github.io/stewart-sim/)
- [ ] Measure one MG996R: body size, tab hole spacing, shaft position relative to body
- [ ] Measure the stock horn: radius of each hole from shaft centre
- [ ] Measure ball-joint swivel: angle where the ball link binds, both directions
- [ ] Measure usable servo range: pulse widths (µs) at each end of travel and the angle that gives
- [x] `rig.json` v0 with a validating parser (values are placeholders until measured)

**Done when:** CI is green, the app loads from its Pages link, and rig.json holds measured values.

## Phase 1: Geometry designer

Picks the geometry to cut from plywood; ends with a 1:1 drilling template. Also where the
kinematics core is written and tested; every later phase reuses it.

1. [x] **Kinematics core**: pose -> six horn angles (closed-form rotary IK, see CLAUDE.md).
2. [x] **Limit checks**: no solution, servo range, ball-joint swivel (bottom and top).
   - [x] Collision checks: servo bodies clashing, rod through a servo body, rod folded onto its horn
     (part sizes in `rig.json` → `collision`; listing values until measured)
3. [x] **3D view**: plates, servo bodies, horns, rods; a leg over a limit turns red.
4. [x] **Sliders**: base/platform radius, joint half-spacings, horn length, rod length; pose sliders.
5. [x] **Workspace**: single-axis reach on each axis (shaded on the pose sliders + table).
   - [x] Roll × pitch reachability map (around the current x, y, z, yaw; colour shows the blocking limit)
6. [ ] **Sweep**: grid-search geometry within what the parts allow (150 mm rod + two 29 mm ends);
   rank layouts by workspace.
7. [ ] **Template export**: 1:1 SVG in mm with hole centres, servo footprints, centre mark,
   100 mm scale bar.
8. [x] Shared test vectors written (`test-vectors/ik-v1.json`). [x] Load rig.json in the app
   (file picker or paste, validated; copy to clipboard to save).

**Done when:** a chosen geometry with a known workspace table, and the printed template's scale
bar measures exactly 100 mm.

## Phase 2: Fabrication and assembly

- [ ] Plate material: 1/4" (6 mm) plywood or HDPE first; laser-cut acrylic/aluminium later
- [ ] Print templates, check scale bar, spray-mount, centre-punch, drill 3 mm, cut outlines
- [ ] Six servo mounts: one printed MG996R cradle reprinted six times, or wood blocks / aluminium angle
- [ ] Centre every servo before fitting horns; drill the chosen horn hole out to 3 mm
- [ ] Cut six rods, thread on ball ends, set centre-to-centre with calipers, lock with jam nuts
- [ ] Separate 5–6 V supply on the PCA9685 V+ terminal, grounds tied together
- [ ] Record per-servo trim and direction in rig.json
- [ ] Measure as-built joint positions; save an as-built config next to the design config

**Done when:** the platform sits level at home and the as-built config is in the repo.

## Phase 3: Firmware and hardware link

- [ ] Generate `rig_config.h` from rig.json with a script
- [ ] Uno sketch: PCA9685 at 50 Hz; angle -> pulse with per-servo trim, direction, limits
- [ ] Port IK to C++; run the shared vectors with desktop g++ before flashing
- [ ] Framed serial protocol: header, sequence number, mode (pose or raw angles), payload, CRC-8
- [ ] Firmware safety: clamp to limits, e-stop command, soft-start ramp, watchdog that eases home
- [ ] Telemetry back: commanded angles, loop time, CRC failures, fault flags
- [ ] Web Serial connect button and live-mirror mode in the app

**Done when:** the rig tracks the sliders, and pulling USB mid-motion sends it smoothly home.

## Phase 4: Motion preview and validation

- [ ] Motion sources: scripted functions, CSV import, recorded slider sessions
- [ ] Pre-flight check: whole motion through IK, position limits, servo speed/accel limits; Play
  enabled only if it passes
- [ ] Speed limits start from MG996R spec (0.17 s/60° at 4.8 V, no load), derated after testing
- [ ] Measure real motion with an IMU (e.g. MPU-6050) on the top plate, or video
- [ ] Plot commanded vs measured roll/pitch for a standard test motion; record the error
- [ ] Log every hardware run; replay logs in the sim

**Done when:** a standard test motion has a recorded sim-vs-rig error figure.

## Phase 5: Show editor

- [ ] Timeline with six tracks, keyframes, per-segment easing (linear, ease in/out, cubic Bézier)
- [ ] Layers: base motion + additive effects (rumble/vibration at set frequency and amplitude)
- [ ] Audio track: waveform, scrub, snap keyframes to beats
- [ ] Live validation: segments turn red where a limit breaks
- [ ] Save/load `show.json` with cues and loops
- [ ] Arm/disarm and Play on the rig with the sim in lockstep

**Done when:** a show synced to music previews and runs on the rig without a limit violation.

## Phase 6: Fault injection and motion cueing

- [ ] Classical washout filter (high-pass translation, low-pass tilt coordination), gains exposed
  with live plots
- [ ] Motion input from the Unity docking sim, or a recorded flight/ride log
- [ ] Instructor panel faults: stuck servo, offset drift, comm dropout/latency, corrupted frames,
  IMU noise
- [ ] Inject in sim first, then on hardware only where safe
- [ ] Firmware health monitor + degraded modes (hold, ease home, limp)
- [ ] Scripted fault-test matrix (fault × timing × expected response) with logged pass/fail

**Done when:** the full fault matrix runs from a script and every fault leads to its documented
response.
