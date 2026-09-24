// Static collision world of the v2 driving simulation (docs/phase-1a-design.md,
// section 7): colliders in the XZ plane with a height, a static uniform
// grid for the broad phase, sandbox ramps and the ground height.

import type { TerrainConfig } from '../protocol.js';
import type { VehicleState } from '../sim/types.js';
import { getTerrainHeight } from './terrain.js';

// top is the height of the upper edge above base. A car whose underside is
// at or above base + top passes over the collider. ramp marks the edge walls
// of that ramp (index into SimWorld.ramps, see rampEdgeColliders).
export type Collider =
    | { kind: 'circle'; x: number; z: number; r: number; base: number; top: number; ramp?: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; base: number; top: number; ramp?: number }; // axis-aligned

// What the world builder provides; createSimWorld adds base
export type ColliderInput =
    | { kind: 'circle'; x: number; z: number; r: number; top: number; ramp?: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; top: number; ramp?: number };

// Wedge rising along its heading (sin yaw, cos yaw) from 0 at the rear edge
// to height at the front edge, where cars take off. Its base is the terrain
// height at the middle of the rear edge, so on a slope the ramp starts
// flush with the ground behind it (docs/phase-2-design.md, 5.5).
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
    rampBases: number[];         // height of each ramp's rear edge (terrain there)
    roads: RoadGrid | null;      // reset target, null = reset in place
    // Race world only (docs/phase-2-design.md, 5.6): the reset target on the
    // racing line (instead of roads) and the slipstream step in stepWorld
    resetPose?: (s: VehicleState) => boolean;
    slipstream?: boolean;
    bound: number;               // terrain.size/2 - 2 = 498 (the old client clamp)
    groundHeight(x: number, z: number): number;   // max(getTerrainHeight, ramps)
    terrainHeight(x: number, z: number): number;  // getTerrainHeight alone
    // Index of the ramp whose surface is the ground at (x, z), -1 = terrain
    rampAt(x: number, z: number): number;
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

// True when (x, z) lies on the ramp's footprint
export function insideRamp(ramp: RampDef, x: number, z: number): boolean {
    return rampHeight(ramp, 0, x, z) > -Infinity;
}

// Height of a ramp's surface at the point of its footprint nearest to (x, z)
export function rampSurfaceNear(world: SimWorld, index: number, x: number, z: number): number {
    const ramp = world.ramps[index];
    const along = (x - ramp.x) * Math.sin(ramp.yaw) + (z - ramp.z) * Math.cos(ramp.yaw);
    const t = Math.max(-0.5, Math.min(0.5, along / ramp.length));
    return world.rampBases[index] + ramp.height * (t + 0.5);
}

/** Terrain height at the middle of a ramp's rear edge: the base of its surface. */
export function rampRearBase(ramp: RampDef, terrainHeight: (x: number, z: number) => number): number {
    return terrainHeight(ramp.x - Math.sin(ramp.yaw) * ramp.length / 2, ramp.z - Math.cos(ramp.yaw) * ramp.length / 2);
}

const FLAT_GROUND = (): number => 0;

// Half thickness of a ramp's edge walls, the minimum of section 7.3
export const RAMP_EDGE_THICKNESS = 0.25;
// Side wall pieces lower than this are left out: a car simply rolls onto
// the ramp there
export const RAMP_EDGE_MIN_TOP = 0.3;
// Side walls are split into pieces this long at most, each as high as the
// ramp at its upper end
const RAMP_SIDE_PIECE = 4;

/**
 * Walls along the high (front) edge and both sides of a ramp, so a car
 * coming from behind or from the side hits the ramp instead of popping up
 * onto it (section 7.2). Each wall is as high as the ramp at that edge.
 * The collision skips them for a car on the ramp, one moving away from it
 * and one level with the ramp's surface (collision.ts), so a car taking
 * off or rolling off a side never snags a wall.
 * front = false leaves out the front wall, for two ramps put back to back
 * as a hill. Only for ramps facing along an axis (yaw a multiple of 90°),
 * since boxes are axis-aligned. terrainHeight is the ground of the world
 * the ramp stands in (flat by default): a wall's top is the ramp surface
 * above the terrain at the wall, since createSimWorld puts every collider
 * on the ground at its centre.
 */
export function rampEdgeColliders(
    ramp: RampDef, index: number, front = true, terrainHeight: (x: number, z: number) => number = FLAT_GROUND
): ColliderInput[] {
    const quarter = ramp.yaw / (Math.PI / 2);
    if (Math.abs(quarter - Math.round(quarter)) > 1e-6) {
        throw new Error('ramp edge colliders need a ramp facing along an axis');
    }
    // Forward (up the ramp) and left in world axes, snapped to exact ±1/0
    const fx = Math.round(Math.sin(ramp.yaw)), fz = Math.round(Math.cos(ramp.yaw));
    const lx = fz, lz = -fx;
    const t = RAMP_EDGE_THICKNESS;
    const out: ColliderInput[] = [];
    const base = rampRearBase(ramp, terrainHeight);
    // A wall centred at along/across (ramp frame) with half extents; height
    // is the ramp's height above its base at the wall's upper end
    const wall = (along: number, across: number, halfAlong: number, halfAcross: number, height: number) => {
        const x = ramp.x + fx * along + lx * across;
        const z = ramp.z + fz * along + lz * across;
        const alongX = fx !== 0;
        out.push({
            kind: 'box', x, z,
            hw: alongX ? halfAlong : halfAcross,
            hd: alongX ? halfAcross : halfAlong,
            top: base + height - terrainHeight(x, z),
            ramp: index
        });
    };
    const halfLength = ramp.length / 2, halfWidth = ramp.width / 2;
    // Front edge, where cars take off: wall across the full width plus the sides
    if (front) wall(halfLength + t, 0, t, halfWidth + 2 * t, ramp.height);
    const pieces = Math.max(1, Math.ceil(ramp.length / RAMP_SIDE_PIECE));
    const pieceLength = ramp.length / pieces;
    for (let i = 0; i < pieces; i++) {
        const top = ramp.height * (i + 1) / pieces;
        if (top < RAMP_EDGE_MIN_TOP) continue;
        const along = -halfLength + pieceLength * (i + 0.5);
        for (const side of [1, -1]) wall(along, side * (halfWidth + t), pieceLength / 2, t, top);
    }
    return out;
}

export function createSimWorld(
    terrain: TerrainConfig,
    colliders: readonly ColliderInput[],
    ramps: readonly RampDef[] = [],
    roads: RoadGrid | null = null
): SimWorld {
    const rampList = ramps.map(ramp => ({ ...ramp }));
    const terrainHeight = (x: number, z: number): number => getTerrainHeight(terrain, x, z);
    // Ramps start at the terrain height of their rear edge
    const rampBases = rampList.map(ramp => rampRearBase(ramp, terrainHeight));
    const groundHeight = (x: number, z: number): number => {
        let height = getTerrainHeight(terrain, x, z);
        for (let i = 0; i < rampList.length; i++) {
            const h = rampHeight(rampList[i], rampBases[i], x, z);
            if (h > height) height = h;
        }
        return height;
    };
    const rampAt = (x: number, z: number): number => {
        let height = getTerrainHeight(terrain, x, z), found = -1;
        for (let i = 0; i < rampList.length; i++) {
            const h = rampHeight(rampList[i], rampBases[i], x, z);
            if (h > height) { height = h; found = i; }
        }
        return found;
    };
    const list: Collider[] = colliders.map(input => ({ ...input, base: groundHeight(input.x, input.z) }));
    return {
        terrain,
        colliders: list,
        grid: new SpatialGrid(list),
        ramps: rampList,
        rampBases,
        roads,
        bound: terrain.size / 2 - 2,
        groundHeight,
        terrainHeight,
        rampAt,
        queryBuffer: new Int32Array(list.length)
    };
}
