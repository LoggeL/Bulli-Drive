// Builders for the hints of a track (docs/phase-2-design.md, 5.2 and 5.3):
// barriers across the side streets of every city crossing the centre line
// passes, chevron boards at corners and arrows on the road before them.
// They run once at load on the track's own data, so the hints stay a pure
// function of the centre line and the shared city layout.

import { cityRoadGrid } from '../../world/cityGen.js';
import type { TrackHint, Vec2 } from '../types.js';

// A barrier row stands this far (m) from the crossing's centre, 1 m into
// the side street (roads are 12 m wide), and spans the street
const BARRIER_OFFSET = 7;
const BARRIER_LENGTH = 12;
const BLOCK_PITCH = 52;

function heading(dx: number, dz: number): number {
    return Math.atan2(dx, dz);
}

interface Leg { ax: number; az: number; bx: number; bz: number }

function legsOf(points: readonly Vec2[], closed: boolean): Leg[] {
    const out: Leg[] = [];
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        out.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    }
    return out;
}

const DIRECTIONS: readonly Vec2[] = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];

/**
 * A barrier across every side street at the city crossings the path runs
 * through or turns at: every direction of a crossing the path does not use
 * and in which the road leads on to the next crossing.
 */
export function sideStreetBarriers(points: readonly Vec2[], closed: boolean): TrackHint[] {
    const roads = cityRoadGrid();
    const legs = legsOf(points, closed).filter(leg => leg.ax === leg.bx || leg.az === leg.bz);
    const out: TrackHint[] = [];
    for (const z of roads.zLines) {
        for (const x of roads.xLines) {
            const used = new Set<number>();
            for (const leg of legs) {
                const minX = Math.min(leg.ax, leg.bx), maxX = Math.max(leg.ax, leg.bx);
                const minZ = Math.min(leg.az, leg.bz), maxZ = Math.max(leg.az, leg.bz);
                if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
                DIRECTIONS.forEach((d, i) => {
                    // The leg reaches from the crossing in direction d
                    const reach = d.x !== 0 ? (d.x > 0 ? maxX - x : x - minX) : (d.z > 0 ? maxZ - z : z - minZ);
                    const along = d.x !== 0 ? leg.ax !== leg.bx : leg.az !== leg.bz;
                    if (along && reach > 0) used.add(i);
                });
            }
            if (used.size === 0) continue;
            DIRECTIONS.forEach((d, i) => {
                if (used.has(i)) return;
                const nx = x + d.x * BLOCK_PITCH, nz = z + d.z * BLOCK_PITCH;
                if (!roads.xLines.includes(nx) || !roads.zLines.includes(nz)) return;
                out.push({
                    kind: 'barrier', x: x + d.x * BARRIER_OFFSET, z: z + d.z * BARRIER_OFFSET,
                    yaw: heading(d.x, d.z), length: BARRIER_LENGTH
                });
            });
        }
    }
    return out;
}

// Turn at vertex i: incoming and outgoing unit directions and the side
function corner(points: readonly Vec2[], i: number) {
    const n = points.length;
    const a = points[(i - 1 + n) % n], v = points[i], b = points[(i + 1) % n];
    const l1 = Math.hypot(v.x - a.x, v.z - a.z), l2 = Math.hypot(b.x - v.x, b.z - v.z);
    const d1 = { x: (v.x - a.x) / l1, z: (v.z - a.z) / l1 };
    const d2 = { x: (b.x - v.x) / l2, z: (b.z - v.z) / l2 };
    // Left is -cross in the x-z plane (forward (sin yaw, cos yaw))
    const cross = d1.x * d2.z - d1.z * d2.x;
    return { v, d1, d2, dir: (cross < 0 ? 'left' : 'right') as 'left' | 'right' };
}

/**
 * A chevron board at each listed corner, facing the approaching car.
 * straightAhead: in the mouth of the street straight on, `distance` past the
 * corner (city crossings, behind the barrier); otherwise on the outside
 * bisector of the bend.
 */
export function cornerChevrons(points: readonly Vec2[], corners: readonly number[], distance: number, straightAhead: boolean): TrackHint[] {
    return corners.map(i => {
        const { v, d1, d2, dir } = corner(points, i);
        let ox = d1.x, oz = d1.z;
        if (!straightAhead) {
            const bx = d1.x - d2.x, bz = d1.z - d2.z;
            const length = Math.hypot(bx, bz);
            ox = bx / length;
            oz = bz / length;
        }
        return { kind: 'chevron', x: v.x + ox * distance, z: v.z + oz * distance, yaw: heading(-d1.x, -d1.z), dir };
    });
}

/** A turn arrow on the road `before` metres ahead of each listed corner, pointing where the road goes. */
export function cornerArrows(points: readonly Vec2[], corners: readonly number[], before: number): TrackHint[] {
    return corners.map(i => {
        const { v, d1, d2 } = corner(points, i);
        return { kind: 'arrow', x: v.x - d1.x * before, z: v.z - d1.z * before, yaw: heading(d2.x, d2.z) };
    });
}
