// Footprints of the building kit's pieces that stand in the sim world
// (docs/phase-3-design.md, 8.2 and 11, deviation A23): buildings, landmarks,
// containers and rocks. The client places the kit piece's model at the same
// origin and heading (tools/models/buildings, public/models/kit), so what a
// car hits is what it sees. The values are the kit manifest's extras
// (footprint in the piece's own axes, local +z = its front); a test checks
// them against public/models/kit/manifest.json.
//
// Turned boxes here are exact: positions, axes and extents come from the
// road samples and the JSON sources with +, -, ×, ÷ and Math.sqrt only,
// rounded to millimetres and micro-units, so client and server build the
// same colliders in every engine (they go into worldHash).

import type { Vec2 } from './geometry.js';

export interface Footprint {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    height: number;
}

export const KIT_FOOTPRINTS = {
    arena_container_40: { minX: 0, maxX: 12.19, minZ: -1.22, maxZ: 1.22, height: 2.6 },
    arena_floodlight: { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5, height: 17.26 },
    beach_w8_f1: { minX: -4, maxX: 4, minZ: -11.4, maxZ: 0, height: 5.6 },
    beach_w9_f1_shop: { minX: -4.5, maxX: 4.5, minZ: -12.4, maxZ: 0, height: 6.29 },
    beach_w10_f2: { minX: -5, maxX: 5, minZ: -12.4, maxZ: 0, height: 8.64 },
    beach_w11_f2_shop: { minX: -5.5, maxX: 5.5, minZ: -13.4, maxZ: 0, height: 9.34 },
    lifeguard_tower: { minX: -1.6, maxX: 6.55, minZ: -3.4, maxZ: 0, height: 6.5 },
    downtown_b3_f1_a: { minX: -6, maxX: 6, minZ: -14, maxZ: 0, height: 5.5 },
    downtown_b3_f2_a: { minX: -6, maxX: 6, minZ: -14, maxZ: 0, height: 9 },
    downtown_b3_f3_a: { minX: -6, maxX: 6, minZ: -16, maxZ: 0, height: 12.5 },
    downtown_b4_f2_a: { minX: -8, maxX: 8, minZ: -16, maxZ: 0, height: 9 },
    downtown_b4_f3_a: { minX: -8, maxX: 8, minZ: -18, maxZ: 0, height: 12.5 },
    downtown_b5_f2_a: { minX: -10, maxX: 10, minZ: -18, maxZ: 0, height: 9 },
    downtown_b6_f3_corner: { minX: -12, maxX: 12, minZ: -20, maxZ: 0, height: 12.5 },
    revival_b2_f1_mission: { minX: -4, maxX: 4, minZ: -12, maxZ: 0, height: 6.38 },
    revival_b3_f1_deco: { minX: -6, maxX: 6, minZ: -14, maxZ: 0, height: 6.68 },
    revival_b3_f2_mission: { minX: -6, maxX: 6, minZ: -14, maxZ: 0, height: 10.28 },
    revival_b3_f3_deco: { minX: -6, maxX: 6, minZ: -16, maxZ: 0, height: 13.69 },
    revival_b4_f1_mission: { minX: -8, maxX: 8, minZ: -16, maxZ: 0, height: 6.78 },
    revival_b4_f2_deco: { minX: -8, maxX: 8, minZ: -16, maxZ: 0, height: 10.56 },
    revival_b5_f2_deco_corner: { minX: -10, maxX: 10, minZ: -18, maxZ: 0, height: 10.19 },
    industrial_b4_d24: { minX: -12, maxX: 12, minZ: -27, maxZ: 0, height: 9.46 },
    industrial_b6_d30_dock: { minX: -18, maxX: 18, minZ: -33, maxZ: 0, height: 11.91 },
    industrial_b8_d36: { minX: -24, maxX: 24, minZ: -36, maxZ: 0, height: 14.36 },
    landmark_diner: { minX: -7.5, maxX: 7.5, minZ: -8, maxZ: 0, height: 6.4 },
    landmark_gas_station: { minX: -6, maxX: 6, minZ: -16, maxZ: 0, height: 6.75 },
    landmark_lighthouse: { minX: -3.4, maxX: 3.4, minZ: -6.8, maxZ: 0, height: 22.91 },
    landmark_water_tower: { minX: -4.6, maxX: 4.6, minZ: -9.2, maxZ: 0, height: 21.71 },
    rock_boulder_l: { minX: -2.467, maxX: 3.066, minZ: -2.294, maxZ: 2.01, height: 2.61 },
    rock_boulder_m: { minX: -1.34, maxX: 1.435, minZ: -1.246, maxZ: 1.076, height: 1.49 },
    spanish_w11_f1_rect: { minX: -5.5, maxX: 5.5, minZ: -10, maxZ: 0, height: 6.6 },
    spanish_w12_f2_rect: { minX: -6, maxX: 6, minZ: -10, maxZ: 0, height: 9.6 },
    spanish_w13_f1_l: { minX: -6.5, maxX: 6.5, minZ: -13.5, maxZ: 0, height: 6.6 },
    spanish_w14_f1_garage: { minX: -7, maxX: 7, minZ: -11, maxZ: 0, height: 6.93 },
    spanish_w15_f2_l: { minX: -7.5, maxX: 7.5, minZ: -14.5, maxZ: 0, height: 9.79 }
} as const satisfies Record<string, Footprint>;

export type KitPieceId = keyof typeof KIT_FOOTPRINTS;

// A kit piece in the world: the model's origin and the direction of its
// local +z axis (unit length); its local x axis is (uz, -ux), as three.js
// turns a model by rotation.y = atan2(ux, uz)
export interface Placement {
    piece: KitPieceId;
    x: number;
    z: number;
    ux: number;
    uz: number;
}

// A turned box: centre, half extents along the local x and z axes, local z axis
export interface OBox {
    x: number;
    z: number;
    hw: number;
    hd: number;
    ux: number;
    uz: number;
}

// Rounded to micro-units and millimetres; -0 comes out as 0
export function toMicro(v: number): number {
    return Math.round(v * 1e6) / 1e6 + 0;
}

export function toMillimetre(v: number): number {
    return Math.round(v * 1000) / 1000 + 0;
}

/** The footprint of a placed piece as a turned box. */
export function placementBox(p: Placement): OBox {
    const f: Footprint = KIT_FOOTPRINTS[p.piece];
    const cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
    return {
        x: p.x + cx * p.uz + cz * p.ux,
        z: p.z - cx * p.ux + cz * p.uz,
        hw: (f.maxX - f.minX) / 2,
        hd: (f.maxZ - f.minZ) / 2,
        ux: p.ux,
        uz: p.uz
    };
}

/** The model origin of a piece whose footprint centre stands at (x, z), front along (ux, uz). */
export function placeByCentre(piece: KitPieceId, x: number, z: number, ux: number, uz: number): Placement {
    const f: Footprint = KIT_FOOTPRINTS[piece];
    const cx = (f.minX + f.maxX) / 2, cz = (f.minZ + f.maxZ) / 2;
    return {
        piece,
        x: toMillimetre(x - cx * uz - cz * ux),
        z: toMillimetre(z + cx * ux - cz * uz),
        ux, uz
    };
}

/**
 * The unit axis of a sim yaw (forward = (sin yaw, cos yaw)), rounded to
 * micro-units: the only place the map world turns an angle into a vector.
 */
export function yawAxis(yaw: number): [number, number] {
    return [toMicro(Math.sin(yaw)), toMicro(Math.cos(yaw))]; // determinism: rounded to 1e-6
}

/** The four corners of a turned box, grown by margin on every side. */
export function boxCorners(b: OBox, margin = 0): Vec2[] {
    const hw = b.hw + margin, hd = b.hd + margin;
    // Local x (uz, -ux), local z (ux, uz)
    const ax = b.uz * hw, az = -b.ux * hw;
    const bx = b.ux * hd, bz = b.uz * hd;
    return [
        [b.x - ax - bx, b.z - az - bz],
        [b.x + ax - bx, b.z + az - bz],
        [b.x + ax + bx, b.z + az + bz],
        [b.x - ax + bx, b.z - az + bz]
    ];
}

/** True when (x, z) lies inside the box grown by margin. */
export function boxContains(b: OBox, x: number, z: number, margin = 0): boolean {
    const dx = x - b.x, dz = z - b.z;
    const lx = dx * b.uz - dz * b.ux, lz = dx * b.ux + dz * b.uz;
    return Math.abs(lx) <= b.hw + margin && Math.abs(lz) <= b.hd + margin;
}

// Half extent of box b projected onto the unit axis (ax, az)
function projectedRadius(b: OBox, ax: number, az: number): number {
    return b.hw * Math.abs(b.uz * ax - b.ux * az) + b.hd * Math.abs(b.ux * ax + b.uz * az);
}

/** Separating axis test of two turned boxes, each grown by margin/2 (a gap under margin counts as overlap). */
export function boxesOverlap(a: OBox, b: OBox, margin = 0): boolean {
    const dx = b.x - a.x, dz = b.z - a.z;
    const axes: [number, number][] = [[a.uz, -a.ux], [a.ux, a.uz], [b.uz, -b.ux], [b.ux, b.uz]];
    for (const [ax, az] of axes) {
        const distance = Math.abs(dx * ax + dz * az);
        if (distance >= projectedRadius(a, ax, az) + projectedRadius(b, ax, az) + margin) return false;
    }
    return true;
}

/** Points on a grid of at most `step` m over the box grown by margin, corners and edges included. */
export function boxSamples(b: OBox, step: number, margin = 0): Vec2[] {
    const hw = b.hw + margin, hd = b.hd + margin;
    const nx = Math.max(1, Math.ceil(2 * hw / step)), nz = Math.max(1, Math.ceil(2 * hd / step));
    const out: Vec2[] = [];
    for (let i = 0; i <= nx; i++) {
        const lx = -hw + 2 * hw * i / nx;
        for (let j = 0; j <= nz; j++) {
            const lz = -hd + 2 * hd * j / nz;
            out.push([b.x + lx * b.uz + lz * b.ux, b.z - lx * b.ux + lz * b.uz]);
        }
    }
    return out;
}

// Turned boxes in buckets of BUCKET m, for the placement tests of
// buildings.ts and plants.ts
export class BoxIndex {
    private static readonly BUCKET = 32;
    private readonly cells = new Map<number, number[]>();
    readonly boxes: OBox[] = [];

    private static key(i: number, j: number): number {
        return (i + 4096) * 8192 + (j + 4096);
    }

    private range(x: number, z: number, r: number): [number, number, number, number] {
        const B = BoxIndex.BUCKET;
        return [Math.floor((x - r) / B), Math.floor((x + r) / B), Math.floor((z - r) / B), Math.floor((z + r) / B)];
    }

    add(b: OBox): void {
        const index = this.boxes.length;
        this.boxes.push(b);
        const [i0, i1, j0, j1] = this.range(b.x, b.z, b.hw + b.hd);
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const key = BoxIndex.key(i, j);
                const list = this.cells.get(key);
                if (list) list.push(index);
                else this.cells.set(key, [index]);
            }
        }
    }

    // Indices of the boxes whose buckets meet the square of half size r around (x, z), each once
    private near(x: number, z: number, r: number): number[] {
        const [i0, i1, j0, j1] = this.range(x, z, r);
        const found: number[] = [];
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                for (const index of this.cells.get(BoxIndex.key(i, j)) ?? []) if (!found.includes(index)) found.push(index);
            }
        }
        return found;
    }

    /** True when a box overlaps b (boxesOverlap with margin). */
    overlaps(b: OBox, margin = 0): boolean {
        for (const index of this.near(b.x, b.z, b.hw + b.hd + Math.max(0, margin))) {
            if (boxesOverlap(this.boxes[index], b, margin)) return true;
        }
        return false;
    }

    /** True when a box grown by margin contains (x, z). */
    contains(x: number, z: number, margin = 0): boolean {
        for (const index of this.near(x, z, margin)) if (boxContains(this.boxes[index], x, z, margin)) return true;
        return false;
    }
}
