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
    // Pieces for the ends of a closed row (front round both corners): the
    // first and last lot of a row at a junction, a road's end or a gap
    corners?: readonly KitPieceId[];
    // Distance of the front from the sidewalk's outer edge (m)
    setback: number;
    // Gap to the next lot along the road (m), drawn from [gapMin, gapMax]
    gapMin: number;
    gapMax: number;
}

// Table 11.1 with the kit's pieces (A23, A25). Downtown: closed rows of the
// four street styles, a corner building at each end; residential: detached
// Spanish Revival houses; industrial: halls; beach: shacks along the
// promenade with wide gaps, so the beach stays reachable from the road.
export const LOT_RULES: Readonly<Partial<Record<number, LotRule>>> = {
    [ZONE.downtown]: {
        pieces: [
            'downtown_b3_f1_a', 'downtown_b3_f2_a', 'downtown_b3_f3_a', 'downtown_b4_f2_a', 'downtown_b4_f3_a',
            'downtown_b5_f2_a', 'downtown_b6_f3_corner', 'revival_b2_f1_mission', 'revival_b3_f1_deco',
            'revival_b3_f2_mission', 'revival_b3_f3_deco', 'revival_b4_f1_mission', 'revival_b4_f2_deco',
            'revival_b5_f2_deco_corner'
        ],
        corners: [
            'downtown_b6_f3_corner', 'revival_b5_f2_deco_corner', 'downtown_b4_f3_corner', 'downtown_b3_f2_corner',
            'revival_b3_f2_mission_corner'
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
// The first lot of a row moves back towards the dropped try before it in
// halving steps, down to this (m): a row starts right behind the corner
export const LOT_SNAP = 0.25;
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

const pieceWidth = (piece: KitPieceId) => KIT_FOOTPRINTS[piece].maxX - KIT_FOOTPRINTS[piece].minX;

// The pieces of a pool narrow enough for `room` m, widest first (ties by id)
function fitting(pool: readonly KitPieceId[], room: number): KitPieceId[] {
    return pool.filter(piece => pieceWidth(piece) <= room + 1e-9)
        .sort((a, b) => pieceWidth(b) - pieceWidth(a) || (a < b ? -1 : a > b ? 1 : 0));
}

interface SideRow {
    ctx: LotContext;
    edge: RoadEdgeData;
    side: 'left' | 'right';
    sign: number;
    sidewalk: number;
    index: BoxIndex;
}

// The zone behind the road `ahead` m along from s
function zoneBehind(row: SideRow, s: number): number {
    const { edge, sign, sidewalk } = row;
    const probe = pointAt(edge.samples, Math.min(edge.length, Math.max(0, s)));
    const [pnx, pnz] = leftNormal(probe.tx, probe.tz);
    const reach = edge.halfWidth + sidewalk + ZONE_PROBE;
    return zoneAt(row.ctx.hf, probe.x + pnx * sign * reach, probe.z + pnz * sign * reach);
}

// The lot of `piece` from station s to s + its width, if it may stand there
function tryLot(row: SideRow, piece: KitPieceId, s: number, rule: LotRule, zone: number, index: number): BuildingLot | null {
    const { edge, sign, sidewalk, side } = row;
    const width = pieceWidth(piece);
    if (s < 0 || s + width > edge.length) return null;
    const p = pointAt(edge.samples, s + width / 2);
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
        edge: edge.id, side, index, zone
    };
    const box = placementBox(lot);
    return lotFits(row.ctx, box, zone) && !row.index.overlaps(box, -LOT_TOUCH) ? lot : null;
}

// A row that starts after a dropped try at `before` moves back towards it:
// halving the step while the lot still fits, down to LOT_SNAP
function snapBack(row: SideRow, piece: KitPieceId, before: number, s: number, rule: LotRule, zone: number, index: number): { lot: BuildingLot; s: number } | null {
    let lo = before, hi = s, best: BuildingLot | null = null;
    while (hi - lo > LOT_SNAP) {
        const mid = (lo + hi) / 2;
        const lot = tryLot(row, piece, mid, rule, zone, index);
        if (lot) { best = lot; hi = mid; } else lo = mid;
    }
    return best ? { lot: best, s: hi } : null;
}

// The narrowest piece of a rule
function minWidth(rule: LotRule): number {
    return Math.min(...rule.pieces.map(pieceWidth));
}

// The row's last lot at the far end: `piece` ending as close to the edge's
// end as it fits, scanning back in LOT_RETRY_STEP and then moving forward
// towards the dropped try in halving steps; null where it fits nowhere
// within the zone
function cornerFromEnd(row: SideRow, piece: KitPieceId, rule: LotRule, zone: number): { lot: BuildingLot; s: number } | null {
    const width = pieceWidth(piece);
    for (let e = row.edge.length, k = 0; e - width >= 0; e -= LOT_RETRY_STEP, k++) {
        if (zoneBehind(row, e - 4) !== zone) return null;
        let lot = tryLot(row, piece, e - width, rule, zone, -1);
        if (!lot) continue;
        let lo = e - width;
        if (k > 0) {
            let hi = lo + LOT_RETRY_STEP;
            while (hi - lo > LOT_SNAP) {
                const mid = (lo + hi) / 2;
                const next = tryLot(row, piece, mid, rule, zone, -1);
                if (next) { lot = next; lo = mid; } else hi = mid;
            }
        }
        return { lot, s: lo };
    }
    return null;
}

function place(row: SideRow, lot: BuildingLot, out: BuildingLot[]): void {
    row.index.add(placementBox(lot));
    out.push(lot);
}

// Whether a node ends the rows along its roads (a junction or a dead end;
// through a joint the road and its rows go on)
function rowEnd(net: RoadNetwork, node: number): boolean {
    return net.nodes[node].def.kind !== 'joint';
}

function sideLots(ctx: LotContext, edge: RoadEdgeData, side: 'left' | 'right', index: BoxIndex, out: BuildingLot[]): void {
    const sign = side === 'left' ? 1 : -1;
    const row: SideRow = { ctx, edge, side, sign, sidewalk: edge.profile.sidewalk[side], index };
    const edgeHash = hashMix(hashString(edge.id), sign > 0 ? 1 : 2);
    let attempt = 0;
    // The row's last lot first, at the far end: a corner piece where the
    // road ends at a junction (or dead end), as close to it as it fits
    let limit = edge.length;
    const endZone = zoneBehind(row, edge.length - 4);
    const endRule = LOT_RULES[endZone];
    if (endRule?.corners && rowEnd(ctx.net, edge.to)) {
        const h = hashMix(edgeHash, 0x7fffffff);
        const hashed = endRule.corners[h % endRule.corners.length];
        // The drawn corner piece, else the narrower ones (a short block)
        const candidates = [hashed, ...fitting(endRule.corners, pieceWidth(hashed) - 1)];
        for (const piece of candidates) {
            const end = cornerFromEnd(row, piece, endRule, endZone);
            if (!end) continue;
            place(row, end.lot, out);
            limit = end.s;
            break;
        }
    }
    // Then from the start: a corner piece first after a junction or a gap,
    // then the zone's pieces; where the next one does not fit before the
    // last lot, the widest one that does
    let s = 0;
    let rowStart = rowEnd(ctx.net, edge.from);
    let dropped = false;
    while (s < limit) {
        const h = hashMix(edgeHash, attempt);
        attempt++;
        // The zone behind the road at the lot's start
        const zone = zoneBehind(row, Math.min(edge.length, s + 4));
        const rule = LOT_RULES[zone];
        if (!rule) {
            s += LOT_RETRY_STEP;
            rowStart = dropped = true;
            continue;
        }
        const pool = rowStart && rule.corners ? rule.corners : rule.pieces;
        let piece = pool[h % pool.length];
        const room = limit - s;
        if (pieceWidth(piece) > room) {
            // The widest piece that fits before the limit, a corner piece
            // first where the row starts or ends here
            const narrower = rule.corners && (rowStart || limit === edge.length)
                ? [...fitting(rule.corners, room), ...fitting(rule.pieces, room)]
                : fitting(rule.pieces, room);
            if (!narrower.length) break;
            piece = narrower[0];
        } else if (rule.corners && !rowStart && limit === edge.length && rowEnd(ctx.net, edge.to) && room - pieceWidth(piece) < minWidth(rule)) {
            // The row's last lot without an end corner: one if it fits
            piece = fitting(rule.corners, room)[0] ?? piece;
        }
        const width = pieceWidth(piece);
        let lot = tryLot(row, piece, s, rule, zone, attempt - 1);
        let start = s;
        // A row's first lot after a dropped try moves up to the corner
        if (lot && dropped) {
            const snapped = snapBack(row, piece, s - LOT_RETRY_STEP, s, rule, zone, attempt - 1);
            if (snapped) { lot = snapped.lot; start = snapped.s; }
        }
        if (lot) {
            place(row, lot, out);
            rowStart = dropped = false;
            const gap = rule.gapMin + (rule.gapMax - rule.gapMin) * hashUnit(hashMix(h, 7));
            s = start + width + gap;
        } else {
            s += LOT_RETRY_STEP;
            rowStart = dropped = true;
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
