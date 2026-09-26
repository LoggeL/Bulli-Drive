// The JSON sources of a curated map as the game loads them
// (docs/phase-3-design.md, 5.1 and A13): roads.json, map.json, zones.json,
// pois.json and tracks.json, each checked by its schema. The server reads
// them from src/shared/maps/<map>/, the client bundles them; both hand the
// parsed values and the baked heightfield to createMapData (mapData.ts).
// base.json only shapes the bake and is not needed at runtime.

import { parseMapFile, parsePoisFile, parseTracksFile, parseZonesFile, type MapFile, type PoisFile, type TracksFile, type ZonesFile } from './mapFiles.js';
import { parseRoadNetwork, type ParseResult, type RoadNetworkFile } from './roadSchema.js';

export interface MapSources {
    roads: RoadNetworkFile;
    map: MapFile;
    zones: ZonesFile;
    pois: PoisFile;
    tracks: TracksFile;
}

export type RawMapSources = Record<keyof MapSources, unknown>;

export const MAP_SOURCE_FILES: Record<keyof MapSources, string> = {
    roads: 'roads.json',
    map: 'map.json',
    zones: 'zones.json',
    pois: 'pois.json',
    tracks: 'tracks.json'
};

/** Parses the sources; throws with every problem of every file. */
export function parseMapSources(raw: RawMapSources): MapSources {
    const errors: string[] = [];
    const take = <T>(name: keyof MapSources, result: ParseResult<T>): T => {
        if (!result.ok) {
            errors.push(...result.errors.map(error => `${MAP_SOURCE_FILES[name]}: ${error}`));
            return null as T;
        }
        return result.value;
    };
    const sources: MapSources = {
        roads: take('roads', parseRoadNetwork(raw.roads)),
        map: take('map', parseMapFile(raw.map)),
        zones: take('zones', parseZonesFile(raw.zones)),
        pois: take('pois', parsePoisFile(raw.pois)),
        tracks: take('tracks', parseTracksFile(raw.tracks))
    };
    if (errors.length) throw new Error(`invalid map sources:\n  ${errors.join('\n  ')}`);
    const ids = new Set(Object.values(sources).map(file => (file as { mapId: string }).mapId));
    if (ids.size !== 1) throw new Error(`the map sources name different maps: ${[...ids].join(', ')}`);
    return sources;
}
