// Racing line and speed profile (docs/phase-2-design.md, 5.4). The line is
// the track's centre line with rounded corners and an out-in-out shift,
// resampled every LINE_STEP metres. Bots follow it, the standings measure
// the remaining distance along it, the wrong-way test compares against its
// tangent, the reset puts cars onto it and the minimap draws it.

import { SIM_TUNING } from '../sim/constants.js';
import { isPaved } from '../map/types.js';
import type { VehicleParams } from '../sim/types.js';
import { surfaceGrip } from '../sim/vehicle.js';
import { roundCorners, samplePath, type Polyline } from './geometry.js';
import {
    CREST_FLIGHT_TIME, CREST_LIFT_MARGIN, CREST_MAX_TURN, CREST_WINDOW, LINE_BRAKE_MARGIN, LINE_GRIP_MARGIN, LINE_STEP
} from './rules.js';
import type { TrackDef } from './types.js';

export function buildRacingLine(track: TrackDef): Polyline {
    const path = roundCorners(track.centerline, track.kind === 'circuit', track.lineOptions.radius);
    return samplePath(path, LINE_STEP, track.lineOptions.apexShift);
}

// Tracks are static data: one line per track object and process
const lines = new WeakMap<TrackDef, Polyline>();

export function racingLine(track: TrackDef): Polyline {
    let line = lines.get(track);
    if (!line) {
        line = buildRacingLine(track);
        lines.set(track, line);
    }
    return line;
}

/**
 * Target speed at every point of the line for one car class:
 * v = min(vtop, sqrt(μ_eff · g / |κ|)) with μ_eff = 0.85 · gripFront times
 * the grip of the surface under the point (when the line's surfaces are
 * known, docs/phase-3-design.md, 8.1; on unpaved ones times unpavedGrip,
 * a bot's own margin). With the terrain heights under the line, a crest
 * the car would leave the ground over while the line turns during the
 * flight is taken below lift-off (crestLimits). Then a backward pass so
 * the car can brake down to every later point with 0.8 · brakeDecel. A
 * closed line wraps (two passes round).
 */
export function speedProfile(line: Polyline, params: VehicleParams, surfaces: Uint8Array | null = null, unpavedGrip = 1,
    heights: Float64Array | null = null): Float64Array {
    const pts = line.points;
    const n = pts.length;
    const v = new Float64Array(n);
    const lateral = LINE_GRIP_MARGIN * params.gripFront * SIM_TUNING.G_TIRE;
    for (let i = 0; i < n; i++) {
        const k = Math.abs(pts[i].curvature);
        const grip = surfaces ? lateral * surfaceGrip(surfaces[i], params) * (isPaved(surfaces[i]) ? 1 : unpavedGrip) : lateral;
        v[i] = k > 0 ? Math.min(params.topSpeed, Math.sqrt(grip / k)) : params.topSpeed;
    }
    if (heights) crestLimits(line, heights, v);
    const decel2 = 2 * LINE_BRAKE_MARGIN * params.brakeDecel;
    const gap = (i: number) => (i + 1 < n ? pts[i + 1].s : line.length) - pts[i].s;
    const rounds = line.closed ? 2 : 1;
    for (let round = 0; round < rounds; round++) {
        for (let i = n - 2 + (line.closed ? 1 : 0); i >= 0; i--) {
            const next = v[(i + 1) % n];
            const reachable = Math.sqrt(next * next + decel2 * gap(i));
            if (reachable < v[i]) v[i] = reachable;
        }
    }
    return v;
}

/**
 * Vertical curvature of the terrain under each point of the line (1/m,
 * convex > 0): the second difference of the heights over ±CREST_WINDOW m.
 * A sprint's ends use the nearest full window.
 */
export function crestCurvature(line: Polyline, heights: Float64Array): Float64Array {
    const pts = line.points;
    const n = pts.length;
    const out = new Float64Array(n);
    const w = Math.max(1, Math.round(CREST_WINDOW / LINE_STEP));
    if (!line.closed && n < 2 * w + 1) return out;
    const at = (i: number) => line.closed ? ((i % n) + n) % n : i;
    // Arc length from point i to point j (j after i, possibly wrapped)
    const between = (i: number, j: number) => {
        const d = pts[at(j)].s - pts[at(i)].s;
        return d > 0 ? d : d + line.length;
    };
    for (let i = 0; i < n; i++) {
        const c = line.closed ? i : Math.min(n - 1 - w, Math.max(w, i));
        const a = at(c - w), b = at(c + w);
        const d1 = between(a, at(c)), d2 = between(at(c), b);
        out[i] = -((heights[b] - heights[at(c)]) / d2 - (heights[at(c)] - heights[a]) / d1) / ((d1 + d2) / 2);
    }
    return out;
}

// Caps v (in place) at the crests a car would leave the ground over while
// the line turns during the flight (CREST_* in rules.ts): the bots may fly,
// but not land across the road in a bend
function crestLimits(line: Polyline, heights: Float64Array, v: Float64Array): void {
    const pts = line.points;
    const n = pts.length;
    const kappa = crestCurvature(line, heights);
    const g = CREST_LIFT_MARGIN * SIM_TUNING.GRAVITY;
    for (let i = 0; i < n; i++) {
        if (kappa[i] <= 0) continue;
        const lift = Math.sqrt(g / kappa[i]);
        if (lift >= v[i]) continue;
        // How far the line turns within the flight at the planned speed
        const reach = v[i] * CREST_FLIGHT_TIME;
        let turn = 0, run = 0;
        for (let j = i; run < reach; j++) {
            if (!line.closed && j >= n - 1) break;
            const k = j % n, next = (j + 1) % n;
            const ds = next > k ? pts[next].s - pts[k].s : line.length - pts[k].s;
            turn += Math.abs(pts[k].curvature) * ds;
            run += ds;
        }
        if (turn > CREST_MAX_TURN) v[i] = lift;
    }
}
