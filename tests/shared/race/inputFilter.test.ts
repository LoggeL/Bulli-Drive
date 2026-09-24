import { describe, expect, it } from 'vitest';
import { inStartGhost, raceFrozen, raceGhostFloor, raceInputFilter } from '../../../src/shared/race/inputFilter.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_JUMP, BTN_RESET } from '../../../src/shared/sim/constants.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';
import type { VehicleInput } from '../../../src/shared/sim/types.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';

// Countdown freeze and start ghost (docs/phase-2-design.md, 11 and 12.1)

const S = 500;
const ALL = BTN_HANDBRAKE | BTN_BOOST | BTN_JUMP | BTN_RESET;
const full = (): VehicleInput => ({ steer: -90, throttle: 255, brake: 255, buttons: ALL });

describe('raceInputFilter', () => {
    it('freezes pedals and steering in the lobby, the countdown and before S; the handbrake stays', () => {
        for (const [phase, tick] of [['lobby', 0], ['countdown', S - 1], ['racing', S - 1], ['countdown', S + 10]] as const) {
            expect(raceInputFilter(phase, tick, S, full())).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: BTN_HANDBRAKE });
        }
        // No start tick yet freezes too, and the lobby after a race with its
        // old start tick
        expect(raceFrozen('racing', S, null)).toBe(true);
        expect(raceFrozen('lobby', S + 5000, S)).toBe(true);
        expect(raceFrozen('countdown', S + 5000, S)).toBe(true);
        expect(raceFrozen('racing', S + 5000, S)).toBe(false);
    });

    it('from S on drops only the jump (E4)', () => {
        expect(raceInputFilter('racing', S, S, full())).toEqual({ steer: -90, throttle: 255, brake: 255, buttons: ALL & ~BTN_JUMP });
        expect(raceInputFilter('finished', S + 5000, S, full()).buttons).toBe(ALL & ~BTN_JUMP);
        expect(raceInputFilter('results', S + 9000, S, full()).buttons).toBe(ALL & ~BTN_JUMP);
    });

    it('keeps a car standing through a 240-tick countdown with everything held (no reversing, no creeping)', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 10, 20, 0.3);
        const input = full();
        for (let tick = S - 240; tick < S; tick++) {
            Object.assign(car.input, raceInputFilter('countdown', tick, S, { ...input }));
            stepVehicle(car, world);
        }
        expect([car.state.x, car.state.z, car.state.yaw]).toEqual([10, 20, 0.3]);
        expect([car.state.vx, car.state.vz, car.state.reverseHold, car.state.boostMeter]).toEqual([0, 0, 0, 0]);
        // Held from the countdown on, the pedals act from the first racing tick
        Object.assign(car.input, raceInputFilter('racing', S, S, { ...input }));
        expect(car.input.throttle).toBe(255);
    });
});

describe('start ghost', () => {
    it('lasts exactly 180 ticks from S', () => {
        expect(inStartGhost(S - 1, S)).toBe(false);
        expect(inStartGhost(S, S)).toBe(true);
        expect(inStartGhost(S + 179, S)).toBe(true);
        expect(inStartGhost(S + 180, S)).toBe(false);
        expect(inStartGhost(S, null)).toBe(false);
        expect(inStartGhost(10, null)).toBe(false);
    });

    it('applies the contact ghost floor to a racer\'s car only while it lasts, in racing and finished', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'beetle', 0, 0, 0);
        expect(raceGhostFloor('racing', S + 179, S, car)).toBe(true);
        expect(car.state.ghostTicks).toBe(2);
        car.state.ghostTicks = 0;
        expect(raceGhostFloor('finished', S + 10, S, car)).toBe(true);
        expect(car.state.ghostTicks).toBe(2);
        car.state.ghostTicks = 0;
        expect(raceGhostFloor('racing', S + 180, S, car)).toBe(false);
        expect(raceGhostFloor('countdown', S - 10, S, car)).toBe(false);
        expect(raceGhostFloor('results', S + 10, S, car)).toBe(false);
        expect(car.state.ghostTicks).toBe(0);
        // A longer ghost (after a reset) is kept
        car.state.ghostTicks = 90;
        raceGhostFloor('racing', S, S, car);
        expect(car.state.ghostTicks).toBe(90);
    });
});
