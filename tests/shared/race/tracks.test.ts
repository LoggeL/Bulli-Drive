import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { heightAt } from '../../../src/shared/map/heightfield.js';
import { nearestRoad, roadSurfaceIdAt } from '../../../src/shared/map/roadNetwork.js';
import { isPaved } from '../../../src/shared/map/types.js';
import { createProjection, pointAt, projectGlobal } from '../../../src/shared/race/geometry.js';
import { createCourse } from '../../../src/shared/race/progress.js';
import { gateSide } from '../../../src/shared/race/gates.js';
import { BARRIER_DEPTH, createRaceWorld } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { MAX_RACERS } from '../../../src/shared/race/rules.js';
import { isTrackId, mapTracks, nextTrack, trackDef, TRACK_IDS } from '../../../src/shared/race/tracks/index.js';
import type { Collider } from '../../../src/shared/world/colliders.js';

// The ported phase 2 tracks on Bulli Bay (docs/phase-3-design.md, 13.3 and
// 15): conditions on the track data checked against the real map and its
// race worlds (terrain, road network, every collider of the map), not
// against how the data was made. The route data itself is validated in
// tests/tools/map/bulliBay.test.ts.

const map = mapFor();
const DEG = Math.PI / 180;

function wrapAngle(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

// Distance from (x, z) to a collider's outline (0 inside)
function clearance(c: Collider, x: number, z: number): number {
    switch (c.kind) {
        case 'circle':
            return Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
        case 'box':
            return Math.hypot(Math.max(0, Math.abs(x - c.x) - c.hw), Math.max(0, Math.abs(z - c.z) - c.hd));
        case 'segment': {
            const ex = c.bx - c.ax, ez = c.bz - c.az;
            const t = Math.max(0, Math.min(1, ((x - c.ax) * ex + (z - c.az) * ez) / (ex * ex + ez * ez)));
            return Math.max(0, Math.hypot(x - (c.ax + t * ex), z - (c.az + t * ez)) - c.r);
        }
        case 'obox': {
            const dx = x - c.x, dz = z - c.z;
            const lx = dx * c.uz - dz * c.ux, lz = dx * c.ux + dz * c.uz;
            return Math.hypot(Math.max(0, Math.abs(lx) - c.hw), Math.max(0, Math.abs(lz) - c.hd));
        }
    }
}

describe.each(TRACK_IDS.map(id => [id] as const))('%s on Bulli Bay', id => {
    const track = trackDef(map, id);
    const line = buildRacingLine(track);
    const world = createRaceWorld(map, track);

    it('is built from its route in tracks.json for the map\'s version', () => {
        const route = map.sources.tracks.tracks.find(t => t.id === id)!;
        expect(track.mapVersion).toBe(map.mapVersion);
        expect(track.trackVersion).toBe(route.trackVersion);
        expect(track.kind).toBe(route.kind);
        expect(track.laps).toBe(track.kind === 'circuit' ? 3 : 1);
    });

    it('has its gates in order along the racing line, a circuit\'s start/finish at its origin', () => {
        // The race measures each leg from the gate before (createCourse):
        // the gates must come in order, else a leg is negative and the bots
        // reset for ever at a gate they "missed"
        const course = createCourse(track, line);
        if (track.kind === 'circuit') expect(course.gateS[0]).toBeLessThan(2);
        for (let k = 1; k < course.gateS.length; k++) expect(course.gateS[k], `gate ${k}`).toBeGreaterThan(course.gateS[k - 1]);
        // Each gate on the line at its own place, not on a parallel leg
        for (const [k, gate] of track.gates.entries()) {
            const at = pointAt(line, course.gateS[k], createProjection());
            expect(Math.hypot(at.x - gate.x, at.z - gate.z), `gate ${k}`).toBeLessThan(1);
        }
    });

    it('keeps its racing line 2.5 m from every collider of its race world (ramp edges are driven over)', () => {
        let nearest = Infinity, at = '';
        const out = new Int32Array(world.colliders.length);
        for (const p of line.points) {
            const count = world.grid.query(p.x - 8, p.z - 8, p.x + 8, p.z + 8, out);
            for (let k = 0; k < count; k++) {
                const c = world.colliders[out[k]];
                if (c.ramp !== undefined) continue;
                const d = clearance(c, p.x, p.z);
                if (d < nearest) { nearest = d; at = `${c.kind} ${out[k]} at s ${p.s.toFixed(0)}`; }
            }
        }
        expect(nearest, at).toBeGreaterThanOrEqual(2.5);
    });

    it('keeps its barrier rows off the roadway of its centre line', () => {
        // Each row (0.6 m deep) sampled every 0.25 m on both faces; the
        // roadway is the half width of the road nearest to the centre line
        // there (junction branches meeting at an acute angle put a row at
        // the trim radius onto the inside of the turn)
        const pts = track.centerline;
        const n = pts.length;
        let worst = Infinity, at = '';
        for (const hint of track.hints) {
            if (hint.kind !== 'barrier') continue;
            const lx = Math.cos(hint.yaw), lz = -Math.sin(hint.yaw), fx = Math.sin(hint.yaw), fz = Math.cos(hint.yaw);
            for (let t = -hint.length / 2; t <= hint.length / 2 + 1e-9; t += 0.25) {
                for (const d of [-BARRIER_DEPTH / 2, BARRIER_DEPTH / 2]) {
                    const x = hint.x + lx * t + fx * d, z = hint.z + lz * t + fz * d;
                    for (let i = 0; i < (track.kind === 'circuit' ? n : n - 1); i++) {
                        const a = pts[i], b = pts[(i + 1) % n];
                        if (Math.abs(a.x - x) > 30 || Math.abs(a.z - z) > 30) continue;
                        const ex = b.x - a.x, ez = b.z - a.z;
                        const u = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez)));
                        const cx = a.x + ex * u, cz = a.z + ez * u;
                        const road = nearestRoad(map.net, cx, cz, 20);
                        const margin = Math.hypot(x - cx, z - cz) - (road?.edge.halfWidth ?? 0);
                        if (margin < worst) { worst = margin; at = `barrier ${hint.x} ${hint.z} at ${x.toFixed(1)} ${z.toFixed(1)}`; }
                    }
                }
            }
        }
        expect(worst, at).toBeGreaterThanOrEqual(0);
    });

    it('has at least 8 grid slots behind the first gate, on the road and clear of every collider', () => {
        expect(track.grid.length).toBeGreaterThanOrEqual(MAX_RACERS);
        track.grid.forEach((slot, k) => {
            expect(gateSide(track.gates[0], slot.x, slot.z), `slot ${k}`).toBeLessThan(0);
            // The whole car on the road: its 1.4 m collider radius either side
            const lx = Math.cos(slot.yaw), lz = -Math.sin(slot.yaw);
            for (const side of [-1.4, 0, 1.4]) expect(roadSurfaceIdAt(map.net, slot.x + lx * side, slot.z + lz * side), `slot ${k}`).toBeGreaterThanOrEqual(0);
            for (const c of world.colliders) expect(clearance(c, slot.x, slot.z), `slot ${k}`).toBeGreaterThanOrEqual(2);
            for (let j = 0; j < k; j++) {
                const other = track.grid[j];
                expect(Math.hypot(slot.x - other.x, slot.z - other.z), `slots ${j}, ${k}`).toBeGreaterThanOrEqual(6);
            }
        });
    });

    it('starts its line behind the grid, so every slot projects onto it', () => {
        const projection = createProjection();
        for (const slot of track.grid) {
            projectGlobal(line, slot.x, slot.z, projection);
            expect(projection.dist).toBeLessThanOrEqual(3.5);
            expect(projection.s).toBeGreaterThan(0);
        }
    });

    it('climbs at most 15 % along the line off the ramps, 21 % off the tarmac', () => {
        // Phase 2 allowed a race 15 %; the map's trails may be steeper (dirt
        // and gravel 18 %, sand 20 %, A14, plus the 1 % the bake may add)
        for (let i = 1; i < line.points.length; i++) {
            const a = line.points[i - 1], b = line.points[i];
            if (world.rampAt(a.x, a.z) >= 0 || world.rampAt(b.x, b.z) >= 0) continue;
            const slope = Math.abs(world.groundHeight(b.x, b.z) - world.groundHeight(a.x, a.z)) / (b.s - a.s);
            const paved = isPaved(world.surfaceAt(a.x, a.z)) && isPaved(world.surfaceAt(b.x, b.z));
            expect(slope, `at (${b.x.toFixed(0)}, ${b.z.toFixed(0)})`).toBeLessThanOrEqual(paved ? 0.15 : 0.21);
        }
    });

    it('jumps its ramps: the line runs over their middle along them, the rear edge flush with the ground', () => {
        const projection = createProjection();
        const first = map.ramps.length;
        track.ramps.forEach((ramp, i) => {
            projectGlobal(line, ramp.x, ramp.z, projection);
            expect(projection.dist, `ramp ${i}`).toBeLessThan(1.5);
            // Snapped onto an axis within 3° of the road (A31)
            expect(Math.abs(wrapAngle(Math.atan2(projection.tx, projection.tz) - ramp.yaw)), `ramp ${i}`).toBeLessThan(3.5 * DEG);
            const fx = Math.sin(ramp.yaw), fz = Math.cos(ramp.yaw);
            const rearX = ramp.x - fx * ramp.length / 2, rearZ = ramp.z - fz * ramp.length / 2;
            expect(world.rampBases[first + i]).toBe(heightAt(map.hf, rearX, rearZ));
            expect(world.rampAt(ramp.x, ramp.z)).toBe(first + i);
        });
    });
});

describe('Ridge Climb (hill-sprint)', () => {
    it('climbs from the town to the lookout at 130 m', () => {
        const track = trackDef(map, 'hill-sprint');
        const start = track.gates[0], finish = track.gates[track.gates.length - 1];
        expect(finish.visual).toBe('finish');
        expect(heightAt(map.hf, finish.x, finish.z) - heightAt(map.hf, start.x, start.z)).toBeGreaterThan(100);
        expect(heightAt(map.hf, finish.x, finish.z)).toBeGreaterThan(120);
        expect(track.ramps).toHaveLength(3);
    });
});

describe('track list', () => {
    it('rotates through the six tracks, knows their ids and builds them once per map', () => {
        const ids = ['downtown-loop', 'coast-sprint', 'hill-sprint', 'harbor-circuit', 'dune-rally', 'grand-tour'];
        expect(TRACK_IDS.map(id => trackDef(map, id).id)).toEqual(ids);
        expect(mapTracks(map)).toBe(mapTracks(map));
        expect(nextTrack('downtown-loop')).toBe('coast-sprint');
        expect(nextTrack('harbor-circuit')).toBe('dune-rally');
        expect(nextTrack('grand-tour')).toBe('downtown-loop');
        expect(isTrackId('hill-sprint')).toBe(true);
        expect(isTrackId('monaco')).toBe(false);
        expect(isTrackId(3)).toBe(false);
    });

    // tracks.json edited by hand (or a road renamed in the worldviewer):
    // the server must not start with a track it cannot build
    const withRoutes = (routes: typeof map.sources.tracks.tracks) =>
        ({ ...map, sources: { ...map.sources, tracks: { ...map.sources.tracks, tracks: routes } } });

    it('refuses a map whose tracks.json lacks a route of TRACK_IDS', () => {
        const routes = map.sources.tracks.tracks.filter(route => route.id !== 'dune-rally');
        expect(() => mapTracks(withRoutes(routes))).toThrow('tracks.json has no route for dune-rally');
    });

    it('refuses a route over a road the network does not have', () => {
        const routes = map.sources.tracks.tracks.map(route =>
            route.id === 'coast-sprint' ? { ...route, route: [...route.route, 'no-such-road'] } : route);
        expect(() => mapTracks(withRoutes(routes))).toThrow(/^track coast-sprint:\n {2}\S/);
    });
});
