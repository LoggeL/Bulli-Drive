import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardSpeed, RoadDriver, steerForAngle } from '../../tools/bots/driver.js';
import { freeRunway, longestRunway, RUNWAY_CLEARANCE } from '../../tools/bots/runway.js';
import { mixTotal, parseMix, httpOrigin } from '../../tools/bots/swarm.js';
import { mapFor } from '../../src/server/maps.js';
import { slotSpawn } from '../../src/server/rooms/spawn.js';
import { pointInPolygon } from '../../src/shared/map/geometry.js';
import { nearestRoad } from '../../src/shared/map/roadNetwork.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import type { CarClassId } from '../../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../src/shared/sim/world.js';

// The bots' driving (docs/phase-1b-design.md, 15.2) against the sim alone
// on Bulli Bay: pure pursuit over the road network in Free Roam, across the
// arena in the Party, the chase of mode ram, the runway of the scripted
// bumps and the mix syntax of npm run bots.

const map = mapFor();

beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(4242));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('RoadDriver', () => {
    it.each(['bulli', 'sport', 'jeep', 'beetle', 'pickup'] as CarClassId[])('drives the %s over the roads for a minute', (classId) => {
        const car = createSimCar('bot', classId);
        // A Free Roam spawn; a different group per class
        const pose = slotSpawn(map.spawns.freeRoam, classId.length, []);
        spawnVehicle(car.state, map.simWorld, pose.x, pose.z, pose.yaw);
        const driver = new RoadDriver(mulberry32(classId.length));
        driver.setMap(map, false);
        let top = 0, offRoad = 0;
        for (let t = 0; t < 60 * 60; t++) {
            driver.drive(car.state, car.params, car.input);
            stepWorld([car], map.simWorld);
            top = Math.max(top, forwardSpeed(car.state));
            // Near a road's centre line (a lane is 3 m out, a bend a few more)
            if (t % 30 === 0 && (nearestRoad(map.net, car.state.x, car.state.z, 12)?.distance ?? Infinity) > 10) offRoad++;
        }
        // Cruising at 20-35 m/s with the bends and junctions: well over 10 m/s on average
        expect(driver.distance).toBeGreaterThan(600);
        expect(top).toBeGreaterThan(18);
        expect(top).toBeLessThan(40);
        // At most a few of the 120 half-second checks off the road, and a reset at most
        expect(offRoad).toBeLessThanOrEqual(6);
        expect(driver.resets).toBeLessThanOrEqual(1);
    });

    it('wanders across the arena in the Party and stays behind its fence', () => {
        const arena = map.net.areas.find(a => a.id === map.sources.pois.arena.area)!;
        const car = createSimCar('bot', 'beetle');
        const slot = map.spawns.party[0];
        spawnVehicle(car.state, map.partyWorld, slot.x, slot.z, slot.yaw);
        const driver = new RoadDriver(mulberry32(5));
        driver.setMap(map, true);
        for (let t = 0; t < 60 * 30; t++) {
            driver.drive(car.state, car.params, car.input);
            stepWorld([car], map.partyWorld);
            expect(pointInPolygon(arena.polygon, car.state.x, car.state.z)).toBe(true);
        }
        expect(driver.distance).toBeGreaterThan(150);
    });

    it('does not chase a car behind a container in the arena, but drives on', () => {
        // The containers at (-122, 566) and (-118.5, 566) stand along z (560-572);
        // the ram bot east of them, its target west of them
        const car = createSimCar('ram', 'bulli');
        const target = createSimCar('target', 'bulli');
        spawnVehicle(car.state, map.partyWorld, -110, 566, -Math.PI / 2);
        spawnVehicle(target.state, map.partyWorld, -130, 566, 0);
        car.state.ghostTicks = target.state.ghostTicks = 0;
        const driver = new RoadDriver(mulberry32(3));
        driver.setMap(map, true);
        for (let t = 0; t < 60 * 4; t++) {
            const s = target.state;
            driver.drive(car.state, car.params, car.input, { x: s.x, z: s.z, vx: s.vx, vz: s.vz });
            stepWorld([car, target], map.partyWorld);
        }
        // Chasing, it would push into the container: a few metres and a
        // back-off in 4 s; wandering it drives off
        expect(driver.backoffCount).toBe(0);
        expect(driver.distance).toBeGreaterThan(25);
    });

    it('chases a car standing on a free road and runs into it', () => {
        const runway = longestRunway(map);
        const car = createSimCar('ram', 'bulli');
        const target = createSimCar('target', 'bulli');
        spawnVehicle(car.state, map.simWorld, runway.x, runway.z + 5, 0);
        spawnVehicle(target.state, map.simWorld, runway.x + 1, runway.z + 45, Math.PI / 2);
        car.state.ghostTicks = target.state.ghostTicks = 0;
        const driver = new RoadDriver(mulberry32(3));
        driver.setMap(map, false);
        let impact = 0;
        for (let t = 0; t < 60 * 4 && impact === 0; t++) {
            const s = target.state;
            driver.drive(car.state, car.params, car.input, { x: s.x, z: s.z, vx: s.vx, vz: s.vz });
            stepWorld([car, target], map.simWorld);
            impact = Math.max(car.events.carImpact, target.events.carImpact);
        }
        expect(impact).toBeGreaterThan(3);
    });

    it('asks for the wheel angle the sim then steers to, standing and moving', () => {
        for (const speed of [0, 12]) {
            const car = createSimCar('p', 'bulli');
            const runway = longestRunway(map);
            spawnVehicle(car.state, map.simWorld, runway.x, runway.z + 5, 0);
            car.state.vz = speed;
            // A tenth of the lock: well below the counter-steer and the grip limit
            const want = car.params.steerLock * 0.1;
            for (let t = 0; t < 20; t++) {
                const u = forwardSpeed(car.state);
                car.input.steer = steerForAngle(want, u, car.params);
                car.input.throttle = speed > 0 ? 40 : 0;
                stepWorld([car], map.simWorld);
            }
            // The axis is quantised to 1/127 of the lock
            expect(Math.abs(car.state.steerAngle - want), `at ${speed} m/s`).toBeLessThan(car.params.steerLock / 127);
        }
    });
});

describe('the runway of the scripted bumps', () => {
    it('is a long free stretch on the road, driving towards +z', () => {
        const runway = longestRunway(map);
        expect(runway.free).toBeGreaterThanOrEqual(120);
        // Free as far as it says: a car there drives it without hitting anything
        const car = createSimCar('p', 'pickup');
        spawnVehicle(car.state, map.simWorld, runway.x, runway.z, 0);
        let wall = 0;
        for (let t = 0; t < 60 * 6 && car.state.z < runway.z + runway.free - 10; t++) {
            car.input.throttle = 255;
            car.input.steer = 0;
            stepWorld([car], map.simWorld);
            wall = Math.max(wall, car.events.wallImpact);
        }
        expect(car.state.z).toBeGreaterThan(runway.z + 100);
        expect(wall).toBe(0);
    });

    it('ends where a collider stands on the line', () => {
        const runway = longestRunway(map);
        // A post (r 0.5) 50 m ahead on the line cuts the free length to where
        // the car's grown circle would touch it
        const probe = { ...map, simWorld: { ...map.simWorld, colliders: [...map.simWorld.colliders, { kind: 'circle' as const, x: runway.x, z: runway.z + 50, r: 0.5, base: 0, top: Infinity }] } };
        expect(freeRunway(probe, runway.x, runway.z)).toBeCloseTo(50 - 0.5 - RUNWAY_CLEARANCE, 9);
    });
});

describe('npm run bots', () => {
    it('reads the mix', () => {
        expect(parseMix('drive:24,ram:6,reconnect:1,hop:1')).toEqual([
            { mode: 'drive', count: 24 }, { mode: 'ram', count: 6 }, { mode: 'reconnect', count: 1 }, { mode: 'hop', count: 1 }
        ]);
        expect(mixTotal(parseMix('drive:3, flood'))).toBe(4);
        expect(() => parseMix('drift:3')).toThrow(/unknown bot mode/);
        expect(() => parseMix('drive:-1')).toThrow(/bad count/);
        expect(httpOrigin('ws://127.0.0.1:8500/ws')).toBe('http://127.0.0.1:8500');
        expect(httpOrigin('wss://bulli.example/ws')).toBe('https://bulli.example');
    });
});
