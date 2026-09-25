import { describe, expect, it } from 'vitest';
import { overlapsColliders } from '../../../src/shared/sim/collision.js';
import { createDummy, driveDummy, resetDummy } from '../../../src/shared/sim/dummies.js';
import { copyVehicleState, createVehicleState, type SimCar, type VehicleState } from '../../../src/shared/sim/types.js';
import { createSimCar, placeVehicle } from '../../../src/shared/sim/vehicle.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import { insideRamp, rampEdgeColliders, RAMP_EDGE_MIN_TOP, RAMP_EDGE_THICKNESS, type SimWorld } from '../../../src/shared/world/colliders.js';
import { createSandboxWorld, SANDBOX, SANDBOX_PAD_SIZE, sandboxColliders } from '../../../src/shared/world/sandbox.js';
import { DEG, forwardSpeed, speedOf } from './helpers.js';

// The sandbox of ?sandbox=1 (docs/phase-1a-design.md, 12.7): its layout,
// the ramp edge walls and the dummy cars, on the same world the browser builds

function carAt(world: SimWorld, x: number, z: number, yaw: number, speed: number, classId = CAR_CLASS_IDS[0]): SimCar {
    const car = createSimCar('player', classId);
    placeVehicle(car.state, world, x, z, yaw);
    car.state.vx = Math.sin(yaw) * speed;
    car.state.vz = Math.cos(yaw) * speed;
    return car;
}

interface RunLog {
    wallImpact: number;
    maxY: number;
    airTicks: number;
    firstLanding: { z: number; impact: number } | null;
}

// Steps the cars with full throttle for the first one, dummies by their script
function run(cars: SimCar[], world: SimWorld, ticks: number, throttle = 255): RunLog {
    const log: RunLog = { wallImpact: 0, maxY: 0, airTicks: 0, firstLanding: null };
    const player = cars[0];
    for (let tick = 0; tick < ticks; tick++) {
        player.input.throttle = throttle;
        for (const car of cars) {
            const spec = SANDBOX.dummies.find(dummy => dummy.id === car.id);
            if (spec) driveDummy(car, spec);
        }
        stepWorld(cars, world);
        log.wallImpact = Math.max(log.wallImpact, player.events.wallImpact);
        log.maxY = Math.max(log.maxY, player.state.y);
        if (!player.state.grounded) log.airTicks++;
        if (player.events.landedImpact > 0 && !log.firstLanding) {
            log.firstLanding = { z: player.state.z, impact: player.events.landedImpact };
        }
    }
    return log;
}

describe('sandbox layout', () => {
    const world = createSandboxWorld();

    it('keeps every collider on the pad and thick enough against tunneling', () => {
        const half = SANDBOX_PAD_SIZE / 2;
        for (const collider of world.colliders) {
            // The pad has circles and axis-aligned boxes only
            if (collider.kind !== 'circle' && collider.kind !== 'box') throw new Error(`a ${collider.kind} on the pad`);
            const hx = collider.kind === 'circle' ? collider.r : collider.hw;
            const hz = collider.kind === 'circle' ? collider.r : collider.hd;
            expect(Math.abs(collider.x) + hx).toBeLessThanOrEqual(half);
            expect(Math.abs(collider.z) + hz).toBeLessThanOrEqual(half);
            // Section 7.3: posts r >= 0.35, walls at least 0.25 m half thickness
            if (collider.kind === 'circle') expect(collider.r).toBeGreaterThanOrEqual(0.35);
            else expect(Math.min(collider.hw, collider.hd)).toBeGreaterThanOrEqual(RAMP_EDGE_THICKNESS);
        }
        expect(world.colliders.length).toBe(sandboxColliders().length);
        expect(world.ramps.length).toBe(SANDBOX.ramps.length);
        // A reset leaves the car where it is
        expect(world.resetPose).toBeUndefined();
    });

    it('spawns the player and the dummies on free, flat ground, apart from each other', () => {
        const spawns = [{ id: 'player', classId: 'pickup' as const, ...SANDBOX.spawn }, ...SANDBOX.dummies];
        expect(SANDBOX.dummies.length).toBeGreaterThanOrEqual(3);
        expect(SANDBOX.dummies.length).toBeLessThanOrEqual(5);
        // Different bodies and masses
        expect(new Set(SANDBOX.dummies.map(dummy => dummy.classId)).size).toBe(SANDBOX.dummies.length);
        for (const spawn of spawns) {
            // The largest car at every spawn: no collider, no ramp
            const car = carAt(world, spawn.x, spawn.z, spawn.yaw, 0, 'pickup');
            expect(overlapsColliders(car.state, car.params, world), spawn.id).toBe(false);
            expect(world.groundHeight(spawn.x, spawn.z)).toBe(0);
            for (const other of spawns) {
                if (other !== spawn) expect(Math.hypot(other.x - spawn.x, other.z - spawn.z)).toBeGreaterThan(10);
            }
        }
    });

    it('builds the same world every time', () => {
        const again = createSandboxWorld();
        expect(again.colliders).toStrictEqual(world.colliders);
        expect(again.ramps).toStrictEqual(world.ramps);
    });
});

describe('ramp edge walls', () => {
    it('surround the front edge and the sides, as high as the ramp there', () => {
        const ramp = { x: 10, z: 20, yaw: 0, width: 8, length: 16, height: 4 };
        const walls = rampEdgeColliders(ramp, 3);
        const front = walls[0];
        expect(front).toMatchObject({ kind: 'box', x: 10, z: 28.25, hw: 4.5, hd: 0.25, top: 4, ramp: 3 });
        const sides = walls.slice(1);
        // 4 pieces of 4 m per side, tops 1, 2, 3 and 4 m
        expect(sides.length).toBe(8);
        expect(sides.map(side => side.top)).toStrictEqual([1, 1, 2, 2, 3, 3, 4, 4]);
        for (const side of sides) {
            expect(side.kind).toBe('box');
            expect(Math.abs(side.x - 10)).toBe(4.25);
            expect(insideRamp(ramp, side.x, side.z)).toBe(false);
        }
        // Without the front wall (hill halves), low side pieces left out
        const low = rampEdgeColliders({ ...ramp, height: 1 }, 0, false);
        expect(low.every(side => side.top >= RAMP_EDGE_MIN_TOP)).toBe(true);
        expect(low.length).toBe(6);
    });

    it('follow a ramp turned by 90° and refuse other angles', () => {
        const turned = rampEdgeColliders({ x: 0, z: 0, yaw: Math.PI / 2, width: 8, length: 16, height: 4 }, 0);
        // Rising towards +x: the front wall is thin along x
        expect(turned[0]).toMatchObject({ x: 8.25, z: 0, hw: 0.25, hd: 4.5 });
        expect(() => rampEdgeColliders({ x: 0, z: 0, yaw: 0.3, width: 8, length: 16, height: 4 }, 0)).toThrow();
    });

    it('stop a car driving into the high face or a side instead of lifting it up', () => {
        const world = createSandboxWorld();
        const kickerIndex = SANDBOX.ramps.findIndex(ramp => ramp.x === 0 && ramp.yaw === 0);
        const ramp = SANDBOX.ramps[kickerIndex];
        // From behind, into the 3.75 m face
        const behind = carAt(world, ramp.x, ramp.z + 30, Math.PI, 20);
        const fromBehind = run([behind], world, 120);
        expect(fromBehind.wallImpact).toBeGreaterThan(15);
        expect(fromBehind.maxY).toBeLessThan(0.05);
        expect(behind.state.z).toBeGreaterThan(ramp.z + ramp.length / 2);
        // From the side near the high end, between two kickers
        const side = carAt(world, ramp.x + 14, ramp.z + 4, -Math.PI / 2, 20);
        const fromSide = run([side], world, 90);
        expect(fromSide.wallImpact).toBeGreaterThan(15);
        expect(fromSide.maxY).toBeLessThan(0.05);
        expect(side.state.x).toBeGreaterThan(ramp.x + ramp.width / 2);
    });

    it('never catch a car taking off, on every kicker, with every class', () => {
        const world = createSandboxWorld();
        // The three kickers side by side (the jump has its own test)
        for (const ramp of SANDBOX.ramps.filter(candidate => candidate.z === -90)) {
            for (const classId of CAR_CLASS_IDS) {
                const car = carAt(world, ramp.x, ramp.z - ramp.length / 2 - 30, 0, 28, classId);
                // Until it is well past the ramp (the 10° line ends at the post row)
                let wall = 0;
                for (let tick = 0; tick < 150; tick++) {
                    car.input.throttle = 255;
                    stepWorld([car], world);
                    wall = Math.max(wall, car.events.wallImpact);
                }
                expect(wall, `${classId} on the ramp at x ${ramp.x}`).toBe(0);
                expect(car.state.z, `${classId} on the ramp at x ${ramp.x}`).toBeGreaterThan(ramp.z + ramp.length / 2 + 15);
            }
        }
    });

    it('let the jump land on the far slope of the landing hill', () => {
        const world = createSandboxWorld();
        const kicker = SANDBOX.ramps.find(ramp => ramp.x === 70 && !ramp.hill)!;
        const slope = SANDBOX.ramps.find(ramp => ramp.hill && ramp.yaw !== 0)!;
        const car = carAt(world, kicker.x, kicker.z - 40, 0, 30);
        const log = run([car], world, 150);
        expect(log.wallImpact).toBe(0);
        expect(log.airTicks).toBeGreaterThan(30);
        expect(log.firstLanding).not.toBeNull();
        expect(log.firstLanding!.z).toBeGreaterThan(slope.z - slope.length / 2);
        expect(log.firstLanding!.z).toBeLessThan(slope.z + slope.length / 2);
        expect(log.firstLanding!.impact).toBeLessThan(10);
    });
});

describe('sandbox obstacles', () => {
    const world = createSandboxWorld();

    it('lets a car slide along the long wall without losing much speed', () => {
        const wall = SANDBOX.walls[0];
        const face = wall.x + wall.hw;
        // 10° towards the wall at 40 m/s
        const car = carAt(world, face + 5, wall.z - wall.hd + 20, -10 * DEG, 40);
        const log = run([car], world, 120);
        expect(log.wallImpact).toBeGreaterThan(3);
        expect(speedOf(car)).toBeGreaterThan(35);
        expect(car.state.x - car.params.colliderRadius).toBeGreaterThan(face - 0.05);
    });

    it('stops every class at 85 m/s at the post row, on a post and between two', () => {
        for (const classId of CAR_CLASS_IDS) {
            for (const x of [-30, -31.25]) {
                const car = carAt(world, x, -40, 0, 85, classId);
                run([car], world, 60);
                expect(car.state.z, `${classId} at x ${x}`).toBeLessThan(0);
            }
        }
    });
});

describe('sandbox dummies', () => {
    it('lap their circles at their speed and stay parked otherwise', () => {
        const world = createSandboxWorld();
        const cars = SANDBOX.dummies.map(spec => createDummy(spec, world));
        const worst: Record<string, { radius: number; speed: number }> = {};
        for (let tick = 0; tick < 1800; tick++) {
            // stepWorld sorts the cars by id, so look each one up
            for (const spec of SANDBOX.dummies) driveDummy(cars.find(car => car.id === spec.id)!, spec);
            stepWorld(cars, world);
            if (tick < 600) continue;
            for (const spec of SANDBOX.dummies) {
                const car = cars.find(candidate => candidate.id === spec.id)!;
                if (spec.behaviour.kind !== 'circle') continue;
                const { cx, cz, radius, speed } = spec.behaviour;
                const entry = worst[spec.id] ??= { radius: 0, speed: 0 };
                entry.radius = Math.max(entry.radius, Math.abs(Math.hypot(car.state.x - cx, car.state.z - cz) - radius));
                entry.speed = Math.max(entry.speed, Math.abs(forwardSpeed(car.state) - speed));
            }
        }
        for (const spec of SANDBOX.dummies) {
            const car = cars.find(candidate => candidate.id === spec.id)!;
            if (spec.behaviour.kind === 'circle') {
                expect(worst[spec.id].radius, spec.id).toBeLessThan(2);
                expect(worst[spec.id].speed, spec.id).toBeLessThan(1);
            } else {
                expect(car.state.x).toBe(spec.x);
                expect(car.state.z).toBe(spec.z);
            }
        }
    });

    it('get pushed away when the player rams them, and reset to their spawn', () => {
        const world = createSandboxWorld();
        const spec = SANDBOX.dummies.find(dummy => dummy.behaviour.kind === 'parked')!;
        const dummy = createDummy(spec, world);
        // Broadside into the parked dummy from 25 m at 20 m/s
        const player = carAt(world, spec.x - 25, spec.z, Math.PI / 2, 20);
        run([player, dummy], world, 90);
        expect(dummy.state.x - spec.x).toBeGreaterThan(2);
        expect(speedOf(dummy)).toBeGreaterThan(1);
        // The ram cost the player speed (it kept full throttle)
        expect(forwardSpeed(player.state)).toBeLessThan(20);
        resetDummy(dummy, spec, world);
        expect(dummy.state).toStrictEqual({
            ...createVehicleState(), x: spec.x, z: spec.z, yaw: spec.yaw, y: 0
        });
    });

    it('replay the same run bit for bit', () => {
        const record = (): VehicleState[] => {
            const world = createSandboxWorld();
            const player = carAt(world, SANDBOX.spawn.x, SANDBOX.spawn.z, SANDBOX.spawn.yaw, 0);
            const cars = [player, ...SANDBOX.dummies.map(spec => createDummy(spec, world))];
            for (let tick = 0; tick < 900; tick++) {
                player.input.throttle = 255;
                player.input.steer = tick > 60 && tick < 140 ? -127 : 0;
                for (const spec of SANDBOX.dummies) driveDummy(cars.find(car => car.id === spec.id)!, spec);
                stepWorld(cars, world);
            }
            return cars.map(car => copyVehicleState(createVehicleState(), car.state));
        };
        expect(record()).toStrictEqual(record());
    });
});

describe('ramp walls outside the sandbox', () => {
    it('leave the golden worlds without edge walls untouched', () => {
        // createFlatWorld with a ramp adds no colliders of its own
        const world = createFlatWorld([], [{ x: 0, z: 0, yaw: 0, width: 8, length: 16, height: 3 }]);
        expect(world.colliders.length).toBe(0);
    });
});
