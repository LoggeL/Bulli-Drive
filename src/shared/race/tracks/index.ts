// The race tracks of the map (docs/phase-3-design.md, 13, E11): the routes
// of tracks.json turned into TrackDefs by routeToTrack. Downtown Loop and
// Ridge Climb ("hill-sprint") are the ports of the phase 2 tracks and keep
// their IDs; the other routes join TRACK_IDS with M5. Built once per map.

import type { MapData } from '../../map/mapData.js';
import { routeToTrack } from '../../map/routeToTrack.js';
import { resolveRoute } from '../../map/trackRoute.js';
import { TRACK_IDS, type TrackDef, type TrackId } from '../types.js';

export { TRACK_IDS };

const cache = new WeakMap<MapData, Readonly<Record<TrackId, TrackDef>>>();

/** The map's tracks by ID; throws if a route of tracks.json does not resolve. */
export function mapTracks(map: MapData): Readonly<Record<TrackId, TrackDef>> {
    let tracks = cache.get(map);
    if (tracks) return tracks;
    const built = {} as Record<TrackId, TrackDef>;
    for (const id of TRACK_IDS) {
        const route = map.sources.tracks.tracks.find(track => track.id === id);
        if (!route) throw new Error(`tracks.json has no route for ${id}`);
        const resolved = resolveRoute(map.net, route);
        if (!resolved.ok) throw new Error(`track ${id}:\n  ${resolved.errors.join('\n  ')}`);
        const { bonus: _bonus, ...def } = routeToTrack(map.net, resolved.route, map.mapVersion);
        built[id] = { ...def, id };
    }
    tracks = built;
    cache.set(map, tracks);
    return tracks;
}

export function trackDef(map: MapData, id: TrackId): TrackDef {
    return mapTracks(map)[id];
}

export const TRACK_ROTATION: readonly TrackId[] = TRACK_IDS;

/** The track after id in the rotation. */
export function nextTrack(id: TrackId): TrackId {
    const index = TRACK_ROTATION.indexOf(id);
    return TRACK_ROTATION[(index + 1) % TRACK_ROTATION.length];
}

export function isTrackId(value: unknown): value is TrackId {
    return typeof value === 'string' && (TRACK_IDS as readonly string[]).includes(value);
}
