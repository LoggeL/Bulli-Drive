// Small plane geometry helpers of the map modules (x/z plane, y up).

export type Vec2 = readonly [number, number];

// Even-odd rule, independent of the polygon's winding. Points exactly on
// an edge may land on either side.
export function pointInPolygon(polygon: readonly Vec2[], x: number, z: number): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, zi] = polygon[i];
        const [xj, zj] = polygon[j];
        if ((zi > z) !== (zj > z) && x < xj + (z - zj) * (xi - xj) / (zi - zj)) inside = !inside;
    }
    return inside;
}

// Squared distance from (px, pz) to the segment a-b
export function segmentDistanceSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = px - (ax + t * ex), dz = pz - (az + t * ez);
    return dx * dx + dz * dz;
}

// Distance to the closed polygon's outline
export function polygonEdgeDistance(polygon: readonly Vec2[], x: number, z: number): number {
    let best = Infinity;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const d2 = segmentDistanceSq(x, z, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]);
        if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
}

// Distance to an open polyline
export function polylineDistance(line: readonly Vec2[], x: number, z: number): number {
    if (line.length === 1) return Math.hypot(x - line[0][0], z - line[0][1]);
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const d2 = segmentDistanceSq(x, z, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
        if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
}

// Positive inside the polygon, negative outside
export function signedPolygonDistance(polygon: readonly Vec2[], x: number, z: number): number {
    const d = polygonEdgeDistance(polygon, x, z);
    return pointInPolygon(polygon, x, z) ? d : -d;
}
