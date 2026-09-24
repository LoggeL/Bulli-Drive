import { describe, expect, it } from 'vitest';
import { applyContactGhostFloor, stopInput } from '../../../src/shared/sim/inputs.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';
import { createStepEvents, createVehicleInput, createVehicleState, resetStepEvents } from '../../../src/shared/sim/types.js';

// The inputs the sim gets without a player (docs/phase-1b-design.md, 5.3
// and 5.4) and the per-tick event reset.

describe('stopInput', () => {
    function stop(yaw: number, vx: number, vz: number) {
        const s = { ...createVehicleState(), yaw, vx, vz };
        return stopInput(s, { steer: 90, throttle: 7, brake: 7, buttons: 15 });
    }

    it('brakes along the heading, gives throttle against it, whatever the heading', () => {
        // Heading +x (yaw π/2): rolling +x is forwards
        expect(stop(Math.PI / 2, 10, 0)).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: 0 });
        expect(stop(Math.PI / 2, -10, 0)).toEqual({ steer: 0, throttle: 255, brake: 0, buttons: 0 });
        // Sliding sideways (along -z while heading +x) is no rolling at all
        expect(stop(Math.PI / 2, 0, -10)).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
        // Heading -z (yaw π): rolling -z is forwards
        expect(stop(Math.PI, 0, -3)).toEqual({ steer: 0, throttle: 0, brake: 255, buttons: 0 });
    });

    it('does nothing from 0.5 m/s down, so a car never starts reversing', () => {
        expect(stop(0, 0, 0.5)).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
        expect(stop(0, 0, -0.5)).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
        expect(stop(0, 0, 0.51).brake).toBe(255);
        expect(stop(0, 0, -0.51).throttle).toBe(255);
    });
});

describe('applyContactGhostFloor', () => {
    it('lifts the contact ghost to at least 2 ticks and never shortens a longer one', () => {
        const car = spawnCar(createFlatWorld(), 'a', 'bulli', 0, 0, 0);
        for (const [before, after] of [[0, 2], [1, 2], [2, 2], [3, 3], [60, 60]]) {
            car.state.ghostTicks = before;
            applyContactGhostFloor(car);
            expect(car.state.ghostTicks, `from ${before}`).toBe(after);
        }
    });
});

describe('step events', () => {
    const NONE = {
        wallImpact: 0, wallX: 0, wallZ: 0, carImpact: 0, carImpactId: '', landedImpact: 0,
        jumped: false, boostStarted: false, drifting: false, reset: false
    };

    it('start empty and are cleared completely for every tick', () => {
        expect(createStepEvents()).toEqual(NONE);
        const events = {
            wallImpact: 3, wallX: 1, wallZ: 2, carImpact: 4, carImpactId: 'b', landedImpact: 5,
            jumped: true, boostStarted: true, drifting: true, reset: true
        };
        resetStepEvents(events);
        expect(events).toEqual(NONE);
    });

    it('a fresh input is neutral', () => {
        expect(createVehicleInput()).toEqual({ steer: 0, throttle: 0, brake: 0, buttons: 0 });
    });
});
