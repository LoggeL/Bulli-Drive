// Base terrain of a map before the roads are cut in (docs/phase-3-design.md,
// 6.4 step 1): the coastline with sea floor and beach, hills as elliptic
// masses, flats that pull an area to a height (harbour, town), cliffs along
// the coast, a gentle tilt and fBm value noise from an integer hash (no
// Math.sin, design E12). Deterministic: the same base.json gives the same
// heights on every machine.

import * as v from 'valibot';
import { pointInPolygon, polylineDistance, signedPolygonDistance, type Vec2 } from '../../src/shared/map/geometry.js';

const Finite = v.pipe(v.number(), v.finite());
const Positive = v.pipe(v.number(), v.finite(), v.gtValue(0));
const NonNegative = v.pipe(v.number(), v.finite(), v.minValue(0));
const Point = v.tuple([Finite, Finite]);
const Polygon = v.pipe(v.array(Point), v.minLength(3));
const Ellipse = {
    id: v.string(),
    x: Finite,
    z: Finite,
    // Semi-axes along `axis` and across it
    radii: v.tuple([Positive, Positive]),
    // Direction of the first semi-axis, default +x
    axis: v.optional(Point),
    height: Finite
};

export const BaseTerrainSchema = v.strictObject({
    format: v.literal('bulli-base'),
    version: v.literal(1),
    mapId: v.string(),
    seed: v.pipe(v.number(), v.integer()),
    // Sea floor depth (negative) reached `shelf` metres off the coast
    sea: v.strictObject({ floor: v.pipe(v.number(), v.maxValue(0)), shelf: Positive }),
    // Land polygon; everything outside is sea. It may reach beyond the grid.
    coast: Polygon,
    // Beach rising from 0 at the water line to `top` over `width` metres,
    // then blending into the land over `blend` metres
    beach: v.strictObject({ width: Positive, top: NonNegative, blend: Positive }),
    // Land height: base + tilt · (p - tiltOrigin)
    land: v.strictObject({ base: Finite, tilt: Point, tiltOrigin: Point }),
    // The highest hill wins where hills overlap (a sum would stack them)
    hills: v.array(v.strictObject(Ellipse)),
    // Pull the land towards `height` (strength 0..1 in the centre, easing
    // out to the ellipse's edge), applied in order after the hills
    flats: v.array(v.strictObject({ ...Ellipse, strength: v.pipe(v.number(), v.minValue(0), v.maxValue(1)) })),
    // Cliff edge along the coast: within `plateau` metres of the line the
    // land is at least `height`, dropping to the sea over `face` metres of
    // coast distance; the effect fades out over `fade` metres beyond
    cliffs: v.array(v.strictObject({
        id: v.string(),
        line: v.pipe(v.array(Point), v.minLength(2)),
        height: Positive,
        face: Positive,
        plateau: NonNegative,
        fade: Positive
    })),
    noise: v.strictObject({
        amplitude: NonNegative,
        wavelength: Positive,
        octaves: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
        gain: v.pipe(v.number(), v.gtValue(0), v.maxValue(1))
    }),
    // Surface overrides of the natural ground (dunes, fields); later wins
    regions: v.array(v.strictObject({
        id: v.string(),
        surface: v.picklist(['grass', 'sand', 'dirt', 'gravel', 'rock']),
        polygon: Polygon
    }))
});

export type BaseTerrain = v.InferOutput<typeof BaseTerrainSchema>;

export function parseBaseTerrain(value: unknown): BaseTerrain {
    const parsed = v.safeParse(BaseTerrainSchema, value);
    if (!parsed.success) {
        const lines = parsed.issues.map(issue => `${issue.path?.map(p => String(p.key)).join('.') ?? ''}: ${issue.message}`);
        throw new Error(`invalid base terrain:\n  ${lines.join('\n  ')}`);
    }
    return parsed.output;
}

// 0 below 0, 1 above 1, smooth (C1) in between
export function smoothstep(t: number): number {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
}

// Integer hash of a lattice point to [-1, 1)
export function latticeValue(ix: number, iz: number, seed: number): number {
    let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x2545f491);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 2147483648 - 1;
}

// Value noise: lattice values at integer points, blended with smoothstep
export function valueNoise(x: number, z: number, seed: number): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = smoothstep(x - ix), fz = smoothstep(z - iz);
    const a = latticeValue(ix, iz, seed), b = latticeValue(ix + 1, iz, seed);
    const c = latticeValue(ix, iz + 1, seed), d = latticeValue(ix + 1, iz + 1, seed);
    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;
    return top + (bottom - top) * fz;
}

// Fractal sum of value noise, normalised to [-1, 1]: octave o has the
// wavelength wavelength / 2^o and the weight gain^o
export function fbm(x: number, z: number, seed: number, wavelength: number, octaves: number, gain: number): number {
    let sum = 0, norm = 0, weight = 1, scale = 1 / wavelength;
    for (let o = 0; o < octaves; o++) {
        sum += weight * valueNoise(x * scale, z * scale, seed + o * 7919);
        norm += weight;
        weight *= gain;
        scale *= 2;
    }
    return sum / norm;
}

// Normalised elliptic radius: 0 in the centre, 1 on the outline
export function ellipseRadius(e: { x: number; z: number; radii: readonly [number, number]; axis?: Vec2 }, x: number, z: number): number {
    let ux = 1, uz = 0;
    if (e.axis) {
        const len = Math.sqrt(e.axis[0] * e.axis[0] + e.axis[1] * e.axis[1]);
        ux = e.axis[0] / len;
        uz = e.axis[1] / len;
    }
    const dx = x - e.x, dz = z - e.z;
    const a = (dx * ux + dz * uz) / e.radii[0];
    const b = (-dx * uz + dz * ux) / e.radii[1];
    return Math.sqrt(a * a + b * b);
}

// Bell profile of a hill or flat: 1 in the centre, 0 at and beyond the
// outline, flat at both ends
export function bell(r: number): number {
    return smoothstep(1 - r);
}

export interface BaseSample {
    height: number;
    // Signed distance to the coastline, positive on land
    coast: number;
}

export function baseSample(base: BaseTerrain, x: number, z: number): BaseSample {
    const coast = signedPolygonDistance(base.coast, x, z);
    if (coast <= 0) return { height: base.sea.floor * smoothstep(-coast / base.sea.shelf), coast };

    let land = base.land.base
        + base.land.tilt[0] * (x - base.land.tiltOrigin[0])
        + base.land.tilt[1] * (z - base.land.tiltOrigin[1]);
    let hill = 0;
    for (const h of base.hills) hill = Math.max(hill, h.height * bell(ellipseRadius(h, x, z)));
    land += hill;
    for (const flat of base.flats) {
        const w = flat.strength * bell(ellipseRadius(flat, x, z));
        land += (flat.height - land) * w;
    }
    const inland = smoothstep((coast - base.beach.width) / base.beach.blend);
    land += base.noise.amplitude * inland
        * fbm(x, z, base.seed, base.noise.wavelength, base.noise.octaves, base.noise.gain);

    const beach = base.beach.top * smoothstep(coast / base.beach.width);
    let height = beach + (land - beach) * inland;
    for (const cliff of base.cliffs) {
        const near = 1 - smoothstep((polylineDistance(cliff.line, x, z) - cliff.plateau) / cliff.fade);
        if (near <= 0) continue;
        const cliffHeight = smoothstep(coast / cliff.face) * Math.max(land, cliff.height);
        height += (cliffHeight - height) * near;
    }
    return { height, coast };
}

export function baseHeight(base: BaseTerrain, x: number, z: number): number {
    return baseSample(base, x, z).height;
}

// Surface override of the regions at (x, z) (the last matching one), or null
export function regionSurface(base: BaseTerrain, x: number, z: number): BaseTerrain['regions'][number]['surface'] | null {
    let surface: BaseTerrain['regions'][number]['surface'] | null = null;
    for (const region of base.regions) if (pointInPolygon(region.polygon, x, z)) surface = region.surface;
    return surface;
}
