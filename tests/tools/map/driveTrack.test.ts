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

const trackOf = (id: string) => tracks.find(([trackId]) => trackId === id)![2];

describe('missed gates', () => {
    it('put the bot back before the gate, as the race room does, and the race goes on', () => {
        // Regression lock (seed 11, found in a sweep of seeds 1-120 after the
        // suspension of docs/phase-1a-design.md 26; seed 7 before it): the
        // easy Beetle drives past a gate of the Coast Sprint outside. The
        // race room holds reset at once and puts it back before the gate:
        // one reset, the race a few seconds longer than the 61.3 s of seed 1.
        // Without the reset it drove on until the bot's own watchdog (25 m
        // off the line for 2 s) reset it: 85 s, 32.6 m off the line; without
        // the placement before the gate it followed the line to its end and
        // stood there (a DNF with dozens of resets).
        const result = driveTrack(map, trackOf('coast-sprint'), 'beetle', 'easy', 11);
        expect(result.missedGates).toBe(1);
        expect(result.resets).toBe(1);
        expect(result.time).not.toBeNull();
        expect(result.time!).toBeLessThan(70);
        expect(result.maxLineDistance).toBeLessThan(25);
    });

    it('stay out of the Dune Rally for the easy bots: they take its dirt bends slower than the grip allows', () => {
        // Regression lock of review finding (bulli easy, seeds 1-4, beetle
        // easy seed 5): the easy bots came into a 180 m bend at 39 m/s on
        // the dirt road after gate 6, weaved with their reaction delay and
        // missed gate 7 (BotSkill.unpavedGrip)
        const dune = trackOf('dune-rally');
        for (const [car, seed] of [['bulli', 1], ['bulli', 2], ['bulli', 3], ['bulli', 4], ['beetle', 5]] as [CarClassId, number][]) {
            const result = driveTrack(map, dune, car, 'easy', seed);
            expect(result.missedGates, `${car} ${seed}`).toBe(0);
            expect(result.resets, `${car} ${seed}`).toBe(0);
        }
    });
});

describe.each(tracks)('%s', (_id, route, track) => {
    it('is driven to the finish by a medium bot without a reset, never 8 m off the racing line', () => {
        const result = driveTrack(map, track, 'bulli');
        expect(result.time).not.toBeNull();
        expect(result.resets).toBe(0);
        expect(result.missedGates).toBe(0);
        expect(result.maxLineDistance).toBeLessThan(8);
    });

    it('is finished by the easy bots of two more classes, at most one gate missed', () => {
        for (const car of ['beetle', 'jeep'] as CarClassId[]) {
            const result = driveTrack(map, track, car, 'easy');
            expect(result.time, car).not.toBeNull();
            expect(result.missedGates, car).toBeLessThanOrEqual(1);
        }
    });

    it('throws the car into the air at every ramp, on every lap, for at least 0.3 s', () => {
        const result = driveTrack(map, track, 'bulli');
        const laps = route.closed ? route.track.laps : 1;
        track.ramps.forEach((_, i) => {
            const off = result.flights.filter(f => f.ramp === i);
            expect(off, `ramp ${i}`).toHaveLength(laps);
            for (const flight of off) expect(flight.ticks, `ramp ${i}`).toBeGreaterThanOrEqual(18);
        });
        // Crests of the terrain may lift the car since the suspension
        // (docs/phase-1a-design.md, 26), but only for short hops: the
        // longest is the medium Bulli's 0.3 s at the grade kink at the top
        // of the Ridge Climb's canyon (x -120, 8 % to 0 % within 4 m)
        for (const flight of result.flights.filter(f => f.ramp < 0)) {
            expect(flight.ticks, `terrain at ${flight.x.toFixed(0)}, ${flight.z.toFixed(0)}`).toBeLessThan(30);
        }
    });

    it('takes the time drivability.ts estimates, within 15 %, for the fastest and the slowest class', () => {
        // The estimate is a point mass at 75 % of the grip, with the grip and
        // rolling resistance per surface of the sim; the medium bot drives
        // 92 % of its own speed profile (85 % of the grip, phase 2) with a
        // standing start. The median of three seeds: a crest hop can throw
        // one race off (seed 1 of the Sport on the Ridge Climb lands from the
        // canyon ramp on the grade kink above, hops again and slides in the
        // next bend: 1.17 of the estimate; seeds 2 and 3: 1.085, as before
        // the suspension).
        for (const car of ['sport', 'pickup'] as CarClassId[]) {
            const estimate = speedProfile(VEHICLE_CLASSES[car], racePoints(route), 0, CORNER_GRIP_MARGIN).time;
            const times = [1, 2, 3].map(seed => driveTrack(map, track, car, 'medium', seed).time!).sort((a, b) => a - b);
            const time = times[1];
            expect(time / estimate, car).toBeGreaterThan(0.85);
            expect(time / estimate, car).toBeLessThan(1.15);
        }
    });
});
