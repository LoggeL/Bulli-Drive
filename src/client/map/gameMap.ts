import { BULLI_BAY_GRID, decodeHeightfield, HeightfieldFormatError, type Heightfield } from '../../shared/map/heightfield.js';
import { createMapData, type MapData } from '../../shared/map/mapData.js';
import { parseMapSources } from '../../shared/map/mapSources.js';
import { trackDef } from '../../shared/race/tracks/index.js';
import type { TrackDef, TrackId } from '../../shared/race/types.js';
import mapFile from '../../shared/maps/bulli-bay/map.json';
import pois from '../../shared/maps/bulli-bay/pois.json';
import roads from '../../shared/maps/bulli-bay/roads.json';
import tracks from '../../shared/maps/bulli-bay/tracks.json';
import zones from '../../shared/maps/bulli-bay/zones.json';
import { reloadOnce } from '../network/reloadOnce.js';

// The map the game is played on (docs/phase-3-design.md, 14 M3): the JSON
// sources come with the bundle, the baked terrain.bhf is downloaded (by its
// content hash from the map's manifest, so the browser and the CDN may keep
// it). The client builds the same MapData as the server from the same bytes
// and compares the world hash in 'roomState' (network/websocket.ts).

export const GAME_MAP_ID = 'bulli-bay';

interface MapManifest {
    mapVersion?: number;
    files: { terrain: { path: string; hash: string } };
}

/**
 * The server serves another version of the map than the one this page
 * bundles (a deploy with a new mapVersion under way or done, the page from
 * before it): every retry would fail the same, only a reload helps.
 */
export class MapVersionError extends Error {
    constructor(readonly served: string) {
        super(`the server's map is version ${served}, this page has ${mapFile.mapVersion}`);
        this.name = 'MapVersionError';
    }
}

const MAP_RELOAD_KEY = 'bulli-map-reload';

/** Reloads the page once per served map version after a MapVersionError; true while it reloads. */
export function reloadForMap(error: unknown): boolean {
    return error instanceof MapVersionError && reloadOnce(MAP_RELOAD_KEY, error.served);
}

let current: MapData | null = null;
let loading: Promise<MapData> | null = null;

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
}

async function load(): Promise<MapData> {
    const base = `/maps/${GAME_MAP_ID}`;
    const manifest = await (await fetchOk(`${base}/manifest.json`, { cache: 'no-cache' })).json() as MapManifest;
    if (manifest.mapVersion !== undefined && manifest.mapVersion !== mapFile.mapVersion) throw new MapVersionError(String(manifest.mapVersion));
    const terrain = manifest.files.terrain;
    const bytes = new Uint8Array(await (await fetchOk(`${base}/${terrain.path}?v=${terrain.hash}`)).arrayBuffer());
    let hf: Heightfield;
    try {
        hf = decodeHeightfield(bytes, BULLI_BAY_GRID);
    } catch (error) {
        // A terrain in a format or on a grid this page does not know
        if (error instanceof HeightfieldFormatError) throw new MapVersionError(`terrain ${terrain.hash}`);
        throw error;
    }
    if (hf.mapVersion !== mapFile.mapVersion) throw new MapVersionError(String(hf.mapVersion));
    const sources = parseMapSources({ roads, map: mapFile, zones, pois, tracks });
    current = createMapData(sources, hf);
    return current;
}

/** Loads the map once (later calls share the first load); a failed load may be retried. */
export function loadGameMap(): Promise<MapData> {
    if (!loading) {
        loading = load().catch(error => {
            loading = null;
            throw error;
        });
    }
    return loading;
}

/** The map once it is loaded, else null. */
export function gameMap(): MapData | null {
    return current;
}

/** Uses a map built elsewhere (the unit tests build it from the files). */
export function setGameMap(map: MapData | null): void {
    current = map;
}

/** A track of the loaded map (race UI, model and client). */
export function gameTrack(id: TrackId): TrackDef {
    if (!current) throw new Error(`track ${id} asked for before the map was loaded`);
    return trackDef(current, id);
}
