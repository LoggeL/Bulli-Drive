// The race world (docs/phase-2-design.md, 5.6): the map plus the track's
// colliders (barriers across the side streets, chevron posts; E3), the
// reset onto the racing line and the slipstream. Client and server build
// the same world from the same shared data.

import type { VehicleState } from '../sim/types.js';
import { createSimWorld, type ColliderInput, type SimWorld } from '../world/colliders.js';
import { mapRampColliders, mapRampDefs } from '../world/mapFeatures.js';
import { canonicalStringify, fnv1a, type MapData } from '../world/mapData.js';
import { createProjection, projectGlobal, type Polyline } from './geometry.js';
import { racingLine } from './racingLine.js';
import type { TrackDef } from './types.js';

// Water barrier row: 0.6 m deep, 1.0 m high
export const BARRIER_DEPTH = 0.6;
export const BARRIER_TOP = 1.0;
// Chevron board posts: like the sign posts (colliders.ts COLLIDER_TOPS.signPost)
export const CHEVRON_POST_RADIUS = 0.35;
export const CHEVRON_POST_OFFSET = 1.2;
export const CHEVRON_POST_TOP = 3.3;

/** Colliders of the track's hints: a box per barrier row, two circles per chevron board. */
export function trackColliders(track: TrackDef): ColliderInput[] {
    const out: ColliderInput[] = [];
    for (const hint of track.hints) {
        if (hint.kind === 'barrier') {
            const quarter = hint.yaw / (Math.PI / 2);
            if (Math.abs(quarter - Math.round(quarter)) > 1e-9) throw new Error('barrier rows need a yaw along an axis');
            // The row runs along the left axis (cos yaw, -sin yaw)
            const acrossX = Math.abs(Math.round(Math.cos(hint.yaw))) === 1;
            out.push({
                kind: 'box', x: hint.x, z: hint.z,
                hw: acrossX ? hint.length / 2 : BARRIER_DEPTH / 2,
                hd: acrossX ? BARRIER_DEPTH / 2 : hint.length / 2,
                top: BARRIER_TOP
            });
        } else if (hint.kind === 'chevron') {
            const lx = Math.cos(hint.yaw), lz = -Math.sin(hint.yaw);
            for (const side of [-1, 1]) {
                out.push({
                    kind: 'circle', x: hint.x + lx * side * CHEVRON_POST_OFFSET, z: hint.z + lz * side * CHEVRON_POST_OFFSET,
                    r: CHEVRON_POST_RADIUS, top: CHEVRON_POST_TOP
                });
            }
        }
    }
    return out;
}

/**
 * The reset pose of the race world (10.3): the nearest point of the racing
 * line, facing along it. Depends only on the car's position and the track,
 * so prediction and server compute the same.
 */
export function lineResetPose(line: Polyline): (s: VehicleState) => boolean {
    const projection = createProjection();
    return (s: VehicleState) => {
        projectGlobal(line, s.x, s.z, projection);
        s.x = projection.x;
        s.z = projection.z;
        s.yaw = Math.atan2(projection.tx, projection.tz);
        return true;
    };
}

/**
 * Map + track as one sim world. Collider order: the map's (trees, rocks,
 * city), the ramp edges, then the track's. Until the map carries the ramps
 * itself (MAP_VERSION 3, step 4 of the plan) the race world adds them here.
 */
export function createRaceWorld(map: MapData, track: TrackDef): SimWorld {
    const colliders = [...map.colliders, ...mapRampColliders(map.terrain), ...trackColliders(track)];
    const world = createSimWorld(map.terrain, colliders, mapRampDefs(), null);
    world.resetPose = lineResetPose(racingLine(track));
    world.slipstream = true;
    return world;
}

/** FNV-1a over the canonical track data, like worldHash. */
export function trackHash(track: TrackDef): string {
    return fnv1a(canonicalStringify(track));
}
