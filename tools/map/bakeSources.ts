// The bake of a map from the bytes of its source files, without file access:
// tools/map/bake.ts reads the files from disk, the worldviewer's bake worker
// (tools/worldviewer) passes the sources it edits. Both hash and bake the
// same bytes the same way, so a worldviewer bake of an exported roads.json
// carries the sourceHash the CLI bake gives it.

import { BULLI_BAY_GRID, type GridSpec } from '../../src/shared/map/heightfield.js';
import { parseMapFile, parseZonesFile } from '../../src/shared/map/mapFiles.js';
import { parseRoadNetwork } from '../../src/shared/map/roadSchema.js';
import { parseBaseTerrain } from './baseTerrain.js';
import { BAKE_VERSION, bakeTerrain, type BakeResult } from './bakeTerrain.js';
import { fnv1a128 } from './hash.js';

export const GRIDS: Record<string, GridSpec> = { 'bulli-bay': BULLI_BAY_GRID };

// The sources the bake reads. pois.json and tracks.json do not shape the
// terrain and are not part of the hash.
export interface MapSources { roads: Uint8Array; map: Uint8Array; zones: Uint8Array; base: Uint8Array }

// FNV-1a-128 over the sources and the bake version (6.1, A13)
export function sourceHash(sources: MapSources): Uint8Array {
    const separator = new Uint8Array([0]);
    const version = new TextEncoder().encode(`bake-version:${BAKE_VERSION}`);
    return fnv1a128(sources.roads, separator, sources.map, separator, sources.zones, separator,
        sources.base, separator, version);
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
    return bakeTerrain({
        roads: roads.value, map: map.value, zones: zones.value, base, spec, sourceHash: sourceHash(sources)
    });
}
