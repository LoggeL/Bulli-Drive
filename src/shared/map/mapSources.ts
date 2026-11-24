// The JSON sources of a curated map as the game loads them
// (docs/phase-3-design.md, 5.1 and A13): roads.json, map.json, zones.json,
// pois.json, tracks.json, and optional discoveries.json, each checked by its
// schema. The server reads them from src/shared/maps/<map>/, the client bundles
// or lazy-imports them; both hand the parsed values and the baked heightfield
// to createMapData (mapData.ts). base.json only shapes the bake.

import { parseDiscoveriesFile, type DiscoveriesFile } from './discoverySchema.js';
import { parseMapFile, parsePoisFile, parseTracksFile, parseZonesFile, type MapFile, type PoisFile, type TracksFile, type ZonesFile } from './mapFiles.js';
import { parseRoadNetwork, type ParseResult, type RoadNetworkFile } from './roadSchema.js';

export interface MapSources {
    roads: RoadNetworkFile;
    map: MapFile;
    zones: ZonesFile;
    pois: PoisFile;
    tracks: TracksFile;
    discoveries?: DiscoveriesFile;
}

export type RequiredMapSourceKey = 'roads' | 'map' | 'zones' | 'pois' | 'tracks';

export type RawMapSources = Record<RequiredMapSourceKey, unknown> & {
    discoveries?: unknown;
};

export const MAP_SOURCE_FILES: Record<RequiredMapSourceKey, string> = {
    roads: 'roads.json',
    map: 'map.json',
    zones: 'zones.json',
    pois: 'pois.json',
    tracks: 'tracks.json'
};

export const MAP_OPTIONAL_SOURCE_FILES = {
    discoveries: 'discoveries.json'
} as const;

/** Parses the sources; throws with every problem of every file. */
export function parseMapSources(raw: RawMapSources): MapSources {
    const errors: string[] = [];
    const take = <T>(fileName: string, result: ParseResult<T>): T => {
        if (!result.ok) {
            errors.push(...result.errors.map(error => `${fileName}: ${error}`));
            return null as T;
        }
        return result.value;
    };
    const sources: MapSources = {
        roads: take(MAP_SOURCE_FILES.roads, parseRoadNetwork(raw.roads)),
        map: take(MAP_SOURCE_FILES.map, parseMapFile(raw.map)),
        zones: take(MAP_SOURCE_FILES.zones, parseZonesFile(raw.zones)),
        pois: take(MAP_SOURCE_FILES.pois, parsePoisFile(raw.pois)),
        tracks: take(MAP_SOURCE_FILES.tracks, parseTracksFile(raw.tracks))
    };
    if (raw.discoveries !== undefined) {
        sources.discoveries = take(MAP_OPTIONAL_SOURCE_FILES.discoveries, parseDiscoveriesFile(raw.discoveries));
    }
    if (errors.length) throw new Error(`invalid map sources:\n  ${errors.join('\n  ')}`);
    const ids = new Set(
        Object.values(sources)
            .filter((file): file is { mapId: string } => file !== undefined)
            .map(file => file.mapId)
    );
    if (ids.size !== 1) throw new Error(`the map sources name different maps: ${[...ids].join(', ')}`);
    return sources;
}
