// Street furniture of the curated map (docs/phase-3-design.md 11.1:
// Downtown "Laternen, Ampeln, Bänke, Hydranten, Mülleimer", Park/Plaza
// "Bänke"): street lights, traffic signals, fire hydrants, benches and trash
// cans on the sidewalks of the paved roads in Downtown and the park, placed
// from the road samples like the street palms (plants.ts), and a ring of
// benches round the plaza's fountain. Each piece has a
// small collider, as in the old city: a car on the sidewalk hits a light or
// a signal pole; a hydrant, a trash can or a bench can be jumped.
//
// Positions go into worldHash through the colliders: exactly rounded
// arithmetic only (samples, +, -, ×, ÷), rounded to millimetres.

import { pointInPolygon, type Vec2 } from './geometry.js';
import { zoneAt, type Heightfield } from './heightfield.js';
import type { Plant } from './plants.js';
import { PLANT_COLLIDERS } from './plants.js';
import type { RoadArea } from './roadSchema.js';
import { insideCorridor, isOnRoad, junctionRadius, JUNCTION_TRIM_EXTRA, type RoadEdgeData, type RoadNetwork } from './roadNetwork.js';
import { leftNormal, pointAt } from './spline.js';
import { boxContains, toMicro, toMillimetre, type BoxIndex, type OBox } from './structures.js';
import { isPaved, SURFACE, ZONE } from './types.js';

export type FurnitureKind = 'lamp' | 'signal' | 'hydrant' | 'trashCan' | 'bench';

export interface Furniture {
    kind: FurnitureKind;
    x: number;
    z: number;
    // The model's local +z axis (unit), its local x axis is (uz, -ux) (as
    // structures.ts): lights and signals reach along local +x over the road,
    // signal heads face local -z (the traffic they control), a bench faces
    // local +z (the road)
    ux: number;
    uz: number;
}

// Colliders: round posts (radius, top) and the bench as a turned box (half
// length along local x, half depth along local z)
export const FURNITURE_COLLIDERS = {
    lamp: { r: 0.2, top: 5.5 },
    signal: { r: 0.25, top: 7.5 },
    hydrant: { r: 0.2, top: 0.8 },
    trashCan: { r: 0.25, top: 1.05 },
    bench: { hw: 1.0, hd: 0.35, top: 0.95 }
} as const;

// The zones with street furniture
export const FURNITURE_ZONES: readonly number[] = [ZONE.downtown, ZONE.park];
// Street lights every LAMP_SPACING m, the first half a spacing after the
// junction (trim + 4 m, like the street palms): on a street with palms
// every 18 m they stand halfway between two palms
export const LAMP_SPACING = 36;
// From the road edge (m): lights, signals and hydrants near the curb
export const CURB_INSET = 0.6;
// Benches (with a trash can beside them) from the back of the sidewalk,
// between every other pair of lights, on sidewalks at least this wide
export const BENCH_BACK = 0.55;
export const BENCH_SIDEWALK = 3;
// The trash can this far along from its bench's middle
export const TRASH_CAN_OFFSET = 2.1;
// Benches round a fountain: this many on a ring of this radius, facing it,
// a trash can beside every other one
export const FOUNTAIN_BENCHES = 8;
export const FOUNTAIN_BENCH_RING = 11;
// The narrowest sidewalk with furniture
export const MIN_SIDEWALK = 1.5;
// Lights round the large lots (parking, the gas station): every
// LOT_LAMP_SPACING m along the rim, LOT_LAMP_INSET m inside it, the arm
// over the lot, clear of the road entering it by LOT_LAMP_ROAD_CLEAR m
export const LOT_LAMP_SPACING = 30;
export const LOT_LAMP_INSET = 1;
export const LOT_LAMP_ROAD_CLEAR = 2;
// A lot of at least this area (m²) gets lights
export const LIT_LOT_AREA = 3000;
// Clearances (m) round a piece's collider
const CLEAR_BUILDING = 0.2;
const CLEAR_OTHER = 0.6;

export interface FurnitureContext {
    net: RoadNetwork;
    hf: Heightfield;
    areas: readonly RoadArea[];
    boundary: readonly Vec2[];
    buildings: BoxIndex;
    reserved: readonly OBox[];
    plants: readonly Plant[];
    // Fountains on a square, with a ring of benches round them
    fountains: readonly Vec2[];
    // Lots with lights round their rim (litLots)
    lots?: readonly RoadArea[];
}

// Twice the signed area of a polygon (positive counter-clockwise in x-z)
function signedArea2(polygon: readonly Vec2[]): number {
    let sum = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) sum += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
    return sum;
}

/** The lots that get lights: paved, not a square, at least LIT_LOT_AREA large, not the arena (it has its masts). */
export function litLots(areas: readonly RoadArea[], arena: string): RoadArea[] {
    return areas.filter(area => area.id !== arena && area.markings !== 'plazaPavers' && (area.surface === 'asphalt' || area.surface === 'concrete')
        && Math.abs(signedArea2(area.polygon)) / 2 >= LIT_LOT_AREA);
}

/** Radius of a piece's footprint (the bench: its half length). */
export function furnitureRadius(kind: FurnitureKind): number {
    return kind === 'bench' ? FURNITURE_COLLIDERS.bench.hw : FURNITURE_COLLIDERS[kind].r;
}

/** The bench's collider as a turned box. */
export function benchBox(piece: Furniture): OBox {
    return { x: piece.x, z: piece.z, hw: FURNITURE_COLLIDERS.bench.hw, hd: FURNITURE_COLLIDERS.bench.hd, ux: piece.ux, uz: piece.uz };
}

function fits(ctx: FurnitureContext, placed: readonly Furniture[], kind: FurnitureKind, x: number, z: number): boolean {
    const r = furnitureRadius(kind);
    if (!pointInPolygon(ctx.boundary, x, z)) return false;
    if (!FURNITURE_ZONES.includes(zoneAt(ctx.hf, x, z))) return false;
    // Off every carriageway and every lot or square (isOnRoad includes the areas)
    if (isOnRoad(ctx.net, x, z)) return false;
    if (ctx.buildings.contains(x, z, r + CLEAR_BUILDING)) return false;
    for (const box of ctx.reserved) if (boxContains(box, x, z, r)) return false;
    for (const plant of ctx.plants) {
        const reach = r + PLANT_COLLIDERS[plant.kind].r * plant.size + CLEAR_OTHER;
        const dx = plant.x - x, dz = plant.z - z;
        if (dx * dx + dz * dz < reach * reach) return false;
    }
    for (const piece of placed) {
        const reach = r + furnitureRadius(piece.kind) + CLEAR_OTHER;
        const dx = piece.x - x, dz = piece.z - z;
        if (dx * dx + dz * dz < reach * reach) return false;
    }
    return true;
}

// A piece `d` m to the side (+1 left, -1 right) of station s, its local +z
// along the tangent, against it, or towards the road
function put(ctx: FurnitureContext, out: Furniture[], edge: RoadEdgeData, kind: FurnitureKind, s: number, sign: number, d: number,
    face: 'along' | 'against' | 'road'): void {
    const p = pointAt(edge.samples, s);
    const [nx, nz] = leftNormal(p.tx, p.tz);
    const x = toMillimetre(p.x + nx * sign * d), z = toMillimetre(p.z + nz * sign * d);
    if (!fits(ctx, out, kind, x, z)) return;
    let ux: number, uz: number;
    if (face === 'along') [ux, uz] = [p.tx, p.tz];
    else if (face === 'against') [ux, uz] = [-p.tx, -p.tz];
    else [ux, uz] = [-nx * sign, -nz * sign];
    out.push({ kind, x, z, ux: toMillimetre(ux), uz: toMillimetre(uz) });
}

// Local +x of a light towards the road: local x = (uz, -ux) = -n · sign
// with n = leftNormal(t) = (tz, -tx), so local +z = (sign · nz, -sign · nx)
// = -sign · t: against the tangent on the left side (sign +1), along it on
// the right
function lightFacing(sign: number): 'along' | 'against' {
    return sign > 0 ? 'against' : 'along';
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The blocks' furniture keeps this far from a junction's centre: its trim
// radius + 4 m (like the street palms), and at a junction trimmed wider than
// the default (acute angles, the diagonals: cars swing wide out of their
// long curves) that surplus once more
function clearAfter(net: RoadNetwork, node: number): number {
    const data = net.nodes[node];
    const trim = junctionRadius(net, data);
    // (0 at joints and ends: no surplus there)
    let half = 0;
    for (const end of data.ends) half = Math.max(half, net.edges[end.edge].halfWidth);
    return trim + 4 + Math.max(0, trim - (half + JUNCTION_TRIM_EXTRA));
}

function furnished(edge: RoadEdgeData): boolean {
    return isPaved(SURFACE[edge.profile.surface]) && (edge.profile.sidewalk.left >= MIN_SIDEWALK || edge.profile.sidewalk.right >= MIN_SIDEWALK);
}

// Benches (and trash cans) on the ring round each fountain: on its square
// (an area), off the roads and their sidewalks, facing the fountain
function fountainBenches(ctx: FurnitureContext, out: Furniture[]): void {
    for (const [fx, fz] of ctx.fountains) {
        for (let k = 0; k < FOUNTAIN_BENCHES; k++) {
            // Starting half a step off north, clockwise seen from above
            const a = (k + 0.5) * 2 * Math.PI / FOUNTAIN_BENCHES;
            const sx = Math.sin(a), sz = Math.cos(a);
            for (const [kind, along] of k % 2 === 0 ? [['bench', 0], ['trashCan', TRASH_CAN_OFFSET]] as const : [['bench', 0]] as const) {
                // Along the ring's tangent (cos a, -sin a) from the bench
                const x = toMillimetre(fx + sx * FOUNTAIN_BENCH_RING + sz * along);
                const z = toMillimetre(fz + sz * FOUNTAIN_BENCH_RING - sx * along);
                if (!ctx.areas.some(area => pointInPolygon(area.polygon, x, z)) || insideCorridor(ctx.net, x, z, furnitureRadius(kind))) continue;
                out.push({ kind, x, z, ux: toMillimetre(-sx), uz: toMillimetre(-sz) });
            }
        }
    }
}

// Lights round each lit lot: along every side, LOT_LAMP_INSET inside,
// the arm (local +x) pointing into the lot; not on the road that enters
// it, the spawns, a jump's run-up or landing, a landmark, a plant or
// another piece
function lotLamps(ctx: FurnitureContext, out: Furniture[]): void {
    for (const area of ctx.lots ?? []) {
        const polygon = area.polygon;
        const inward = signedArea2(polygon) > 0 ? 1 : -1;
        for (let i = 0; i < polygon.length; i++) {
            const [ax, az] = polygon[i], [bx, bz] = polygon[(i + 1) % polygon.length];
            const length = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
            const tx = (bx - ax) / length, tz = (bz - az) / length;
            // Inward normal: left of the side's direction on a counter-clockwise polygon
            const nx = -tz * inward, nz = tx * inward;
            const count = Math.floor(length / LOT_LAMP_SPACING);
            const first = (length - (count - 1) * LOT_LAMP_SPACING) / 2;
            for (let k = 0; k < count; k++) {
                const s = first + k * LOT_LAMP_SPACING;
                const x = toMillimetre(ax + tx * s + nx * LOT_LAMP_INSET), z = toMillimetre(az + tz * s + nz * LOT_LAMP_INSET);
                if (!lotLampFits(ctx, out, x, z)) continue;
                // Local x = (uz, -ux) = the inward normal
                out.push({ kind: 'lamp', x, z, ux: toMicro(-nz), uz: toMicro(nx) });
            }
        }
    }
}

function lotLampFits(ctx: FurnitureContext, placed: readonly Furniture[], x: number, z: number): boolean {
    const r = FURNITURE_COLLIDERS.lamp.r;
    if (!pointInPolygon(ctx.boundary, x, z)) return false;
    if (insideCorridor(ctx.net, x, z, LOT_LAMP_ROAD_CLEAR + r)) return false;
    if (ctx.buildings.contains(x, z, r + CLEAR_BUILDING)) return false;
    for (const box of ctx.reserved) if (boxContains(box, x, z, r)) return false;
    for (const plant of ctx.plants) {
        const reach = r + PLANT_COLLIDERS[plant.kind].r * plant.size + CLEAR_OTHER;
        const dx = plant.x - x, dz = plant.z - z;
        if (dx * dx + dz * dz < reach * reach) return false;
    }
    for (const piece of placed) {
        const reach = r + furnitureRadius(piece.kind) + CLEAR_OTHER;
        const dx = piece.x - x, dz = piece.z - z;
        if (dx * dx + dz * dz < reach * reach) return false;
    }
    return true;
}

/**
 * Every piece of street furniture: the signals at the signalled junctions
 * (nodes in id order), then per edge (id order) a hydrant, the lights, the
 * benches with their trash cans, then the benches round the fountains and
 * the lights round the lots.
 */
export function placeFurniture(ctx: FurnitureContext): Furniture[] {
    const out: Furniture[] = [];
    const { net } = ctx;
    // Signals: at a signalled junction one pole per approach, on the right
    // of the incoming lanes a metre before the junction's fill, the arm over
    // the lanes, the heads towards the traffic
    for (const node of [...net.nodes].sort(byId)) {
        if (node.def.kind !== 'junction' || node.def.junction?.control !== 'signal') continue;
        const trim = junctionRadius(net, node);
        for (const end of node.ends) {
            const edge = net.edges[end.edge];
            if (!furnished(edge)) continue;
            // Arriving at its end: the right side, the traffic along the
            // tangent; leaving from its start: the left side, the traffic
            // against it (only with lanes that way)
            if (!end.atStart && edge.profile.lanes[0] > 0 && edge.profile.sidewalk.right >= 1) {
                put(ctx, out, edge, 'signal', edge.length - trim - 1, -1, edge.halfWidth + CURB_INSET, 'along');
            }
            if (end.atStart && edge.profile.lanes[1] > 0 && edge.profile.sidewalk.left >= 1) {
                put(ctx, out, edge, 'signal', trim + 1, 1, edge.halfWidth + CURB_INSET, 'against');
            }
        }
    }
    for (const edge of [...net.edges].sort(byId)) {
        if (!furnished(edge)) continue;
        const start = clearAfter(net, edge.from);
        const end = edge.length - clearAfter(net, edge.to);
        if (end - start < 12) continue;
        for (const sign of [1, -1]) {
            const sidewalk = sign > 0 ? edge.profile.sidewalk.left : edge.profile.sidewalk.right;
            if (sidewalk < MIN_SIDEWALK) continue;
            // A hydrant near the end of the block on the right side, where
            // the traffic slows for the junction (not behind a junction,
            // where turning cars run wide)
            if (sign < 0) put(ctx, out, edge, 'hydrant', end - 3, sign, edge.halfWidth + CURB_INSET, 'road');
            for (let s = start + LAMP_SPACING / 2; s < end; s += LAMP_SPACING) {
                put(ctx, out, edge, 'lamp', s, sign, edge.halfWidth + CURB_INSET, lightFacing(sign));
            }
            if (sidewalk < BENCH_SIDEWALK) continue;
            for (let s = start + LAMP_SPACING; s < end - 2; s += 2 * LAMP_SPACING) {
                put(ctx, out, edge, 'bench', s, sign, edge.halfWidth + sidewalk - BENCH_BACK, 'road');
                put(ctx, out, edge, 'trashCan', s + TRASH_CAN_OFFSET, sign, edge.halfWidth + sidewalk - BENCH_BACK, 'road');
            }
        }
    }
    fountainBenches(ctx, out);
    lotLamps(ctx, out);
    return out;
}
