// Small shared helpers for world systems.

// Squared 2D distance in the XZ plane (avoid sqrt where only comparisons are needed).
export function distSq2D(x1: number, z1: number, x2: number, z2: number): number {
    const dx = x1 - x2;
    const dz = z1 - z2;
    return dx * dx + dz * dz;
}
