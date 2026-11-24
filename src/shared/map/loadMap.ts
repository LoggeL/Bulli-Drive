// Isomorphic multi-map loader shared by browser client, Node server, and tests.
// Uses explicit per-map dynamic imports so Vite code-splits unselected maps
// instead of bundling every map's JSON into the initial entry chunk.

import { decodeHeightfield } from './heightfield.js';
import { createMapData, type MapData } from './mapData.js';
import { parseMapSources, type MapSources, type RawMapSources } from './mapSources.js';
import { MAP_GRIDS, type MapId } from './registry.js';

export interface MapManifestJson {
    mapId: string;
    mapVersion?: number;
    files: {
        terrain: {
            path: string;
            hash: string;
        };
    };
}

/**
 * Lazily imports and parses the JSON sources for any registered map ID.
 * Each branch uses static import specifiers so Vite splits maps into separate chunks.
 */
export async function importMapSources(mapId: MapId): Promise<MapSources> {
    let raw: RawMapSources;
    switch (mapId) {
        case 'bulli-bay': {
            const [roads, map, zones, pois, tracks, discoveries] = await Promise.all([
                import('../maps/bulli-bay/roads.json'),
                import('../maps/bulli-bay/map.json'),
                import('../maps/bulli-bay/zones.json'),
                import('../maps/bulli-bay/pois.json'),
                import('../maps/bulli-bay/tracks.json'),
                import('../maps/bulli-bay/discoveries.json')
            ]);
            raw = {
                roads: roads.default, map: map.default, zones: zones.default,
                pois: pois.default, tracks: tracks.default, discoveries: discoveries.default
            };
            break;
        }
        case 'alpen-pass': {
            const [roads, map, zones, pois, tracks, discoveries] = await Promise.all([
                import('../maps/alpen-pass/roads.json'),
                import('../maps/alpen-pass/map.json'),
                import('../maps/alpen-pass/zones.json'),
                import('../maps/alpen-pass/pois.json'),
                import('../maps/alpen-pass/tracks.json'),
                import('../maps/alpen-pass/discoveries.json')
            ]);
            raw = {
                roads: roads.default, map: map.default, zones: zones.default,
                pois: pois.default, tracks: tracks.default, discoveries: discoveries.default
            };
            break;
        }
        case 'stunt-forge': {
            const [roads, map, zones, pois, tracks, discoveries] = await Promise.all([
                import('../maps/stunt-forge/roads.json'),
                import('../maps/stunt-forge/map.json'),
                import('../maps/stunt-forge/zones.json'),
                import('../maps/stunt-forge/pois.json'),
                import('../maps/stunt-forge/tracks.json'),
                import('../maps/stunt-forge/discoveries.json')
            ]);
            raw = {
                roads: roads.default, map: map.default, zones: zones.default,
                pois: pois.default, tracks: tracks.default, discoveries: discoveries.default
            };
            break;
        }
        case 'logge-forge': {
            const [roads, map, zones, pois, tracks, discoveries] = await Promise.all([
                import('../maps/logge-forge/roads.json'),
                import('../maps/logge-forge/map.json'),
                import('../maps/logge-forge/zones.json'),
                import('../maps/logge-forge/pois.json'),
                import('../maps/logge-forge/tracks.json'),
                import('../maps/logge-forge/discoveries.json')
            ]);
            raw = {
                roads: roads.default, map: map.default, zones: zones.default,
                pois: pois.default, tracks: tracks.default, discoveries: discoveries.default
            };
            break;
        }
    }
    return parseMapSources(raw);
}

/** Pure builder: parses raw JSON sources and decodes terrain.bhf bytes into MapData. */
export function buildMapFromRaw(mapId: MapId, raw: RawMapSources, terrainBytes: Uint8Array): MapData {
    const sources = parseMapSources(raw);
    const hf = decodeHeightfield(terrainBytes, MAP_GRIDS[mapId]);
    return createMapData(sources, hf);
}

/** Fetches manifest + terrain.bhf over HTTP and builds MapData for any registered map ID. */
export async function fetchMapData(
    mapId: MapId,
    options?: { fetchFn?: typeof fetch; baseUrl?: string }
): Promise<MapData> {
    const fetchFn = options?.fetchFn ?? globalThis.fetch;
    const base = `${options?.baseUrl ?? ''}/maps/${mapId}`;
    const [sources, manifestRes] = await Promise.all([
        importMapSources(mapId),
        fetchFn(`${base}/manifest.json`, { cache: 'no-cache' })
    ]);
    if (!manifestRes.ok) throw new Error(`${base}/manifest.json: HTTP ${manifestRes.status}`);
    const manifest = await manifestRes.json() as MapManifestJson;
    const terrain = manifest.files.terrain;
    const terrainRes = await fetchFn(`${base}/${terrain.path}?v=${terrain.hash}`);
    if (!terrainRes.ok) throw new Error(`${base}/${terrain.path}: HTTP ${terrainRes.status}`);
    const bytes = new Uint8Array(await terrainRes.arrayBuffer());
    const hf = decodeHeightfield(bytes, MAP_GRIDS[mapId]);
    return createMapData(sources, hf);
}
