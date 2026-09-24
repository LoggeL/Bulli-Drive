import { describe, expect, it } from 'vitest';
import { DT } from '../../../src/shared/sim/constants.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';
import { copyVehicleState, createVehicleState, type SimCar } from '../../../src/shared/sim/types.js';
import { sortCarsById, stepWorld } from '../../../src/shared/sim/world.js';

// The world step (docs/phase-1a-design.md, 6.3): the order of the cars
// comes from their ids alone, kinematic cars only move, and a car whose
// state went non-finite is reset instead of spreading NaN.

function ids(cars: SimCar[]): string[] {
    return cars.map(car => car.id);
}

// Three overlapping cars: the contact order decides the result
function pileUp(): SimCar[] {
    const world = createFlatWorld();
    return [
        spawnCar(world, 'b', 'beetle', 1.5, 0, 0, 5),
        spawnCar(world, 'c', 'jeep', 0.7, 2.0, Math.PI, 5),
        spawnCar(world, 'a', 'bulli', 0, 0, Math.PI / 2, 5)
    ];
}

describe('sortCarsById', () => {
    it('sorts by id with plain string order, in place', () => {
        const world = createFlatWorld();
        const make = (id: string) => spawnCar(world, id, 'bulli', 0, 0, 0);
        const cars = ['b', 'a'].map(make);
        sortCarsById(cars);
        expect(ids(cars)).toEqual(['a', 'b']);
        const more = ['d', 'b', 'e', 'a', 'c', 'B'].map(make);
        const same = more;
        sortCarsById(more);
        expect(more).toBe(same);
        // Upper case before lower case (code units, not the locale)
        expect(ids(more)).toEqual(['B', 'a', 'b', 'c', 'd', 'e']);
    });
});

describe('stepWorld', () => {
    it('gives the same result whatever order the cars come in', () => {
        const world = createFlatWorld();
        const reference = pileUp();
        stepWorld(reference, world);
        expect(ids(reference)).toEqual(['a', 'b', 'c']);
        // All three hit each other in the first tick
        expect(reference.every(car => car.events.carImpact > 1)).toBe(true);
        for (let tick = 1; tick < 30; tick++) stepWorld(reference, world);

        const orders = [[2, 0, 1], [1, 2, 0], [0, 2, 1]];
        for (const order of orders) {
            const cars = pileUp();
            const shuffled = order.map(i => cars[i]);
            for (let tick = 0; tick < 30; tick++) stepWorld(shuffled, world);
            for (const car of reference) {
                const other = shuffled.find(c => c.id === car.id)!;
                expect(other.state, `${car.id} after order ${order}`).toEqual(car.state);
            }
        }
    });

    it('moves a kinematic car along its velocity only, even into a wall', () => {
        // A box from x = 1 to 3; the proxy's circles overlap it at once
        const world = createFlatWorld([{ kind: 'box', x: 2, z: 0, hw: 1, hd: 5, top: Infinity }]);
        const proxy = spawnCar(world, 'p', 'bulli', 0, 0, Math.PI / 2, 12);
        proxy.kinematic = true;
        proxy.input.throttle = 255;
        // Hovering 3 m up, still marked as grounded: no fall, no landing
        proxy.state.y = 3;
        const before = createVehicleState();
        copyVehicleState(before, proxy.state);
        stepWorld([proxy], world);
        expect(proxy.state.x).toBeCloseTo(12 * DT, 12);
        expect(proxy.state.z).toBeCloseTo(0, 12);
        // No drag, no throttle, no push-out, no ground step
        expect(proxy.state.vx).toBe(12);
        expect(proxy.events.wallImpact).toBe(0);
        const { x: _x, z: _z, ...rest } = proxy.state;
        const { x: _bx, z: _bz, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        // The same car, not kinematic, is pushed out of the box
        const car = spawnCar(world, 'q', 'bulli', 0, 0, Math.PI / 2, 12);
        stepWorld([car], world);
        expect(car.state.vx).toBeLessThan(12);
    });

    it('resets a car whose state went non-finite where it was', () => {
        const world = createFlatWorld();
        // Fields a NaN in them does not carry into the position within the tick
        for (const key of ['y', 'boostMeter', 'flipAngle', 'flipRate'] as const) {
            const car = spawnCar(world, 'a', 'bulli', 30, 40, 1);
            car.state[key] = NaN;
            stepWorld([car], world);
            for (const [name, value] of Object.entries(car.state)) {
                if (typeof value === 'number') expect(Number.isFinite(value), `${key}: ${name}`).toBe(true);
            }
            expect(car.events.reset, key).toBe(true);
            // Where it was, at rest, with the reset's contact ghost
            expect(car.state.x, key).toBe(30);
            expect(car.state.z, key).toBe(40);
            expect(car.state.yaw, key).toBe(1);
            expect(car.state.vx).toBe(0);
            expect(car.state.vz).toBe(0);
            expect(car.state.ghostTicks).toBeGreaterThan(0);
        }
    });

    it('puts the car at the origin facing 0 once the NaN reached its position', () => {
        const world = createFlatWorld();
        const keys = ['x', 'z', 'yaw', 'vx', 'vz', 'yawRate', 'steerAngle', 'loadX', 'rearGrip', 'scale'] as const;
        for (const key of keys) {
            const car = spawnCar(world, 'a', 'bulli', 30, 40, 1);
            car.state[key] = NaN;
            stepWorld([car], world);
            for (const [name, value] of Object.entries(car.state)) {
                if (typeof value === 'number') expect(Number.isFinite(value), `${key}: ${name}`).toBe(true);
            }
            expect(car.events.reset, key).toBe(true);
            expect([car.state.x, car.state.z, car.state.yaw], key).toEqual([0, 0, 0]);
            expect(car.state.scale, key).toBe(1);
        }
        const boost = spawnCar(world, 'a', 'bulli', 30, 40, 1);
        boost.state.boostMeter = NaN;
        stepWorld([boost], world);
        expect(boost.state.boostMeter).toBe(0);
        // A finite car keeps its state and reports no reset
        const fine = spawnCar(world, 'a', 'bulli', 30, 40, 1, 10);
        fine.state.boostMeter = 0.7;
        stepWorld([fine], world);
        expect(fine.events.reset).toBe(false);
        expect(fine.state.yaw).toBeCloseTo(1, 3);
        expect(fine.state.boostMeter).toBeGreaterThan(0.6);
    });
});
