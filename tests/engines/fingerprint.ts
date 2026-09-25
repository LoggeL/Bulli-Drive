// Fingerprint of everything the map computes that must come out
// bit-identical in every JavaScript engine (docs/phase-3-design.md, E4 and
// 5.3): heightAt, the road samples, the rail colliders, the tracks'
// TrackDefs and the whole bake. Runs in Node (the test) and, bundled, in
// WebKit and Chromium (map-determinism.spec.ts); the two must be equal.

import { BULLI_BAY_GRID, decodeHeightfield, heightAt } from '../../src/shared/map/heightfield.js';
import { parseTracksFile } from '../../src/shared/map/mapFiles.js';
import { networkRailColliders } from '../../src/shared/map/rails.js';
import { buildRoadNetwork } from '../../src/shared/map/roadNetwork.js';
import { parseRoadNetwork } from '../../src/shared/map/roadSchema.js';
import { routeToTrack } from '../../src/shared/map/routeToTrack.js';
import { resolveRoute } from '../../src/shared/map/trackRoute.js';
import { canonicalStringify, fnv1a } from '../../src/shared/world/mapData.js';
import { bakeSources } from '../../tools/map/bakeSources.js';

export interface FingerprintInput {
    roads: string;
    map: string;
    zones: string;
    base: string;
    tracks: string;
    terrain: Uint8Array;
}

// 32-bit FNV-1a over bytes (fast enough for the 3 MB of a bake)
function fnvBytes(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function fnvDoubles(values: readonly number[]): string {
    return fnvBytes(new Uint8Array(Float64Array.from(values).buffer));
}

export function fingerprint(input: FingerprintInput): Record<string, string> {
    const hf = decodeHeightfield(input.terrain, BULLI_BAY_GRID);
    // heightAt at 20 000 points of a fixed LCG, also beyond the grid
    const heights: number[] = [];
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    for (let i = 0; i < 20000; i++) heights.push(heightAt(hf, -1010 + next() * 2020, -1010 + next() * 2020));

    const parsed = parseRoadNetwork(JSON.parse(input.roads) as unknown);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const net = buildRoadNetwork(parsed.value);
    const samples: number[] = [];
    for (const edge of net.edges) for (const p of edge.samples) samples.push(p.x, p.z, p.tx, p.tz, p.s, p.curvature);

    const tracks = parseTracksFile(JSON.parse(input.tracks) as unknown);
    if (!tracks.ok) throw new Error(tracks.errors.join('\n'));
    const trackHashes: Record<string, string> = {};
    for (const track of tracks.value.tracks) {
        const route = resolveRoute(net, track);
        if (!route.ok) throw new Error(route.errors.join('\n'));
        trackHashes[track.id] = fnv1a(canonicalStringify(routeToTrack(net, route.route, hf.mapVersion)));
    }

    const encoder = new TextEncoder();
    const bake = bakeSources('bulli-bay', {
        roads: encoder.encode(input.roads), map: encoder.encode(input.map),
        zones: encoder.encode(input.zones), base: encoder.encode(input.base)
    });
    return {
        heights: fnvDoubles(heights),
        samples: fnvDoubles(samples),
        rails: fnv1a(canonicalStringify(networkRailColliders(net))),
        tracks: fnv1a(canonicalStringify(trackHashes)),
        bake: fnvBytes(bake.bytes),
        committedTerrain: fnvBytes(input.terrain)
    };
}
