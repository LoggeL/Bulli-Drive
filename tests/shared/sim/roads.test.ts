import { describe, expect, it } from 'vitest';
import { BTN_RESET } from '../../../src/shared/sim/constants.js';
import { FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import { moveToRoad } from '../../../src/shared/sim/vehicle.js';
import { createVehicleState } from '../../../src/shared/sim/types.js';
import { CITY_BOUNDS, cityRoadGrid, isOnRoad, roadLineCenter } from '../../../src/shared/world/cityGen.js';
import { createSimWorld } from '../../../src/shared/world/colliders.js';
import { drive, spawnCar } from './helpers.js';

// The player's reset (R held) puts the car back onto the nearest road of the
// city grid; far from the city it resets in place.

describe('reset onto the road', () => {
    const roads = cityRoadGrid();

    it('describes the city road grid', () => {
        expect(roads.xLines).toHaveLength(5);
        expect(roads.zLines).toHaveLength(5);
        for (const x of roads.xLines) expect(isOnRoad(x, 7)).toBe(true);
        for (const z of roads.zLines) expect(isOnRoad(7, z)).toBe(true);
        expect(roads.minX).toBe(CITY_BOUNDS.minX);
    });

    it('moves to the nearest centre line and faces along the road', () => {
        const s = createVehicleState();
        const lineX = roadLineCenter(2, 'x');
        s.x = lineX + 4;
        s.z = 17;
        s.yaw = 3;   // roughly towards -z
        expect(moveToRoad(s, roads)).toBe(true);
        expect(s.x).toBe(lineX);
        expect(s.z).toBe(17);
        expect(s.yaw).toBe(Math.PI);

        const lineZ = roadLineCenter(1, 'z');
        s.x = 23;
        s.z = lineZ - 3;
        s.yaw = 1.2;   // towards +x
        expect(moveToRoad(s, roads)).toBe(true);
        expect(s.z).toBe(lineZ);
        expect(s.yaw).toBe(Math.PI / 2);
    });

    it('stays in place far from the city', () => {
        const s = createVehicleState();
        s.x = 350;
        s.z = -320;
        s.yaw = 0.7;
        expect(moveToRoad(s, roads)).toBe(false);
        expect([s.x, s.z, s.yaw]).toEqual([350, -320, 0.7]);
    });

    it('happens when reset is held', () => {
        const world = createSimWorld(FLAT_TERRAIN, [], [], roads);
        const lineX = roadLineCenter(0, 'x');
        const car = spawnCar(world, 'a', 'bulli', lineX + 9, 30, 0.2);
        drive(car, world, 30, { buttons: BTN_RESET });
        expect(car.state.x).toBe(lineX);
        expect(car.state.z).toBe(30);
        expect(car.state.yaw).toBe(0);
        expect(car.state.ghostTicks).toBeGreaterThan(0);
    });
});
