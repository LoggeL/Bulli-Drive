// Bakes a map's terrain (docs/phase-3-design.md, 6.4):
//
//   npx tsx tools/map/bake.ts [--map bulli-bay] [--out <dir>] [--check]
//
// Reads src/shared/maps/<map>/{roads,map,zones,base}.json, writes
// public/maps/<map>/terrain.bhf and manifest.json, and a review preview to
// output/maps/<map>/preview.png. --check writes nothing and fails when the
// committed terrain.bhf differs from a fresh bake (a forgotten bake).
// --strict also fails on corridor conflicts and infeasible profiles.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { BHF_HEADER_BYTES } from '../../src/shared/map/heightfield.js';
import { BAKE_VERSION, type BakeResult } from './bakeTerrain.js';
import { bakeSources, type MapSources } from './bakeSources.js';
import { toHex } from './hash.js';
import { renderPreview } from './preview.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Hashing and baking the source bytes live in bakeSources.ts (no file
// access, the worldviewer bakes in the browser with it)
export { bakeSources, sourceHash, type MapSources } from './bakeSources.js';

export function readSources(mapId: string): MapSources {
    const dir = path.join(ROOT, 'src/shared/maps', mapId);
    return {
        roads: readFileSync(path.join(dir, 'roads.json')),
        map: readFileSync(path.join(dir, 'map.json')),
        zones: readFileSync(path.join(dir, 'zones.json')),
        base: readFileSync(path.join(dir, 'base.json'))
    };
}

function compressedSizes(bytes: Uint8Array): { gzip: number; brotli: number } {
    return {
        gzip: gzipSync(bytes, { level: 9 }).length,
        brotli: brotliCompressSync(bytes, {
            params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length
            }
        }).length
    };
}

export function buildManifest(mapId: string, result: BakeResult) {
    const { heightfield: hf, bytes, report } = result;
    const n = hf.spec.cols * hf.spec.rows;
    const heightsEnd = BHF_HEADER_BYTES + 2 * n;
    const size = compressedSizes(bytes);
    return {
        mapId,
        mapVersion: hf.mapVersion,
        bakeVersion: BAKE_VERSION,
        sourceHash: toHex(hf.sourceHash),
        grid: hf.spec,
        files: {
            terrain: {
                path: 'terrain.bhf',
                hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
                bytes: bytes.length,
                gzipBytes: size.gzip,
                brotliBytes: size.brotli,
                // Over the wire the layers are compressed together; these
                // are the brotli sizes of each on its own
                layers: {
                    heights: compressedSizes(bytes.subarray(BHF_HEADER_BYTES, heightsEnd)).brotli,
                    surface: compressedSizes(bytes.subarray(heightsEnd, heightsEnd + n)).brotli,
                    zones: compressedSizes(bytes.subarray(heightsEnd + n)).brotli
                }
            }
        },
        stats: {
            edges: report.edges,
            nodes: report.nodes,
            areas: report.areas,
            roadKm: Math.round(report.roadLength) / 1000,
            minHeight: Math.round(report.minHeight * 100) / 100,
            maxHeight: Math.round(report.maxHeight * 100) / 100,
            conflicts: report.conflicts.count,
            maxConflictGap: Math.round(report.conflicts.maxGap * 100) / 100,
            infeasibleChains: report.infeasibleChains.length,
            maxBakedGrade: Math.round(report.maxBakedGrade.grade * 1000) / 1000
        }
    };
}

function main(argv: string[]): number {
    const arg = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const mapId = arg('--map') ?? 'bulli-bay';
    const outDir = path.resolve(ROOT, arg('--out') ?? path.join('public/maps', mapId));
    const check = argv.includes('--check');
    const strict = argv.includes('--strict');

    const started = performance.now();
    const result = bakeSources(mapId, readSources(mapId));
    const { report } = result;
    console.log(`baked ${mapId} in ${Math.round(performance.now() - started)} ms`, report.timings);
    const manifest = buildManifest(mapId, result);
    console.log(`roads: ${report.edges} edges, ${report.nodes} nodes, ${report.areas} areas, ${(report.roadLength / 1000).toFixed(2)} km`);
    console.log(`heights: ${report.minHeight.toFixed(2)} .. ${report.maxHeight.toFixed(2)} m, steepest baked road grade ${(report.maxBakedGrade.grade * 100).toFixed(1)} % (${report.maxBakedGrade.edge})`);
    const t = manifest.files.terrain;
    console.log(`terrain.bhf: ${t.bytes} bytes, gzip ${t.gzipBytes}, brotli ${t.brotliBytes} (heights ${t.layers.heights}, surface ${t.layers.surface}, zones ${t.layers.zones})`);
    console.log('surfaces:', report.surfaceCounts);
    for (const issue of report.networkIssues) console.warn(`network: ${issue}`);
    let problems = 0;
    if (report.conflicts.count) {
        problems++;
        console.warn(`corridor conflicts: ${report.conflicts.count} grid points, worst ${report.conflicts.maxGap.toFixed(2)} m at (${report.conflicts.worstX} | ${report.conflicts.worstZ})`);
    }
    for (const chain of report.infeasibleChains) {
        problems++;
        console.warn(`profile: pins of ${chain.edges.join(' → ')} miss the grade limit by ${chain.infeasible.toFixed(2)} m`);
    }

    const terrainPath = path.join(outDir, 'terrain.bhf');
    if (check) {
        const committed = existsSync(terrainPath) ? readFileSync(terrainPath) : null;
        if (!committed || Buffer.compare(committed, Buffer.from(result.bytes)) !== 0) {
            console.error(`${path.relative(ROOT, terrainPath)} is not the bake of the current sources: run npx tsx tools/map/bake.ts`);
            return 1;
        }
        console.log(`${path.relative(ROOT, terrainPath)} is up to date`);
    } else {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(terrainPath, result.bytes);
        writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        const previewDir = path.join(ROOT, 'output/maps', mapId);
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(path.join(previewDir, 'preview.png'), renderPreview(result));
        console.log(`wrote ${path.relative(ROOT, outDir)}/{terrain.bhf,manifest.json} and ${path.relative(ROOT, previewDir)}/preview.png`);
    }
    return strict && problems ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
