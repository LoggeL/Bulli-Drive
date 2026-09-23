import { describe, expect, it } from 'vitest';
import { MEGA_SCALE } from '../../../src/shared/constants.js';
import { SIM_TUNING } from '../../../src/shared/sim/constants.js';
import { resolveContact } from '../../../src/shared/sim/contact.js';
import { createFlatWorld, findScenario, runScenario, type ScenarioRun } from '../../../src/shared/sim/scenarios.js';
import { copyVehicleState, createVehicleState, type SimCar, type VehicleState } from '../../../src/shared/sim/types.js';
import { stepWorld } from '../../../src/shared/sim/world.js';
import { DEG, slipAngle, spawnCar, speedOf } from './helpers.js';

// Car-car contact (docs/phase-1a-design.md, section 8 and 14.4)

function carById(run: ScenarioRun, id: string): SimCar {
    return run.cars.find(car => car.id === id)!;
}

// Deepest overlap of any circle pair of two cars (> 0 = overlapping)
function overlap(a: SimCar, b: SimCar): number {
    let worst = -Infinity;
    for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
            const ax = a.state.x + sa * a.params.colliderOffset * Math.sin(a.state.yaw);
            const az = a.state.z + sa * a.params.colliderOffset * Math.cos(a.state.yaw);
            const bx = b.state.x + sb * b.params.colliderOffset * Math.sin(b.state.yaw);
            const bz = b.state.z + sb * b.params.colliderOffset * Math.cos(b.state.yaw);
            worst = Math.max(worst, a.params.colliderRadius + b.params.colliderRadius - Math.hypot(ax - bx, az - bz));
        }
    }
    return worst;
}

// Runs a scenario and reports the tick of the first car contact plus the
// velocities just before and after it
function firstContact(name: string) {
    const scenario = findScenario(name);
    let contactTick = -1;
    const before = new Map<string, VehicleState>();
    const after = new Map<string, VehicleState>();
    const previous = new Map<string, VehicleState>();
    const run = runScenario(scenario, (tick, current) => {
        const touched = current.cars.some(car => car.events.carImpact > 0);
        if (touched && contactTick < 0) {
            contactTick = tick;
            for (const car of current.cars) {
                before.set(car.id, previous.get(car.id)!);
                after.set(car.id, copyVehicleState(createVehicleState(), car.state));
            }
        }
        for (const car of current.cars) {
            // Contacts never touch the vertical: everything stays on the flat ground
            expect(car.state.y).toBe(0);
            expect(car.state.vy).toBe(0);
            previous.set(car.id, copyVehicleState(createVehicleState(), car.state));
        }
    });
    expect(contactTick).toBeGreaterThanOrEqual(0);
    return { run, contactTick, before, after };
}

describe('v2 contact golden scenarios', () => {
    it('frontal: two Bullis at 50 m/s stop and bounce back with at most 4 m/s', () => {
        // Each car needs Δv = 52 m/s; the 30 m/s cap per tick spreads that
        // over two ticks
        const scenario = findScenario('contact-frontal');
        let contactTick = -1;
        const speeds: number[][] = [];
        const run = runScenario(scenario, (tick, current) => {
            if (contactTick < 0 && current.cars[0].events.carImpact > 0) contactTick = tick;
            if (contactTick >= 0 && tick <= contactTick + 1) {
                speeds.push(current.cars.map(car => car.state.vz));
                for (const car of current.cars) expect(car.contactDv).toBeLessThanOrEqual(30 + 1e-9);
            }
        });
        const [first, second] = speeds;
        expect(first[0]).toBeCloseTo(50 - 30, 1);
        for (const vz of second) expect(Math.abs(vz)).toBeLessThanOrEqual(4);
        expect(second[0]).toBeLessThan(0);
        // Symmetric set-up: momentum stays zero and the cars mirror each other
        expect(Math.abs(second[0] + second[1])).toBeLessThan(1e-9);
        const [a, b] = [carById(run, 'a'), carById(run, 'b')];
        expect(a.state.x).toBeCloseTo(-b.state.x, 6);
        expect(a.state.z).toBeCloseTo(-b.state.z, 6);
        expect(overlap(a, b)).toBeLessThan(0.05);
    });

    it('T-bone: the pickup shoves the standing beetle sideways and loses speed', () => {
        const { run, before, after } = firstContact('contact-t-bone');
        expect(after.get('beetle')!.vx).toBeGreaterThan(5);
        expect(after.get('pickup')!.vx).toBeLessThan(before.get('pickup')!.vx - 5);
        // Contact masses 2000 vs 900 are capped at a ratio of 1.8
        const dvBeetle = after.get('beetle')!.vx - before.get('beetle')!.vx;
        const dvPickup = before.get('pickup')!.vx - after.get('pickup')!.vx;
        expect(dvBeetle / dvPickup).toBeGreaterThan(1.5);
        expect(dvBeetle / dvPickup).toBeLessThan(2.1);
        expect(overlap(carById(run, 'pickup'), carById(run, 'beetle'))).toBeLessThan(0.05);
    });

    it('PIT: the hit Bulli spins at most 2.5 rad/s per tick and is caught again within 90 ticks', () => {
        const scenario = findScenario('contact-pit');
        let contactTick = -1, prevYawRate = 0, maxJump = 0, maxDw = 0, betaAt90 = Infinity;
        runScenario(scenario, (tick, run) => {
            const bulli = carById(run, 'bulli');
            if (contactTick < 0 && bulli.events.carImpact > 0) contactTick = tick;
            if (contactTick >= 0) {
                maxJump = Math.max(maxJump, Math.abs(bulli.state.yawRate - prevYawRate));
                maxDw = Math.max(maxDw, bulli.contactDw);
                if (tick === contactTick + 90) betaAt90 = Math.abs(slipAngle(bulli.state));
            }
            prevYawRate = bulli.state.yawRate;
        });
        expect(contactTick).toBeGreaterThanOrEqual(0);
        // A real kick, within the contact cap (plus one tick of tyre torque)
        expect(maxDw).toBeGreaterThan(1.5);
        expect(maxDw).toBeLessThanOrEqual(SIM_TUNING.CONTACT_DOMEGA_CAP + 1e-9);
        expect(maxJump).toBeLessThanOrEqual(SIM_TUNING.CONTACT_DOMEGA_CAP + 0.5);
        expect(betaAt90).toBeLessThan(10 * DEG);
    });

    it('chain of three: the front cars get faster, nothing overlaps after 10 ticks', () => {
        const { run, contactTick, before, after } = firstContact('contact-chain-three');
        expect(after.get('c2')!.vz).toBeGreaterThan(before.get('c2')!.vz);
        const [c1, c2, c3] = ['c1', 'c2', 'c3'].map(id => carById(run, id));
        expect(c3.state.vz).toBeLessThan(45);
        expect(c1.state.vz).toBeGreaterThan(before.get('c1')!.vz - 5);
        expect(contactTick).toBeLessThan(170);
        expect(overlap(c1, c2)).toBeLessThan(0.05);
        expect(overlap(c2, c3)).toBeLessThan(0.05);
        // Order along the road is kept
        expect(c1.state.z).toBeGreaterThan(c2.state.z);
        expect(c2.state.z).toBeGreaterThan(c3.state.z);
    });

    it('Mega pushes the beetle away and barely slows down itself', () => {
        const { before, after } = firstContact('contact-mega-vs-beetle');
        const dvMega = before.get('mega')!.vz - after.get('mega')!.vz;
        const dvBeetle = after.get('beetle')!.vz - before.get('beetle')!.vz;
        expect(dvBeetle).toBeGreaterThan(20);
        // Mass ratio capped at 3.5 (the Mega's throttle blurs it a little)
        expect(dvBeetle / dvMega).toBeGreaterThan(3.2);
        expect(dvBeetle / dvMega).toBeLessThan(3.7);
    });

    it('a Party ghost drives straight through a parked car', () => {
        const run = runScenario(findScenario('ghost-through-car-and-building'), (_tick, current) => {
            for (const car of current.cars) expect(car.events.carImpact).toBe(0);
        });
        const parked = carById(run, 'parked');
        expect(parked.state.x).toBe(0);
        expect(parked.state.z).toBe(-30);
    });
});

describe('v2 contact rules', () => {
    it('conserves momentum between two dynamic cars (with capped contact masses)', () => {
        const world = createFlatWorld();
        const cases: [SimCar, SimCar][] = [
            [spawnCar(world, 'a', 'bulli', 0, 0, 0, 10), spawnCar(world, 'b', 'bulli', 1.2, 3.8, 0.4, -5)],
            [spawnCar(world, 'a', 'beetle', 0, 0, 0.3, 20), spawnCar(world, 'b', 'pickup', -1, 4, -1.2, 3)]
        ];
        for (const [a, b] of cases) {
            a.state.yawRate = 0.5;
            // resolveContact uses the effective params; here the base values
            const ratio = Math.max(a.params.massRatioCap, b.params.massRatioCap);
            const light = Math.min(a.params.contactMass, b.params.contactMass);
            const ma = Math.min(a.params.contactMass, ratio * light);
            const mb = Math.min(b.params.contactMass, ratio * light);
            const px = ma * a.state.vx + mb * b.state.vx, pz = ma * a.state.vz + mb * b.state.vz;
            resolveContact(a, b);
            expect(ma * a.state.vx + mb * b.state.vx).toBeCloseTo(px, 6);
            expect(ma * a.state.vz + mb * b.state.vz).toBeCloseTo(pz, 6);
        }
    });

    it('caps the velocity change per car and tick at 30 m/s', () => {
        const world = createFlatWorld();
        const mega = spawnCar(world, 'a', 'pickup', 0, -6, 0, 85);
        mega.mods.mega = true;
        mega.state.scale = MEGA_SCALE;
        const victim = spawnCar(world, 'b', 'beetle', 0, 4, 0);
        const cars = [mega, victim];
        for (let tick = 0; tick < 20; tick++) {
            const vBefore = victim.state.vz;
            stepWorld(cars, world);
            expect(victim.contactDv).toBeLessThanOrEqual(SIM_TUNING.CONTACT_DV_CAP + 1e-9);
            expect(Math.abs(victim.state.vz - vBefore)).toBeLessThan(SIM_TUNING.CONTACT_DV_CAP + 1);
            expect(Math.abs(victim.contactDw)).toBeLessThanOrEqual(SIM_TUNING.CONTACT_DOMEGA_CAP + 1e-9);
        }
        expect(speedOf(victim)).toBeGreaterThan(30);
    });

    it('does not explode when three cars spawn on top of each other', () => {
        const world = createFlatWorld();
        const cars = [
            spawnCar(world, 'a', 'bulli', 0, 0, 0),
            spawnCar(world, 'b', 'pickup', 0.3, 0.2, 1),
            spawnCar(world, 'c', 'beetle', -0.2, 0.1, 2)
        ];
        for (let tick = 0; tick < 120; tick++) {
            stepWorld(cars, world);
            for (const car of cars) expect(speedOf(car)).toBeLessThan(15);
        }
        expect(overlap(cars[0], cars[1])).toBeLessThan(0.05);
        expect(overlap(cars[0], cars[2])).toBeLessThan(0.05);
        expect(overlap(cars[1], cars[2])).toBeLessThan(0.05);
    });

    it('skips cars in a reset ghost and cars far apart in height', () => {
        const world = createFlatWorld();
        const a = spawnCar(world, 'a', 'bulli', 0, 0, 0, 10);
        const b = spawnCar(world, 'b', 'bulli', 0, 3, 0);
        b.state.ghostTicks = 5;
        resolveContact(a, b);
        expect(a.state.vz).toBe(10);
        b.state.ghostTicks = 0;
        b.state.y = 1.5;
        resolveContact(a, b);
        expect(a.state.vz).toBe(10);
        b.state.y = 1.3;
        resolveContact(a, b);
        expect(a.state.vz).toBeLessThan(10);
    });

    it('a kinematic proxy only pushes the dynamic car, softly and without rebound', () => {
        const world = createFlatWorld();
        const local = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        const proxy = spawnCar(world, 'b', 'bulli', 0, 3.5, 0);
        proxy.kinematic = true;
        proxy.contactScale = SIM_TUNING.PROXY_CONTACT_SCALE;
        const proxyBefore = copyVehicleState(createVehicleState(), proxy.state);
        resolveContact(local, proxy);
        expect(proxy.state).toStrictEqual(proxyBefore);
        // e = 0: a full-strength impulse would stop the closing speed; the proxy
        // counts as 1500 kg, so the two-body impulse takes away half of the
        // 20 m/s, 70 % of that is applied
        expect(local.state.vz).toBeCloseTo(20 - 0.7 * 10, 6);
        // Both kinematic: nothing happens
        local.kinematic = true;
        local.state.z = 1;
        const localBefore = copyVehicleState(createVehicleState(), local.state);
        resolveContact(local, proxy);
        expect(local.state).toStrictEqual(localBefore);
    });

    it('a car hit from the side slides on its tyres, not stopped dead (90° like 60°)', () => {
        // A pickup at 40 m/s into a standing beetle; the pickup stops after
        // the hit. Measures how far the beetle slides.
        const slide = (angle: number) => {
            const world = createFlatWorld();
            const beetle = spawnCar(world, 'b', 'beetle', 0, 0, 0);
            const heading = Math.PI / 2 + (90 * DEG - angle);
            const pickup = spawnCar(world, 'a', 'pickup', -8 * Math.sin(heading), -8 * Math.cos(heading), heading, 40);
            const cars = [pickup, beetle];
            let hit = false, distance = 0;
            for (let tick = 0; tick < 300; tick++) {
                const { x, z } = beetle.state;
                stepWorld(cars, world);
                if (!hit && beetle.events.carImpact > 0) {
                    hit = true;
                    pickup.state.vx = pickup.state.vz = pickup.state.yawRate = 0;
                    pickup.state.x -= 20;
                }
                distance += Math.hypot(beetle.state.x - x, beetle.state.z - z);
            }
            expect(hit).toBe(true);
            return distance;
        };
        const side = slide(90 * DEG), angled = slide(60 * DEG);
        expect(side).toBeGreaterThan(10);
        expect(side).toBeGreaterThan(angled / 5);
    });

    it('slows a car sliding sideways at 70 m/s smoothly (u ≈ 0 is no low-speed case)', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.state.vx = 70;
        let prev = 70, maxDrop = 0;
        for (let tick = 0; tick < 30; tick++) {
            stepWorld([car], world);
            maxDrop = Math.max(maxDrop, prev - speedOf(car));
            prev = speedOf(car);
        }
        // At most a few g from the sliding tyres, not 12 m/s in one tick
        expect(maxDrop).toBeLessThan(1);
        expect(speedOf(car)).toBeGreaterThan(50);
    });

    it('gives the same result whatever order the cars come in', () => {
        const build = () => {
            const world = createFlatWorld();
            return {
                world,
                cars: [
                    spawnCar(world, 'car-10', 'bulli', 0, -20, 0, 40),
                    spawnCar(world, 'car-2', 'sport', 1, 0, Math.PI, 30),
                    spawnCar(world, 'car-1', 'beetle', -1.5, -2, 0.3, 5)
                ]
            };
        };
        const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        const results = permutations.map(order => {
            const { world, cars } = build();
            const list = order.map(i => cars[i]);
            for (let tick = 0; tick < 90; tick++) {
                for (const car of list) car.input.throttle = 200;
                stepWorld(list, world);
            }
            return Object.fromEntries(cars.map(car => [car.id, car.state]));
        });
        // Sorted with <, so 'car-1' < 'car-10' < 'car-2'
        for (const result of results.slice(1)) expect(result).toStrictEqual(results[0]);
        expect(results[0]['car-1'].vx).not.toBe(0);
    });

    it('lets a dynamic car push a standing one with the rebound limited to 4 m/s', () => {
        const world = createFlatWorld();
        const a = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        const b = spawnCar(world, 'b', 'bulli', 0, 3.9, 0);
        resolveContact(a, b);
        // Equal masses: vn = -20, bounce = min(0.25·20, 4) = 4
        expect(b.state.vz - a.state.vz).toBeCloseTo(4, 6);
        expect(a.state.vz + b.state.vz).toBeCloseTo(20, 6);
    });
});

// ---- Tunneling between cars (14.5) ----

// Circle centres of a car: front, rear
function centres(car: SimCar): [number, number][] {
    const { x, z, yaw } = car.state;
    const c = car.params.colliderOffset;
    return [[x + c * Math.sin(yaw), z + c * Math.cos(yaw)], [x - c * Math.sin(yaw), z - c * Math.cos(yaw)]];
}

// Runs two cars at each other at fixed speeds until they first touch and
// checks every circle pair: when a pair swaps its order along the approach
// axis (ax, az), it must be passing side by side, never through each other
function expectNoTunneling(a: SimCar, b: SimCar, speedA: number, speedB: number, ax: number, az: number, label: string): void {
    const world = createFlatWorld();
    const cars = [a, b];
    const reach = a.params.colliderRadius + b.params.colliderRadius;
    let touched = false;
    let prev: number[][] | null = null;
    for (let tick = 0; tick < 40; tick++) {
        if (!touched) {
            for (const [car, speed] of [[a, speedA], [b, speedB]] as [SimCar, number][]) {
                car.state.vx = Math.sin(car.state.yaw) * speed;
                car.state.vz = Math.cos(car.state.yaw) * speed;
                car.state.yawRate = 0;
            }
        }
        stepWorld(cars, world);
        touched ||= a.events.carImpact > 0;
        // Along/lateral offset of every circle pair (a_i - b_j)
        const now: number[][] = [];
        for (const [pax, paz] of centres(a)) {
            for (const [pbx, pbz] of centres(b)) {
                const dx = pax - pbx, dz = paz - pbz;
                now.push([dx * ax + dz * az, dx * az - dz * ax]);
            }
        }
        if (prev) {
            for (let k = 0; k < 4; k++) {
                const [a0, l0] = prev[k], [a1, l1] = now[k];
                if ((a0 < 0) !== (a1 < 0)) {
                    const lateral = l0 + (l1 - l0) * (-a0 / (a1 - a0));
                    expect(Math.abs(lateral), label).toBeGreaterThan(reach - 0.3);
                }
            }
        }
        prev = now;
    }
}

describe('v2 tunneling between cars', () => {
    it('two beetles meeting head-on at 85 m/s each never pass through each other', () => {
        for (const angle of [0, 10, 20, 30]) {
            for (let k = -30; k <= 30; k++) {
                const offset = k / 10;
                const world = createFlatWorld();
                const a = spawnCar(world, 'a', 'beetle', 0, -8, 0);
                const b = spawnCar(world, 'b', 'beetle', offset, 8, Math.PI + angle * DEG);
                expectNoTunneling(a, b, 85, 85, 0, 1, `head-on ${angle}° offset ${offset}`);
            }
        }
    });

    it('a beetle T-boning another at 85 m/s never passes through it', () => {
        for (let k = -40; k <= 40; k++) {
            const offset = k / 10;
            const world = createFlatWorld();
            const a = spawnCar(world, 'a', 'beetle', -10, offset, Math.PI / 2);
            const b = spawnCar(world, 'b', 'beetle', 0, 0, 0);
            expectNoTunneling(a, b, 85, 0, 1, 0, `T-bone offset ${offset}`);
        }
    });
});
