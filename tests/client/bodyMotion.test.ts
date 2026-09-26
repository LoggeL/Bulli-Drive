import { describe, expect, it } from 'vitest';
import { BodyMotion, SUSP_VISUAL, type BodyMotionInput } from '../../src/client/vehicle/bodyMotion.js';
import { SIM_TUNING } from '../../src/shared/sim/constants.js';

// The body's look on screen (src/client/vehicle/bodyMotion.ts,
// docs/phase-1a-design.md 26.8): height, pitch, roll and the wheels from the
// sim's suspension and flight. Expectations from geometry: the flight path
// angle atan(vy / v), the slope angle atan(grade), wheels that stay on the
// ground while the body moves on its springs.

const DT = 1 / 60;
const flat = (_x: number, _z: number) => 0;

function input(over: Partial<BodyMotionInput> = {}): BodyMotionInput {
    return {
        x: 0, z: 0, yaw: 0, airHeight: 0, grounded: true, susp: 0, vy: 0, speed: 30, horizontalSpeed: 30, loadX: 0, yawRate: 0,
        ...over
    };
}

function run(motion: BodyMotion, seconds: number, over: Partial<BodyMotionInput>, ground = flat): void {
    for (let t = 0; t < seconds - 1e-9; t += DT) motion.update(DT, input(over), ground);
}

// The body's pitch in the world (+ = nose down)
const worldPitch = (m: BodyMotion) => m.groundPitch + m.bodyPitch;

describe('the body on its springs', () => {
    it('keeps the wheels on the ground while the body sinks and rises', () => {
        // Rest height of the spring: g / (2π f)²; the sim never goes
        // beyond it on the ground nor below the bump stop
        const extension = SIM_TUNING.GRAVITY / (2 * Math.PI * SIM_TUNING.SUSP_FREQ) ** 2;
        for (const susp of [-SIM_TUNING.SUSP_TRAVEL, -0.1, 0, 0.05, extension]) {
            const motion = new BodyMotion();
            motion.update(DT, input({ susp }), flat);
            expect(motion.bodyY, `susp ${susp}`).toBeCloseTo(susp * SUSP_VISUAL, 12);
            // The wheels' underside: the body's height minus their drop
            expect(motion.bodyY - motion.wheelDrop, `susp ${susp}`).toBeCloseTo(0, 12);
        }
        // Compressed the body is lower than at rest, extended higher
        const low = new BodyMotion(), high = new BodyMotion();
        low.update(DT, input({ susp: -0.2 }), flat);
        high.update(DT, input({ susp: 0.1 }), flat);
        expect(low.bodyY).toBeLessThan(-0.1);
        expect(high.bodyY).toBeGreaterThan(0.05);
    });

    it('shows at most the travel the sim allows, whatever the input', () => {
        const motion = new BodyMotion();
        motion.update(DT, input({ susp: -3 }), flat);
        expect(motion.bodyY).toBeCloseTo(-SIM_TUNING.SUSP_TRAVEL * SUSP_VISUAL, 12);
    });

    it('lifts body and wheels together in the air', () => {
        const motion = new BodyMotion();
        const extension = SIM_TUNING.GRAVITY / (2 * Math.PI * SIM_TUNING.SUSP_FREQ) ** 2;
        motion.update(DT, input({ grounded: false, airHeight: 3, susp: extension, vy: 2 }), flat);
        expect(motion.airHeight).toBe(3);
        expect(motion.bodyY - motion.wheelDrop).toBeCloseTo(3, 12);
        // The wheels hang below their rest spot on the body
        expect(motion.wheelDrop).toBeGreaterThan(0.05);
    });
});

describe('pitch and roll', () => {
    it('tilts with the slope under the car', () => {
        // 10 % uphill ahead (yaw 0 faces +z): nose up by atan(0.1)
        const motion = new BodyMotion();
        run(motion, 2, { speed: 0, horizontalSpeed: 0 }, (_x, z) => 0.1 * z);
        expect(motion.groundPitch).toBeCloseTo(-Math.atan(0.1), 4);
        expect(motion.bodyPitch).toBeCloseTo(0, 4);
    });

    it('turns the nose along the flight path in the air, with inertia', () => {
        // Rising at 8 m/s at 30 m/s: the path climbs at atan(8/30) = 15°
        const motion = new BodyMotion();
        run(motion, 0.5, {});
        motion.update(DT, input({ grounded: false, airHeight: 0.1, vy: 8 }), flat);
        const target = -Math.atan2(8, 30);
        // One frame after take-off it has barely begun to turn
        expect(Math.abs(worldPitch(motion))).toBeLessThan(0.1 * Math.abs(target));
        run(motion, 3, { grounded: false, airHeight: 2, vy: 8 });
        expect(worldPitch(motion)).toBeCloseTo(target, 3);
        // Falling towards the landing: nose down
        run(motion, 3, { grounded: false, airHeight: 2, vy: -8 });
        expect(worldPitch(motion)).toBeCloseTo(-target, 3);
    });

    it('settles onto the ground after the landing, and levels the roll in the air', () => {
        // On a side slope (left side 10 % up), then off the ground
        const side = (x: number) => 0.1 * x;
        const motion = new BodyMotion();
        run(motion, 2, {}, side);
        expect(worldPitch(motion)).toBeCloseTo(0, 6);
        expect(motion.groundRoll + motion.bodyRoll).toBeCloseTo(Math.atan(0.1), 3);
        run(motion, 3, { grounded: false, airHeight: 2, vy: -8 }, side);
        expect(Math.abs(motion.groundRoll + motion.bodyRoll)).toBeLessThan(0.02 * Math.atan(0.1));
        // Back on flat ground: body on the ground within half a second
        run(motion, 0.5, {});
        expect(Math.abs(worldPitch(motion))).toBeLessThan(0.01);
        expect(Math.abs(motion.groundRoll + motion.bodyRoll)).toBeLessThan(0.01);
    });

    it('rocks with the accelerations on the ground only', () => {
        // 8 m/s² forwards: the nose lifts (negative pitch), at most 4°
        const motion = new BodyMotion();
        run(motion, 1, { loadX: 8 });
        expect(motion.bodyPitch).toBeLessThan(-0.02);
        expect(motion.bodyPitch).toBeGreaterThanOrEqual(-4 * Math.PI / 180 - 1e-9);
        // Turning left at speed: the body leans out of the turn (right side down)
        const turning = new BodyMotion();
        run(turning, 1, { yawRate: 0.5 });
        expect(turning.bodyRoll).toBeGreaterThan(0.02);
        // In the air (level flight) the spring lets go
        run(motion, 1, { grounded: false, airHeight: 1, loadX: 8, vy: 0 });
        expect(Math.abs(motion.bodyPitch)).toBeLessThan(1e-3);
    });
});
