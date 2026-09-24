import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    BHF_HEADER_BYTES, BULLI_BAY_GRID, decodeHeightfield, heightAt, surfaceAt, waterDepth, zoneAt
} from '../../../src/shared/map/heightfield.js';
import { buildRoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import { parseMapFile, parseRoadNetwork } from '../../../src/shared/map/roadSchema.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import { readSources, sourceHash } from '../../../tools/map/bake.js';
import { parseBaseTerrain } from '../../../tools/map/baseTerrain.js';
import { toHex } from '../../../tools/map/hash.js';

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

describe('Bulli Bay sources', () => {
    it('parse and build a network without findings', () => {
        const roads = parseRoadNetwork(json(sources.roads));
        expect(roads.ok ? [] : roads.errors).toEqual([]);
        const map = parseMapFile(json(sources.map));
        expect(map.ok ? [] : map.errors).toEqual([]);
        expect(() => parseBaseTerrain(json(sources.base))).not.toThrow();
        if (roads.ok) expect(buildRoadNetwork(roads.value).issues).toEqual([]);
    });

    it('stay within 150 KB compressed together (6.2)', () => {
        const all = new Uint8Array(sources.roads.length + sources.map.length + sources.base.length);
        all.set(sources.roads, 0);
        all.set(sources.map, sources.roads.length);
        all.set(sources.base, sources.roads.length + sources.map.length);
        expect(gzipSync(all).length).toBeLessThanOrEqual(150 * 1024);
    });
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
