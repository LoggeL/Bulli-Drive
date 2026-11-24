import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHeightfield } from '../shared/map/heightfield.js';
import { createMapData, type MapData } from '../shared/map/mapData.js';
import {
    MAP_OPTIONAL_SOURCE_FILES, MAP_SOURCE_FILES, parseMapSources,
    type MapSources, type RawMapSources, type RequiredMapSourceKey
} from '../shared/map/mapSources.js';
import { DEFAULT_MAP_ID, isMapId, MAP_GRIDS, type MapId } from '../shared/map/registry.js';

// The immutable map data, built lazily once per map and process and shared by
// every room on that map (docs/phase-1b-design.md, 2.1; docs/phase-3-design.md, 14 M3).
// Rooms copy the items they change. The sources are the JSON files under
// src/shared/maps/<map>/, the ground the baked terrain.bhf the client
// downloads: in production both lie next to the built client (dist/client and
// dist/shared), in dev and in the tests under src/ and public/.

export { DEFAULT_MAP_ID, type MapId };

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server -> dist/client; src/server -> repository root
const ROOTS = [path.resolve(here, '..'), path.resolve(here, '../..')];

function findFileOptional(candidates: string[]): string | null {
    for (const file of candidates) if (fs.existsSync(file)) return file;
    return null;
}

function findFile(candidates: string[]): string {
    const found = findFileOptional(candidates);
    if (found) return found;
    throw new Error(`map file not found, tried:\n  ${candidates.join('\n  ')}`);
}

/** The path of a map's terrain.bhf (the client's URL is /maps/<map>/terrain.bhf). */
export function terrainPath(mapId: string): string {
    return findFile(ROOTS.flatMap(root => [
        path.join(root, 'client', 'maps', mapId, 'terrain.bhf'),
        path.join(root, 'public', 'maps', mapId, 'terrain.bhf')
    ]));
}

function sourceCandidates(mapId: string, file: string): string[] {
    return ROOTS.flatMap(root => [
        path.join(root, 'client', 'maps', mapId, file),
        path.join(root, 'src', 'shared', 'maps', mapId, file),
        path.join(root, 'shared', 'maps', mapId, file)
    ]);
}

function sourcePath(mapId: string, file: string): string {
    return findFile(sourceCandidates(mapId, file));
}

export function readMapSources(mapId: string): MapSources {
    const raw = {} as RawMapSources;
    for (const [key, file] of Object.entries(MAP_SOURCE_FILES) as [RequiredMapSourceKey, string][]) {
        raw[key] = JSON.parse(fs.readFileSync(sourcePath(mapId, file), 'utf8')) as unknown;
    }
    const discoveriesFile = findFileOptional(sourceCandidates(mapId, MAP_OPTIONAL_SOURCE_FILES.discoveries));
    if (discoveriesFile) {
        raw.discoveries = JSON.parse(fs.readFileSync(discoveriesFile, 'utf8')) as unknown;
    }
    return parseMapSources(raw);
}

export function loadMap(mapId: string = DEFAULT_MAP_ID): MapData {
    if (!isMapId(mapId)) throw new Error(`unknown map ${mapId}`);
    const grid = MAP_GRIDS[mapId];
    const hf = decodeHeightfield(new Uint8Array(fs.readFileSync(terrainPath(mapId))), grid);
    return createMapData(readMapSources(mapId), hf);
}

const maps = new Map<MapId, MapData>();

/** Returns the cached MapData for any registered map ID, lazily loading on first access. */
export function mapFor(mapId: string = DEFAULT_MAP_ID): MapData {
    if (!isMapId(mapId)) throw new Error(`unknown map ${mapId}`);
    let map = maps.get(mapId);
    if (!map) {
        map = loadMap(mapId);
        maps.set(mapId, map);
    }
    return map;
}

/** Map IDs currently built and cached in this process. */
export function loadedMapIds(): MapId[] {
    return [...maps.keys()];
}
