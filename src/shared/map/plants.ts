// Trees, palms and rocks with colliders (docs/phase-3-design.md, 11.2):
// a jittered grid per zone (a candidate per cell from a hash of the cell,
// E12), kept off the road corridors, areas, buildings and reserved places,
// plus palms along Main Street and the promenade. Shrubs, grass and other
// plants without a collider are the client's (looks only).
//
// Positions go into worldHash through the colliders: exactly rounded
// arithmetic only, rounded to millimetres.

import type { Vec2 } from './geometry.js';
import { pointInPolygon } from './geometry.js';
import { hashMix, hashUnit } from './buildings.js';
import { heightAt, surfaceAt, zoneAt, type Heightfield } from './heightfield.js';
import type { RoadArea } from './roadSchema.js';
import { insideCorridor, junctionRadius, type RoadNetwork } from './roadNetwork.js';
import { leftNormal, pointAt } from './spline.js';
import { boxContains, toMillimetre, type BoxIndex, type OBox } from './structures.js';
import { SURFACE, ZONE } from './types.js';

export type PlantKind = 'palm' | 'oak' | 'cypress' | 'boulder' | 'rock';

export interface Plant {
    kind: PlantKind;
    x: number;
    z: number;
    // Scale of the model (0.8 .. 1.25) and a seed for its looks
    size: number;
    seed: number;
}

// Collider per kind: trunk or rock radius (m) at size 1 and the top
// (Infinity: cannot be jumped over; rocks by their height). Boulder and rock
// are the kit's rock_boulder_l and rock_boulder_m.
export const PLANT_COLLIDERS: Record<PlantKind, { r: number; top: number }> = {
    palm: { r: 0.35, top: Infinity },
    oak: { r: 0.55, top: Infinity },
    cypress: { r: 0.45, top: Infinity },
    boulder: { r: 2.2, top: 2.61 },
    rock: { r: 1.2, top: 1.49 }
};

export interface PlantRule {
    zone: number;
    // Grid cell (m) and the share of cells that get a plant
    cell: number;
    density: number;
    // Kinds with weights (summing to 1)
    kinds: readonly [PlantKind, number][];
}

export const PLANT_RULES: readonly PlantRule[] = [
    { zone: ZONE.wild, cell: 20, density: 0.5, kinds: [['oak', 0.55], ['cypress', 0.1], ['rock', 0.2], ['boulder', 0.15]] },
    { zone: ZONE.hills, cell: 22, density: 0.45, kinds: [['oak', 0.6], ['rock', 0.2], ['boulder', 0.2]] },
    { zone: ZONE.ranch, cell: 34, density: 0.35, kinds: [['oak', 0.9], ['rock', 0.1]] },
    { zone: ZONE.cliffs, cell: 30, density: 0.25, kinds: [['boulder', 0.5], ['rock', 0.5]] },
    { zone: ZONE.residential, cell: 18, density: 0.3, kinds: [['cypress', 0.6], ['palm', 0.25], ['oak', 0.15]] },
    { zone: ZONE.park, cell: 14, density: 0.55, kinds: [['palm', 1]] },
    { zone: ZONE.beach, cell: 36, density: 0.2, kinds: [['palm', 1]] }
];

// Street palms (11.1): every STREET_PALM_SPACING m on the given sidewalk,
// this far from its road edge
export const STREET_PALMS: readonly { name: string; sides: readonly ('left' | 'right')[] }[] = [
    { name: 'Main Street', sides: ['left', 'right'] },
    { name: 'Ocean Boulevard', sides: ['right'] }
];
export const STREET_PALM_SPACING = 18;
export const STREET_PALM_INSET = 1.2;

// Clearances (m): from a road's corridor, an area, a building, a reserved place
export const PLANT_CORRIDOR_MARGIN = 2;
export const PLANT_AREA_MARGIN = 2;
export const PLANT_BUILDING_MARGIN = 1.5;
// Lowest ground above the water
const PLANT_MIN_HEIGHT = 0.5;
// Steepest ground under a plant: the gradient over ±1 m, tan 35° (a trunk
// on a cliff face would float over the ground below it)
export const PLANT_MAX_GRADE = 0.7;

/** The ground's gradient at (x, z): the height change per metre from central differences over ±1 m. */
export function groundGrade(hf: Heightfield, x: number, z: number): number {
    const gx = (heightAt(hf, x + 1, z) - heightAt(hf, x - 1, z)) / 2;
    const gz = (heightAt(hf, x, z + 1) - heightAt(hf, x, z - 1)) / 2;
    return Math.sqrt(gx * gx + gz * gz);
}

export interface PlantContext {
    net: RoadNetwork;
    hf: Heightfield;
    areas: readonly RoadArea[];
    boundary: readonly Vec2[];
    buildings: BoxIndex;
    reserved: readonly OBox[];
    // Breakwater lines (pois.json moles): rock armour along them
    moles?: readonly (readonly Vec2[])[];
}

function pick(rule: PlantRule, u: number): PlantKind {
    let sum = 0;
    for (const [kind, weight] of rule.kinds) {
        sum += weight;
        if (u < sum) return kind;
    }
    return rule.kinds[rule.kinds.length - 1][0];
}

// Distance from (x, z) to the polygon's outline is at least margin, or it lies outside
function clearOfArea(area: RoadArea, x: number, z: number, margin: number): boolean {
    if (pointInPolygon(area.polygon, x, z)) return false;
    const polygon = area.polygon;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [ax, az] = polygon[j], [bx, bz] = polygon[i];
        const ex = bx - ax, ez = bz - az;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = x - (ax + t * ex), dz = z - (az + t * ez);
        if (dx * dx + dz * dz < margin * margin) return false;
    }
    return true;
}

/** Whether a plant of radius r may stand at (x, z) (roads and street palms aside). */
export function plantFits(ctx: PlantContext, x: number, z: number, r: number, corridor: boolean): boolean {
    if (!pointInPolygon(ctx.boundary, x, z)) return false;
    if (heightAt(ctx.hf, x, z) < ctx.hf.spec.waterLevel + PLANT_MIN_HEIGHT) return false;
    const surface = surfaceAt(ctx.hf, x, z);
    if (surface === SURFACE.water || surface === SURFACE.wetSand) return false;
    if (groundGrade(ctx.hf, x, z) > PLANT_MAX_GRADE) return false;
    if (corridor && insideCorridor(ctx.net, x, z, PLANT_CORRIDOR_MARGIN + r)) return false;
    for (const area of ctx.areas) if (!clearOfArea(area, x, z, PLANT_AREA_MARGIN + r)) return false;
    if (ctx.buildings.contains(x, z, PLANT_BUILDING_MARGIN + r)) return false;
    for (const box of ctx.reserved) if (boxContains(box, x, z, r)) return false;
    return true;
}

// Palms along the named streets, outside the junctions
function streetPalms(ctx: PlantContext, out: Plant[]): void {
    const edges = [...ctx.net.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const street of STREET_PALMS) {
        for (const edge of edges) {
            if (edge.def.name !== street.name) continue;
            const startTrim = junctionRadius(ctx.net, ctx.net.nodes[edge.from]) + 4;
            const endTrim = edge.length - junctionRadius(ctx.net, ctx.net.nodes[edge.to]) - 4;
            for (const side of street.sides) {
                const sign = side === 'left' ? 1 : -1;
                const sidewalk = edge.profile.sidewalk[side];
                if (sidewalk < 2 * STREET_PALM_INSET) continue;
                const d = edge.halfWidth + STREET_PALM_INSET;
                for (let s = startTrim + STREET_PALM_SPACING / 2, k = 0; s < endTrim; s += STREET_PALM_SPACING, k++) {
                    const p = pointAt(edge.samples, s);
                    const [nx, nz] = leftNormal(p.tx, p.tz);
                    const x = toMillimetre(p.x + nx * sign * d), z = toMillimetre(p.z + nz * sign * d);
                    if (!plantFits(ctx, x, z, PLANT_COLLIDERS.palm.r, false)) continue;
                    const h = hashMix(hashMix(hashMix(0x9a1f, edge.index), sign + 2), k);
                    out.push({ kind: 'palm', x, z, size: toMillimetre(0.9 + 0.3 * hashUnit(h)), seed: h % 100000 });
                }
            }
        }
    }
}

// Talus at the foot of the rock faces (the cliffs): on a TALUS_CELL m
// jittered grid, a rock where the ground is gentle (at most TALUS_MAX_GRADE)
// and rock stands TALUS_DROP m higher within TALUS_REACH m (in one of eight
// directions), down into the shallow water at the foot
export const TALUS_CELL = 6;
export const TALUS_DENSITY = 0.8;
export const TALUS_REACH = 8;
export const TALUS_DROP = 4;
export const TALUS_MAX_GRADE = 0.5;
export const TALUS_MIN_HEIGHT = -0.8;
const TALUS_DIRECTIONS: readonly Vec2[] = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];

/** Whether (x, z) lies at the foot of a rock face: rock at least TALUS_DROP m higher within TALUS_REACH m. */
export function atRockFoot(hf: Heightfield, x: number, z: number): boolean {
    const h = heightAt(hf, x, z);
    for (const [dx, dz] of TALUS_DIRECTIONS) {
        for (let d = 2; d <= TALUS_REACH; d += 2.5) {
            const px = x + dx * d, pz = z + dz * d;
            if (surfaceAt(hf, px, pz) === SURFACE.rock && heightAt(hf, px, pz) >= h + TALUS_DROP) return true;
        }
    }
    return false;
}

function talusRocks(ctx: PlantContext, out: Plant[]): void {
    const spec = ctx.hf.spec;
    const extent = (spec.cols - 1) * spec.cellSize;
    const cells = Math.floor(extent / TALUS_CELL);
    for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
            const h = hashMix(hashMix(0x7a105, i), j);
            if (hashUnit(h) >= TALUS_DENSITY) continue;
            const x = toMillimetre(spec.originX + (i + 0.1 + 0.8 * hashUnit(hashMix(h, 1))) * TALUS_CELL);
            const z = toMillimetre(spec.originZ + (j + 0.1 + 0.8 * hashUnit(hashMix(h, 2))) * TALUS_CELL);
            const ground = heightAt(ctx.hf, x, z);
            if (ground < spec.waterLevel + TALUS_MIN_HEIGHT) continue;
            if (groundGrade(ctx.hf, x, z) > TALUS_MAX_GRADE || !atRockFoot(ctx.hf, x, z)) continue;
            const kind: PlantKind = hashUnit(hashMix(h, 3)) < 0.4 ? 'boulder' : 'rock';
            const size = toMillimetre(0.6 + 0.6 * hashUnit(hashMix(h, 4)));
            const r = PLANT_COLLIDERS[kind].r * size;
            if (!pointInPolygon(ctx.boundary, x, z)) continue;
            if (insideCorridor(ctx.net, x, z, PLANT_CORRIDOR_MARGIN + r)) continue;
            if (ctx.areas.some(area => !clearOfArea(area, x, z, PLANT_AREA_MARGIN + r))) continue;
            if (ctx.buildings.contains(x, z, PLANT_BUILDING_MARGIN + r)) continue;
            if (ctx.reserved.some(box => boxContains(box, x, z, r))) continue;
            // Clear of the plants placed so far
            if (out.some(p => {
                const reach = r + PLANT_COLLIDERS[p.kind].r * p.size;
                return (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < reach * reach;
            })) continue;
            out.push({ kind, x, z, size, seed: hashMix(h, 5) % 100000 });
        }
    }
}

// A breakwater's armour: every MOLE_STEP m along the line a boulder on the
// crest and a rock on each flank MOLE_FLANK m out (a quarter and three
// quarters of a step further on), sizes drawn from a hash of the mole and
// the step; a pile, so they may touch
export const MOLE_STEP = 2.6;
export const MOLE_FLANK = 2.8;

function moleRocks(ctx: PlantContext, out: Plant[]): void {
    (ctx.moles ?? []).forEach((line, m) => {
        let k = 0;
        for (let i = 1; i < line.length; i++) {
            const [ax, az] = line[i - 1], [bx, bz] = line[i];
            const dx = bx - ax, dz = bz - az;
            const length = Math.sqrt(dx * dx + dz * dz);
            const tx = dx / length, tz = dz / length;
            for (let s = i === 1 ? 0 : MOLE_STEP / 2; s <= length; s += MOLE_STEP, k++) {
                const h = hashMix(hashMix(0x3013, m), k);
                for (const [across, kind, min, ahead] of [[0, 'boulder', 1, 0], [MOLE_FLANK, 'rock', 0.8, 0.25], [-MOLE_FLANK, 'rock', 0.8, 0.75]] as const) {
                    const along = s + ahead * MOLE_STEP;
                    const x = toMillimetre(ax + tx * along - tz * across), z = toMillimetre(az + tz * along + tx * across);
                    const size = toMillimetre(min + 0.3 * hashUnit(hashMix(h, across === 0 ? 1 : across > 0 ? 2 : 3)));
                    const r = PLANT_COLLIDERS[kind].r * size;
                    // Not on a road, an area, a building or a reserved place
                    if (!pointInPolygon(ctx.boundary, x, z) || insideCorridor(ctx.net, x, z, PLANT_CORRIDOR_MARGIN + r)) continue;
                    if (ctx.areas.some(area => !clearOfArea(area, x, z, PLANT_AREA_MARGIN + r))) continue;
                    if (ctx.buildings.contains(x, z, PLANT_BUILDING_MARGIN + r) || ctx.reserved.some(box => boxContains(box, x, z, r))) continue;
                    out.push({ kind, x, z, size, seed: hashMix(h, across === 0 ? 4 : across > 0 ? 5 : 6) % 100000 });
                }
            }
        }
    });
}

/** Every plant with a collider: street palms, then the zones in PLANT_RULES order, row by row, then the talus at the rock faces and the breakwaters' armour. */
export function placePlants(ctx: PlantContext): Plant[] {
    const out: Plant[] = [];
    streetPalms(ctx, out);
    const spec = ctx.hf.spec;
    const minX = spec.originX, minZ = spec.originZ;
    const extent = (spec.cols - 1) * spec.cellSize;
    for (const rule of PLANT_RULES) {
        const cells = Math.floor(extent / rule.cell);
        for (let j = 0; j < cells; j++) {
            for (let i = 0; i < cells; i++) {
                const h = hashMix(hashMix(hashMix(0x51a7, rule.zone), i), j);
                if (hashUnit(h) >= rule.density) continue;
                // Jitter within the middle 80 % of the cell
                const x = toMillimetre(minX + (i + 0.1 + 0.8 * hashUnit(hashMix(h, 1))) * rule.cell);
                const z = toMillimetre(minZ + (j + 0.1 + 0.8 * hashUnit(hashMix(h, 2))) * rule.cell);
                if (zoneAt(ctx.hf, x, z) !== rule.zone) continue;
                const kind = pick(rule, hashUnit(hashMix(h, 3)));
                const size = toMillimetre(0.8 + 0.45 * hashUnit(hashMix(h, 4)));
                if (!plantFits(ctx, x, z, PLANT_COLLIDERS[kind].r * size, true)) continue;
                out.push({ kind, x, z, size, seed: hashMix(h, 5) % 100000 });
            }
        }
    }
    talusRocks(ctx, out);
    moleRocks(ctx, out);
    return out;
}
