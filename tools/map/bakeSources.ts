// The bake of a map from the bytes of its source files, without file access:
// tools/map/bake.ts reads the files from disk, the worldviewer's bake worker
// (tools/worldviewer) passes the sources it edits. Both hash and bake the
// same bytes the same way, so a worldviewer bake of an exported roads.json
// carries the sourceHash the CLI bake gives it.

import type { GridSpec } from '../../src/shared/map/heightfield.js';
import { MAP_GRIDS } from '../../src/shared/map/registry.js';
import { parseDiscoveriesFile } from '../../src/shared/map/discoverySchema.js';
import { parseMapFile, parsePoisFile, parseZonesFile } from '../../src/shared/map/mapFiles.js';
import { parseRoadNetwork } from '../../src/shared/map/roadSchema.js';
import { parseBaseTerrain } from './baseTerrain.js';
import { BAKE_VERSION, bakeTerrain, type BakeResult } from './bakeTerrain.js';
import { fnv1a128 } from './hash.js';

export const GRIDS: Readonly<Record<string, GridSpec>> = MAP_GRIDS;

// The sources the bake reads. pois.json and discoveries.json are optional so
// callers that only edit roads/base (e.g. worldviewer) keep working; when
// provided, they flatten structure/prop/billboard/ramp pads and enter sourceHash.
export interface MapSources {
    roads: Uint8Array;
    map: Uint8Array;
    zones: Uint8Array;
    base: Uint8Array;
    pois?: Uint8Array;
    discoveries?: Uint8Array;
}

// FNV-1a-128 over the sources and the bake version (6.1, A13)
export function sourceHash(sources: MapSources): Uint8Array {
    const separator = new Uint8Array([0]);
    const version = new TextEncoder().encode(`bake-version:${BAKE_VERSION}`);
    const parts: Uint8Array[] = [
        sources.roads, separator, sources.map, separator, sources.zones, separator,
        sources.base, separator
    ];
    if (sources.pois) parts.push(sources.pois, separator);
    if (sources.discoveries) parts.push(sources.discoveries, separator);
    parts.push(version);
    return fnv1a128(...parts);
}

export function bakeSources(mapId: string, sources: MapSources): BakeResult {
    const spec = GRIDS[mapId];
    if (!spec) throw new Error(`no grid for map ${mapId}`);
    const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const roads = parseRoadNetwork(decode(sources.roads));
    if (!roads.ok) throw new Error(`roads.json:\n  ${roads.errors.join('\n  ')}`);
    const map = parseMapFile(decode(sources.map));
    if (!map.ok) throw new Error(`map.json:\n  ${map.errors.join('\n  ')}`);
    const zones = parseZonesFile(decode(sources.zones));
    if (!zones.ok) throw new Error(`zones.json:\n  ${zones.errors.join('\n  ')}`);
    const base = parseBaseTerrain(decode(sources.base));
    const pois = sources.pois ? parsePoisFile(decode(sources.pois)) : undefined;
    if (pois && !pois.ok) throw new Error(`pois.json:\n  ${pois.errors.join('\n  ')}`);
    const discoveries = sources.discoveries ? parseDiscoveriesFile(decode(sources.discoveries)) : undefined;
    if (discoveries && !discoveries.ok) throw new Error(`discoveries.json:\n  ${discoveries.errors.join('\n  ')}`);
    return bakeTerrain({
        roads: roads.value,
        map: map.value,
        zones: zones.value,
        base,
        pois: pois?.value,
        discoveries: discoveries?.value,
        spec,
        sourceHash: sourceHash(sources)
    });
}
