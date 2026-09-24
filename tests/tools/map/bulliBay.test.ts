import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    BHF_HEADER_BYTES, BULLI_BAY_GRID, decodeHeightfield, heightAt, surfaceAt, waterDepth, zoneAt
} from '../../../src/shared/map/heightfield.js';
import { parseMapFile, parsePoisFile, parseTracksFile, parseZonesFile } from '../../../src/shared/map/mapFiles.js';
import { buildRoadNetwork, roadSurfaceAt } from '../../../src/shared/map/roadNetwork.js';
import { parseRoadNetwork } from '../../../src/shared/map/roadSchema.js';
import { leftNormal } from '../../../src/shared/map/spline.js';
import { routePointAt, type ResolvedRoute } from '../../../src/shared/map/trackRoute.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import { readSources, sourceHash } from '../../../tools/map/bake.js';
import { parseBaseTerrain } from '../../../tools/map/baseTerrain.js';
import { toHex } from '../../../tools/map/hash.js';
import { loadMapBundle } from '../../../tools/map/mapBundle.js';
import { validateMap, type ValidationResult } from '../../../tools/map/validateMap.js';

// Data tests on the real map (docs/phase-3-design.md, section 15): the
// committed sources parse, the committed terrain.bhf is the bake of exactly
// these sources, it stays within the download budget of 6.2, and a few
// fixed places of the map (section 3) come out as designed. Expected values
// come from the design document, not from the bake.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = readSources('bulli-bay');
const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
const terrainBytes = new Uint8Array(readFileSync(path.join(ROOT, 'public/maps/bulli-bay/terrain.bhf')));
const hf = decodeHeightfield(terrainBytes, BULLI_BAY_GRID);

const DIR = path.join(ROOT, 'src/shared/maps/bulli-bay');
const readJson = (name: string) => JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as unknown;

describe('Bulli Bay sources', () => {
    it('parse and build a network without findings', () => {
        const roads = parseRoadNetwork(json(sources.roads));
        expect(roads.ok ? [] : roads.errors).toEqual([]);
        for (const [name, parse] of [
            ['map.json', parseMapFile], ['zones.json', parseZonesFile], ['pois.json', parsePoisFile], ['tracks.json', parseTracksFile]
        ] as const) {
            const parsed = parse(readJson(name));
            expect(parsed.ok ? [] : parsed.errors, name).toEqual([]);
        }
        expect(() => parseBaseTerrain(json(sources.base))).not.toThrow();
        if (roads.ok) expect(buildRoadNetwork(roads.value).issues).toEqual([]);
    });

    it('stay within 150 KB compressed together (6.2)', () => {
        const files = ['roads.json', 'map.json', 'zones.json', 'pois.json', 'tracks.json', 'base.json']
            .map(name => readFileSync(path.join(DIR, name)));
        expect(gzipSync(Buffer.concat(files)).length).toBeLessThanOrEqual(150 * 1024);
    });
});

// Loaded and validated once: the validation takes about 0.2 s
let validation: ValidationResult | null = null;
function validated(): ValidationResult {
    validation ??= validateMap(loadMapBundle('bulli-bay'));
    return validation;
}
const routeOf = (id: string): ResolvedRoute => {
    const route = validated().routes.find(r => r.track.id === id);
    if (!route) throw new Error(`track ${id} does not resolve`);
    return route;
};
// Twice the signed area of the closed centre line: positive when it runs
// clockwise on the map (north up, x right, z down)
function orientation(route: ResolvedRoute): number {
    let area = 0;
    const pts = route.points;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        area += a.x * b.z - b.x * a.z;
    }
    return area;
}

describe('Bulli Bay validation (tools/map/validate.ts)', () => {
    it('finds no errors: connected network, no crossings without a junction, grades, bends, rails, spawns, tracks', () => {
        const errors = validated().findings.filter(f => f.severity === 'error')
            .map(f => `[${f.check}] ${f.message}${f.x !== undefined ? ` (${f.x} | ${f.z})` : ''}`);
        expect(errors).toEqual([]);
    }, 20_000);

    it('resolves every track of tracks.json, at least the four race tracks of section 4', () => {
        const tracks = json(readFileSync(path.join(DIR, 'tracks.json'))) as { tracks: { id: string; bonus?: boolean }[] };
        expect(validated().routes.map(r => r.track.id)).toEqual(tracks.tracks.map(t => t.id));
        const races = tracks.tracks.filter(t => !t.bonus).map(t => t.id);
        expect(races).toEqual(expect.arrayContaining(['downtown-loop', 'coast-sprint', 'hill-sprint', 'harbor-circuit']));
    }, 20_000);

    it('builds the tracks as section 4 describes them', () => {
        // T1: circuit of about 1.3 km, counter-clockwise, start on Main
        // Street heading east
        const loop = routeOf('downtown-loop');
        expect(loop.closed).toBe(true);
        expect(loop.length).toBeGreaterThan(1300 * 0.9);
        expect(loop.length).toBeLessThan(1300 * 1.1);
        expect(orientation(loop)).toBeLessThan(0);
        expect(loop.gates[0].yaw).toBeCloseTo(Math.PI / 2, 1);
        // Six 90° corners, five to the left and one to the right
        const turns = loop.junctions.map(pass => {
            const a = routePointAt(loop, pass.entryS), b = routePointAt(loop, pass.exitS);
            const [lx, lz] = leftNormal(a.tx, a.tz);
            return Math.atan2(b.tx * lx + b.tz * lz, b.tx * a.tx + b.tz * a.tz);
        }).filter(angle => Math.abs(angle) > Math.PI / 4);
        expect(turns.map(angle => (angle > 0 ? 'left' : 'right')).sort()).toEqual(['left', 'left', 'left', 'left', 'left', 'right']);
        // (within 10°: the tangents are read from the 2 m centre line points)
        for (const angle of turns) expect(Math.abs(Math.abs(angle) - Math.PI / 2)).toBeLessThan(10 * Math.PI / 180);
        // T4: circuit of about 1.2 km, clockwise
        const harbor = routeOf('harbor-circuit');
        expect(harbor.closed).toBe(true);
        expect(harbor.length).toBeGreaterThan(1200 * 0.9);
        expect(harbor.length).toBeLessThan(1200 * 1.1);
        expect(orientation(harbor)).toBeGreaterThan(0);
        // T2: from the north edge of the map to the south cliffs
        const coast = routeOf('coast-sprint');
        expect(coast.closed).toBe(false);
        expect(coast.gates[0].z).toBeLessThan(-900);
        expect(coast.gates[coast.gates.length - 1].z).toBeGreaterThan(850);
        // T3: from downtown up the ridge, climbing more than 120 m to the lookout
        const stats = validated().tracks.find(t => t.id === 'hill-sprint')!;
        expect(stats.climb).toBeGreaterThan(120);
        const finish = routeOf('hill-sprint').gates.at(-1)!;
        // Lookout parking at (640 | -760)
        expect(Math.hypot(finish.x - 640, finish.z + 760)).toBeLessThan(120);
    }, 20_000);

    it('puts every grid slot and gate of every track on the road', () => {
        const net = loadMapBundle('bulli-bay').net;
        for (const route of validated().routes) {
            for (const p of [...route.grid, ...route.gates]) {
                expect(roadSurfaceAt(net, p.x, p.z), `${route.track.id} at (${p.x.toFixed(0)} | ${p.z.toFixed(0)})`).not.toBeNull();
            }
        }
    }, 20_000);
});

describe('Bulli Bay terrain.bhf', () => {
    it('is the bake of the committed sources (else: run npx tsx tools/map/bake.ts)', () => {
        expect(toHex(hf.sourceHash)).toBe(toHex(sourceHash(sources)));
        const map = parseMapFile(json(sources.map));
        if (!map.ok) throw new Error(map.errors.join('\n'));
        expect(hf.mapVersion).toBe(map.value.mapVersion);
    });

    it('stays within the download budget of 600 KB, surface and zones within 80 KB (6.2)', () => {
        // gzip at the default level is an upper bound: the server sends
        // brotli at quality 11 where the browser accepts it, which is smaller
        expect(gzipSync(terrainBytes).length).toBeLessThanOrEqual(600 * 1024);
        const layers = terrainBytes.subarray(BHF_HEADER_BYTES + 2 * BULLI_BAY_GRID.cols * BULLI_BAY_GRID.rows);
        expect(gzipSync(layers).length).toBeLessThanOrEqual(80 * 1024);
    });

    it('has the places of section 3 where the design puts them', () => {
        // Pier deck at y = 5 over the sea, wood (section 6.4 step 7)
        expect(heightAt(hf, -700, -20)).toBeCloseTo(5, 2);
        expect(surfaceAt(hf, -700, -20)).toBe(SURFACE.wood);
        expect(waterDepth(hf, -700, -30)).toBeGreaterThan(0.6);
        // Open sea in the west, sea floor at -12 m (3.1)
        expect(heightAt(hf, -950, 0)).toBeCloseTo(-12, 2);
        expect(surfaceAt(hf, -950, 0)).toBe(SURFACE.water);
        // Lookout on the ridge at about 145 m (3.1, a start value)
        expect(Math.abs(heightAt(hf, 640, -770) - 145)).toBeLessThan(5);
        // Party arena "Cannery Lot": concrete, arena zone (E10)
        expect(surfaceAt(hf, -170, 590)).toBe(SURFACE.concrete);
        expect(zoneAt(hf, -170, 590)).toBe(ZONE.arena);
        // Downtown between 4 and 14 m (3.1)
        const downtown = heightAt(hf, -400, 0);
        expect(downtown).toBeGreaterThan(4);
        expect(downtown).toBeLessThan(14);
        expect(zoneAt(hf, -400, 0)).toBe(ZONE.downtown);
    });

    it('keeps every road within its grade limit on the baked ground', () => {
        const roads = parseRoadNetwork(json(sources.roads));
        if (!roads.ok) throw new Error(roads.errors.join('\n'));
        const net = buildRoadNetwork(roads.value);
        const over: string[] = [];
        for (const edge of net.edges) {
            // + 1 cm of quantisation per metre; on the tightest hairpins the
            // bilinear surface between the samples adds up to 0.5 %
            const limit = (edge.def.maxGrade ?? 0.08) + 0.01;
            for (let k = 1; k < edge.samples.length; k++) {
                const a = edge.samples[k - 1], b = edge.samples[k];
                const grade = Math.abs(heightAt(hf, b.x, b.z) - heightAt(hf, a.x, a.z)) / (b.s - a.s);
                if (grade > limit) over.push(`${edge.id} at s = ${b.s.toFixed(0)}: ${(grade * 100).toFixed(1)} %`);
            }
        }
        expect(over).toEqual([]);
    });
});
