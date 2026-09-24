// The tracks of phase 2 and the order "next track" goes through (E10)

import { TRACK_IDS, type TrackDef, type TrackId } from '../types.js';
import { DOWNTOWN_LOOP } from './downtownLoop.js';
import { HILL_SPRINT } from './hillSprint.js';

export { DOWNTOWN_LOOP, HILL_SPRINT, TRACK_IDS };

export const TRACKS: Readonly<Record<TrackId, TrackDef>> = {
    'downtown-loop': DOWNTOWN_LOOP,
    'hill-sprint': HILL_SPRINT
};

export const TRACK_ROTATION: readonly TrackId[] = TRACK_IDS;

/** The track after id in the rotation. */
export function nextTrack(id: TrackId): TrackId {
    const index = TRACK_ROTATION.indexOf(id);
    return TRACK_ROTATION[(index + 1) % TRACK_ROTATION.length];
}

export function isTrackId(value: unknown): value is TrackId {
    return typeof value === 'string' && (TRACK_IDS as readonly string[]).includes(value);
}
