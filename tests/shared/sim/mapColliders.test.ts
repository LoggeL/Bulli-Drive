import { describe, expect, it } from 'vitest';
import { MEGA_SCALE } from '../../../src/shared/constants.js';
import { overlapsColliders, pushOutOfColliders } from '../../../src/shared/sim/collision.js';
import { BTN_JUMP, DT, V_SAFE } from '../../../src/shared/sim/constants.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import type { CarClassId, SimCar } from '../../../src/shared/sim/types.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import {
    colliderBounds, createSimWorld, SpatialGrid, type Collider, type ColliderInput, type GroundModel, type SimWorld
} from '../../../src/shared/world/colliders.js';
import { DEG, drive, spawnCar, speedOf } from './helpers.js';

// The collider shapes of phase 3 (docs/phase-3-design.md, 8.2, E8): the
// capsule (segment) of guard rails and fences and the turned box (obox) of
// buildings along oblique roads, and the collider grid over a 2 km map.

function circleCentres(car: SimCar): [number, number][] {
    const { x, z, yaw } = car.state;
    const c = car.params.colliderOffset;
    return [[x + c * Math.sin(yaw), z + c * Math.cos(yaw)], [x - c * Math.sin(yaw), z - c * Math.cos(yaw)]];
}

// A ground model: height and surface functions, 2 km grid, no water
function groundWorld(colliders: ColliderInput[], height: (x: number, z: number) => number = () => 0): SimWorld {
    const ground: GroundModel = {
        height, surface: () => 0, waterLevel: -Infinity, fallLimit: -Infinity, bound: 998,
        grid: { origin: -1000, cellSize: 16, cells: 125 }
    };
    return createSimWorld(ground, colliders);
}

describe('collider bounds and the map grid', () => {
    it('bounds a capsule by its ends plus the radius and a turned box by its turned corners', () => {
        const world = groundWorld([
            { kind: 'segment', ax: 0, az: 0, bx: 10, bz: 4, r: 0.5, top: 0.8 },
            // Local z along +x (yaw 90°): hd extends along x, hw along z
            { kind: 'obox', x: 3, z: -2, hw: 2, hd: 5, ux: 1, uz: 0, top: Infinity },
            // 45°: every corner at (±hw ± hd)/√2 on both axes
            { kind: 'obox', x: 0, z: 0, hw: 1, hd: 3, ux: Math.SQRT1_2, uz: Math.SQRT1_2, top: Infinity }
        ]);
        expect(colliderBounds(world.colliders[0])).toEqual([-0.5, -0.5, 10.5, 4.5]);
        expect(colliderBounds(world.colliders[1])).toEqual([-2, -4, 8, 0]);
        const b = colliderBounds(world.colliders[2]);
        for (const [value, expected] of [[b[0], -4 / Math.SQRT2], [b[2], 4 / Math.SQRT2], [b[1], -4 / Math.SQRT2], [b[3], 4 / Math.SQRT2]]) {
            expect(value).toBeCloseTo(expected, 12);
        }
    });

    it('gives a capsule its midpoint and an obox a unit axis', () => {
        const world = groundWorld([
            { kind: 'segment', ax: 2, az: 4, bx: 6, bz: -8, r: 0.15, top: 0.8 },
            { kind: 'obox', x: 0, z: 0, hw: 1, hd: 1, ux: 3, uz: 4, top: 1 }
        ]);
        expect(world.colliders[0]).toMatchObject({ x: 4, z: -2 });
        expect(world.colliders[1]).toMatchObject({ ux: 0.6, uz: 0.8 });
    });

    it('stands a rail on the higher of its two ends, so it is never lower than its top', () => {
        // Ground rising 10 % along x: the ends of an 8 m rail from x = 0 are 0.8 m apart
        const world = groundWorld([{ kind: 'segment', ax: 0, az: 0, bx: 8, bz: 0, r: 0.15, top: 0.8 }], x => 0.1 * x);
        expect(world.colliders[0].base).toBeCloseTo(0.8, 12);
    });

    it('finds colliders in the corners of a 2 km map, where the old 1 km grid clamped them', () => {
        const colliders: Collider[] = [
            { kind: 'circle', x: 990, z: 990, r: 1, base: 0, top: Infinity },
            { kind: 'circle', x: -990, z: 990, r: 1, base: 0, top: Infinity },
            { kind: 'circle', x: 600, z: 600, r: 1, base: 0, top: Infinity }
        ];
        const grid = new SpatialGrid(colliders, { origin: -1000, cellSize: 16, cells: 125 });
        const out = new Int32Array(3);
        expect(Array.from(out.subarray(0, grid.query(985, 985, 995, 995, out)))).toEqual([0]);
        expect(Array.from(out.subarray(0, grid.query(-995, 985, -985, 995, out)))).toEqual([1]);
        // In the old grid every collider beyond 512 m lands in the border
        // cells: a query there would return all three
        const old = new SpatialGrid(colliders);
        expect(old.query(985, 985, 995, 995, out)).toBe(2);
        expect(grid.query(985, 985, 995, 995, out)).toBe(1);
        // A world on a map's ground builds its grid with the map's layout
        const world = groundWorld(colliders.map(({ x, z }) => ({ kind: 'circle', x, z, r: 1, top: Infinity })));
        expect(world.grid.query(985, 985, 995, 995, out)).toBe(1);
    });
});

describe('turned box (obox)', () => {
    it('behaves exactly like the axis-aligned box at yaw 0', () => {
        const box = createFlatWorld([{ kind: 'box', x: 1, z: 2, hw: 3, hd: 5, top: Infinity }]);
        const obox = createFlatWorld([{ kind: 'obox', x: 1, z: 2, hw: 3, hd: 5, ux: 0, uz: 1, top: Infinity }]);
        for (const [x, z, yaw] of [[5.2, 2, 0], [1, 8.5, 0.3], [-3, -4.5, 1.2], [1.5, 2.5, 0], [4.5, 7.5, 2.1]]) {
            const a = spawnCar(box, 'a', 'bulli', x, z, yaw);
            const b = spawnCar(obox, 'b', 'bulli', x, z, yaw);
            expect(overlapsColliders(b.state, b.params, obox)).toBe(overlapsColliders(a.state, a.params, box));
            pushOutOfColliders(a.state, a.params, box, 8);
            pushOutOfColliders(b.state, b.params, obox, 8);
            expect(b.state.x).toBeCloseTo(a.state.x, 12);
            expect(b.state.z).toBeCloseTo(a.state.z, 12);
        }
    });

    it('pushes a car out along the face normal of a box turned by 30°', () => {
        // Local z = (sin 30°, cos 30°); the face at +hd has that normal
        const u = [Math.sin(30 * DEG), Math.cos(30 * DEG)];
        const world = createFlatWorld([{ kind: 'obox', x: 0, z: 0, hw: 10, hd: 2, ux: u[0], uz: u[1], top: Infinity }]);
        // Car across the face (its axis along the face), centre 1 m out: both circles 0.3 m deep
        const car = spawnCar(world, 'a', 'bulli', u[0] * 3, u[1] * 3, 30 * DEG + Math.PI / 2);
        const r = car.params.colliderRadius;
        expect(overlapsColliders(car.state, car.params, world)).toBe(true);
        pushOutOfColliders(car.state, car.params, world, 8);
        // Distance from the face plane: centre · u - hd = r (plus the push epsilon)
        const out = car.state.x * u[0] + car.state.z * u[1] - 2;
        expect(out).toBeGreaterThanOrEqual(r);
        expect(out).toBeLessThan(r + 0.01);
        // Only along the normal: the position along the face is unchanged
        const along = car.state.x * u[1] - car.state.z * u[0];
        expect(along).toBeCloseTo(0, 9);
    });

    it('a car driving into a building at 45° does not get inside', () => {
        const world = createFlatWorld([{ kind: 'obox', x: 0, z: 30, hw: 8, hd: 8, ux: Math.SQRT1_2, uz: Math.SQRT1_2, top: Infinity }]);
        const car = spawnCar(world, 'a', 'sport', 0, 0, 0, 40);
        let hit = false;
        drive(car, world, 120, { throttle: 255 }, () => {
            hit ||= car.events.wallImpact > 0;
            for (const [cx, cz] of circleCentres(car)) {
                // Box frame: |local x|, |local z| minus the circle's reach stays outside
                const dx = cx, dz = cz - 30;
                const lx = dx * Math.SQRT1_2 - dz * Math.SQRT1_2, lz = dx * Math.SQRT1_2 + dz * Math.SQRT1_2;
                expect(Math.abs(lx) < 8 && Math.abs(lz) < 8).toBe(false);
            }
        });
        expect(hit).toBe(true);
    });
});

describe('guard rail (segment)', () => {
    it('slides a car hitting it at 10° with 50 m/s along it, like a wall', () => {
        const world = createFlatWorld([{ kind: 'segment', ax: 5, az: -150, bx: 5, bz: 150, r: 0.15, top: 0.8 }]);
        const car = spawnCar(world, 'a', 'bulli', 0, -100, 10 * DEG, 50);
        let hitTick = -1;
        drive(car, world, 90, { throttle: 255 }, tick => {
            if (hitTick < 0 && car.events.wallImpact > 0) {
                hitTick = tick;
                // vn ≈ 50·sin 10° = 8.7 m/s
                expect(car.events.wallImpact).toBeGreaterThan(7);
                expect(car.events.wallImpact).toBeLessThan(10);
            }
            for (const [cx] of circleCentres(car)) expect(cx + car.params.colliderRadius).toBeLessThan(4.85 + 0.01);
        });
        expect(hitTick).toBeGreaterThanOrEqual(0);
        expect(car.state.yaw).toBeLessThan(0);
        expect(speedOf(car)).toBeGreaterThan(47);
    });

    it('lets a jumping car over (top 0.8) but not a car on the ground, and nobody stands on it', () => {
        const world = createFlatWorld([{ kind: 'segment', ax: -20, az: 15, bx: 20, bz: 15, r: 0.15, top: 0.8 }]);
        const grounded = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        drive(grounded, world, 90, { throttle: 255 });
        expect(grounded.state.z).toBeLessThan(15);

        const jumper = spawnCar(world, 'b', 'bulli', 0, 0, 0, 20);
        drive(jumper, world, 90, tick => ({ throttle: 255, buttons: tick === 20 ? BTN_JUMP : 0 }));
        expect(jumper.state.z).toBeGreaterThan(30);

        // Dropped onto the rail from 3 m: lands on the ground beside it, not on top
        const dropped = spawnCar(world, 'c', 'bulli', 0, 15, Math.PI / 2);
        dropped.state.y = 3;
        dropped.state.grounded = false;
        drive(dropped, world, 60, {});
        expect(dropped.state.grounded).toBe(true);
        expect(dropped.state.y).toBe(0);
        expect(Math.abs(dropped.state.z - 15)).toBeGreaterThan(dropped.params.colliderRadius);
    });

    it('pushes a car centred exactly on the rail out along the rail\'s left normal', () => {
        // Rail along +x: left of (1, 0) is (0, -1) in the sim's convention (dz, -dx)
        const world = createFlatWorld([{ kind: 'segment', ax: -10, az: 0, bx: 10, bz: 0, r: 0.15, top: 0.8 }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, Math.PI / 2);
        pushOutOfColliders(car.state, car.params, world, 8);
        expect(car.state.z).toBeLessThan(-(car.params.colliderRadius + 0.15) + 1e-9);
        expect(car.state.x).toBe(0);
    });

    // Tunneling (the risk "rails feel hard or sticky", design 16): a rail is
    // thinner (0.3 m) than the walls of the phase 1a test (0.5 m)
    const SPEEDS = [85, V_SAFE];
    const ANGLES = [0, 20, 40, 60, 80].map(a => a * DEG);
    for (const classId of CAR_CLASS_IDS) {
        for (const mega of [false, true]) {
            it(`${classId}${mega ? ' (Mega)' : ''} never passes through a rail at up to ${V_SAFE} m/s`, () => {
                const world = createFlatWorld([{ kind: 'segment', ax: -300, az: 0, bx: 300, bz: 0, r: 0.15, top: Infinity }]);
                for (const speed of SPEEDS) {
                    for (const angle of ANGLES) {
                        for (let phase = 0; phase < speed * DT; phase += 0.1) {
                            const probe = spawnCar(world, 'p', classId as CarClassId, 0, 0, 0);
                            const scale = mega ? MEGA_SCALE : 1;
                            const reach = (probe.base.colliderOffset + probe.base.colliderRadius) * scale;
                            const car = spawnCar(world, 'a', classId as CarClassId, 0, -(reach + 3) - phase * Math.cos(angle), angle);
                            if (mega) {
                                car.mods.mega = true;
                                car.state.scale = MEGA_SCALE;
                            }
                            let touched = false;
                            for (let tick = 0; tick < 30; tick++) {
                                if (!touched) {
                                    car.state.vx = Math.sin(angle) * speed;
                                    car.state.vz = Math.cos(angle) * speed;
                                    car.state.yawRate = 0;
                                }
                                car.input.throttle = 255;
                                stepVehicle(car, world);
                                touched ||= car.events.wallImpact > 0;
                                for (const [, cz] of circleCentres(car)) expect(cz, `${speed} m/s ${angle / DEG}°`).toBeLessThan(-0.15);
                            }
                            expect(touched).toBe(true);
                        }
                    }
                }
            });
        }
    }
});
