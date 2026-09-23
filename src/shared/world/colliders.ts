// Static collision world of the v2 driving simulation (docs/phase-1a-design.md,
// section 7): colliders in the XZ plane with a height, a static uniform
// grid for the broad phase, sandbox ramps and the ground height.

import type { TerrainConfig } from '../protocol.js';
import { getTerrainHeight } from './terrain.js';

// top is the height of the upper edge above base. A car whose underside is
// at or above base + top passes over the collider.
export type Collider =
    | { kind: 'circle'; x: number; z: number; r: number; base: number; top: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; base: number; top: number }; // axis-aligned

// What the world builder provides; createSimWorld adds base
export type ColliderInput =
    | { kind: 'circle'; x: number; z: number; r: number; top: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; top: number };

// Wedge rising along its heading (sin yaw, cos yaw) from 0 at the rear edge
// to height at the front edge, where cars take off
export interface RampDef { x: number; z: number; yaw: number; width: number; length: number; height: number }

// Straight roads a reset puts the car back onto (the city's road grid):
// centre lines x = const running from minZ to maxZ and z = const running
// from minX to maxX. A car farther than snapRange from every line is reset
// where it is.
export interface RoadGrid {
    xLines: number[];
    zLines: number[];
    minX: number; maxX: number;
    minZ: number; maxZ: number;
    snapRange: number;
}

// Collider heights (top) of the obstacle sources in client/world/city.ts and
// environment.ts (section 7.1). Infinity = cannot be jumped over.
export const COLLIDER_TOPS = {
    building: Infinity,
    bench: 1.2,
    pond: 0.8,
    parkTree: Infinity,
    palm: Infinity,
    lamp: 5.5,
    signPost: 3.3,
    planter: 1.0,
    parasol: 2.8,
    fountain: 1.5,
    tree: Infinity,
    // Rocks: top = rockPerSize × rockSize
    rockPerSize: 0.9
} as const;

// ---- Spatial grid ----

export const GRID_CELL_SIZE = 16;
export const GRID_ORIGIN = -512;
export const GRID_CELLS = 64;

function cellCoord(value: number): number {
    const cell = Math.floor((value - GRID_ORIGIN) / GRID_CELL_SIZE);
    return cell < 0 ? 0 : cell >= GRID_CELLS ? GRID_CELLS - 1 : cell;
}

// Uniform 64 × 64 grid in CSR layout, built once. Colliders outside the
// covered 1024 m square land in the border cells, so queries stay complete.
export class SpatialGrid {
    // items[cellStart[c] .. cellStart[c + 1]) are the colliders of cell c,
    // ascending by index
    readonly cellStart: Int32Array;
    readonly items: Int32Array;
    private readonly stamps: Int32Array;
    private stamp = 0;

    constructor(colliders: readonly Collider[]) {
        const cellCount = GRID_CELLS * GRID_CELLS;
        const counts = new Int32Array(cellCount + 1);
        const forEachCell = (collider: Collider, visit: (cell: number) => void) => {
            const hx = collider.kind === 'circle' ? collider.r : collider.hw;
            const hz = collider.kind === 'circle' ? collider.r : collider.hd;
            const x0 = cellCoord(collider.x - hx), x1 = cellCoord(collider.x + hx);
            const z0 = cellCoord(collider.z - hz), z1 = cellCoord(collider.z + hz);
            for (let cz = z0; cz <= z1; cz++) {
                for (let cx = x0; cx <= x1; cx++) visit(cz * GRID_CELLS + cx);
            }
        };
        for (const collider of colliders) forEachCell(collider, cell => { counts[cell + 1]++; });
        for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
        this.cellStart = counts;
        this.items = new Int32Array(counts[cellCount]);
        const fill = counts.slice(0, cellCount);
        colliders.forEach((collider, index) => forEachCell(collider, cell => { this.items[fill[cell]++] = index; }));
        this.stamps = new Int32Array(colliders.length);
    }

    // Writes the indices of all colliders whose cells overlap the AABB into
    // out, deduplicated and sorted ascending, and returns their count. The
    // result therefore does not depend on the traversal order or on how
    // large the queried box is. No allocation; out needs room for every
    // collider (SimWorld.queryBuffer), anything beyond out.length is dropped.
    query(minX: number, minZ: number, maxX: number, maxZ: number, out: Int32Array): number {
        if (this.stamp === 0x7FFFFFFF) {
            this.stamps.fill(0);
            this.stamp = 0;
        }
        const stamp = ++this.stamp;
        const x0 = cellCoord(minX), x1 = cellCoord(maxX);
        const z0 = cellCoord(minZ), z1 = cellCoord(maxZ);
        let count = 0;
        for (let cz = z0; cz <= z1; cz++) {
            for (let cx = x0; cx <= x1; cx++) {
                const cell = cz * GRID_CELLS + cx;
                for (let k = this.cellStart[cell], end = this.cellStart[cell + 1]; k < end; k++) {
                    const index = this.items[k];
                    if (this.stamps[index] === stamp) continue;
                    this.stamps[index] = stamp;
                    if (count < out.length) out[count++] = index;
                }
            }
        }
        // Insertion sort: typically fewer than 20 hits
        for (let i = 1; i < count; i++) {
            const value = out[i];
            let j = i - 1;
            while (j >= 0 && out[j] > value) {
                out[j + 1] = out[j];
                j--;
            }
            out[j + 1] = value;
        }
        return count;
    }
}

// ---- World ----

export interface SimWorld {
    terrain: TerrainConfig;
    colliders: Collider[];       // index = deterministic order
    grid: SpatialGrid;
    ramps: RampDef[];
    roads: RoadGrid | null;      // reset target, null = reset in place
    bound: number;               // terrain.size/2 - 2 = 498 (as the legacy clamp)
    groundHeight(x: number, z: number): number;   // max(getTerrainHeight, ramps)
    // Scratch buffer for grid queries of the collision code
    queryBuffer: Int32Array;
}

// Height of a ramp's surface at (x, z), or -Infinity outside its footprint
function rampHeight(ramp: RampDef, rampBase: number, x: number, z: number): number {
    const dx = x - ramp.x, dz = z - ramp.z;
    const sin = Math.sin(ramp.yaw), cos = Math.cos(ramp.yaw);
    const along = dx * sin + dz * cos;
    const across = dx * cos - dz * sin;
    if (Math.abs(across) > ramp.width / 2 || Math.abs(along) > ramp.length / 2) return -Infinity;
    return rampBase + ramp.height * (along / ramp.length + 0.5);
}

export function createSimWorld(
    terrain: TerrainConfig,
    colliders: readonly ColliderInput[],
    ramps: readonly RampDef[] = [],
    roads: RoadGrid | null = null
): SimWorld {
    const rampList = ramps.map(ramp => ({ ...ramp }));
    // Ramps sit on the terrain height under their centre
    const rampBases = rampList.map(ramp => getTerrainHeight(terrain, ramp.x, ramp.z));
    const groundHeight = (x: number, z: number): number => {
        let height = getTerrainHeight(terrain, x, z);
        for (let i = 0; i < rampList.length; i++) {
            const h = rampHeight(rampList[i], rampBases[i], x, z);
            if (h > height) height = h;
        }
        return height;
    };
    const list: Collider[] = colliders.map(input => ({ ...input, base: groundHeight(input.x, input.z) }));
    return {
        terrain,
        colliders: list,
        grid: new SpatialGrid(list),
        ramps: rampList,
        roads,
        bound: terrain.size / 2 - 2,
        groundHeight,
        queryBuffer: new Int32Array(list.length)
    };
}
