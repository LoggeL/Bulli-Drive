// Gates and timing (docs/phase-2-design.md, section 8). A car moves from
// p0 = p(T-1) to p1 = p(T) in tick T; the gate counts it when it crosses
// the gate line from behind to the front within the gate's width (plus
// GATE_TOLERANCE). The fraction t of the tick at the crossing gives a
// sub-tick time. Height plays no part: a car in the air above a gate counts.

import { projectGlobal, createProjection, type Polyline } from './geometry.js';
import { GATE_TOLERANCE } from './rules.js';
import type { GateDef, TrackDef } from './types.js';

/** (p - c) · f: negative behind the gate, positive in front of it. */
export function gateSide(gate: GateDef, x: number, z: number): number {
    return (x - gate.x) * Math.sin(gate.yaw) + (z - gate.z) * Math.cos(gate.yaw);
}

/**
 * The fraction t in (0, 1] of the tick at which the move from (x0, z0) to
 * (x1, z1) crosses the gate forwards within its width, or -1. The boundary
 * rule side(p0) < 0 <= side(p1) counts a crossing in exactly one tick, even
 * for a car that stops right on the line.
 */
export function crossGate(gate: GateDef, x0: number, z0: number, x1: number, z1: number): number {
    const side0 = gateSide(gate, x0, z0);
    const side1 = gateSide(gate, x1, z1);
    if (!(side0 < 0 && side1 >= 0)) return -1;
    const t = side0 / (side0 - side1);
    const qx = x0 + t * (x1 - x0), qz = z0 + t * (z1 - z0);
    // Offset along the left axis (cos yaw, -sin yaw)
    const across = (qx - gate.x) * Math.cos(gate.yaw) - (qz - gate.z) * Math.sin(gate.yaw);
    return Math.abs(across) <= gate.width / 2 + GATE_TOLERANCE ? t : -1;
}

/**
 * Race time (float ticks since startTick) of a crossing at fraction t of
 * tick T. The whole ticks first: (T - 1 - S) is exact, so the result does
 * not depend on how far the room's clock has run (a replay counts from 0
 * and must give the same bits).
 */
export function crossingTicks(tick: number, t: number, startTick: number): number {
    return (tick - 1 - startTick) + t;
}

/**
 * Arc length of every gate's centre on the racing line; from the second
 * gate on, the candidate nearest to the previous gate along the line wins
 * (so a gate never lands on a parallel leg).
 */
export function gateArcLengths(track: TrackDef, line: Polyline): number[] {
    const projection = createProjection();
    const out: number[] = [];
    let expected: number | undefined;
    for (const gate of track.gates) {
        projectGlobal(line, gate.x, gate.z, projection, expected);
        out.push(projection.s);
        expected = projection.s;
    }
    return out;
}
