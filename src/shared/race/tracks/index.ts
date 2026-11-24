// The race tracks of any curated map (docs/phase-3-design.md, 13, E11):
// turns every route declared in the map's tracks.json into a TrackDef via
// routeToTrack, cached once per MapData instance. Multi-map aware: each map
// defines its own track roster (Bulli Bay keeps its original 6 IDs intact).

import type { MapData } from '../../map/mapData.js';
import { routeToTrack } from '../../map/routeToTrack.js';
import { resolveRoute } from '../../map/trackRoute.js';
import { ALL_TRACK_IDS, MAP_TRACK_IDS, TRACK_IDS, type TrackDef, type TrackId } from '../types.js';

export { ALL_TRACK_IDS, MAP_TRACK_IDS, TRACK_IDS };

const cache = new WeakMap<MapData, Readonly<Record<string, TrackDef>>>();
const idCache = new WeakMap<MapData, readonly TrackId[]>();

/**
 * The map's tracks by ID. Builds every route in `map.sources.tracks.tracks`,
 * validates that any registered required track IDs for `map.mapId` are present,
 * and throws if any route fails to resolve against the road network.
 */
export function mapTracks(map: MapData): Readonly<Record<string, TrackDef>> {
    let tracks = cache.get(map);
    if (tracks) return tracks;

    const routes = map.sources.tracks.tracks;
    const expected = MAP_TRACK_IDS[map.mapId];
    if (expected) {
        for (const id of expected) {
            if (!routes.some(track => track.id === id)) {
                throw new Error(`tracks.json has no route for ${id}`);
            }
        }
    }

    const built: Record<string, TrackDef> = {};
    const ordered: TrackId[] = [];
    for (const route of routes) {
        const resolved = resolveRoute(map.net, route);
        if (!resolved.ok) throw new Error(`track ${route.id}:\n  ${resolved.errors.join('\n  ')}`);
        const { bonus: _bonus, ...def } = routeToTrack(map.net, resolved.route, map.mapVersion);
        const id = route.id as TrackId;
        built[id] = { ...def, id };
        ordered.push(id);
    }

    tracks = built;
    cache.set(map, tracks);
    idCache.set(map, ordered);
    return tracks;
}

/** Ordered track IDs defined on the given map. */
export function trackIdsForMap(map: MapData): readonly TrackId[] {
    mapTracks(map);
    return idCache.get(map) ?? [];
}

/** Looks up a track by ID on `map`; throws if the map has no such track. */
export function trackDef(map: MapData, id: TrackId): TrackDef {
    const def = mapTracks(map)[id];
    if (!def) throw new Error(`map ${map.mapId} has no track ${id}`);
    return def;
}

export const TRACK_ROTATION: readonly TrackId[] = TRACK_IDS;

/** The track after `id` in the map's track rotation (or the map containing `id`). */
export function nextTrack(id: TrackId, map?: MapData): TrackId {
    let rotation: readonly TrackId[];
    if (map) {
        rotation = trackIdsForMap(map);
    } else {
        const group = Object.values(MAP_TRACK_IDS).find(list => list.includes(id));
        rotation = group ?? TRACK_ROTATION;
    }
    const index = rotation.indexOf(id);
    if (index < 0) return rotation[0];
    return rotation[(index + 1) % rotation.length];
}

export function isTrackId(value: unknown): value is TrackId {
    return typeof value === 'string' && (ALL_TRACK_IDS as readonly string[]).includes(value);
}
