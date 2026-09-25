import { describe, expect, it } from 'vitest';
import { CORNER_GRIP_MARGIN, speedProfile, type ProfilePoint } from '../../../src/shared/map/drivability.js';
import { heightAt } from '../../../src/shared/map/heightfield.js';
import { routeToTrack, type MapTrackDef } from '../../../src/shared/map/routeToTrack.js';
import type { ResolvedRoute } from '../../../src/shared/map/trackRoute.js';
import { VEHICLE_CLASSES } from '../../../src/shared/sim/vehicleClasses.js';
import type { CarClassId } from '../../../src/shared/sim/types.js';
import { createMapData } from '../../../src/shared/map/mapData.js';
import { driveTrack } from '../../../tools/map/driveTrack.js';
import { loadMapBundle } from '../../../tools/map/mapBundle.js';
import { validateMap } from '../../../tools/map/validateMap.js';

// The race bots of phase 2 with the v2 sim in the race worlds of Bulli Bay
// (tools/map/driveTrack.ts: the baked ground with its surfaces, every
// collider of the map, the track's ramps and hints): every track, the
// bonus ones too, can be finished, every ramp throws the car into the air,
// and the estimate of drivability.ts matches the sim (review finding 15).
// One bot race takes 10-30 ms.

const bundle = loadMapBundle('bulli-bay');
const map = createMapData(bundle, bundle.hf);
const validation = validateMap(bundle);
const tracks: [string, ResolvedRoute, MapTrackDef][] = validation.routes.map(route =>
    [route.track.id, route, routeToTrack(bundle.net, route, bundle.map.mapVersion)]);

// Profile points of a whole race (circuit: all laps) as the validator builds them
function racePoints(route: ResolvedRoute): ProfilePoint[] {
    const laps = route.closed ? route.track.laps : 1;
    const points: ProfilePoint[] = [];
    for (let lap = 0; lap < laps; lap++) {
        for (const p of route.points) points.push({ s: lap * route.length + p.s, curvature: p.curvature, surface: p.surface, y: heightAt(bundle.hf, p.x, p.z) });
    }
    if (route.closed) {
        const p = route.points[0];
        return [...points, { s: laps * route.length, curvature: p.curvature, surface: p.surface, y: heightAt(bundle.hf, p.x, p.z) }];
    }
    const from = points.findIndex(p => p.s >= route.startS), to = points.findIndex(p => p.s >= route.finishS);
    return points.slice(from, to + 1);
}

describe.each(tracks)('%s', (_id, route, track) => {
    it('is driven to the finish by a medium bot without a reset, never 8 m off the racing line', () => {
        const result = driveTrack(map, track, 'bulli');
        expect(result.time).not.toBeNull();
        expect(result.resets).toBe(0);
        expect(result.maxLineDistance).toBeLessThan(8);
    });

    it('throws the car into the air at every ramp, on every lap, for at least 0.3 s', () => {
        const result = driveTrack(map, track, 'bulli');
        const laps = route.closed ? route.track.laps : 1;
        track.ramps.forEach((_, i) => {
            const off = result.flights.filter(f => f.ramp === i);
            expect(off, `ramp ${i}`).toHaveLength(laps);
            for (const flight of off) expect(flight.ticks, `ramp ${i}`).toBeGreaterThanOrEqual(18);
        });
        // And nowhere else: terrain never launches a car in the v2 sim
        expect(result.flights.filter(f => f.ramp < 0)).toEqual([]);
    });

    it('takes the time drivability.ts estimates, within 15 %, for the fastest and the slowest class', () => {
        // The estimate is a point mass at 75 % of the grip, with the grip and
        // rolling resistance per surface of the sim; the medium bot drives
        // 92 % of its own speed profile (85 % of the grip, phase 2) with a
        // standing start.
        for (const car of ['sport', 'pickup'] as CarClassId[]) {
            const estimate = speedProfile(VEHICLE_CLASSES[car], racePoints(route), 0, CORNER_GRIP_MARGIN).time;
            const time = driveTrack(map, track, car).time!;
            expect(time / estimate, car).toBeGreaterThan(0.85);
            expect(time / estimate, car).toBeLessThan(1.15);
        }
    });
});
