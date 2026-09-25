import { BULLI_BAY_GRID, decodeHeightfield } from '../../shared/map/heightfield.js';
import { createMapData, type MapData } from '../../shared/map/mapData.js';
import { parseMapSources } from '../../shared/map/mapSources.js';
import { trackDef } from '../../shared/race/tracks/index.js';
import type { TrackDef, TrackId } from '../../shared/race/types.js';
import mapFile from '../../shared/maps/bulli-bay/map.json';
import pois from '../../shared/maps/bulli-bay/pois.json';
import roads from '../../shared/maps/bulli-bay/roads.json';
import tracks from '../../shared/maps/bulli-bay/tracks.json';
import zones from '../../shared/maps/bulli-bay/zones.json';

// The map the game is played on (docs/phase-3-design.md, 14 M3): the JSON
// sources come with the bundle, the baked terrain.bhf is downloaded (by its
// content hash from the map's manifest, so the browser and the CDN may keep
// it). The client builds the same MapData as the server from the same bytes
// and compares the world hash in 'roomState' (network/websocket.ts).

export const GAME_MAP_ID = 'bulli-bay';

interface MapManifest {
    files: { terrain: { path: string; hash: string } };
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
    const terrain = manifest.files.terrain;
    const bytes = new Uint8Array(await (await fetchOk(`${base}/${terrain.path}?v=${terrain.hash}`)).arrayBuffer());
    const hf = decodeHeightfield(bytes, BULLI_BAY_GRID);
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
