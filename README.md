# Stewart Platform Sim

[![CI](https://github.com/JayyCub/stewart-sim/actions/workflows/ci.yml/badge.svg)](https://github.com/JayyCub/stewart-sim/actions/workflows/ci.yml)
&nbsp;[Live demo](https://jayycub.github.io/stewart-sim/)

> Built with AI coding assistance (Claude Code) as a learning project: a hands-on way to explore kinematics,
> flight dynamics, motion cueing and embedded control on real hardware. It is not production or safety-certified software.

A browser-based design tool, simulator and controller for a six-axis rotary Stewart platform
(6 × MG996R servos, PCA9685, Arduino Uno). It designs the rig's geometry, checks every motion against the
machine's physical limits, and drives the real hardware, including from a built-in flight simulator.

![The real platform following the flight simulator running on the laptop](docs/images/rig-flight.gif)

## Features

- **Rig design:** closed-form inverse kinematics, servo, ball-joint and collision limits, a workspace map, a geometry
  optimiser, and 1:1 drilling templates for the plates
- **Flight simulator:** 6-DOF light-aircraft model (RK4, quaternions, trim, linearised modes, turbulence) in a 3D flight
  game, with classical washout cueing the motion onto the platform
- **Hardware control:** Web Serial live control and Python bench scripts, through firmware that buffers frames at 50 Hz
- **Verification:** ~250 tests in CI, including shared IK vectors, conservation-law checks on the dynamics, and every
  scripted manoeuvre's poses passing the rig's limit checks

## How it works

```mermaid
flowchart LR
  rig[("rig.json<br/>geometry · limits")] --> kin
  subgraph browser["Browser app"]
    game["Flight model<br/>+ washout"] --> lim["Pose limiter"] --> kin["IK + limit<br/>checks"]
  end
  kin -- "Web Serial" --> uno["Arduino Uno<br/>clamps again"] -- "I²C" --> pca["PCA9685"] --> servos["6 × MG996R"]
```

One config file defines the rig. Every pose is checked against it before it is sent, and the firmware clamps again.

## Build progress

| Printed parts and pushrods | Servos mounted | First assembly, wired to the Uno | Current build |
| --- | --- | --- | --- |
| ![3D-printed base, top plate and pushrods](docs/images/build-1-parts.jpg) | ![Six servos mounted on the base](docs/images/build-2-servos.jpg) | ![Assembled platform wired to the Arduino and PCA9685](docs/images/build-3-assembled.jpg) | ![Current build of the platform](docs/images/build-4-current.jpg) |

## Screenshots

| Flight sim beside the platform | Rig designer | Aircraft vs platform motion |
| --- | --- | --- |
| ![A light aircraft in a 30° coordinated turn beside the platform view](docs/images/flight-split.jpg) | ![Rig designer](docs/images/designer.jpg) | ![Motion cueing charts in turbulence](docs/images/flight-motion.jpg) |

## Stack

TypeScript, React, three.js (react-three-fiber), Zustand, Vite, Vitest · Arduino C++, PCA9685 · Python · GitHub Actions and Pages

## Status

The platform is assembled and flies with the simulator over live control. Next: replace the placeholder dimensions in
`rig.json` with measured ones, and move the IK into the firmware. Flying in the demo needs the rig connected.

[Plan](docs/PROJECT_PLAN.md) · [Status](docs/STATUS.md) · [Hardware](docs/HARDWARE.md) · [Decisions](docs/DECISIONS.md)
