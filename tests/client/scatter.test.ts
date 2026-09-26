import { describe, expect, it } from 'vitest';
import { mapFor } from '../../src/server/maps.js';
import { DECOR_RULES, FENCE_OFFSET, mailboxSpots, ranchFences, scatterDecor } from '../../src/client/world/scatter.js';
import type { MapData } from '../../src/shared/map/mapData.js';
import { buildRoadNetwork } from '../../src/shared/map/roadNetwork.js';
import { ZONE } from '../../src/shared/map/types.js';
import { edge, makeHeightfield, network, node, PROFILE } from '../shared/map/fixtures.js';
import { pointInPolygon } from '../../src/shared/map/geometry.js';
import { heightAt, surfaceAt, zoneAt } from '../../src/shared/map/heightfield.js';
import { insideCorridor } from '../../src/shared/map/roadNetwork.js';
import { BoxIndex, placementBox } from '../../src/shared/map/structures.js';
import { SURFACE } from '../../src/shared/map/types.js';

// The client's plants and props without a collider on Bulli Bay
// (src/client/world/scatter.ts, docs/phase-3-design.md 11.1 and 11.2)

describe('the scatter on Bulli Bay', () => {
    const map = mapFor();
    const all = scatterDecor(map);

    it('is the same on every device', () => {
        expect(scatterDecor(map)).toEqual(all);
        expect(all.length).toBeGreaterThan(3000);
    });

    it('keeps off the roads and sidewalks, the lots, the buildings and landmarks', () => {
        const walls = new BoxIndex();
        for (const placed of [...map.buildings, ...map.structures]) walls.add(placementBox(placed));
        for (const spot of all) {
            expect(insideCorridor(map.net, spot.x, spot.z, 0), `${spot.kind} at ${spot.x}, ${spot.z}`).toBe(false);
            expect(map.net.areas.some(area => pointInPolygon(area.polygon, spot.x, spot.z))).toBe(false);
            expect(walls.contains(spot.x, spot.z, 0.5)).toBe(false);
        }
    });

    it('keeps its distance from the plants that have a collider', () => {
        for (const spot of all) {
            for (const plant of map.plants) {
                if (Math.abs(plant.x - spot.x) > 6 || Math.abs(plant.z - spot.z) > 6) continue;
                expect(Math.hypot(plant.x - spot.x, plant.z - spot.z)).toBeGreaterThan(1.5);
            }
        }
    });

    it('stands in the zones of its rules, on its surfaces, on the ground', () => {
        const zones = new Map<string, Set<number>>();
        for (const rule of DECOR_RULES) zones.set(rule.kind, new Set([...(zones.get(rule.kind) ?? []), rule.zone]));
        for (const spot of all) {
            expect(zones.get(spot.kind)!.has(zoneAt(map.hf, spot.x, spot.z))).toBe(true);
            expect(spot.y).toBe(heightAt(map.hf, spot.x, spot.z));
            expect(surfaceAt(map.hf, spot.x, spot.z)).not.toBe(SURFACE.water);
            // Sunshades and volleyball nets on dry sand above the water line
            if (spot.kind === 'sunshade' || spot.kind === 'volleyball') {
                expect(surfaceAt(map.hf, spot.x, spot.z)).toBe(SURFACE.sand);
                expect(spot.y).toBeGreaterThanOrEqual(1);
            }
        }
        const kinds = new Set(all.map(spot => spot.kind));
        expect([...kinds].sort()).toEqual(['chaparral', 'duneGrass', 'flowers', 'pallets', 'shrub', 'sunshade', 'volleyball']);
    });

    it('thins out to a subset with a lower density', () => {
        const half = scatterDecor(map, 0.5);
        const key = (s: { x: number; z: number; kind: string }) => `${s.kind}:${s.x}:${s.z}`;
        const full = new Set(all.map(key));
        expect(half.length).toBeGreaterThan(all.length * 0.35);
        expect(half.length).toBeLessThan(all.length * 0.65);
        for (const spot of half) expect(full.has(key(spot))).toBe(true);
    });
});

// A small map for the props beside the grid: an east-west track from
// (-90, 0) to (90, 0), 6 m wide with 0.5 m shoulders, dead ends (trim 0)
function smallMap(zone: number, buildings: MapData['buildings'] = [], lane = false, height: (x: number, z: number) => number = () => 5): MapData {
    // lane: a second track from the north ending on the first at x = 0.5
    const nodes = [node('w', -90, 0), node('e', 90, 0), ...(lane ? [node('n', 0.5, -90), node('m', 0.5, -3)] : [])];
    const edges = [edge('track', 'w', 'e'), ...(lane ? [edge('lane', 'n', 'm')] : [])];
    const net = buildRoadNetwork(network(nodes, edges, {
        profiles: { road: { ...PROFILE, width: 6, surface: 'dirt', shoulder: 0.5 } }
    }));
    return { hf: makeHeightfield(height, () => zone), net, buildings, structures: [], plants: [] } as unknown as MapData;
}

describe('the scatter on slopes', () => {
    it('puts no bush or shrub on ground steeper than 45°', () => {
        // West of x = 0 the ground rises 0.9 m per metre (42°), east of it 1.2 (50°)
        const spots = scatterDecor(smallMap(ZONE.wild, [], false, x => 100 + (x < 0 ? 0.9 : 1.2) * x));
        expect(spots.filter(s => s.x < -2).length).toBeGreaterThan(20);
        expect(spots.filter(s => s.x > 2)).toEqual([]);
    });
});

describe('mailboxes', () => {
    it('stand in front of every house in the residential zone, towards the street, facing it', () => {
        // A house facing south (+z) with its front at (0, -20): the mailbox
        // 5.4 m in front of it and 2.2 m to its right (local +x = (uz, -ux) = +x)
        const house = { piece: 'spanish_w12_f2_rect', x: 0, z: -20, ux: 0, uz: 1 } as MapData['buildings'][number];
        expect(mailboxSpots(smallMap(ZONE.residential, [house]))).toEqual([{ x: 2.2, y: 5, z: -14.6, yaw: 0 }]);
        // Not in Downtown
        expect(mailboxSpots(smallMap(ZONE.downtown, [house]))).toEqual([]);
    });

    it('leave out a mailbox that would stand on the road', () => {
        // A house with its front 8 m from the track's centre line: its mailbox
        // at z = -2.6, inside the track (3 m half width + 0.5 m shoulder)
        const near = { piece: 'spanish_w12_f2_rect', x: 30, z: -8, ux: 0, uz: 1 } as MapData['buildings'][number];
        const house = { piece: 'spanish_w12_f2_rect', x: 0, z: -20, ux: 0, uz: 1 } as MapData['buildings'][number];
        expect(mailboxSpots(smallMap(ZONE.residential, [house, near]))).toEqual([{ x: 2.2, y: 5, z: -14.6, yaw: 0 }]);
    });
});

describe('ranch fences', () => {
    it('run along both sides of a ranch track, 2.5 m beyond its shoulder, a post every 3 m', () => {
        const runs = ranchFences(smallMap(ZONE.ranch));
        // 3 + 0.5 + 2.5 = 6 m from the centre line; from s = 8 to 172 (the
        // ends' trim 0 + 8 m open): 55 posts a side
        expect(runs).toHaveLength(2);
        expect(FENCE_OFFSET).toBe(2.5);
        for (const run of runs) expect(run).toHaveLength(55);
        const near = (p: [number, number], q: [number, number]) => { expect(p[0]).toBeCloseTo(q[0], 9); expect(p[1]).toBeCloseTo(q[1], 9); };
        near(runs[0][0], [-82, -6]);
        near(runs[1][54], [80, 6]);
    });

    it('stop at a building and go on behind it, and stay out of other zones', () => {
        // A 10 m wide house on the north fence line at x = 0
        const house = { piece: 'spanish_w12_f2_rect', x: 0, z: -2, ux: 0, uz: 1 } as MapData['buildings'][number];
        const runs = ranchFences(smallMap(ZONE.ranch, [house]));
        // North: two runs, their inner ends at least 1 m off the house's
        // footprint (x -6 .. 6); south: one run
        expect(runs).toHaveLength(3);
        const north = runs.filter(run => run[0][1] < 0);
        expect(north).toHaveLength(2);
        expect(north[0].at(-1)![0]).toBeLessThanOrEqual(-7);
        expect(north[1][0][0]).toBeGreaterThanOrEqual(7);
        expect(ranchFences(smallMap(ZONE.hills))).toEqual([]);
    });

    it('stop where a post would stand on another road', () => {
        // The lane ends on the track without a junction; the north fence line
        // (z = -6, posts at x = -82 + 3 k) crosses it at x = 0.5, whose
        // corridor (3 + 0.5 m, 0.5 m margin) takes the posts at -1 and 2
        const north = ranchFences(smallMap(ZONE.ranch, [], true)).filter(run => run.every(([, z]) => Math.abs(z + 6) < 1e-9));
        expect(north).toHaveLength(2);
        expect(north[0].at(-1)![0]).toBeCloseTo(-4, 9);
        expect(north[1][0][0]).toBeCloseTo(5, 9);
    });
});
