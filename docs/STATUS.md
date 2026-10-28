# Status

_Last updated: 2026-10-27_

## Where things stand

Phase 0 scaffold is done and the first half of Phase 1 is built. Physical rig: servos wired and
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
- 73 Vitest tests: constraint satisfaction on 500 random poses, heave/symmetry/mirror checks,
  fault detection, workspace boundary, rig.json validation, and the shared vectors
- `test-vectors/ik-v1.json`: 34 cases (29 fully valid, including one unreachable pose)
- Sim app: 3D rig (plywood plates, MG996R bodies, horns, rods, ball joints), pose sliders with
  reach shaded on the track, geometry and limit sliders, per-leg table, reach table,
  copy and load rig.json (file picker or paste, validated before it replaces the rig),
  light/dark theme, phone layout
- Repo at https://github.com/JayyCub/stewart-sim (public); CI green; sim live at
  https://jayycub.github.io/stewart-sim/
- Node 22 pinned

Not done / known gaps:

- rig.json is placeholder values (`"measured": false`)
- Collision part sizes are MG996R listing values, not measurements; the rod is modelled in the
  horn plane (ignores the ball stud's outward offset), so rod-hits-servo errs on the safe side

## Next steps, in order

1. **Jacob:** take the Phase 0 measurements (`docs/HARDWARE.md` checklist) and update rig.json.
2. Phase 1 remaining, roughly in this order:
   - Geometry sweep within part constraints, ranked by workspace
   - 1:1 SVG drilling template export (base + top), with 100 mm scale bar
3. Decide where IK runs on hardware (see `docs/DECISIONS.md`) before Phase 3.

## Session history

- **2026-10-26** — Reviewed parts; found the 1 A supply undersized for a loaded rig; chose
  "iterate in software, cut flat plates" over repeated 3D prints; chose to build a custom web sim.
- **2026-10-27** — Wrote the phased plan; scaffolded the repo; built kinematics core, tests,
  vectors and the sim app; published a preview; moved the project to `~/Documents/stewart-sim`.
  Desktop shell sandbox would not start on this Mac, so work continues in Claude Code locally.
  Installed Node 22, moved workflows into `.github/`, created the public GitHub repo, CI green,
  Pages live. Phase 0 software done; only measurements remain.
