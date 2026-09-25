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

export interface PlantContext {
    net: RoadNetwork;
    hf: Heightfield;
    areas: readonly RoadArea[];
    boundary: readonly Vec2[];
    buildings: BoxIndex;
    reserved: readonly OBox[];
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

/** Every plant with a collider: street palms, then the zones in PLANT_RULES order, row by row. */
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
    return out;
}
