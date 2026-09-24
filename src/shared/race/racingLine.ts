// Racing line and speed profile (docs/phase-2-design.md, 5.4). The line is
// the track's centre line with rounded corners and an out-in-out shift,
// resampled every LINE_STEP metres. Bots follow it, the standings measure
// the remaining distance along it, the wrong-way test compares against its
// tangent, the reset puts cars onto it and the minimap draws it.

import { SIM_TUNING } from '../sim/constants.js';
import type { VehicleParams } from '../sim/types.js';
import { roundCorners, samplePath, type Polyline } from './geometry.js';
import { LINE_BRAKE_MARGIN, LINE_GRIP_MARGIN, LINE_STEP } from './rules.js';
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
 * v = min(vtop, sqrt(μ_eff · g / |κ|)) with μ_eff = 0.85 · gripFront, then
 * a backward pass so the car can brake down to every later point with
 * 0.8 · brakeDecel. A closed line wraps (two passes round).
 */
export function speedProfile(line: Polyline, params: VehicleParams): Float64Array {
    const pts = line.points;
    const n = pts.length;
    const v = new Float64Array(n);
    const lateral = LINE_GRIP_MARGIN * params.gripFront * SIM_TUNING.G_TIRE;
    for (let i = 0; i < n; i++) {
        const k = Math.abs(pts[i].curvature);
        v[i] = k > 0 ? Math.min(params.topSpeed, Math.sqrt(lateral / k)) : params.topSpeed;
    }
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
