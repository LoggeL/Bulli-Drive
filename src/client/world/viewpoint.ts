import type { Vec2 } from '../../shared/map/geometry.js';

// Where a lookout's coin telescopes stand (docs/phase-3-design.md 3.3,
// "Aussichtspunkt mit Parkplatz, Münzfernrohr, Blick auf die Bucht"): at
// the lot's railing, in the corner that looks furthest towards the view.
// Bulli Bay's lookout lot sees the bay over the cut knoll to its west
// (base.json cuts, A66). Pure: tested with made-up railings.

export interface ViewingSpot {
    x: number;
    z: number;
    // rotation.y: the local +z axis points at the target
    yaw: number;
}

/**
 * `count` spots along the railing `rail` (a polyline), `spacing` m apart,
 * starting `spacing` m along it from its point furthest towards the target
 * (seen from `from`, the lot's centre) and moved `inset` m from the railing
 * towards `from`, each facing the target.
 */
export function railSpots(rail: readonly Vec2[], from: Vec2, target: Vec2, count: number, spacing: number, inset: number): ViewingSpot[] {
    const length = Math.hypot(target[0] - from[0], target[1] - from[1]);
    const dx = (target[0] - from[0]) / length, dz = (target[1] - from[1]) / length;
    // Arc length along the railing of its point furthest towards the target
    const lengths = [0];
    for (let i = 1; i < rail.length; i++) lengths.push(lengths[i - 1] + Math.hypot(rail[i][0] - rail[i - 1][0], rail[i][1] - rail[i - 1][1]));
    let best = 0, bestReach = -Infinity;
    rail.forEach(([x, z], i) => {
        const reach = (x - from[0]) * dx + (z - from[1]) * dz;
        if (reach > bestReach) { bestReach = reach; best = i; }
    });
    const total = lengths[lengths.length - 1];
    // Along the railing towards its longer side from there
    const sign = total - lengths[best] >= lengths[best] ? 1 : -1;
    const pointAt = (s: number): Vec2 => {
        let i = 1;
        while (i < rail.length - 1 && lengths[i] < s) i++;
        const t = (s - lengths[i - 1]) / Math.max(1e-9, lengths[i] - lengths[i - 1]);
        return [rail[i - 1][0] + (rail[i][0] - rail[i - 1][0]) * t, rail[i - 1][1] + (rail[i][1] - rail[i - 1][1]) * t];
    };
    const spots: ViewingSpot[] = [];
    for (let k = 1; k <= count; k++) {
        const [px, pz] = pointAt(Math.min(total, Math.max(0, lengths[best] + sign * k * spacing)));
        const back = Math.hypot(from[0] - px, from[1] - pz);
        const x = px + (from[0] - px) / back * inset, z = pz + (from[1] - pz) / back * inset;
        spots.push({ x, z, yaw: Math.atan2(target[0] - x, target[1] - z) });
    }
    return spots;
}
