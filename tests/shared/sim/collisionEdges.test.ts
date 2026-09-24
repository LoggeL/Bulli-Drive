import { describe, expect, it } from 'vitest';
import { overlapsColliders, pushOutOfColliders, resolveWorld, supportHeight } from '../../../src/shared/sim/collision.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';

// Car against the static world (docs/phase-1a-design.md, 7.3), by hand
// geometry: a Bulli is two circles of 1.3 m at ±0.7 m along its heading,
// the flat test world's border lies at ±498 m, wall hits change the spin
// by at most 2.5 rad/s each and never beyond 6 rad/s.

const BOX = { kind: 'box', x: 0, z: 0, hw: 5, hd: 5, top: Infinity } as const;

describe('push-out of a box the car is inside', () => {
    it('leaves through the nearest face, on each of the four sides', () => {
        const world = createFlatWorld([BOX]);
        // Heading +z: circles at z ± 0.7. Clear of the box: |x| >= 6.3,
        // or |z| >= 5 + 1.3 + 0.7 = 7 for the far circle
        const cases: [number, number, (x: number, z: number) => void][] = [
            [4, 0, x => expect(x).toBeGreaterThanOrEqual(6.3)],
            [-4, 0, x => expect(x).toBeLessThanOrEqual(-6.3)],
            [0, 4.2, (_x, z) => expect(z).toBeGreaterThanOrEqual(7)],
            [0, -4.2, (_x, z) => expect(z).toBeLessThanOrEqual(-7)]
        ];
        for (const [x, z, check] of cases) {
            const car = spawnCar(world, 'a', 'bulli', x, z, 0);
            pushOutOfColliders(car.state, car.params, world, 8);
            check(car.state.x, car.state.z);
            // Straight out: the other coordinate stays
            if (x === 0) expect(car.state.x).toBe(0);
            else expect(car.state.z).toBe(0);
            expect(overlapsColliders(car.state, car.params, world)).toBe(false);
        }
    });

    it('does nothing with no iterations or nothing to leave', () => {
        const world = createFlatWorld([BOX]);
        const inside = spawnCar(world, 'a', 'bulli', 4, 0, 0);
        pushOutOfColliders(inside.state, inside.params, world, 0);
        expect(inside.state.x).toBe(4);
        const free = spawnCar(world, 'b', 'bulli', 20, 0, 0);
        pushOutOfColliders(free.state, free.params, world, 8);
        expect(free.state.x).toBe(20);
    });

    it('separates along +x from a post right under a circle', () => {
        const world = createFlatWorld([{ kind: 'circle', x: 30, z: 0.7, r: 0.5, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 30, 0, 0);
        pushOutOfColliders(car.state, car.params, world, 8);
        expect(car.state.x).toBeGreaterThan(30);
        expect(car.state.z).toBe(0);
    });
});

describe('wall impulse', () => {
    it('reports the hit where the circle touches the wall, with the closing speed', () => {
        // Heading +x at 20 m/s into the face x = 30 of a wall
        const world = createFlatWorld([{ kind: 'box', x: 32, z: 0, hw: 2, hd: 20, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 30 - 2 + 0.05, 5, Math.PI / 2, 20);
        resolveWorld(car, world);
        expect(car.events.wallImpact).toBeCloseTo(20, 9);
        expect(car.events.wallX).toBeCloseTo(30, 1);
        expect(car.events.wallZ).toBeCloseTo(5, 9);
        expect(car.state.vx).toBeLessThan(0);
    });

    it('spins the car by at most 2.5 rad/s per hit and never beyond 6 rad/s', () => {
        // The nose at 45° into a wall at 80 m/s
        // and the same hit mirrored at x = 0, which spins the other way
        const world = createFlatWorld([
            { kind: 'box', x: 32, z: 0, hw: 2, hd: 20, top: Infinity },
            { kind: 'box', x: -32, z: 0, hw: 2, hd: 20, top: Infinity }
        ]);
        const hit = (mirror: 1 | -1, yawRate: number) => {
            const car = spawnCar(world, 'a', 'bulli', mirror * 28.8, 0, mirror * Math.PI / 4, 80);
            car.state.yawRate = yawRate;
            resolveWorld(car, world);
            return car.state.yawRate;
        };
        const spun = hit(1, 0);
        // Two iterations per substep, each at most 2.5
        expect(Math.abs(spun)).toBeGreaterThan(2.5 - 1e-9);
        expect(Math.abs(spun)).toBeLessThanOrEqual(5 + 1e-9);
        expect(hit(-1, 0)).toBeCloseTo(-spun, 9);
        expect(hit(1, Math.sign(spun) * 5)).toBe(Math.sign(spun) * 6);
        expect(hit(-1, -Math.sign(spun) * 5)).toBe(-Math.sign(spun) * 6);
    });
});

describe('world border', () => {
    it('keeps both circles inside all four planes at ±498 m', () => {
        const world = createFlatWorld();
        // Front circle across each plane, then the rear one (car reversed)
        const cases: [number, number, number][] = [
            [497, 0, Math.PI / 2], [-497, 0, -Math.PI / 2], [0, 497, 0], [0, -497, Math.PI],
            [497, 0, -Math.PI / 2], [-497, 0, Math.PI / 2], [0, 497, Math.PI], [0, -497, 0]
        ];
        for (const [x, z, yaw] of cases) {
            const car = spawnCar(world, 'a', 'bulli', x, z, yaw, 5);
            resolveWorld(car, world);
            const fx = Math.sin(yaw), fz = Math.cos(yaw);
            for (const side of [1, -1]) {
                const cx = car.state.x + side * 0.7 * fx, cz = car.state.z + side * 0.7 * fz;
                expect(Math.abs(cx) + 1.3, `${x},${z},${yaw}`).toBeLessThanOrEqual(498 + 1e-9);
                expect(Math.abs(cz) + 1.3, `${x},${z},${yaw}`).toBeLessThanOrEqual(498 + 1e-9);
            }
            expect(car.state.wallTicks, `${x},${z},${yaw}`).toBe(0);
        }
    });
});

describe('standing on low colliders', () => {
    it('stands on the highest low top under the car, not on walls, ramp edges or anything above it', () => {
        const world = createFlatWorld([
            { kind: 'box', x: 0, z: 0, hw: 3, hd: 3, top: 1 },
            { kind: 'box', x: 0, z: 2, hw: 3, hd: 1, top: 0.6 },
            { kind: 'box', x: 0, z: -1, hw: 1, hd: 1, top: Infinity },
            { kind: 'box', x: 1, z: 0, hw: 1, hd: 1, top: 1.02, ramp: 0 }
        ]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.state.y = 1.05;
        expect(supportHeight(car, world)).toBe(1);
        // Below the top: it does not stand on it (the wall pushes instead)
        car.state.y = 0.8;
        expect(supportHeight(car, world)).toBe(0.6);
        car.state.y = 0.5;
        expect(supportHeight(car, world)).toBe(-Infinity);
        // A ghost stands on nothing
        car.state.y = 1.05;
        car.mods.ghost = true;
        expect(supportHeight(car, world)).toBe(-Infinity);
        car.mods.ghost = false;
        car.state.ghostExit = 3;
        expect(supportHeight(car, world)).toBe(-Infinity);
    });

    it('passes over a low collider it is above', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 3, hd: 3, top: 1 }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.state.y = 1;
        expect(overlapsColliders(car.state, car.params, world)).toBe(false);
        car.state.y = 0.99;
        expect(overlapsColliders(car.state, car.params, world)).toBe(true);
    });
});
