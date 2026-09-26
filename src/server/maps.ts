import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BULLI_BAY_GRID, decodeHeightfield, type GridSpec } from '../shared/map/heightfield.js';
import { createMapData, type MapData } from '../shared/map/mapData.js';
import { MAP_SOURCE_FILES, parseMapSources, type MapSources, type RawMapSources } from '../shared/map/mapSources.js';

// The immutable map data, built once per map and process and shared by
// every room (docs/phase-1b-design.md, 2.1; docs/phase-3-design.md, 14 M3).
// Rooms copy the items they change. The sources are the JSON files under
// src/shared/maps/<map>/, the ground the baked terrain.bhf the client
// downloads: in production both lie next to the built client (dist/client),
// in dev and in the tests under src/ and public/.

export const DEFAULT_MAP_ID = 'bulli-bay';
const GRIDS: Record<string, GridSpec> = { 'bulli-bay': BULLI_BAY_GRID };

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server -> dist/client; src/server -> repository root
const ROOTS = [path.resolve(here, '..'), path.resolve(here, '../..')];

function findFile(candidates: string[]): string {
    for (const file of candidates) if (fs.existsSync(file)) return file;
    throw new Error(`map file not found, tried:\n  ${candidates.join('\n  ')}`);
}

/** The path of a map's terrain.bhf (the client's URL is /maps/<map>/terrain.bhf). */
export function terrainPath(mapId: string): string {
    return findFile(ROOTS.flatMap(root => [
        path.join(root, 'client', 'maps', mapId, 'terrain.bhf'),
        path.join(root, 'public', 'maps', mapId, 'terrain.bhf')
    ]));
}

function sourcePath(mapId: string, file: string): string {
    return findFile(ROOTS.flatMap(root => [
        path.join(root, 'client', 'maps', mapId, file),
        path.join(root, 'src', 'shared', 'maps', mapId, file),
        path.join(root, 'shared', 'maps', mapId, file)
    ]));
}

export function readMapSources(mapId: string): MapSources {
    const raw = {} as RawMapSources;
    for (const [key, file] of Object.entries(MAP_SOURCE_FILES) as [keyof MapSources, string][]) {
        raw[key] = JSON.parse(fs.readFileSync(sourcePath(mapId, file), 'utf8')) as unknown;
    }
    return parseMapSources(raw);
}

export function loadMap(mapId: string = DEFAULT_MAP_ID): MapData {
    const grid = GRIDS[mapId];
    if (!grid) throw new Error(`unknown map ${mapId}`);
    const hf = decodeHeightfield(new Uint8Array(fs.readFileSync(terrainPath(mapId))), grid);
    return createMapData(readMapSources(mapId), hf);
}

const maps = new Map<string, MapData>();

export function mapFor(mapId: string = DEFAULT_MAP_ID): MapData {
    let map = maps.get(mapId);
    if (!map) {
        map = loadMap(mapId);
        maps.set(mapId, map);
    }
    return map;
}
