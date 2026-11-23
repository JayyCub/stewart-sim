# Production firmware (Phase 3, not started)

Today the rig runs on the bench firmware in [`../servo_test`](../servo_test): immediate servo commands plus a
48-frame queue played at 50 Hz, with a 500–2500 µs clamp. The host does the IK and converts angles to pulses
from `rig.json`.

This sketch will move that onto the Uno:

- servo calibration and limits from `rig_config.h`, generated from `packages/rig-config/rig.json`
- the IK from `packages/kinematics/src/ik.ts` ported to C++, passing every case in `test-vectors/ik-v1.json`
  (desktop g++ test) before it is flashed
- a framed serial protocol with CRC, clamping, an e-stop and a watchdog that eases the platform home
