import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { pointAt } from '../../../src/shared/map/spline.js';
import { spawnCar } from '../../../src/shared/sim/scenarios.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';

// The crests and bumps built into the roads of Bulli Bay on purpose
// (docs/phase-1a-design.md, 27): each lifts a car at 130 km/h for a short,
// controlled flight and keeps it on the ground at town speed. The list is
// the map's design; a crest left out of the bake, a rounding back to 150 m
// or a GRAVITY back at 20 takes the lift away, a sharper one keeps it
// flying longer or lifts it in town.

// Edge, station of the crest (m), direction of travel along the edge
// (+1 with the edge, -1 against it) and what it is
const CRESTS: [string, number, 1 | -1, string][] = [
    ['palm-east', 105, 1, 'Palm Street up onto Seaview Drive (terrace, R 60 m)'],
    ['palm-east', 101, -1, 'Palm Street down off Seaview Drive'],
    ['seaview-3', 36, 1, 'Seaview Drive south off the top terrace'],
    ['seaview-3', 34, -1, 'Seaview Drive north onto the top terrace'],
    ['sunset-court', 26, 1, 'Sunset Court down off its top terrace'],
    ['sunset-court', 24, -1, 'Sunset Court up onto its top terrace'],
    ['canyon-2', 117, 1, 'Canyon Road up onto the terrace (Ridge Climb)'],
    ['canyon-2', 115, -1, 'Canyon Road down off the terrace'],
    ['pch-cliff-4', 159, 1, 'Pacific Coast Highway down off the terrace (Coast Sprint)'],
    ['pch-cliff-4', 157, -1, 'Pacific Coast Highway up onto the terrace'],
    ['canyon-8', 60, 1, 'Canyon Road east, first wave'],
    ['canyon-8', 122, -1, 'Canyon Road east, second wave, westwards'],
    ['east-ranch-trail', 40, 1, 'East Ranch Trail bump (Grand Tour)'],
    ['oak-canyon', 404, 1, 'Oak Canyon Trail bump (Grand Tour)'],
    ['oak-canyon', 548, 1, 'Oak Canyon Trail bump at the harbour end (Grand Tour)'],
    ['beach-trail-3', 70, 1, 'Beach Trail dune hump (Dune Rally)'],
    ['beach-trail-3', 140, 1, 'Beach Trail second dune hump (Dune Rally)'],
    ['chaparral-trail', 110, 1, 'Chaparral Trail bump'],
    ['chaparral-trail', 170, -1, 'Chaparral Trail bump, westwards'],
    ['chaparral-trail', 230, 1, 'Chaparral Trail bump'],
    ['fire-1', 46, 1, 'Ranch Fire Road bump']
];

const world = mapFor().simWorld;
const net = mapFor().net;

// A Bulli held at km/h along the edge's centre line from 80 m before the
// crest to 50 m after it (put back on the line and along it every tick, as
// scripts/sim-airtime.ts drives the roads): the longest flight in ticks that
// takes off within 20 m of the crest (the car spawned on a grade may hop
// once while its suspension settles)
function longestFlight(edgeId: string, s0: number, dir: 1 | -1, kmh: number): number {
    const edge = net.edgeById.get(edgeId)!;
    const v = kmh / 3.6;
    const at = (d: number) => {
        const p = pointAt(edge.samples, Math.max(0, Math.min(edge.length, s0 + dir * d)));
        return { x: p.x, z: p.z, tx: p.tx * dir, tz: p.tz * dir };
    };
    const start = at(-80);
    const car = spawnCar(world, 'a', 'bulli', start.x, start.z, Math.atan2(start.tx, start.tz), v);
    const s = car.state;
    let d = -80, air = 0, takeoff = 0, longest = 0;
    while (d < 50 || air > 0) {
        if (s.grounded || d < 50) {
            const p = at(d);
            s.x = p.x;
            s.z = p.z;
            s.vx = p.tx * v;
            s.vz = p.tz * v;
            s.yaw = Math.atan2(p.tx, p.tz);
            s.yawRate = 0;
        }
        stepVehicle(car, world);
        if (!s.grounded && air === 0) takeoff = d;
        air = s.grounded ? 0 : air + 1;
        if (Math.abs(takeoff) <= 20) longest = Math.max(longest, air);
        d += v / 60;
        if (d > 200) break;
    }
    return longest;
}

describe('Bulli Bay: the crests and bumps of the roads', () => {
    it.each(CRESTS)('%s at s = %d (%d): %s: 0.15-0.6 s in the air at 130 km/h, on the ground at 60 km/h', (edge, s, dir) => {
        // Designed for v²·κ > GRAVITY from about 110-120 km/h (terraces with
        // R 60 m: √(15 · 60) = 30 m/s, bumps 1 m high and 34 m long: top
        // curvature 16 · 1/34², √(15 · 34² / 16) = 32.9 m/s); at 60 km/h
        // v²·κ is under a third of GRAVITY. Measured at 130 km/h:
        // 12-25 ticks (0.20-0.42 s, scripts/sim-airtime.ts, 27)
        const fast = longestFlight(edge, s, dir, 130);
        expect(fast).toBeGreaterThanOrEqual(9);
        expect(fast).toBeLessThanOrEqual(36);
        expect(longestFlight(edge, s, dir, 60)).toBe(0);
    });

    it('keeps a car on the ground over all of them at 100 km/h: they lift between 100 and 130 km/h', () => {
        // Regression lock of the design: v²·κ at 27.8 m/s is 0.86 of GRAVITY
        // over the terraces and 0.71 over the bumps (measured: no flight at
        // all, 12-25 ticks at 130 km/h)
        for (const [edge, s, dir] of CRESTS) expect(longestFlight(edge, s, dir, 100), `${edge} ${s}`).toBe(0);
    });
});
