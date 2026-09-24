import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardSpeed, RoadDriver, steerForAngle } from '../../tools/bots/driver.js';
import { longestRunway } from '../../tools/bots/runway.js';
import { mixTotal, parseMix, httpOrigin } from '../../tools/bots/swarm.js';
import { randomSpawnPose } from '../../src/server/rooms/spawn.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import type { CarClassId } from '../../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../src/shared/sim/world.js';
import { cityRoadGrid } from '../../src/shared/world/cityGen.js';
import { createMapData } from '../../src/shared/world/mapData.js';

// The bots' driving (docs/phase-1b-design.md, 15.2) against the sim alone:
// pure pursuit over the city's road grid, the chase of mode ram, and the
// mix syntax of npm run bots.

const map = createMapData();

beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(4242));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('RoadDriver', () => {
    it.each(['bulli', 'sport', 'jeep', 'beetle', 'pickup'] as CarClassId[])('drives the %s through the city for a minute', (classId) => {
        const car = createSimCar('bot', classId);
        const pose = randomSpawnPose(map.world.city, []);
        spawnVehicle(car.state, map.simWorld, pose.x, pose.z, pose.yaw);
        const driver = new RoadDriver(cityRoadGrid(), mulberry32(classId.length));
        let top = 0;
        for (let t = 0; t < 60 * 60; t++) {
            driver.drive(car.state, car.params, car.input);
            stepWorld([car], map.simWorld);
            top = Math.max(top, forwardSpeed(car.state));
            // Never far from the road grid
            expect(Math.abs(car.state.x)).toBeLessThan(140);
            expect(Math.abs(car.state.z)).toBeLessThan(140);
        }
        // Cruising at 20-35 m/s with the corners and the odd back-off from
        // a lamp post: well over 10 m/s on average
        expect(driver.distance).toBeGreaterThan(600);
        expect(top).toBeGreaterThan(18);
        expect(top).toBeLessThan(40);
        expect(driver.resets).toBeLessThanOrEqual(1);
    });

    it('chases a car standing on a free road and runs into it', () => {
        const runway = longestRunway(map.colliders);
        const car = createSimCar('ram', 'bulli');
        const target = createSimCar('target', 'bulli');
        spawnVehicle(car.state, map.simWorld, runway.x, runway.z + 5, 0);
        spawnVehicle(target.state, map.simWorld, runway.x + 1, runway.z + 45, Math.PI / 2);
        car.state.ghostTicks = target.state.ghostTicks = 0;
        const driver = new RoadDriver(cityRoadGrid(), mulberry32(3));
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
            const runway = longestRunway(map.colliders);
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
