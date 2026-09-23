import { describe, expect, it } from 'vitest';
import { FixedStepLoop, MAX_TICKS_PER_FRAME } from '../../src/client/game/loop.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { BTN_HANDBRAKE, BTN_JUMP, DT } from '../../src/shared/sim/constants.js';
import { createFlatWorld, spawnCar } from '../../src/shared/sim/scenarios.js';
import { copyVehicleState, createVehicleState, type VehicleState } from '../../src/shared/sim/types.js';
import { stepVehicle } from '../../src/shared/sim/world.js';

// docs/phase-1a-design.md, 14.6: the input script is indexed by tick, so any
// sequence of frame lengths over the same total time must produce the very
// same state per tick.

const TOTAL_SECONDS = 4;

function runWithFrames(frames: number[]): VehicleState[] {
    const world = createFlatWorld();
    const car = spawnCar(world, 'a', 'sport', 0, -300, 0);
    const loop = new FixedStepLoop();
    const states: VehicleState[] = [];
    let tick = 0;
    for (const frame of frames) {
        loop.advance(frame, () => {
            car.input.throttle = 255;
            car.input.steer = tick > 60 && tick < 140 ? 90 : 0;
            car.input.buttons = (tick > 100 && tick < 130 ? BTN_HANDBRAKE : 0) | (tick === 170 ? BTN_JUMP : 0);
            stepVehicle(car, world);
            states.push(copyVehicleState(createVehicleState(), car.state));
            tick++;
        });
    }
    return states;
}

function fixedFrames(frameDt: number): number[] {
    return new Array(Math.round(TOTAL_SECONDS / frameDt)).fill(frameDt);
}

function jitteredFrames(seed: number): number[] {
    const random = mulberry32(seed);
    const frames: number[] = [];
    let total = 0;
    while (total < TOTAL_SECONDS) {
        const frame = 0.004 + random() * 0.04;
        frames.push(frame);
        total += frame;
    }
    return frames;
}

describe('FixedStepLoop', () => {
    it('produces the same state per tick at any frame rate', () => {
        const reference = runWithFrames(fixedFrames(1 / 60));
        const expectedTicks = TOTAL_SECONDS / DT;
        expect(Math.abs(reference.length - expectedTicks)).toBeLessThanOrEqual(1);
        for (const frames of [fixedFrames(1 / 30), fixedFrames(1 / 144), jitteredFrames(7), jitteredFrames(1234)]) {
            const states = runWithFrames(frames);
            expect(Math.abs(states.length - expectedTicks)).toBeLessThanOrEqual(1);
            const common = Math.min(states.length, reference.length);
            // Bit-identical, not just close
            expect(states.slice(0, common)).toStrictEqual(reference.slice(0, common));
        }
        // The script really drove, turned and jumped
        const last = reference[reference.length - 1];
        expect(Math.hypot(last.x, last.z + 300)).toBeGreaterThan(30);
        expect(reference.some(state => !state.grounded)).toBe(true);
    });

    it('returns the progress towards the next tick as alpha', () => {
        const loop = new FixedStepLoop();
        let ticks = 0;
        expect(loop.advance(DT / 4, () => ticks++)).toBeCloseTo(0.25, 9);
        expect(ticks).toBe(0);
        expect(loop.advance(DT, () => ticks++)).toBeCloseTo(0.25, 9);
        expect(ticks).toBe(1);
        loop.reset();
        expect(loop.acc).toBe(0);
    });

    it('runs at most 8 ticks after a hitch and drops the rest', () => {
        const loop = new FixedStepLoop();
        let ticks = 0;
        const alpha = loop.advance(0.5, () => ticks++);
        expect(ticks).toBe(MAX_TICKS_PER_FRAME);
        expect(alpha).toBe(0);
        // The next normal frame is a normal frame again
        loop.advance(DT, () => ticks++);
        expect(ticks).toBe(MAX_TICKS_PER_FRAME + 1);
    });

    it('ignores negative frame times', () => {
        const loop = new FixedStepLoop();
        let ticks = 0;
        loop.advance(-1, () => ticks++);
        expect(ticks).toBe(0);
        expect(loop.acc).toBe(0);
    });
});
