// Loads a map's sources and its baked terrain for the tools (validation,
// preview): the JSON files through their schemas, the road network and
// public/maps/<map>/terrain.bhf. Node only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHeightfield } from '../../src/shared/map/heightfield.js';
import { parseMapFile, parsePoisFile, parseTracksFile, parseZonesFile } from '../../src/shared/map/mapFiles.js';
import { buildRoadNetwork } from '../../src/shared/map/roadNetwork.js';
import { parseRoadNetwork, type ParseResult, type RoadNetworkFile } from '../../src/shared/map/roadSchema.js';
import { GRIDS } from './bakeSources.js';
import type { MapBundle } from './validateMap.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export { GRIDS };

function load<T>(dir: string, name: string, parse: (value: unknown) => ParseResult<T>): T {
    const result = parse(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as unknown);
    if (!result.ok) throw new Error(`${name}:\n  ${result.errors.join('\n  ')}`);
    return result.value;
}

export interface LoadedMap extends MapBundle {
    roads: RoadNetworkFile;
}

export function loadMapBundle(mapId: string, terrainPath?: string): LoadedMap {
    const spec = GRIDS[mapId];
    if (!spec) throw new Error(`no grid for map ${mapId}`);
    const dir = path.join(ROOT, 'src/shared/maps', mapId);
    const roads = load(dir, 'roads.json', parseRoadNetwork);
    const bytes = readFileSync(terrainPath ?? path.join(ROOT, 'public/maps', mapId, 'terrain.bhf'));
    return {
        roads,
        net: buildRoadNetwork(roads),
        map: load(dir, 'map.json', parseMapFile),
        zones: load(dir, 'zones.json', parseZonesFile),
        pois: load(dir, 'pois.json', parsePoisFile),
        tracks: load(dir, 'tracks.json', parseTracksFile),
        hf: decodeHeightfield(new Uint8Array(bytes), spec)
    };
}
