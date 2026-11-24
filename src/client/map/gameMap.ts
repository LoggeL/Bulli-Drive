import { decodeHeightfield, HeightfieldFormatError, type Heightfield } from '../../shared/map/heightfield.js';
import { importMapSources, type MapManifestJson } from '../../shared/map/loadMap.js';
import { createMapData, type MapData } from '../../shared/map/mapData.js';
import { DEFAULT_MAP_ID, isMapId, MAP_GRIDS, type MapId } from '../../shared/map/registry.js';
import { trackDef } from '../../shared/race/tracks/index.js';
import type { TrackDef, TrackId } from '../../shared/race/types.js';
import { reloadOnce } from '../network/reloadOnce.js';

// Multi-map client loader & cache: JSON sources are code-split per map via
// importMapSources (shared/map/loadMap.ts) and the baked terrain.bhf is fetched
// by its content hash from /maps/<mapId>/manifest.json. The client builds the
// exact same MapData & worldHash as the server and compares them in roomState.

export const GAME_MAP_ID: MapId = DEFAULT_MAP_ID;

/**
 * The server serves another version of the map than the one this page
 * bundles (a deploy with a new mapVersion under way or done, the page from
 * before it): every retry would fail the same, only a reload helps.
 */
export class MapVersionError extends Error {
    constructor(readonly served: string, readonly expected?: number) {
        super(`the server's map is version ${served}, this page has ${expected ?? 'another version'}`);
        this.name = 'MapVersionError';
    }
}

const MAP_RELOAD_KEY = 'bulli-map-reload';

/** Reloads the page once per served map version after a MapVersionError; true while it reloads. */
export function reloadForMap(error: unknown): boolean {
    return error instanceof MapVersionError && reloadOnce(MAP_RELOAD_KEY, error.served);
}

const loadedMaps = new Map<MapId, MapData>();
const loadingMaps = new Map<MapId, Promise<MapData>>();
let current: MapData | null = null;

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
}

async function load(mapId: MapId): Promise<MapData> {
    const base = `/maps/${mapId}`;
    const [sources, manifestRes] = await Promise.all([
        importMapSources(mapId),
        fetchOk(`${base}/manifest.json`, { cache: 'no-cache' })
    ]);
    const manifest = await manifestRes.json() as MapManifestJson;
    const expectedVersion = sources.map.mapVersion;
    if (manifest.mapVersion !== undefined && manifest.mapVersion !== expectedVersion) {
        throw new MapVersionError(String(manifest.mapVersion), expectedVersion);
    }
    const terrain = manifest.files.terrain;
    const bytes = new Uint8Array(await (await fetchOk(`${base}/${terrain.path}?v=${terrain.hash}`)).arrayBuffer());
    let hf: Heightfield;
    try {
        hf = decodeHeightfield(bytes, MAP_GRIDS[mapId]);
    } catch (error) {
        // A terrain in a format or on a grid this page does not know
        if (error instanceof HeightfieldFormatError) throw new MapVersionError(`terrain ${terrain.hash}`, expectedVersion);
        throw error;
    }
    if (hf.mapVersion !== expectedVersion) throw new MapVersionError(String(hf.mapVersion), expectedVersion);
    const built = createMapData(sources, hf);
    loadedMaps.set(mapId, built);
    if (!current || current.mapId === mapId) current = built;
    return built;
}

/**
 * Loads and caches a registered map (later calls share the in-flight or cached
 * result); a failed load may be retried. Defaults to Bulli Bay.
 */
export function loadGameMap(mapId: MapId = DEFAULT_MAP_ID): Promise<MapData> {
    const target: MapId = isMapId(mapId) ? mapId : DEFAULT_MAP_ID;
    const cached = loadedMaps.get(target);
    if (cached) return Promise.resolve(cached);
    let inflight = loadingMaps.get(target);
    if (!inflight) {
        inflight = load(target).catch(error => {
            loadingMaps.delete(target);
            throw error;
        });
        loadingMaps.set(target, inflight);
    }
    return inflight;
}

/** Returns the cached MapData for a map ID if already loaded, else null. */
export function cachedGameMap(mapId: MapId): MapData | null {
    return loadedMaps.get(mapId) ?? null;
}

/** The active map once loaded, else null. */
export function gameMap(): MapData | null {
    return current;
}

/** Sets the active map (used on live map swaps and in unit tests). */
export function setGameMap(map: MapData | null): void {
    current = map;
    if (map && isMapId(map.mapId)) {
        loadedMaps.set(map.mapId, map);
    }
}

/** Clears cached maps (test helper). */
export function clearGameMapCache(): void {
    loadedMaps.clear();
    loadingMaps.clear();
    current = null;
}

/** A track of the active map (race UI, model and client). */
export function gameTrack(id: TrackId): TrackDef {
    if (!current) throw new Error(`track ${id} asked for before the map was loaded`);
    return trackDef(current, id);
}
