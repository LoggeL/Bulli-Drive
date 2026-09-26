import { SIM_TUNING } from '../../shared/sim/constants.js';

// How a car's body moves on screen (docs/phase-1a-design.md, 26.8). The
// renderer only, never the sim: the sim has one vertical degree of freedom
// (the body on its suspension, `susp`) and no pitch or roll. From it and the
// ground under the car this derives
// - the ground tilt (group): the terrain's slope under the car, eased; the
//   contact shadow lies in this plane, also while the car flies,
// - the body (bodyGroup, relative to the ground tilt): its height over the
//   ground (flight plus suspension travel), its pitch and roll: on the
//   ground the terrain plus a spring from the accelerations (nose up when
//   accelerating, leaning out of turns), in the air the nose follows the
//   flight path (up while rising, down towards the landing) with some
//   inertia, and the roll levels out,
// - the wheels' drop below their rest spot on the body, so they stay on
//   the ground while the body moves on its springs and hang down in the air.

// Visual spring from the accelerations
const PITCH_PER_ACCEL = 0.0035;      // rad per m/s²
const ROLL_PER_ACCEL = 0.0045;
const MAX_PITCH = 4 * Math.PI / 180;
const MAX_ROLL = 5 * Math.PI / 180;
const SPRING_RATE = 10;
// Terrain tilt: ±2 m samples, eased
const SLOPE_STEP = 2.0;
const TILT_RATE = 6;
// In the air the nose turns towards the flight path at this rate (1/s),
// at most this far; back on the ground the body settles onto the ground
// tilt at LAND_RATE, and the roll levels out in the air at AIR_ROLL_RATE
const AIR_PITCH_RATE = 2.5;
const MAX_AIR_PITCH = 25 * Math.PI / 180;
const LAND_RATE = 12;
const AIR_ROLL_RATE = 1.5;
// Share of the suspension travel shown: the body sinks at most
// 0.6 · SUSP_TRAVEL = 15 cm, so the wheels stay inside their arches
export const SUSP_VISUAL = 0.6;

export interface BodyMotionInput {
    x: number;
    z: number;
    yaw: number;
    // Height of the wheels' underside over the terrain (m): 0 on the
    // ground, > 0 in the air or on a ramp or low collider
    airHeight: number;
    grounded: boolean;
    // The body over its rest position (m, + = extended), as in the sim
    susp: number;
    // Vertical speed (m/s) and forward speed (m/s) of the body
    vy: number;
    speed: number;
    // Horizontal speed (m/s), for the flight path angle
    horizontalSpeed: number;
    // Longitudinal acceleration (m/s², the sim's loadX) and yaw rate (rad/s)
    // for the spring; 0 where unknown (remote cars)
    loadX: number;
    yawRate: number;
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function damp(rate: number, dt: number): number {
    return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

export class BodyMotion {
    // Ground tilt (group rotation x and z): + pitch = nose down, + roll =
    // left side up
    groundPitch = 0;
    groundRoll = 0;
    // The body in the world: pitch and roll without the spring
    private worldPitch = 0;
    private worldRoll = 0;
    private springPitch = 0;
    private springRoll = 0;
    private placed = false;
    // Outputs for the body (relative to the ground tilt)
    bodyPitch = 0;
    bodyRoll = 0;
    // Body height over the ground (m) and the wheels' drop below their
    // rest spot on the body (m, + = down)
    bodyY = 0;
    wheelDrop = 0;
    // Height of the wheels over the ground (m): contact shadow, camera, sound
    airHeight = 0;

    /** Starts over without easing (spawn, reset, teleport). */
    reset(): void {
        this.placed = false;
    }

    update(dt: number, input: BodyMotionInput, ground: (x: number, z: number) => number): void {
        const fx = Math.sin(input.yaw), fz = Math.cos(input.yaw);
        const hFwd = ground(input.x + fx * SLOPE_STEP, input.z + fz * SLOPE_STEP);
        const hBack = ground(input.x - fx * SLOPE_STEP, input.z - fz * SLOPE_STEP);
        const hLeft = ground(input.x + fz * SLOPE_STEP, input.z - fx * SLOPE_STEP);
        const hRight = ground(input.x - fz * SLOPE_STEP, input.z + fx * SLOPE_STEP);
        const terrainPitch = Math.atan2(hBack - hFwd, SLOPE_STEP * 2);
        const terrainRoll = Math.atan2(hLeft - hRight, SLOPE_STEP * 2);
        if (!this.placed) {
            this.placed = true;
            this.groundPitch = this.worldPitch = terrainPitch;
            this.groundRoll = this.worldRoll = terrainRoll;
            this.springPitch = this.springRoll = 0;
        }
        const tilt = damp(TILT_RATE, dt);
        this.groundPitch += (terrainPitch - this.groundPitch) * tilt;
        this.groundRoll += (terrainRoll - this.groundRoll) * tilt;

        const grounded = input.grounded;
        // Nose up when accelerating, down when braking; the body leans out
        // of turns; nothing of it in the air
        const pitchTarget = grounded ? clamp(-input.loadX * PITCH_PER_ACCEL, -MAX_PITCH, MAX_PITCH) : 0;
        const rollTarget = grounded ? clamp(input.speed * input.yawRate * ROLL_PER_ACCEL, -MAX_ROLL, MAX_ROLL) : 0;
        const spring = damp(SPRING_RATE, dt);
        this.springPitch += (pitchTarget - this.springPitch) * spring;
        this.springRoll += (rollTarget - this.springRoll) * spring;

        if (grounded) {
            const land = damp(LAND_RATE, dt);
            this.worldPitch += (this.groundPitch - this.worldPitch) * land;
            this.worldRoll += (this.groundRoll - this.worldRoll) * land;
        } else {
            // The flight path angle, nose up while rising (negative pitch)
            const path = -Math.atan2(input.vy, Math.max(Math.abs(input.horizontalSpeed), 1));
            this.worldPitch += (clamp(path, -MAX_AIR_PITCH, MAX_AIR_PITCH) - this.worldPitch) * damp(AIR_PITCH_RATE, dt);
            this.worldRoll -= this.worldRoll * damp(AIR_ROLL_RATE, dt);
        }
        this.bodyPitch = this.worldPitch - this.groundPitch + this.springPitch;
        this.bodyRoll = this.worldRoll - this.groundRoll + this.springRoll;

        const T = SIM_TUNING;
        const k = (2 * Math.PI * T.SUSP_FREQ) ** 2;
        const travel = clamp(input.susp, -T.SUSP_TRAVEL, T.GRAVITY / k) * SUSP_VISUAL;
        this.airHeight = Math.max(0, input.airHeight);
        this.bodyY = this.airHeight + travel;
        this.wheelDrop = travel;
    }
}
