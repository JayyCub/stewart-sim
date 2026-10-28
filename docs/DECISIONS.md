# Decisions

## Made

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-26 | Build our own sim app rather than Blender, FreeCAD/Fusion/Onshape or Simscape | Stewart kinematics fight Blender's rigging; CAD is poor at interactive "slider -> workspace"; none give a show editor or hardware link. Closed-form IK is ~50 lines; the rest is UI. CAD is still fine for the servo bracket. |
| 2026-10-26 | Web app: React + TypeScript + Three.js (react-three-fiber) | Strongest existing skill set; Web Serial for hardware; shareable link. Unity considered (already used for the docking sim) but serial and editing UI are more friction there. |
| 2026-10-26 | Plates from plywood/HDPE via printed 1:1 template, not repeated 3D prints | No 3D printer on hand; flat plates + adjustable horn/rod length make iteration cheap. |
| 2026-10-27 | TypeScript and C++ IK kept in sync by shared test vectors (`test-vectors/ik-v1.json`) | Simpler build than compiling C to WASM, and demonstrates a verification practice. |
| 2026-10-27 | Horn angle 0 = level at home; rotation order Rz·Ry·Rx; legs 0–5, pairs at 0/120/240° | See CLAUDE.md conventions. |
| 2026-10-27 | Ball-joint limit = rod tilt from perpendicular to the stud; top studs radial | Matches how RC ball links bind. Revisit if top joints are mounted differently. |
| 2026-10-27 | Node 22 pinned (`.nvmrc`, `engines`) | Vite 8 / Vitest 5 need Node ≥ 20.19. |

## Open

| Decision | Options | Lean | Needed by |
| --- | --- | --- | --- |
| Where IK runs on hardware | App streams raw servo angles; or the Uno computes IK from poses | Uno computes from poses (truer twin), with raw-angle mode as fallback. **Awaiting Jacob's call.** | Phase 3 |
| Microcontroller | Stay on Uno; or move to ESP32 / Teensy 4 | Uno through Phase 4, revisit for the FreeRTOS rewrite (2 KB RAM is tight) | Phase 6 |
| Plate material | Plywood; HDPE; laser-cut acrylic/aluminium | Plywood for the first build | Phase 2 |
| Top joint mounting | Radial stud on a small bracket; tangential stud | Radial (what the sim assumes) | Phase 2 |
| Servo mount | Printed cradle ×6; wood block; aluminium angle | Either; cradle if a printer is reachable | Phase 2 |

## Risks

- **Ball-joint swivel may cap range of motion** before the servos do. Measure it in Phase 0.
- **Power under load.** Treat jitter or Uno resets as a power problem first.
- **Uno RAM (2 KB)** limits on-board show storage and FreeRTOS.
- **Servo backlash and deadband** aren't modelled; Phase 4's error measurement shows how much
  they matter.
- **Web Serial** works only in desktop Chrome and Edge.
