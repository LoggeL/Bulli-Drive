import { describe, expect, it } from 'vitest';
import { decodeHeightfield, heightAt, surfaceAt, zoneAt, type GridSpec } from '../../../src/shared/map/heightfield.js';
import type { MapFile, ZonesFile } from '../../../src/shared/map/mapFiles.js';
import type { RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import { SURFACE, SURFACE_PRIORITY, ZONE } from '../../../src/shared/map/types.js';
import { bakeTerrain, type BakeInput } from '../../../tools/map/bakeTerrain.js';
import { fnv1a128, toHex } from '../../../tools/map/hash.js';
import { encodePng } from '../../../tools/map/png.js';
import { inflateSync } from 'node:zlib';
import { edge, network, node } from '../../shared/map/fixtures.js';
import { FLAT_COAST } from './fixtures.js';

// The bake on a small synthetic map (docs/phase-3-design.md, 6.4): 400 m
// square, sea west of x = -150, a hill the east road climbs over, a car
// park at a fixed height. The checks read the baked bytes back through the
// runtime functions (heightAt, surfaceAt, zoneAt) like the game will.

const SPEC: GridSpec = {
    cols: 201, rows: 201, cellSize: 2, originX: -200, originZ: -200,
    heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8
};

const ROADS: RoadNetworkFile = network(
    [
        node('n', -100, -190), node('mid', -100, 0, 'joint'), node('j', -100, 150, 'junction'),
        node('e', 190, 150), node('s', -100, 195),
        node('lot-start', 20, -40), node('lot-gate', 115, -40)
    ],
    [
        edge('coast-1', 'n', 'mid', [[-95, -100]]),
        edge('coast-2', 'mid', 'j', [[-105, 80]]),
        edge('east', 'j', 'e', [[40, 140]]),
        edge('south', 'j', 's'),
        edge('lot-road', 'lot-start', 'lot-gate', [], { profile: 'dirt', maxGrade: 0.12 })
    ],
    {
        areas: [{
            id: 'lot', polygon: [[100, -60], [160, -60], [160, -20], [100, -20]], y: 6,
            surface: 'concrete', curb: false, connects: ['lot-gate']
        }]
    }
);

const MAP: MapFile = {
    format: 'bulli-map', version: 1, mapId: 'test', mapVersion: 3, name: 'Test',
    boundary: [[-200, -200], [200, -200], [200, 200], [-200, 200]]
};

const ZONES: ZonesFile = {
    format: 'bulli-zones', version: 1, mapId: 'test',
    zones: [{ id: 'centre', zone: 'downtown', polygon: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }]
};

const INPUT: BakeInput = {
    roads: ROADS,
    map: MAP,
    zones: ZONES,
    base: { ...FLAT_COAST, hills: [{ id: 'hill', x: 60, z: 110, radii: [70, 70], height: 25 }] },
    spec: SPEC,
    sourceHash: fnv1a128(new TextEncoder().encode('test sources'))
};

// Built inside each test, not while collecting them: Stryker only
// activates a mutant while a test runs
const bake = () => {
    const result = bakeTerrain(INPUT);
    const hf = decodeHeightfield(result.bytes, SPEC);
    return { result, hf };
};

describe('bakeTerrain', () => {
    it('gives the same bytes for the same input', () => {
        const { result } = bake();
        const again = bakeTerrain(INPUT);
        expect(Buffer.compare(Buffer.from(again.bytes), Buffer.from(result.bytes))).toBe(0);
    });

    it('writes map version and source hash into the header', () => {
        const { hf } = bake();
        expect(hf.mapVersion).toBe(3);
        expect(toHex(hf.sourceHash)).toBe(toHex(INPUT.sourceHash));
    });

    it('has no conflicts or unreachable pins on this map', () => {
        const { result } = bake();
        expect(result.report.conflicts.count).toBe(0);
        expect(result.report.infeasibleChains).toEqual([]);
        expect(result.report.edges).toBe(5);
    });

    it('puts the baked ground on the road profile under every sample (within 1 cm)', () => {
        const { result, hf } = bake();
        for (const e of result.network.edges) {
            const profile = result.edgeHeights.get(e.id)!;
            e.samples.forEach((p, k) => {
                // Quantisation ±0.5 cm; the flat zone makes the bilinear
                // surface the road itself
                expect(Math.abs(heightAt(hf, p.x, p.z) - profile[k]), `${e.id} at s = ${p.s}`).toBeLessThan(0.01);
            });
        }
    });

    it('keeps each road within its grade limit on the baked heightfield', () => {
        const { result, hf } = bake();
        let climbed = 0;
        for (const e of result.network.edges) {
            const limit = e.def.maxGrade ?? 0.08;
            for (let k = 1; k < e.samples.length; k++) {
                const a = e.samples[k - 1], b = e.samples[k];
                const grade = Math.abs(heightAt(hf, b.x, b.z) - heightAt(hf, a.x, a.z)) / (b.s - a.s);
                // + 1 cm of quantisation per metre
                expect(grade, `${e.id} at s = ${b.s}`).toBeLessThanOrEqual(limit + 0.01);
                if (e.id === 'east') climbed = Math.max(climbed, grade);
            }
        }
        // The east road does climb the hill (the limit matters here)
        expect(climbed).toBeGreaterThan(0.06);
    });

    it('holds the junction flat and runs the chain through its joint without a step', () => {
        const { result, hf } = bake();
        const j = result.network.nodeById.get('j')!;
        const h = heightAt(hf, j.x, j.z);
        // Plateau: 10 m wide roads, flat zone 9 m → level 9 m along each road
        expect(heightAt(hf, j.x + 9, j.z)).toBeCloseTo(h, 2);
        expect(heightAt(hf, j.x, j.z + 9)).toBeCloseTo(h, 2);
        const c1 = result.edgeHeights.get('coast-1')!, c2 = result.edgeHeights.get('coast-2')!;
        expect(c1[c1.length - 1]).toBeCloseTo(c2[0], 9);
    });

    it('ends a road level with the area it connects to', () => {
        const { result, hf } = bake();
        const road = result.edgeHeights.get('lot-road')!;
        expect(road[road.length - 1]).toBe(6);
        expect(heightAt(hf, 130, -40)).toBeCloseTo(6, 2);
        expect(heightAt(hf, 100, -40)).toBeCloseTo(6, 2);
    });

    it('rasterises road and area surfaces over the natural ground', () => {
        const { hf } = bake();
        // The straight south road (x = -100): width/2 + 1 m = 6 m of asphalt
        expect(surfaceAt(hf, -100, 175)).toBe(SURFACE.asphalt);
        expect(surfaceAt(hf, -100 + 5.9, 175)).toBe(SURFACE.asphalt);
        expect(surfaceAt(hf, -100 - 6, 175)).toBe(SURFACE.asphalt);
        expect(surfaceAt(hf, -100 + 8, 175)).toBe(SURFACE.grass);
        expect(surfaceAt(hf, 60, -40)).toBe(SURFACE.dirt);
        expect(surfaceAt(hf, 130, -40)).toBe(SURFACE.concrete);
        // Concrete (8) beats dirt (5) where the road enters the lot
        expect(surfaceAt(hf, 110, -40)).toBe(SURFACE.concrete);
        expect(SURFACE_PRIORITY[SURFACE.concrete]).toBeGreaterThan(SURFACE_PRIORITY[SURFACE.dirt]);
    });

    it('classifies the ground: sea, wet sand, beach, grass', () => {
        const { hf } = bake();
        expect(surfaceAt(hf, -190, -100)).toBe(SURFACE.water);
        // 2 m inland: 2·S(2/30) ≈ 0.03 m, below 0.5 m
        expect(surfaceAt(hf, -148, -100)).toBe(SURFACE.wetSand);
        // 10 m inland: 2·S(1/3) ≈ 0.74 m
        expect(surfaceAt(hf, -140, -100)).toBe(SURFACE.sand);
        expect(surfaceAt(hf, 0, -150)).toBe(SURFACE.grass);
    });

    it('fills the zone layer from map.json', () => {
        const { hf } = bake();
        expect(zoneAt(hf, 0, 0)).toBe(ZONE.downtown);
        expect(zoneAt(hf, 45, -45)).toBe(ZONE.downtown);
        expect(zoneAt(hf, 150, 150)).toBe(ZONE.wild);
    });
});

describe('fnv1a128', () => {
    it('matches the published FNV-1a 128 test vectors', () => {
        expect(toHex(fnv1a128(new Uint8Array(0)))).toBe('6c62272e07bb014262b821756295c58d');
        expect(toHex(fnv1a128(new TextEncoder().encode('a')))).toBe('d228cb696f1a8caf78912b704e4a8964');
        // Parts hash like their concatenation
        const enc = new TextEncoder();
        expect(toHex(fnv1a128(enc.encode('foo'), enc.encode('bar')))).toBe(toHex(fnv1a128(enc.encode('foobar'))));
        expect(toHex(fnv1a128(enc.encode('foobar')))).toBe('343e1662793c64bf6f0d3597ba446f18');
    });
});

describe('encodePng', () => {
    it('writes a PNG with the pixels in one unfiltered IDAT', () => {
        const png = encodePng(2, 1, Uint8Array.from([255, 0, 0, 0, 0, 255]));
        expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer);
        expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
        expect(view.getUint32(16)).toBe(2);
        expect(view.getUint32(20)).toBe(1);
        const idatLength = view.getUint32(33);
        expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
        const raw = inflateSync(png.subarray(41, 41 + idatLength));
        expect(Array.from(raw)).toEqual([0, 255, 0, 0, 0, 0, 255]);
    });
});

describe('bakeTerrain: height pins and steep ground', () => {
    // A straight north-south road x = 0 through a joint with a fixed height
    // and an elevation pin 100 m after it; a steep round hill in the east.
    // Natural ground there: 4 + 0.02·(x + 150) = 7 m at x = 0.
    const pinned: BakeInput = {
        ...INPUT,
        roads: network(
            [node('a', 0, -190), node('m', 0, -50, 'joint', { y: 12 }), node('b', 0, 190)],
            [edge('north', 'a', 'm'), edge('south', 'm', 'b', [], { elevation: [{ s: 100, y: 5 }] })]
        ),
        zones: { ...ZONES, zones: [] },
        base: { ...FLAT_COAST, hills: [{ id: 'steep', x: 120, z: 0, radii: [40, 40], height: 60 }] }
    };
    // Built inside each test, not while collecting them: Stryker only
    // activates a mutant while a test runs
    const bakePinned = () => {
        const baked = bakeTerrain(pinned);
        const pinnedHf = decodeHeightfield(baked.bytes, SPEC);
        return { baked, pinnedHf };
    };

    it('meets a fixed joint height and an elevation pin on the baked ground', () => {
        const { baked, pinnedHf } = bakePinned();
        expect(baked.report.infeasibleChains).toEqual([]);
        // Quantisation ±0.5 cm
        expect(heightAt(pinnedHf, 0, -50)).toBeCloseTo(12, 2);
        expect(heightAt(pinnedHf, 0, 50)).toBeCloseTo(5, 2);
        // Across the flat zone the pinned height too (9 m half width)
        expect(heightAt(pinnedHf, 8, -50)).toBeCloseTo(12, 2);
    });

    it('classifies ground steeper than 45° as rock, the hill top as grass', () => {
        const { pinnedHf } = bakePinned();
        // Hill flank at half its radius: 60 m · 1.5 / 40 m = 2.25 > 1
        expect(surfaceAt(pinnedHf, 140, 0)).toBe(SURFACE.rock);
        expect(surfaceAt(pinnedHf, 120, 0)).toBe(SURFACE.grass);
    });
});
