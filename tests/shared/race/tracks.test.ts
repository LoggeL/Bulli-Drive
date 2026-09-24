import { beforeEach, describe, expect, it } from 'vitest';
import { createProjection, projectGlobal } from '../../../src/shared/race/geometry.js';
import { gateSide } from '../../../src/shared/race/gates.js';
import { MAP_VERSION_FOR_RACES } from '../../../src/shared/race/mapVersion.js';
import { createCourse, createRaceProgress, passGate } from '../../../src/shared/race/progress.js';
import { createRaceWorld } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { MAX_RACERS } from '../../../src/shared/race/rules.js';
import { DOWNTOWN_LOOP, HILL_SPRINT, isTrackId, nextTrack, TRACK_IDS, TRACKS } from '../../../src/shared/race/tracks/index.js';
import type { TrackDef } from '../../../src/shared/race/types.js';
import { cityRoadGrid, isInCityArea, isOnRoad } from '../../../src/shared/world/cityGen.js';
import type { Collider } from '../../../src/shared/world/colliders.js';
import { createMapData } from '../../../src/shared/world/mapData.js';
import { MAP_RAMPS } from '../../../src/shared/world/mapFeatures.js';
import { getTerrainHeight } from '../../../src/shared/world/terrain.js';

// Data test of both tracks (docs/phase-2-design.md, 20.1): conditions on
// the track data checked against the real map (terrain, colliders, road
// grid), independent of how the data was made.

const map = createMapData();
const terrain = (x: number, z: number) => getTerrainHeight(map.terrain, x, z);
const ALL: TrackDef[] = [DOWNTOWN_LOOP, HILL_SPRINT];
const DEG = Math.PI / 180;

function wrapAngle(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

// Distance from (x, z) to a collider's outline (0 inside)
function clearance(c: Collider, x: number, z: number): number {
    if (c.kind === 'circle') return Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
    const dx = Math.max(0, Math.abs(x - c.x) - c.hw), dz = Math.max(0, Math.abs(z - c.z) - c.hd);
    return Math.hypot(dx, dz);
}

describe.each(ALL.map(track => [track.id, track] as const))('%s', (_id, track) => {
    // Built fresh in every test, so the mutation run attributes the line
    // and gate geometry to these tests
    let line = buildRacingLine(track);
    let world = createRaceWorld(map, track);
    let course = createCourse(track, line);
    beforeEach(() => {
        line = buildRacingLine(track);
        world = createRaceWorld(map, track);
        course = createCourse(track, line);
    });

    it('is built for this map version and has gates, a grid and a line', () => {
        expect(track.mapVersion).toBe(MAP_VERSION_FOR_RACES);
        expect(track.gates.length).toBeGreaterThanOrEqual(4);
        expect(track.laps).toBe(track.kind === 'circuit' ? 3 : 1);
    });

    it('can be driven along its racing line: every gate forwards, in order, to the finish', () => {
        const p = createRaceProgress();
        const pts = line.points;
        const laps = track.kind === 'circuit' ? track.laps + 1 : 1;
        let tick = 1;
        for (let lap = 0; lap < laps && p.status === 'racing'; lap++) {
            const count = track.kind === 'circuit' ? pts.length : pts.length - 1;
            for (let i = 0; i < count && p.status === 'racing'; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                passGate(p, course, tick++, 0, a.x, a.z, b.x, b.z);
            }
        }
        expect(p.status).toBe('finished');
        expect(p.passed).toBe(track.kind === 'circuit' ? track.laps * track.gates.length + 1 : track.gates.length);
    });

    it('puts the gates in the order of the line, facing along it (≤ 20°)', () => {
        for (let k = 1; k < course.gateS.length; k++) expect(course.gateS[k]).toBeGreaterThan(course.gateS[k - 1]);
        const projection = createProjection();
        track.gates.forEach((gate, k) => {
            projectGlobal(line, gate.x, gate.z, projection, course.gateS[k]);
            const tangent = Math.atan2(projection.tx, projection.tz);
            expect(Math.abs(wrapAngle(gate.yaw - tangent)), `gate ${k}`).toBeLessThanOrEqual(20 * DEG);
            // The line passes well inside the gate
            expect(projection.dist, `gate ${k}`).toBeLessThan(gate.width / 2 - 2);
        });
    });

    it('has at least 8 grid slots behind the first gate, 6 m apart, on the road, clear of colliders', () => {
        expect(track.grid.length).toBeGreaterThanOrEqual(MAX_RACERS);
        track.grid.forEach((slot, k) => {
            expect(gateSide(track.gates[0], slot.x, slot.z), `slot ${k}`).toBeLessThan(0);
            expect(Math.abs(wrapAngle(slot.yaw - track.gates[0].yaw)), `slot ${k}`).toBeLessThan(1e-9);
            // The whole car on the road: its 1.3 m collider radius either side
            const lx = Math.cos(slot.yaw), lz = -Math.sin(slot.yaw);
            for (const side of [-1.3, 0, 1.3]) expect(isOnRoad(slot.x + lx * side, slot.z + lz * side), `slot ${k}`).toBe(true);
            for (const c of world.colliders) expect(clearance(c, slot.x, slot.z), `slot ${k}`).toBeGreaterThanOrEqual(2);
            for (let j = 0; j < k; j++) {
                const other = track.grid[j];
                expect(Math.hypot(slot.x - other.x, slot.z - other.z), `slots ${j}, ${k}`).toBeGreaterThanOrEqual(6);
            }
            // The pole is nearest the line
            expect(gateSide(track.gates[0], slot.x, slot.z)).toBeLessThanOrEqual(gateSide(track.gates[0], track.grid[0].x, track.grid[0].z));
        });
    });

    it('keeps its racing line 2.5 m from every collider of the race world (ramp edges are driven over)', () => {
        let nearest = Infinity;
        for (const p of line.points) {
            for (const c of world.colliders) {
                if (c.ramp !== undefined) continue;
                nearest = Math.min(nearest, clearance(c, p.x, p.z));
            }
        }
        expect(nearest).toBeGreaterThanOrEqual(2.5);
    });

    it('climbs at most 25 % along the line off the ramps', () => {
        for (let i = 1; i < line.points.length; i++) {
            const a = line.points[i - 1], b = line.points[i];
            if (world.rampAt(a.x, a.z) >= 0 || world.rampAt(b.x, b.z) >= 0) continue;
            const slope = Math.abs(world.groundHeight(b.x, b.z) - world.groundHeight(a.x, a.z)) / (b.s - a.s);
            expect(slope, `at (${b.x.toFixed(0)}, ${b.z.toFixed(0)})`).toBeLessThanOrEqual(0.25);
        }
    });

    it('keeps the city gates clear of the crossings', () => {
        const roads = cityRoadGrid();
        for (const gate of track.gates) {
            if (!isInCityArea(gate.x, gate.z)) continue;
            // The gate stands across the road at least 2 m clear of every
            // crossing (half a road, 6 m, from its centre)
            for (const x of roads.xLines) {
                for (const z of roads.zLines) {
                    expect(Math.max(Math.abs(gate.x - x), Math.abs(gate.z - z))).toBeGreaterThanOrEqual(6 + 2);
                }
            }
        }
    });
});

describe('Downtown Loop', () => {
    it('is a circuit of 3 laps that never crosses itself', () => {
        expect(DOWNTOWN_LOOP.kind).toBe('circuit');
        const pts = DOWNTOWN_LOOP.centerline;
        const n = pts.length;
        const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
        for (let i = 0; i < n; i++) {
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue;   // neighbours across the seam
                const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
                const d1 = cross(b.x - a.x, b.z - a.z, c.x - a.x, c.z - a.z);
                const d2 = cross(b.x - a.x, b.z - a.z, d.x - a.x, d.z - a.z);
                const d3 = cross(d.x - c.x, d.z - c.z, a.x - c.x, a.z - c.z);
                const d4 = cross(d.x - c.x, d.z - c.z, b.x - c.x, b.z - c.z);
                expect(d1 * d2 < 0 && d3 * d4 < 0, `legs ${i} and ${j}`).toBe(false);
            }
        }
        // The centre line of 832 m, rounded: between 740 and 800 m a lap
        const perimeter = pts.reduce((sum, p, i) => sum + Math.hypot(pts[(i + 1) % n].x - p.x, pts[(i + 1) % n].z - p.z), 0);
        expect(perimeter).toBe(832);
        expect(buildRacingLine(DOWNTOWN_LOOP).length).toBeGreaterThan(740);
        expect(buildRacingLine(DOWNTOWN_LOOP).length).toBeLessThan(800);
    });

    it('closes every side street at its crossings: 19 barrier rows', () => {
        expect(DOWNTOWN_LOOP.hints.filter(h => h.kind === 'barrier')).toHaveLength(19);
        expect(DOWNTOWN_LOOP.hints.filter(h => h.kind === 'chevron')).toHaveLength(8);
    });
});

describe('Hill Sprint', () => {
    let line = buildRacingLine(HILL_SPRINT);
    let world = createRaceWorld(map, HILL_SPRINT);
    beforeEach(() => {
        line = buildRacingLine(HILL_SPRINT);
        world = createRaceWorld(map, HILL_SPRINT);
    });

    it('closes the side streets of its 4 city crossings', () => {
        const barriers = HILL_SPRINT.hints.filter(h => h.kind === 'barrier');
        expect(barriers).toHaveLength(8);
        // East and west of x = 58, at z = 58, 6, -46, -98
        expect(new Set(barriers.map(b => b.z))).toEqual(new Set([58, 6, -46, -98]));
        expect(new Set(barriers.map(b => b.x))).toEqual(new Set([51, 65]));
    });

    it('jumps its three ramps: the line runs straight over the middle, the lip ≥ 1.2 m above the ground ahead', () => {
        const projection = createProjection();
        MAP_RAMPS.forEach((ramp, i) => {
            projectGlobal(line, ramp.x, ramp.z, projection);
            expect(projection.dist, ramp.name).toBeLessThan(1);
            expect(Math.abs(wrapAngle(Math.atan2(projection.tx, projection.tz) - ramp.yaw)), ramp.name).toBeLessThan(2 * DEG);
            const fx = Math.sin(ramp.yaw), fz = Math.cos(ramp.yaw);
            const rearX = ramp.x - fx * ramp.length / 2, rearZ = ramp.z - fz * ramp.length / 2;
            const frontX = ramp.x + fx * ramp.length / 2, frontZ = ramp.z + fz * ramp.length / 2;
            // Rear edge flush with the ground behind it where the line (and the
            // car's ground point) crosses it; 1 m to the side the terrain's
            // cross slope (R2: 9 %) leaves at most a 10 cm step
            for (const across of [-1, 0, 1]) {
                const x = rearX + fz * across, z = rearZ - fx * across;
                const step = Math.abs(world.groundHeight(x + fx * 0.01, z + fz * 0.01) - terrain(x - fx * 0.01, z - fz * 0.01));
                expect(step, ramp.name).toBeLessThanOrEqual(across === 0 ? 0.05 : 0.1);
            }
            // Lip above the terrain just past the front edge
            const lip = world.groundHeight(frontX - fx * 0.01, frontZ - fz * 0.01);
            expect(lip - terrain(frontX + fx * 0.01, frontZ + fz * 0.01), ramp.name).toBeGreaterThanOrEqual(1.2);
            expect(world.rampBases[i]).toBe(terrain(rearX, rearZ));
        });
    });

    it('finishes on a local high point at 13 m or more', () => {
        const finish = HILL_SPRINT.gates[HILL_SPRINT.gates.length - 1];
        expect(finish.visual).toBe('finish');
        const top = terrain(finish.x, finish.z);
        expect(top).toBeGreaterThanOrEqual(13);
        for (let k = 0; k < 72; k++) {
            const a = k * 5 * DEG;
            expect(terrain(finish.x + 20 * Math.cos(a), finish.z + 20 * Math.sin(a))).toBeLessThan(top);
        }
    });

    it('starts its line behind the grid, so every slot projects onto it', () => {
        const projection = createProjection();
        for (const slot of HILL_SPRINT.grid) {
            projectGlobal(line, slot.x, slot.z, projection);
            expect(projection.dist).toBeLessThanOrEqual(3);
            expect(projection.s).toBeGreaterThan(0);
        }
    });
});

describe('track list', () => {
    it('rotates through both tracks and knows their ids', () => {
        expect(TRACK_IDS.map(id => TRACKS[id].id)).toEqual(['downtown-loop', 'hill-sprint']);
        expect(nextTrack('downtown-loop')).toBe('hill-sprint');
        expect(nextTrack('hill-sprint')).toBe('downtown-loop');
        expect(isTrackId('hill-sprint')).toBe(true);
        expect(isTrackId('monaco')).toBe(false);
        expect(isTrackId(3)).toBe(false);
    });
});
