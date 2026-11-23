# Status

_Last updated: 2026-11-23_

## Where things stand

**2026-11-23:** Flight simulator added (Phase 6 motion cueing pulled forward). `packages/flight` is a 6-DOF
light-aircraft model with trim, linearised modes (short period, phugoid, Dutch roll, roll, spiral), turbulence,
a small autopilot and scripted manoeuvres; classical washout turns it into platform poses, `PoseLimiter` keeps
them inside the checked workspace, and the store pose carries them to the 3D view and to live hardware control.
Verified by tests (rigid-body conservation laws, trim equilibrium, linear vs non-linear response, phugoid
period, washout behaviour, every scripted manoeuvre's limited poses passing the rig checks). Not yet flown on
the real rig. Bench firmware, Web Serial live control, jog/limit fitting and bench CLIs are committed.

Phase 0 software is done (only measurements remain) and every Phase 1 software item is built. Physical rig: servos wired and
tested sweeping in unison on the PCA9685; base and top plates not built yet.

Done:

- pnpm monorepo with `packages/kinematics`, `packages/rig-config`, `apps/sim`
- Closed-form rotary IK with limit checks (no solution, servo range, bottom/top ball swivel)
- Collision checks (optional `collision` section in rig.json, defaults filled in): servo bodies
  clashing, rod through any servo body, rod folded onto its horn. On the placeholder geometry
  the pairs clash below ~14.5° half-spacing, and rod-hits-servo cuts heave-down to −18.5 mm
- Single-axis workspace reach (bisection per axis)
- Roll × pitch reachability map: grid around the current pose, each cell coloured by the limit
  that blocks it; click or drag on it to set roll and pitch
- 91 Vitest tests: constraint satisfaction on 500 random poses, heave/symmetry/mirror checks,
  fault detection, workspace boundary, rig.json validation, and the shared vectors
- `test-vectors/ik-v1.json`: 34 cases (29 fully valid, including one unreachable pose)
- Sim app: 3D rig (plywood plates, MG996R bodies, horns, rods, ball joints), pose sliders with
  reach shaded on the track, geometry and limit sliders, per-leg table, reach table,
  copy and load rig.json (file picker or paste, validated before it replaces the rig),
  geometry sweep (Web Worker, ranked by six-axis reach, click to apply), 1:1 drilling templates
  for both plates (print tiled on A4/Letter, or download SVG), light/dark theme,
  phone layout
- Repo at https://github.com/JayyCub/stewart-sim (public); CI green; sim live at
  https://jayycub.github.io/stewart-sim/
- Node 22 pinned

Not done / known gaps:

- rig.json is placeholder values (`"measured": false`)
- Collision part sizes are MG996R listing values, not measurements; the rod is modelled in the
  horn plane (ignores the ball stud's outward offset), so rod-hits-servo errs on the safe side

## Next steps, in order

1. **Jacob:** take the Phase 0 measurements (`docs/HARDWARE.md` checklist) and update rig.json.
2. **Jacob:** finish Phase 1 on paper: with measured values loaded, run the sweep (rod range set to
   what the parts allow), pick a layout, print both templates and check the scale bars measure
   100 mm. Commit the chosen rig.json.
3. Decide where IK runs on hardware (see `docs/DECISIONS.md`) before Phase 3.

## Session history

- **2026-11-23 (later)** — Flight simulator moved out of the designer into its own page, `/flight/`: a full-screen
  low-poly flight game (procedural terrain with lakes, forests and mountains; clouds; animated control surfaces;
  chase and cockpit views; HUD) with the platform beside it as an inset or split view, plus Motion (cue charts,
  washout gains) and Rig (live hardware) drawers. Terrain height is shared with the flight model, so the aircraft
  crashes into what you see. Esc or hiding the tab always stops the rig on that page.
- **2026-11-23 (later still)** — A flight now needs the rig live (connected and levelled) before it starts, and
  pauses if the rig stops following. The start menu carries the connect/level step.

- **2026-11-23** — Committed the hardware tooling. Built the flight model, washout cueing, cue limiter and
  the Flight simulator panel (scenarios, keyboard/gamepad, attitude indicator, aircraft-vs-platform cue charts,
  washout gains, mode table). Next: fly a scenario on the rig with the Uno connected; add an IMU on the top
  plate to measure delivered motion; compare the model with JSBSim.

- **2026-10-26** — Reviewed parts; found the 1 A supply undersized for a loaded rig; chose
  "iterate in software, cut flat plates" over repeated 3D prints; chose to build a custom web sim.
- **2026-10-27 (evening)** — Load rig.json, roll × pitch map, collision checks, geometry sweep,
  drilling templates. Phase 1 software complete.
- **2026-10-27** — Wrote the phased plan; scaffolded the repo; built kinematics core, tests,
  vectors and the sim app; published a preview; moved the project to `~/Documents/stewart-sim`.
  Desktop shell sandbox would not start on this Mac, so work continues in Claude Code locally.
  Installed Node 22, moved workflows into `.github/`, created the public GitHub repo, CI green,
  Pages live. Phase 0 software done; only measurements remain.
