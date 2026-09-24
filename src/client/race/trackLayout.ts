import { CHEVRON_POST_OFFSET } from '../../shared/race/raceWorld.js';
import type { GateDef, TrackHint, Vec2 } from '../../shared/race/types.js';

// Where the pieces of a track's dressing stand (docs/phase-2-design.md,
// 17.4), as plain numbers: gate masts, the 2 m segments of the water
// barrier rows, the chevron posts (exactly where the race world has their
// colliders), the delineator posts and the edges of a road ribbon. No
// three: race/TrackDressing.ts builds the meshes from these, the Node
// tests check them against the colliders.
// Conventions as in the sim: forward (sin yaw, cos yaw), left (cos yaw, -sin yaw).

// Length of one plastic water barrier (m)
export const BARRIER_SEGMENT = 2;

export interface PlacedPiece { x: number; z: number; yaw: number }
export interface BarrierPiece extends PlacedPiece { red: boolean }

/** The two ends of a gate's line, `extra` metres beyond its half width (left end first). */
export function gateEnds(gate: GateDef, extra = 0): { left: Vec2; right: Vec2 } {
    const half = gate.width / 2 + extra;
    const lx = Math.cos(gate.yaw), lz = -Math.sin(gate.yaw);
    return {
        left: { x: gate.x + lx * half, z: gate.z + lz * half },
        right: { x: gate.x - lx * half, z: gate.z - lz * half }
    };
}

/** The barriers of a row, alternating red and white, each facing along the row's yaw. */
export function barrierPieces(hint: Extract<TrackHint, { kind: 'barrier' }>): BarrierPiece[] {
    const count = Math.max(1, Math.round(hint.length / BARRIER_SEGMENT));
    const step = hint.length / count;
    const lx = Math.cos(hint.yaw), lz = -Math.sin(hint.yaw);
    const out: BarrierPiece[] = [];
    for (let i = 0; i < count; i++) {
        const along = -hint.length / 2 + step * (i + 0.5);
        out.push({ x: hint.x + lx * along, z: hint.z + lz * along, yaw: hint.yaw, red: i % 2 === 0 });
    }
    return out;
}

/** The two posts of a chevron board (where its colliders are), left post first. */
export function chevronPosts(hint: Extract<TrackHint, { kind: 'chevron' }>): Vec2[] {
    const lx = Math.cos(hint.yaw), lz = -Math.sin(hint.yaw);
    return [1, -1].map(side => ({ x: hint.x + lx * side * CHEVRON_POST_OFFSET, z: hint.z + lz * side * CHEVRON_POST_OFFSET }));
}

/**
 * Delineator posts along a polyline: one every `spacing` metres of its
 * length (the first half a spacing in), on both sides at `offset`, facing
 * along the line.
 */
export function delineatorPosts(line: readonly Vec2[], offset: number, spacing: number): PlacedPiece[] {
    const out: PlacedPiece[] = [];
    let next = spacing / 2;
    let travelled = 0;
    for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length === 0) continue;
        const fx = (b.x - a.x) / length, fz = (b.z - a.z) / length;
        const yaw = Math.atan2(fx, fz);
        // Left of the direction of travel
        const lx = fz, lz = -fx;
        while (next <= travelled + length) {
            const t = next - travelled;
            const x = a.x + fx * t, z = a.z + fz * t;
            out.push({ x: x + lx * offset, z: z + lz * offset, yaw }, { x: x - lx * offset, z: z - lz * offset, yaw });
            next += spacing;
        }
        travelled += length;
    }
    return out;
}

/**
 * The left and right edge of a ribbon of the given width along the points
 * (the direction at a point is the mean of the segments before and after).
 */
export function ribbonEdges(points: readonly Vec2[], width: number): { left: Vec2; right: Vec2 }[] {
    const half = width / 2;
    return points.map((p, i) => {
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const length = Math.hypot(dx, dz) || 1;
        const lx = dz / length, lz = -dx / length;
        return { left: { x: p.x + lx * half, z: p.z + lz * half }, right: { x: p.x - lx * half, z: p.z - lz * half } };
    });
}
