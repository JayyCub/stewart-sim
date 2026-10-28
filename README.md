# Stewart Platform Sim

Design, preview and (later) program shows for a 6-servo rotary Stewart platform:
6 × MG996R on a PCA9685, driven by an Arduino Uno.

The app and the firmware share one rig config (`packages/rig-config/rig.json`) and one set of IK test
vectors (`test-vectors/ik-v1.json`), so the sim predicts the machine instead of approximating it.

## Docs

- `CLAUDE.md` — context for Claude Code sessions
- `docs/STATUS.md` — where things stand and what's next
- `docs/PROJECT_PLAN.md` — phases 0–6 with checklists
- `docs/HARDWARE.md` — parts, power, build approach, measurement checklist
- `docs/DECISIONS.md` — decisions made, open questions, risks

## Layout

```
packages/kinematics/   Pure TS: inverse kinematics, limit checks, workspace reach
packages/rig-config/   rig.json (geometry, limits, servo calibration) + validator
packages/template/     1:1 drilling templates for the base and top plates
apps/sim/              React + Three.js app: 3D rig, pose/geometry sliders, leg status
test-vectors/          Pose -> horn angle golden values; the C++ port must match them
firmware/stewart_uno/  Arduino sketch (Phase 3)
scripts/               gen-vectors.ts
```

## Commands

Requires Node 22 (`nvm use`).

```
pnpm install
pnpm dev          # run the sim at http://localhost:5173
pnpm test         # unit tests + shared test vectors
pnpm typecheck
pnpm build        # static build in apps/sim/dist
pnpm vectors      # regenerate test-vectors/ik-v1.json after an intentional IK change
```

Web Serial (Phase 3) works in desktop Chrome and Edge only.

## Conventions

- Lengths in mm. The kinematics API uses radians; rig.json and the UI use degrees.
- z is up. Base frame origin: base centre at servo-shaft height. Platform frame origin: top-plate centre at top-joint height.
- Pose rotation is R = Rz(yaw) · Ry(pitch) · Rx(roll). Home pose (all zeros) has every horn level.
- Legs are numbered 0–5 in code (1–6 in the UI). Servo pair k holds legs 2k and 2k+1, centred at k × 120°.
- Horn angle alpha is measured from level; positive raises the horn tip.

## Phase 0 measurements still needed

`rig.json` ships with placeholder numbers (`"measured": false`). Replace them with:

- [ ] Horn hole radius you will use (`hornLength`)
- [ ] Rod centre-to-centre length once ball ends are threaded on (`rodLength`)
- [ ] Ball-joint swivel before binding (`ballSwivelDeg`)
- [ ] Usable servo travel either side of level (`servoMinDeg`, `servoMaxDeg`)
- [ ] Pulse width at each end of travel, per servo (`servos[].centerUs`, `usPerDeg`)
