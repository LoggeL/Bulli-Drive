// The driving radar's frame (docs/phase-3-design.md E2 and 15): heading up,
// the map turning beneath the car. World axes: east = +x, north = -z; on the
// canvas px grows to the right, py downwards. Pure (unit-tested).

/** Canvas rotation (ctx.rotate) of a north-up map layer for a car heading yaw. */
export function radarRotation(yaw: number): number {
    // Forward (sin yaw, cos yaw) must end up as screen up (0, -1)
    return yaw - Math.PI;
}

/** Screen offset (px right, py down) of a world offset (dx, dz) from the car, in the units of dx, dz. */
export function radarOffset(dx: number, dz: number, yaw: number): { x: number; y: number } {
    const phi = radarRotation(yaw);
    const c = Math.cos(phi), s = Math.sin(phi);
    return { x: dx * c - dz * s, y: dx * s + dz * c };
}

/** Where north lies on the rim, as a unit screen vector (the "N" marker). */
export function radarNorth(yaw: number): { x: number; y: number } {
    return radarOffset(0, -1, yaw);
}
