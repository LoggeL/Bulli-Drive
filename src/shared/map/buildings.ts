// Buildings along the roads (docs/phase-3-design.md, 11.2): lots on both
// sides of every edge, in the order of the edge IDs, facing the road. The
// zone behind the road decides the kit pieces, the setback and the gaps; a
// lot is dropped where it would reach into a road's corridor or an area,
// leave its zone, overlap a lot placed before, a landmark or another
// reserved place, stand in the water or on ground that differs by more than
// 2.5 m under it. Which piece and gap a lot gets comes from a hash of
// (edge, side, lot index) (E12), so moving one road only changes the
// buildings along that road.
//
// The lots are colliders (turned boxes) and go into worldHash: exactly
// rounded arithmetic only, positions in millimetres, axes in micro-units.

import { pointInPolygon } from './geometry.js';
import { heightAt, zoneAt, type Heightfield } from './heightfield.js';
import type { RoadArea } from './roadSchema.js';
import { insideCorridor, type RoadEdgeData, type RoadNetwork } from './roadNetwork.js';
import { leftNormal, pointAt } from './spline.js';
import {
    BoxIndex, boxesOverlap, boxSamples, KIT_FOOTPRINTS, placementBox, toMicro, toMillimetre,
    type KitPieceId, type OBox, type Placement
} from './structures.js';
import { ZONE } from './types.js';

export interface BuildingLot extends Placement {
    edge: string;
    side: 'left' | 'right';
    index: number;
    zone: number;
}

export interface LotRule {
    pieces: readonly KitPieceId[];
    // Distance of the front from the sidewalk's outer edge (m)
    setback: number;
    // Gap to the next lot along the road (m), drawn from [gapMin, gapMax]
    gapMin: number;
    gapMax: number;
}

// Table 11.1 with the kit's pieces (A23, A25). Downtown: closed rows of the
// four street styles; residential: detached Spanish Revival houses;
// industrial: halls; beach: shacks along the promenade with wide gaps, so
// the beach stays reachable from the road.
export const LOT_RULES: Readonly<Partial<Record<number, LotRule>>> = {
    [ZONE.downtown]: {
        pieces: [
            'downtown_b3_f1_a', 'downtown_b3_f2_a', 'downtown_b3_f3_a', 'downtown_b4_f2_a', 'downtown_b4_f3_a',
            'downtown_b5_f2_a', 'downtown_b6_f3_corner', 'revival_b2_f1_mission', 'revival_b3_f1_deco',
            'revival_b3_f2_mission', 'revival_b3_f3_deco', 'revival_b4_f1_mission', 'revival_b4_f2_deco',
            'revival_b5_f2_deco_corner'
        ],
        setback: 0.3, gapMin: 0, gapMax: 0
    },
    [ZONE.residential]: {
        pieces: ['spanish_w11_f1_rect', 'spanish_w12_f2_rect', 'spanish_w13_f1_l', 'spanish_w14_f1_garage', 'spanish_w15_f2_l'],
        setback: 6, gapMin: 4, gapMax: 12
    },
    [ZONE.industrial]: {
        pieces: ['industrial_b4_d24', 'industrial_b6_d30_dock', 'industrial_b8_d36'],
        setback: 10, gapMin: 6, gapMax: 16
    },
    [ZONE.beach]: {
        pieces: ['beach_w8_f1', 'beach_w9_f1_shop', 'beach_w10_f2', 'beach_w11_f2_shop'],
        setback: 3, gapMin: 12, gapMax: 28
    }
};

// A lot keeps this far from every road's corridor (m)
export const LOT_CORRIDOR_MARGIN = 0.25;
// Largest height difference of the ground under a lot (11.2) and the
// lowest ground above the water level
export const LOT_MAX_RELIEF = 2.5;
export const LOT_MIN_ABOVE_WATER = 0.5;
// After a dropped lot the next try starts this much further along (m)
export const LOT_RETRY_STEP = 2;
// Sample spacing over a lot's footprint (m): the heightfield's grid
const LOT_SAMPLE_STEP = 2;
// Lots next to each other may touch; boxes overlapping by less than this
// (rounding) still count as touching
const LOT_TOUCH = 0.05;
// Where the zone behind the road is read: this far beyond the sidewalk
const ZONE_PROBE = 8;

// ---- Hashing (E12) ----

// 32-bit FNV-1a of a string, then integer mixing: exact in every engine
export function hashString(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function hashMix(h: number, value: number): number {
    h = (h ^ value) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

// [0, 1) from a hash
export function hashUnit(h: number): number {
    return h / 4294967296;
}

export interface LotContext {
    net: RoadNetwork;
    hf: Heightfield;
    areas: readonly RoadArea[];
    // Places no lot may overlap (landmarks, jumps and their landings, spawns)
    reserved: readonly OBox[];
}

/** Whether a lot's footprint may stand where it is (everything but the other lots). */
export function lotFits(ctx: LotContext, box: OBox, zone: number): boolean {
    const samples = boxSamples(box, LOT_SAMPLE_STEP);
    let low = Infinity, high = -Infinity;
    for (const [x, z] of samples) {
        if (zoneAt(ctx.hf, x, z) !== zone) return false;
        if (insideCorridor(ctx.net, x, z, LOT_CORRIDOR_MARGIN)) return false;
        const h = heightAt(ctx.hf, x, z);
        if (h < low) low = h;
        if (h > high) high = h;
        for (const area of ctx.areas) if (pointInPolygon(area.polygon, x, z)) return false;
    }
    if (high - low > LOT_MAX_RELIEF || low < ctx.hf.spec.waterLevel + LOT_MIN_ABOVE_WATER) return false;
    for (const reserved of ctx.reserved) if (boxesOverlap(reserved, box)) return false;
    return true;
}

function sideLots(ctx: LotContext, edge: RoadEdgeData, side: 'left' | 'right', index: BoxIndex, out: BuildingLot[]): void {
    const sign = side === 'left' ? 1 : -1;
    const sidewalk = edge.profile.sidewalk[side];
    const edgeHash = hashMix(hashString(edge.id), sign > 0 ? 1 : 2);
    let s = 0, attempt = 0;
    while (s < edge.length) {
        const h = hashMix(edgeHash, attempt);
        attempt++;
        // The zone behind the road at the lot's start
        const probe = pointAt(edge.samples, Math.min(edge.length, s + 4));
        const [pnx, pnz] = leftNormal(probe.tx, probe.tz);
        const reach = edge.halfWidth + sidewalk + ZONE_PROBE;
        const zone = zoneAt(ctx.hf, probe.x + pnx * sign * reach, probe.z + pnz * sign * reach);
        const rule = LOT_RULES[zone];
        if (!rule) {
            s += LOT_RETRY_STEP;
            continue;
        }
        const piece = rule.pieces[h % rule.pieces.length];
        const f = KIT_FOOTPRINTS[piece];
        const width = f.maxX - f.minX;
        const centre = s + width / 2;
        if (centre + width / 2 > edge.length) break;
        const p = pointAt(edge.samples, centre);
        const [nx, nz] = leftNormal(p.tx, p.tz);
        // Front centre of the building at the sidewalk's edge plus the
        // setback, its front facing the road
        const d = edge.halfWidth + sidewalk + rule.setback;
        const lot: BuildingLot = {
            piece,
            x: toMillimetre(p.x + nx * sign * d),
            z: toMillimetre(p.z + nz * sign * d),
            ux: toMicro(-nx * sign),
            uz: toMicro(-nz * sign),
            edge: edge.id, side, index: attempt - 1, zone
        };
        const box = placementBox(lot);
        if (lotFits(ctx, box, zone) && !index.overlaps(box, -LOT_TOUCH)) {
            index.add(box);
            out.push(lot);
            const gap = rule.gapMin + (rule.gapMax - rule.gapMin) * hashUnit(hashMix(h, 7));
            s += width + gap;
        } else {
            s += LOT_RETRY_STEP;
        }
    }
}

/**
 * Every building lot of the map, edge by edge in ID order, left side before
 * right. Only paved roads get buildings: dirt and sand tracks run through
 * open country and along the beach.
 */
export function placeBuildings(ctx: LotContext): BuildingLot[] {
    const edges = ctx.net.edges
        .filter(edge => edge.profile.surface === 'asphalt' || edge.profile.surface === 'concrete')
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const index = new BoxIndex();
    const out: BuildingLot[] = [];
    for (const edge of edges) {
        sideLots(ctx, edge, 'left', index, out);
        sideLots(ctx, edge, 'right', index, out);
    }
    return out;
}
