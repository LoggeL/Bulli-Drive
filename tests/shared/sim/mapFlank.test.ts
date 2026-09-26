import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { spawnCar } from '../../../src/shared/sim/scenarios.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';

// Steep flanks of the Bulli Bay terrain with the suspension
// (docs/phase-1a-design.md, 26.9): a bank the car hits at town speed throws
// it no higher than the inelastic push along the ground's normal allows.

describe('Bulli Bay: the grass bank south of (-84, -338)', () => {
    it('throws a car coasting at 14 m/s at most (v/2)²/2g above the top (regression lock of the review)', () => {
        // Southwards from (-84, -338) a bank of 108 % rises 1.1 m just ahead
        // of a road. The push along the normal leaves at most v/2 upwards
        // (at 100 %: half and half; at 108 %: 14·1.08/(1 + 1.08²) = 6.97),
        // so the apex over the lip is at most (v/2)²/(2g) = 1.23 m. Before
        // (vy raised to ∇h·v = 15 m/s at no cost) it flew 2.9 m over the
        // lip, 68 ticks, with 1.6 times the kinetic energy it came with.
        const world = mapFor().simWorld;
        const v = 14;
        const car = spawnCar(world, 'a', 'bulli', -84, -338, Math.PI, v);
        let lip = NaN, apex = -Infinity, most = 0;
        for (let tick = 0; tick < 120; tick++) {
            stepVehicle(car, world);
            const s = car.state;
            most = Math.max(most, (s.vx ** 2 + s.vy ** 2 + s.vz ** 2) / 2);
            if (s.grounded) continue;
            if (Number.isNaN(lip)) lip = s.y;
            apex = Math.max(apex, s.y);
        }
        // It does leave the bank (the lock would pass trivially otherwise)
        expect(lip).toBeGreaterThan(13);
        expect(apex - lip).toBeLessThan((v / 2) ** 2 / (2 * 20));
        expect(most).toBeLessThanOrEqual(v * v / 2);
    });
});
