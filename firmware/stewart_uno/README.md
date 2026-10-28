# Firmware (Phase 3)

Not started. This sketch will:

- read servo calibration and limits from `rig_config.h`, generated from `packages/rig-config/rig.json`
- port the IK from `packages/kinematics/src/ik.ts` to C++
- pass every case in `test-vectors/ik-v1.json` (desktop g++ test) before it is flashed
