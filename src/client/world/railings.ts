import type { Vec2 } from '../../shared/map/geometry.js';

// Where the pieces of a guard rail or barrier stand along a rail line
// (docs/phase-3-design.md 5.5, A26): the kit's 3.81 m segments one after
// the other along the polyline (chords, so a curve is a chain of short
// straight pieces, like the capsule colliders), the last one shortened.
// Each piece runs from its post along its local +x with the traffic side
// (local +z) towards the road. Pure: tested without a renderer.

export interface RailPiece {
    // Post (origin) and far end of the piece
    ax: number;
    az: number;
    bx: number;
    bz: number;
    // Length over the kit piece's length (1 for a full piece)
    scale: number;
}

/** Point at arc length s along a polyline (clamped). */
export function alongPolyline(line: readonly Vec2[], s: number): Vec2 {
    let rest = s;
    for (let i = 1; i < line.length; i++) {
        const dx = line[i][0] - line[i - 1][0], dz = line[i][1] - line[i - 1][1];
        const l = Math.sqrt(dx * dx + dz * dz);
        if (rest <= l || i === line.length - 1) {
            const t = l > 0 ? Math.min(1, rest / l) : 0;
            return [line[i - 1][0] + dx * t, line[i - 1][1] + dz * t];
        }
        rest -= l;
    }
    return line[line.length - 1];
}

export function polylineLength(line: readonly Vec2[]): number {
    let total = 0;
    for (let i = 1; i < line.length; i++) {
        const dx = line[i][0] - line[i - 1][0], dz = line[i][1] - line[i - 1][1];
        total += Math.sqrt(dx * dx + dz * dz);
    }
    return total;
}

/**
 * Pieces of `pieceLength` along the line, facing `toRoad(x, z)` (a vector
 * from the rail towards the road at that point). A rest shorter than
 * minRest is spread over the last piece instead of drawn on its own.
 */
export function railPieces(line: readonly Vec2[], pieceLength: number, toRoad: (x: number, z: number) => Vec2, minRest = 1): RailPiece[] {
    const total = polylineLength(line);
    if (total < 0.5) return [];
    let count = Math.floor(total / pieceLength);
    const rest = total - count * pieceLength;
    if (rest >= minRest || count === 0) count++;
    const pieces: RailPiece[] = [];
    let s = 0;
    for (let k = 0; k < count; k++) {
        const step = k === count - 1 ? total - s : pieceLength;
        const a = alongPolyline(line, s), b = alongPolyline(line, s + step);
        s += step;
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const [rx, rz] = toRoad((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        // Local +z of a piece running along (dx, dz) is (-dz, dx) (three.js
        // rotation about y); if that faces away from the road, the piece
        // runs the other way
        const facesRoad = -dz * rx + dx * rz >= 0;
        pieces.push(facesRoad
            ? { ax: a[0], az: a[1], bx: b[0], bz: b[1], scale: step / pieceLength }
            : { ax: b[0], az: b[1], bx: a[0], bz: a[1], scale: step / pieceLength });
    }
    return pieces;
}

/** Posts every `spacing` m along a line, both ends included. */
export function postsAlong(line: readonly Vec2[], spacing: number): Vec2[] {
    const total = polylineLength(line);
    const count = Math.max(1, Math.round(total / spacing));
    const posts: Vec2[] = [];
    for (let k = 0; k <= count; k++) posts.push(alongPolyline(line, total * k / count));
    return posts;
}
