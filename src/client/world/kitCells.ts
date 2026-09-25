// Which merged kit cells to draw (docs/phase-3-design.md 9 and A41): the
// kit pieces of the map are merged per cell and per LOD, in a quadtree of
// three levels over the 2 km square: 250 m chunks with LOD2, their 125 m
// quarters with LOD1, and those quarters' 62.5 m quarters with LOD0. A
// chunk far from the camera draws as one mesh; nearer, it splits into its
// quarters, and those near the camera split again. So every piece is drawn
// exactly once, at the LOD of its cell's distance, with few draw calls.
// Pure: the unit tests check the choice.

export const CELL_ORIGIN = -1000;
// Edge length of the cells per level (level 0: LOD2 chunks)
export const CELL_SIZES = [250, 125, 62.5] as const;
export type CellLevel = 0 | 1 | 2;

// The LOD a level's meshes are merged from; the finest cells may use a
// coarser one (phones: LOD1 up close, design 10 "ohne Gesimse")
export function cellLod(level: CellLevel, nearLod = 0): number {
    return Math.max(2 - level, level === 2 ? nearLod : 0);
}

export interface CellRef {
    level: CellLevel;
    i: number;
    j: number;
}

export function cellKey(level: CellLevel, i: number, j: number): string {
    return `${level}:${i}:${j}`;
}

export function cellIndex(v: number, level: CellLevel): number {
    return Math.floor((v - CELL_ORIGIN) / CELL_SIZES[level]);
}

/** Horizontal distance from (x, z) to the cell's square (0 inside). */
export function cellDistance(x: number, z: number, level: CellLevel, i: number, j: number): number {
    const size = CELL_SIZES[level];
    const minX = CELL_ORIGIN + i * size, minZ = CELL_ORIGIN + j * size;
    const dx = Math.max(minX - x, 0, x - (minX + size));
    const dz = Math.max(minZ - z, 0, z - (minZ + size));
    return Math.sqrt(dx * dx + dz * dz);
}

export interface CellDistances {
    // Beyond this a 125 m cell draws LOD1 instead of splitting into LOD0 cells
    lod0: number;
    // Beyond this a 250 m chunk draws LOD2 instead of splitting
    lod1: number;
    // Beyond this nothing is drawn
    sight: number;
    // Band a split cell keeps splitting in (no flicker at the threshold)
    hysteresis: number;
    // Cells nearer than this cast shadows (m)
    shadowReach: number;
    // LOD of the finest (62.5 m) cells
    nearLod: number;
}

/** Which cells hold pieces: keys of all three levels for the pieces' positions. */
export function occupiedCells(points: readonly { x: number; z: number }[]): Set<string> {
    const occupied = new Set<string>();
    for (const p of points) {
        for (const level of [0, 1, 2] as const) occupied.add(cellKey(level, cellIndex(p.x, level), cellIndex(p.z, level)));
    }
    return occupied;
}

/**
 * The cells to draw for a camera at (x, z): chunks split while near, as
 * described above. `previous` (keys of the last choice) keeps a split
 * cell split within the hysteresis band.
 */
export function selectCells(occupied: ReadonlySet<string>, x: number, z: number, distances: CellDistances, previous?: ReadonlySet<string>): CellRef[] {
    const out: CellRef[] = [];
    const chunks = Math.round(2000 / CELL_SIZES[0]);
    const band = (level: CellLevel, i: number, j: number) => {
        // Split last time: one of its children was drawn (or split)
        if (!previous) return 0;
        for (let di = 0; di < 2; di++) {
            for (let dj = 0; dj < 2; dj++) {
                const child = (level + 1) as CellLevel;
                if (previous.has(cellKey(child, 2 * i + di, 2 * j + dj))) return distances.hysteresis;
                if (child < 2) {
                    for (let ei = 0; ei < 2; ei++) {
                        for (let ej = 0; ej < 2; ej++) {
                            if (previous.has(cellKey(2, 4 * i + 2 * di + ei, 4 * j + 2 * dj + ej))) return distances.hysteresis;
                        }
                    }
                }
            }
        }
        return 0;
    };
    for (let i = 0; i < chunks; i++) {
        for (let j = 0; j < chunks; j++) {
            if (!occupied.has(cellKey(0, i, j))) continue;
            const d = cellDistance(x, z, 0, i, j);
            if (d > distances.sight) continue;
            if (d > distances.lod1 + band(0, i, j)) {
                out.push({ level: 0, i, j });
                continue;
            }
            for (let di = 0; di < 2; di++) {
                for (let dj = 0; dj < 2; dj++) {
                    const ci = 2 * i + di, cj = 2 * j + dj;
                    if (!occupied.has(cellKey(1, ci, cj))) continue;
                    if (cellDistance(x, z, 1, ci, cj) > distances.lod0 + band(1, ci, cj)) {
                        out.push({ level: 1, i: ci, j: cj });
                        continue;
                    }
                    for (let ei = 0; ei < 2; ei++) {
                        for (let ej = 0; ej < 2; ej++) {
                            const fi = 2 * ci + ei, fj = 2 * cj + ej;
                            if (occupied.has(cellKey(2, fi, fj))) out.push({ level: 2, i: fi, j: fj });
                        }
                    }
                }
            }
        }
    }
    return out;
}
