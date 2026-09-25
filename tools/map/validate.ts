// Validates a curated map (docs/phase-3-design.md, 15, deviation A14):
//
//   npx tsx tools/map/validate.ts [--map bulli-bay] [--warnings]
//
// Reads the sources and the committed terrain.bhf (bake first:
// npx tsx tools/map/bake.ts), prints every finding, the road lengths and
// per track its length, gates, climb, estimated race times, flow and jumps
// (lip, take-off speed, time in the air), the terrain mesh's deviation from
// the sim's ground, and fails on errors.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMapBundle } from './mapBundle.js';
import { terrainMeshStats, validateMap } from './validateMap.js';

function main(argv: string[]): number {
    const i = argv.indexOf('--map');
    const mapId = i >= 0 ? argv[i + 1] : 'bulli-bay';
    const bundle = loadMapBundle(mapId);
    const started = performance.now();
    const result = validateMap(bundle);
    const ms = Math.round(performance.now() - started);
    const { roads } = result;
    console.log(`${mapId}: ${roads.km.toFixed(2)} km of road (${roads.pavedKm.toFixed(2)} km paved), ${bundle.net.edges.length} edges, ${bundle.net.nodes.length} nodes, ${bundle.net.areas.length} areas`);
    console.log('by surface (km):', Object.fromEntries(Object.entries(roads.bySurface).map(([k, v]) => [k, Math.round(v * 100) / 100])));
    for (const t of result.tracks) {
        const track = bundle.tracks.tracks.find(x => x.id === t.id)!;
        const time = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
        console.log(`track ${t.id}: ${(t.length / 1000).toFixed(2)} km${track.kind === 'circuit' ? ` × ${track.laps}` : ''}, ${t.gates} gates, `
            + `+${t.climb.toFixed(0)} / -${t.descent.toFixed(0)} m, slowest bend ${t.minCornerSpeed.toFixed(0)} km/h, `
            + `race ${time(t.fastest.time)} (${t.fastest.car}) .. ${time(t.slowest.time)} (${t.slowest.car})`);
        console.log(`  flow: longest straight ${t.longestStraight.toFixed(0)} m, ${t.bendsPerKm.toFixed(1)} bends per km`
            + (t.obliqueBarriers ? `, ${t.obliqueBarriers} oblique barrier rows (obox, M3)` : ''));
        for (const j of t.jumps) {
            console.log(`  jump at ${j.s.toFixed(0)} m (${j.x.toFixed(0)} | ${j.z.toFixed(0)}): lip ${j.lip.toFixed(2)} m, take-off ${j.speed.toFixed(0)} km/h, `
                + `${j.airtime.toFixed(2)} s in the air over ${j.distance.toFixed(0)} m`);
        }
    }
    const mesh = terrainMeshStats(bundle.hf);
    console.log(`terrain mesh against the sim's ground: ${(mesh.worst2m * 100).toFixed(1)} cm at 2 m, `
        + `${(mesh.worstNear * 100).toFixed(1)} cm at 0.5 m near the car, roads ${(mesh.worstRoad * 100).toFixed(1)} cm`);
    const errors = result.findings.filter(f => f.severity === 'error');
    const warnings = result.findings.filter(f => f.severity === 'warning');
    for (const f of result.findings) {
        if (f.severity === 'warning' && !argv.includes('--warnings')) continue;
        const at = f.x !== undefined ? ` (${f.x} | ${f.z})` : '';
        console.log(`${f.severity === 'error' ? 'ERROR' : 'warn '} [${f.check}] ${f.message}${at}`);
    }
    console.log(`${errors.length} errors, ${warnings.length} warnings (${ms} ms)`);
    return errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
