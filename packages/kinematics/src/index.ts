export * from "./types.ts";
export { DEG, rotation } from "./math.ts";
export { buildLayout, solve, rodLengthOf } from "./ik.ts";
export { AXES, axisReach, workspace, type Axis, type Reach } from "./workspace.ts";
export { TILT_BALL, TILT_COLLISION, TILT_NO_SOLUTION, TILT_OK, TILT_SERVO, tiltAt, tiltMap, type TiltCell, type TiltMap } from "./tiltmap.ts";
export { DEFAULT_COLLISION, collisionFaults, servoClashes, servoCorners, servoFrame, type ServoFrame } from "./collision.ts";
export { REACH_REF, TopK, scoreGeometry, sweep, sweepCandidates, sweepSize, type SweepRange, type SweepResult } from "./sweep.ts";
export { G, legTorques, nmmToKgCm } from "./statics.ts";
export {
  decode, differentialEvolution, encode, evaluateDesign, optimizeDesign, patternSearch, rng, weightedReachScore,
  type DEOptions, type Design, type DesignGoal, type FreeParam, type OptimizeOptions,
} from "./optimize.ts";
