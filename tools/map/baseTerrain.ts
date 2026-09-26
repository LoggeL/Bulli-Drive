// Base terrain of a map before the roads are cut in (docs/phase-3-design.md,
// 6.4 step 1): the coastline with sea floor and beach, hills as elliptic
// masses, ridges along spine lines with a sharp crest, canyons cut along
// lines, flats that pull an area to a height (harbour, town), cliffs along
// the coast, a gentle tilt and value noise from an integer hash (no
// Math.sin, design E12): fBm blended with ridged noise, its domain warped,
// its amplitude set per region. Deterministic: the same base.json gives the
// same heights on every machine and in every engine (only exactly rounded
// operations, tests/shared/map/determinism.test.ts).

import * as v from 'valibot';
import { pointInPolygon, polylineDistance, signedPolygonDistance, type Vec2 } from '../../src/shared/map/geometry.js';
import { catmullRomChain, evalCubic, type CurvePoint } from '../../src/shared/map/spline.js';

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
    // An irregular face (`vary`, optional): its edge comes up to `face` of
    // the face width closer to the sea (value noise of `wavelength` m along
    // the coast: bays and headlands), gullies cut its foot up to `gullies` m
    // inland (noise of `gullyWavelength` m), and on the headlands (where the
    // edge comes out) the foot reaches up to `headlands` m into the sea.
    // `height` (optional) varies the cliff's height by up to that share
    // (two octaves of noise of `heightWavelength` m): full on the face,
    // easing back to `height` over `heightReach` m inland of the plain face
    // width, and only as far as the bake's keep weight allows (none on and
    // next to the roads and areas, bakeTerrain.ts terrainKeep), so the roads
    // on the plateau keep their profile.
    cliffs: v.array(v.strictObject({
        id: v.string(),
        line: v.pipe(v.array(Point), v.minLength(2)),
        height: Positive,
        face: Positive,
        plateau: NonNegative,
        fade: Positive,
        vary: v.optional(v.strictObject({
            face: v.pipe(v.number(), v.minValue(0), v.maxValue(0.9)),
            wavelength: Positive,
            gullies: NonNegative,
            gullyWavelength: Positive,
            headlands: v.optional(NonNegative),
            height: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(0.6))),
            heightWavelength: v.optional(Positive),
            heightReach: v.optional(Positive)
        }))
    })),
    // Breakwaters: a spit along `line` reaching `height` on its crest, down
    // to the ground (or the sea floor) over `width` m to each side with the
    // bell profile; the highest ground wins
    moles: v.optional(v.array(v.strictObject({
        id: v.string(),
        line: v.pipe(v.array(Point), v.minLength(2)),
        height: Finite,
        width: Positive
    }))),
    // A view kept open (a lookout): in the wedge from `from` towards `to`
    // (half width `spread` · the distance along it, easing out beyond),
    // out to `length` m (easing out over its last 30 %), the
    // ground stays below `height` - `slope` · the distance along the wedge
    // (after the noise), as far as the bake's keep weight allows (not on
    // the roads)
    views: v.optional(v.array(v.strictObject({
        id: v.string(),
        from: Point,
        to: Point,
        height: Finite,
        slope: NonNegative,
        spread: Positive,
        length: Positive
    }))),
    // Ridges: a crest along `line` ([x, z, height] per vertex; the line is
    // smoothed as a centripetal Catmull-Rom spline, the height interpolated
    // along it), falling to 0 at `width` metres with the bell profile of the
    // hills: a rounded crest and a soft foot. Like hills, the highest wins.
    ridges: v.optional(v.array(v.strictObject({
        id: v.string(),
        line: v.pipe(v.array(v.tuple([Finite, Finite, Finite])), v.minLength(2)),
        width: Positive
    }))),
    // Canyons and gullies: cut `depth` metres deep along `line` (smoothed
    // like a ridge line) with the bell profile over `width` metres
    canyons: v.optional(v.array(v.strictObject({
        id: v.string(),
        line: v.pipe(v.array(Point), v.minLength(2)),
        depth: Positive,
        width: Positive
    }))),
    noise: v.strictObject({
        amplitude: NonNegative,
        wavelength: Positive,
        octaves: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
        gain: v.pipe(v.number(), v.gtValue(0), v.maxValue(1)),
        // Share of ridged noise (1 - |n|)² in the mix, 0 = plain fBm
        ridged: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
        // Domain warp: the noise is read at a position moved by up to
        // `amplitude` metres along a second noise of `wavelength`
        warp: v.optional(v.strictObject({ amplitude: NonNegative, wavelength: Positive })),
        // Amplitude per region: inside the polygon `amplitude`, blending over
        // `blend` metres across its outline (later regions win)
        regions: v.optional(v.array(v.strictObject({ id: v.string(), polygon: Polygon, amplitude: NonNegative, blend: Positive })))
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

// Ridged fBm: each octave is (1 - |n|)² of the same value noise as fbm
// (sharp where the noise crosses 0), mapped from [0, 1] to [-1, 1]
export function ridgedFbm(x: number, z: number, seed: number, wavelength: number, octaves: number, gain: number): number {
    return fbmPair(x, z, seed, wavelength, octaves, gain).ridged;
}

// fbm and ridgedFbm from one pass over the octaves (one value noise each)
export function fbmPair(x: number, z: number, seed: number, wavelength: number, octaves: number, gain: number): { plain: number; ridged: number } {
    let plain = 0, ridged = 0, norm = 0, weight = 1, scale = 1 / wavelength;
    for (let o = 0; o < octaves; o++) {
        const n = valueNoise(x * scale, z * scale, seed + o * 7919);
        const r = 1 - Math.abs(n);
        plain += weight * n;
        ridged += weight * r * r;
        norm += weight;
        weight *= gain;
        scale *= 2;
    }
    return { plain: plain / norm, ridged: 2 * ridged / norm - 1 };
}

// Seed offsets of the two warp noises (x and z)
export const WARP_SEED_X = 4099;
export const WARP_SEED_Z = 8209;

// The noise of base.json at (x, z): domain warp, then fBm and ridged fBm
// mixed by `ridged`; in [-1, 1]
export function terrainNoise(noise: BaseTerrain['noise'], seed: number, x: number, z: number): number {
    if (noise.warp && noise.warp.amplitude > 0) {
        const w = noise.warp;
        const dx = w.amplitude * fbm(x, z, seed + WARP_SEED_X, w.wavelength, 2, 0.5);
        const dz = w.amplitude * fbm(x, z, seed + WARP_SEED_Z, w.wavelength, 2, 0.5);
        x += dx;
        z += dz;
    }
    const share = noise.ridged ?? 0;
    if (share <= 0) return fbm(x, z, seed, noise.wavelength, noise.octaves, noise.gain);
    const both = fbmPair(x, z, seed, noise.wavelength, noise.octaves, noise.gain);
    return both.plain + (both.ridged - both.plain) * share;
}

// Noise amplitude at (x, z): the base amplitude, moved towards each
// region's amplitude by smoothstep(1/2 + d / blend), d the signed distance
// to the region's outline (positive inside): half-way on the outline, fully
// `blend` / 2 inside
export function noiseAmplitude(noise: BaseTerrain['noise'], x: number, z: number): number {
    let amplitude = noise.amplitude;
    for (const region of noise.regions ?? []) {
        // Beyond blend / 2 outside the polygon's box the weight is 0
        const box = polygonBox(region.polygon, region.blend / 2);
        if (x < box[0] || x > box[2] || z < box[1] || z > box[3]) continue;
        const w = smoothstep(0.5 + signedPolygonDistance(region.polygon, x, z) / region.blend);
        amplitude += (region.amplitude - amplitude) * w;
    }
    return amplitude;
}

// Bounding box of a polygon grown by `margin`: minX, minZ, maxX, maxZ (cached)
const boxes = new WeakMap<object, [number, number, number, number]>();
function polygonBox(polygon: readonly (readonly [number, number])[], margin: number): [number, number, number, number] {
    let box = boxes.get(polygon);
    if (!box) {
        box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, z] of polygon) {
            if (x < box[0]) box[0] = x;
            if (z < box[1]) box[1] = z;
            if (x > box[2]) box[2] = x;
            if (z > box[3]) box[3] = z;
        }
        box = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
        boxes.set(polygon, box);
    }
    return box;
}

// Distance to a polyline and the interpolated third coordinate of the
// nearest point (the ridge height), both at once
export function polylineNearest(line: readonly (readonly [number, number, number])[], x: number, z: number): { distance: number; value: number } {
    let best = Infinity, value = line[0][2];
    for (let i = 1; i < line.length; i++) {
        const [ax, az, ah] = line[i - 1], [bx, bz, bh] = line[i];
        const ex = bx - ax, ez = bz - az;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = x - (ax + t * ex), dz = z - (az + t * ez);
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; value = ah + (bh - ah) * t; }
    }
    return { distance: Math.sqrt(best), value };
}

// A canyon's line smoothed like a ridge line (third coordinate 0)
const flatLines = new WeakMap<object, [number, number, number][]>();
function smoothLine(line: readonly (readonly [number, number])[]): [number, number, number][] {
    let out = flatLines.get(line);
    if (!out) flatLines.set(line, out = smoothRidgeLine(line.map(p => [p[0], p[1], 0] as const)));
    return out;
}

// Cells of the index over a smoothed line: each cell lists the segments
// that come within `reach` of it, so a point only measures those. The
// nearest segment within `reach` of a point is always in its cell's list,
// so the result equals a search over all segments.
const LINE_CELL = 32;
interface LineIndex { x0: number; z0: number; cols: number; rows: number; starts: Int32Array; segs: Int32Array }
const lineIndexes = new WeakMap<object, LineIndex>();

function lineIndex(dense: readonly (readonly [number, number, number])[], reach: number): LineIndex {
    let index = lineIndexes.get(dense);
    if (index) return index;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of dense) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    const x0 = Math.floor((minX - reach) / LINE_CELL) * LINE_CELL, z0 = Math.floor((minZ - reach) / LINE_CELL) * LINE_CELL;
    const cols = Math.ceil((maxX + reach - x0) / LINE_CELL) + 1, rows = Math.ceil((maxZ + reach - z0) / LINE_CELL) + 1;
    // A segment belongs to a cell if it comes within reach of the cell's
    // centre plus half the cell's diagonal
    const slack = reach + LINE_CELL * 0.7072;
    const lists: number[][] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cx = x0 + (c + 0.5) * LINE_CELL, cz = z0 + (r + 0.5) * LINE_CELL;
            const list: number[] = [];
            for (let i = 1; i < dense.length; i++) {
                const [ax, az] = dense[i - 1], [bx, bz] = dense[i];
                const ex = bx - ax, ez = bz - az;
                const len2 = ex * ex + ez * ez;
                let t = len2 > 0 ? ((cx - ax) * ex + (cz - az) * ez) / len2 : 0;
                if (t < 0) t = 0; else if (t > 1) t = 1;
                const dx = cx - (ax + t * ex), dz = cz - (az + t * ez);
                if (dx * dx + dz * dz <= slack * slack) list.push(i);
            }
            lists.push(list);
        }
    }
    const starts = new Int32Array(lists.length + 1);
    lists.forEach((list, k) => { starts[k + 1] = starts[k] + list.length; });
    const segs = new Int32Array(starts[lists.length]);
    lists.forEach((list, k) => segs.set(list, starts[k]));
    index = { x0, z0, cols, rows, starts, segs };
    lineIndexes.set(dense, index);
    return index;
}

// polylineNearest over the segments within `reach` of (x, z) only; null
// when none comes that close
export function nearestWithin(dense: readonly (readonly [number, number, number])[], reach: number, x: number, z: number): { distance: number; value: number } | null {
    const index = lineIndex(dense, reach);
    const c = Math.floor((x - index.x0) / LINE_CELL), r = Math.floor((z - index.z0) / LINE_CELL);
    if (c < 0 || r < 0 || c >= index.cols || r >= index.rows) return null;
    const k = r * index.cols + c;
    let best = Infinity, value = 0;
    for (let n = index.starts[k]; n < index.starts[k + 1]; n++) {
        const i = index.segs[n];
        const [ax, az, ah] = dense[i - 1], [bx, bz, bh] = dense[i];
        const ex = bx - ax, ez = bz - az;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = x - (ax + t * ex), dz = z - (az + t * ez);
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; value = ah + (bh - ah) * t; }
    }
    if (best > reach * reach) return null;
    return { distance: Math.sqrt(best), value };
}

// Steps per spline segment when a ridge line is smoothed
export const RIDGE_STEPS = 16;

// A ridge's line smoothed into a dense polyline [x, z, height]: the
// Catmull-Rom spline through the vertices (straight into its ends), the
// height linear along each segment's parameter. Cached per line.
const smoothed = new WeakMap<object, [number, number, number][]>();
export function smoothRidgeLine(line: readonly (readonly [number, number, number])[]): [number, number, number][] {
    let out = smoothed.get(line);
    if (out) return out;
    const segments = catmullRomChain(line.map(p => [p[0], p[1]] as const));
    const p: CurvePoint = { x: 0, z: 0, dx: 0, dz: 0, ddx: 0, ddz: 0 };
    out = [[line[0][0], line[0][1], line[0][2]]];
    segments.forEach((segment, k) => {
        for (let i = 1; i <= RIDGE_STEPS; i++) {
            const u = i / RIDGE_STEPS;
            evalCubic(segment, u, p);
            out!.push([p.x, p.z, line[k][2] + (line[k + 1][2] - line[k][2]) * u]);
        }
    });
    smoothed.set(line, out);
    return out;
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
    // How much (0..1) the point lies on a cliff's face or at its foot (the
    // bake does not fill embankments there)
    cliff: number;
}

/**
 * Weight (0..1) of the terrain variations the bake keeps off its roads and
 * areas at (x, z): 1 far from them, 0 on and next to them.
 */
export type KeepWeight = (x: number, z: number) => number;

const KEEP_ALL: KeepWeight = () => 1;

export function baseSample(base: BaseTerrain, x: number, z: number, keep: KeepWeight = KEEP_ALL): BaseSample {
    const coast = signedPolygonDistance(base.coast, x, z);
    if (coast <= 0) {
        const floor = base.sea.floor * smoothstep(-coast / base.sea.shelf);
        // A headland of a cliff reaching into the sea
        const headland = cliffHeadland(base, x, z, coast, keep);
        const ground = headland === null ? floor : floor + (headland.height - floor) * headland.near;
        return { height: moleHeight(base, x, z, ground), coast, cliff: cliffNear(base, x, z) };
    }

    let land = base.land.base
        + base.land.tilt[0] * (x - base.land.tiltOrigin[0])
        + base.land.tilt[1] * (z - base.land.tiltOrigin[1]);
    let hill = 0;
    for (const h of base.hills) hill = Math.max(hill, h.height * bell(ellipseRadius(h, x, z)));
    for (const ridge of base.ridges ?? []) {
        const near = nearestWithin(smoothRidgeLine(ridge.line), ridge.width, x, z);
        if (near && near.distance < ridge.width) hill = Math.max(hill, near.value * bell(near.distance / ridge.width));
    }
    land += hill;
    for (const canyon of base.canyons ?? []) {
        const near = nearestWithin(smoothLine(canyon.line), canyon.width, x, z);
        if (near && near.distance < canyon.width) land -= canyon.depth * bell(near.distance / canyon.width);
    }
    for (const flat of base.flats) {
        const w = flat.strength * bell(ellipseRadius(flat, x, z));
        land += (flat.height - land) * w;
    }
    const inland = smoothstep((coast - base.beach.width) / base.beach.blend);
    const amplitude = noiseAmplitude(base.noise, x, z);
    if (amplitude > 0) land += amplitude * inland * terrainNoise(base.noise, base.seed, x, z);
    for (const view of base.views ?? []) land = viewCap(view, x, z, land, keep);

    const beach = base.beach.top * smoothstep(coast / base.beach.width);
    let height = beach + (land - beach) * inland;
    let face = 0;
    base.cliffs.forEach((cliff, i) => {
        const near = 1 - smoothstep((polylineDistance(cliff.line, x, z) - cliff.plateau) / cliff.fade);
        if (near <= 0) return;
        const shape = cliffShape(base, i, x, z, coast, keep);
        const cliffHeight = shape.rise * Math.max(land, shape.height);
        height += (cliffHeight - height) * near;
        face = Math.max(face, faceNear(cliff, x, z) * (1 - shape.rise));
    });
    return { height: moleHeight(base, x, z, height), coast, cliff: face };
}

// The ground with the breakwaters' spits over it
function moleHeight(base: BaseTerrain, x: number, z: number, ground: number): number {
    for (const mole of base.moles ?? []) {
        const d = polylineDistance(mole.line, x, z);
        if (d >= mole.width) continue;
        const h = ground + (mole.height - ground) * bell(d / mole.width);
        if (h > ground) ground = h;
    }
    return ground;
}

// The cliff face's share of a point by its distance to the cliff line: 1
// within the plateau, gone FACE_FADE m beyond it (the cliff's own fade is
// the long run-out of its height)
const FACE_FADE = 40;
function faceNear(cliff: BaseTerrain['cliffs'][number], x: number, z: number): number {
    return 1 - smoothstep((polylineDistance(cliff.line, x, z) - cliff.plateau) / FACE_FADE);
}

// How near (0..1) a point over the sea lies to a cliff face
function cliffNear(base: BaseTerrain, x: number, z: number): number {
    let near = 0;
    for (const cliff of base.cliffs) near = Math.max(near, faceNear(cliff, x, z));
    return near;
}

// The ground under a view's wedge (base.json views); its sides ease out
// over its half width plus VIEW_EDGE m
const VIEW_EDGE = 20;
function viewCap(view: NonNullable<BaseTerrain['views']>[number], x: number, z: number, land: number, keep: KeepWeight): number {
    const ex = view.to[0] - view.from[0], ez = view.to[1] - view.from[1];
    const el = Math.sqrt(ex * ex + ez * ez);
    const dx = ex / el, dz = ez / el;
    const px = x - view.from[0], pz = z - view.from[1];
    const along = px * dx + pz * dz;
    if (along <= 0 || along >= view.length) return land;
    const cap = view.height - view.slope * along;
    if (land <= cap) return land;
    const across = Math.abs(px * dz - pz * dx);
    const half = view.spread * along;
    const w = (1 - smoothstep((across - half) / (half + VIEW_EDGE))) * (1 - smoothstep((along - 0.7 * view.length) / (0.3 * view.length)));
    return w > 0 ? land - (land - cap) * w * keep(x, z) : land;
}

// Seed offset of a cliff's noises (per cliff: base seed + CLIFF_SEED · (index + 1))
export const CLIFF_SEED = 4099;

// A cliff at coast distance `coast`: how far up its face (0 at the foot, 1
// at the edge and beyond) and its height there
function cliffShape(base: BaseTerrain, i: number, x: number, z: number, coast: number, keep: KeepWeight): { rise: number; height: number } {
    const cliff = base.cliffs[i];
    const vary = cliff.vary;
    if (!vary) return { rise: smoothstep(coast / cliff.face), height: cliff.height };
    const seed = base.seed + CLIFF_SEED * (i + 1);
    // The edge only moves towards the sea, the foot inland in the gullies
    // and out into the sea on the headlands (where the edge comes out):
    // beyond `face` metres of the coast the plateau stays
    const out = 0.5 + 0.5 * valueNoise(x / vary.wavelength, z / vary.wavelength, seed);
    const top = cliff.face * (1 - vary.face * out);
    const foot = vary.gullies * (0.5 + 0.5 * valueNoise(x / vary.gullyWavelength, z / vary.gullyWavelength, seed + 1))
        - (vary.headlands ?? 0) * smoothstep(2 * out - 1);
    let height = cliff.height;
    if (vary.height) {
        const reach = 1 - smoothstep((coast - cliff.face) / (vary.heightReach ?? cliff.face));
        const w = reach > 0 ? reach * keep(x, z) : 0;
        if (w > 0) height *= 1 + vary.height * w * fbm(x, z, seed + 2, vary.heightWavelength ?? vary.wavelength, 2, 0.5);
    }
    return { rise: smoothstep((coast - foot) / Math.max(1, top - foot)), height };
}

// The highest headland of the cliffs over the sea at (x, z) (coast ≤ 0),
// with its weight near the cliff line; null where none reaches out
function cliffHeadland(base: BaseTerrain, x: number, z: number, coast: number, keep: KeepWeight): { height: number; near: number } | null {
    let best: { height: number; near: number } | null = null;
    base.cliffs.forEach((cliff, i) => {
        if (!cliff.vary?.headlands || -coast >= cliff.vary.headlands) return;
        const near = 1 - smoothstep((polylineDistance(cliff.line, x, z) - cliff.plateau) / cliff.fade);
        if (near <= 0) return;
        const shape = cliffShape(base, i, x, z, coast, keep);
        if (shape.rise <= 0) return;
        const height = shape.rise * shape.height;
        if (!best || height * near > best.height * best.near) best = { height, near };
    });
    return best;
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
