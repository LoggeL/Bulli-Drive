// Static collision world of the v2 driving simulation (docs/phase-1a-design.md,
// section 7): colliders in the XZ plane with a height, a static uniform
// grid for the broad phase, sandbox ramps and the ground height. A world
// stands either on the sine terrain of a TerrainConfig (the old city, the
// sandbox) or on a ground model: the baked heightfield of a curated map
// with its surfaces, water level and grid (docs/phase-3-design.md, 6 to 8).

import type { TerrainConfig } from '../protocol.js';
import type { VehicleState } from '../sim/types.js';
import { getTerrainHeight } from './terrain.js';

// top is the height of the upper edge above base. A car whose underside is
// at or above base + top passes over the collider. ramp marks the edge walls
// of that ramp (index into SimWorld.ramps, see rampEdgeColliders).
//
// segment: a capsule of radius r around the line a-b (guard rails, fences,
// the map border; phase 3, E8); x, z is its midpoint. obox: a box turned in
// the XZ plane (buildings along oblique roads, containers, oblique barrier
// rows); (ux, uz) is the unit vector of its local z axis, along which it
// extends hd, and its local x axis is (uz, -ux) with the extent hw. With
// (ux, uz) = (sin yaw, cos yaw) that is the sim's forward and left.
export type Collider =
    | { kind: 'circle'; x: number; z: number; r: number; base: number; top: number; ramp?: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; base: number; top: number; ramp?: number } // axis-aligned
    | { kind: 'segment'; x: number; z: number; ax: number; az: number; bx: number; bz: number; r: number; base: number; top: number; ramp?: number }
    | { kind: 'obox'; x: number; z: number; hw: number; hd: number; ux: number; uz: number; base: number; top: number; ramp?: number };

// The shapes of phase 1a (circle and axis-aligned box), e.g. of the old city
export type BoxOrCircleInput = Extract<ColliderInput, { kind: 'circle' | 'box' }>;
export type BoxInput = Extract<ColliderInput, { kind: 'box' }>;

// What the world builder provides; createSimWorld adds base (and a
// segment's midpoint, and normalises an obox's axis)
export type ColliderInput =
    | { kind: 'circle'; x: number; z: number; r: number; top: number; ramp?: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; top: number; ramp?: number }
    | { kind: 'segment'; ax: number; az: number; bx: number; bz: number; r: number; top: number }
    | { kind: 'obox'; x: number; z: number; hw: number; hd: number; ux: number; uz: number; top: number; ramp?: number };

// Wedge rising along its heading (sin yaw, cos yaw) from 0 at the rear edge
// to height at the front edge, where cars take off. Its base is the terrain
// height at the middle of the rear edge, so on a slope the ramp starts
// flush with the ground behind it (docs/phase-2-design.md, 5.5).
export interface RampDef { x: number; z: number; yaw: number; width: number; length: number; height: number }

// ---- Spatial grid ----

// A square grid of `cells` × `cells` cells of `cellSize` m from `origin`
// (the same on both axes)
export interface ColliderGridSpec {
    origin: number;
    cellSize: number;
    cells: number;
}

export const GRID_CELL_SIZE = 16;
export const GRID_ORIGIN = -512;
export const GRID_CELLS = 64;
// The old city and the sandbox: 64 × 64 cells over 1024 m
export const DEFAULT_GRID: ColliderGridSpec = { origin: GRID_ORIGIN, cellSize: GRID_CELL_SIZE, cells: GRID_CELLS };

// Half extents of a collider's bounding box along x and z (module scratch)
let extentX = 0;
let extentZ = 0;
export function colliderExtent(collider: Collider): void {
    switch (collider.kind) {
        case 'circle':
            extentX = extentZ = collider.r;
            return;
        case 'box':
            extentX = collider.hw;
            extentZ = collider.hd;
            return;
        case 'segment':
            extentX = Math.abs(collider.bx - collider.ax) / 2 + collider.r;
            extentZ = Math.abs(collider.bz - collider.az) / 2 + collider.r;
            return;
        case 'obox': {
            const ux = Math.abs(collider.ux), uz = Math.abs(collider.uz);
            // Local x (uz, -ux) · hw plus local z (ux, uz) · hd
            extentX = uz * collider.hw + ux * collider.hd;
            extentZ = ux * collider.hw + uz * collider.hd;
        }
    }
}

/** Bounding box of a collider: [minX, minZ, maxX, maxZ]. */
export function colliderBounds(collider: Collider): [number, number, number, number] {
    colliderExtent(collider);
    return [collider.x - extentX, collider.z - extentZ, collider.x + extentX, collider.z + extentZ];
}

// Uniform grid in CSR layout, built once. Colliders outside the covered
// square land in the border cells, so queries stay complete.
export class SpatialGrid {
    // items[cellStart[c] .. cellStart[c + 1]) are the colliders of cell c,
    // ascending by index
    readonly cellStart: Int32Array;
    readonly items: Int32Array;
    private readonly stamps: Int32Array;
    private stamp = 0;
    private readonly origin: number;
    private readonly cellSize: number;
    private readonly cells: number;

    constructor(colliders: readonly Collider[], spec: ColliderGridSpec = DEFAULT_GRID) {
        this.origin = spec.origin;
        this.cellSize = spec.cellSize;
        this.cells = spec.cells;
        const cells = this.cells;
        const cellCount = cells * cells;
        const counts = new Int32Array(cellCount + 1);
        const forEachCell = (collider: Collider, visit: (cell: number) => void) => {
            colliderExtent(collider);
            const hx = extentX, hz = extentZ;
            const x0 = this.cellCoord(collider.x - hx), x1 = this.cellCoord(collider.x + hx);
            const z0 = this.cellCoord(collider.z - hz), z1 = this.cellCoord(collider.z + hz);
            for (let cz = z0; cz <= z1; cz++) {
                for (let cx = x0; cx <= x1; cx++) visit(cz * cells + cx);
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

    private cellCoord(value: number): number {
        const cell = Math.floor((value - this.origin) / this.cellSize);
        return cell < 0 ? 0 : cell >= this.cells ? this.cells - 1 : cell;
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
        const x0 = this.cellCoord(minX), x1 = this.cellCoord(maxX);
        const z0 = this.cellCoord(minZ), z1 = this.cellCoord(maxZ);
        const cells = this.cells;
        let count = 0;
        for (let cz = z0; cz <= z1; cz++) {
            for (let cx = x0; cx <= x1; cx++) {
                const cell = cz * cells + cx;
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

/**
 * The ground of a curated map (docs/phase-3-design.md, 6 to 8): the height
 * (the baked heightfield), the surface ID under a point (SURFACE in
 * shared/map/types.ts), the water level and the grid of the colliders.
 */
export interface GroundModel {
    height(x: number, z: number): number;
    surface(x: number, z: number): number;
    waterLevel: number;
    // A car whose underside falls below this is reset (fell out of the map)
    fallLimit: number;
    // Half side of the square the cars stay in (the world border)
    bound: number;
    grid: ColliderGridSpec;
}

export interface SimWorld {
    // The sine terrain of the old city and the sandbox, null on a map's ground
    terrain: TerrainConfig | null;
    colliders: Collider[];       // index = deterministic order
    grid: SpatialGrid;
    ramps: RampDef[];
    rampBases: number[];         // height of each ramp's rear edge (terrain there)
    // The reset target: the racing line of a race world
    // (docs/phase-2-design.md, 5.6), the nearest road of a map
    // (docs/phase-3-design.md, 8.3). Returns false to reset in place; a
    // world without it resets in place.
    resetPose?: (s: VehicleState) => boolean;
    // Race world only: the slipstream step in stepWorld
    slipstream?: boolean;
    bound: number;               // terrain.size/2 - 2 = 498 (the old client clamp)
    // The world border the cars' circles stay inside, even a Party ghost:
    // ±bound by default; the Party's arena (docs/phase-3-design.md, 12)
    border: { minX: number; maxX: number; minZ: number; maxZ: number };
    groundHeight(x: number, z: number): number;   // max(terrain, ramps)
    terrainHeight(x: number, z: number): number;  // the terrain alone
    // Surface ID at (x, z) (SURFACE in shared/map/types.ts); always 0
    // (asphalt) on the sine terrain
    surfaceAt(x: number, z: number): number;
    // Water level; -Infinity: no water. A car whose underside is WATER_DEPTH
    // below it is in the water (vehicle.ts)
    waterLevel: number;
    // A car below this is reset; -Infinity on the sine terrain
    fallLimit: number;
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
): BoxInput[] {
    const quarter = ramp.yaw / (Math.PI / 2);
    if (Math.abs(quarter - Math.round(quarter)) > 1e-6) {
        throw new Error('ramp edge colliders need a ramp facing along an axis');
    }
    // Forward (up the ramp) and left in world axes, snapped to exact ±1/0
    const fx = Math.round(Math.sin(ramp.yaw)), fz = Math.round(Math.cos(ramp.yaw));
    const lx = fz, lz = -fx;
    const t = RAMP_EDGE_THICKNESS;
    const out: BoxInput[] = [];
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

function isTerrainConfig(ground: TerrainConfig | GroundModel): ground is TerrainConfig {
    return typeof (ground as TerrainConfig).frequency1 === 'number';
}

const ASPHALT = (): number => 0;

export function createSimWorld(
    ground: TerrainConfig | GroundModel,
    colliders: readonly ColliderInput[],
    ramps: readonly RampDef[] = []
): SimWorld {
    const rampList = ramps.map(ramp => ({ ...ramp }));
    const terrain = isTerrainConfig(ground) ? ground : null;
    const terrainHeight = terrain
        ? (x: number, z: number): number => getTerrainHeight(terrain, x, z)
        : (ground as GroundModel).height;
    // Ramps start at the terrain height of their rear edge
    const rampBases = rampList.map(ramp => rampRearBase(ramp, terrainHeight));
    // Per ramp: heading, and the radius of a circle around its footprint
    // (a cheap test that skips the far ones; the result is the same)
    const count = rampList.length;
    const sins = rampList.map(ramp => Math.sin(ramp.yaw));
    const coss = rampList.map(ramp => Math.cos(ramp.yaw));
    const reach = rampList.map(ramp => Math.sqrt(ramp.length * ramp.length + ramp.width * ramp.width) / 2);
    // Height of ramp i's surface at (x, z), or -Infinity off its footprint
    const onRamp = (i: number, x: number, z: number): number => {
        const ramp = rampList[i];
        const dx = x - ramp.x, dz = z - ramp.z;
        if (dx > reach[i] || dx < -reach[i] || dz > reach[i] || dz < -reach[i]) return -Infinity;
        const sin = sins[i], cos = coss[i];
        const along = dx * sin + dz * cos;
        const across = dx * cos - dz * sin;
        if (Math.abs(across) > ramp.width / 2 || Math.abs(along) > ramp.length / 2) return -Infinity;
        return rampBases[i] + ramp.height * (along / ramp.length + 0.5);
    };
    const groundHeight = (x: number, z: number): number => {
        let height = terrainHeight(x, z);
        for (let i = 0; i < count; i++) {
            const h = onRamp(i, x, z);
            if (h > height) height = h;
        }
        return height;
    };
    const rampAt = (x: number, z: number): number => {
        let height = terrainHeight(x, z), found = -1;
        for (let i = 0; i < count; i++) {
            const h = onRamp(i, x, z);
            if (h > height) { height = h; found = i; }
        }
        return found;
    };
    const list: Collider[] = colliders.map(input => placeCollider(input, groundHeight));
    const model = terrain ? null : ground as GroundModel;
    return {
        terrain,
        colliders: list,
        grid: new SpatialGrid(list, model ? model.grid : DEFAULT_GRID),
        ramps: rampList,
        rampBases,
        bound: terrain ? terrain.size / 2 - 2 : model!.bound,
        border: borderOf(terrain ? terrain.size / 2 - 2 : model!.bound),
        groundHeight,
        terrainHeight,
        surfaceAt: model ? model.surface : ASPHALT,
        waterLevel: model ? model.waterLevel : -Infinity,
        fallLimit: model ? model.fallLimit : -Infinity,
        rampAt,
        queryBuffer: new Int32Array(list.length)
    };
}

function borderOf(bound: number): SimWorld['border'] {
    return { minX: -bound, maxX: bound, minZ: -bound, maxZ: bound };
}

/**
 * A collider input on the ground: base is the ground height at its centre;
 * a segment stands on the higher of its two ends (so a rail on a slope is
 * never lower than top at either end) and gets its midpoint; an obox's
 * axis is normalised.
 */
export function placeCollider(input: ColliderInput, groundHeight: (x: number, z: number) => number): Collider {
    if (input.kind === 'segment') {
        const base = Math.max(groundHeight(input.ax, input.az), groundHeight(input.bx, input.bz));
        return { ...input, x: (input.ax + input.bx) / 2, z: (input.az + input.bz) / 2, base };
    }
    if (input.kind === 'obox') {
        const length = Math.sqrt(input.ux * input.ux + input.uz * input.uz);
        return { ...input, ux: input.ux / length, uz: input.uz / length, base: groundHeight(input.x, input.z) };
    }
    return { ...input, base: groundHeight(input.x, input.z) };
}
