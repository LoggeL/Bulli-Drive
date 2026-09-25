import type { Vec2 } from '../../shared/map/geometry.js';

// Where a lookout's coin telescopes stand (docs/phase-3-design.md 3.3,
// "Aussichtspunkt mit Parkplatz, Münzfernrohr, Blick auf die Bucht"): on
// the crest between the lot and what they look at. Bulli Bay's lookout lot
// lies in a cut below the summit, which hides the bay at eye height (A66);
// from the knoll between lot and bay the view opens. Pure: tested with a
// made-up ground.

export interface ViewingSpot {
    x: number;
    z: number;
    // rotation.y: the local +z axis points at the target
    yaw: number;
}

/**
 * The highest ground on the way from `from` towards `target` between `near`
 * and `far` m (every metre), and `count` spots there, `spacing` m apart
 * across the view, each facing the target.
 */
export function crestSpots(
    ground: (x: number, z: number) => number, from: Vec2, target: Vec2,
    near: number, far: number, count: number, spacing: number
): ViewingSpot[] {
    const length = Math.hypot(target[0] - from[0], target[1] - from[1]);
    const dx = (target[0] - from[0]) / length, dz = (target[1] - from[1]) / length;
    let best = near, bestHeight = -Infinity;
    for (let d = near; d <= far; d++) {
        const h = ground(from[0] + dx * d, from[1] + dz * d);
        if (h > bestHeight) { bestHeight = h; best = d; }
    }
    const cx = from[0] + dx * best, cz = from[1] + dz * best;
    const spots: ViewingSpot[] = [];
    for (let k = 0; k < count; k++) {
        const across = (k - (count - 1) / 2) * spacing;
        // Across the view: (-dz, dx)
        const x = cx - dz * across, z = cz + dx * across;
        spots.push({ x, z, yaw: Math.atan2(target[0] - x, target[1] - z) });
    }
    return spots;
}
