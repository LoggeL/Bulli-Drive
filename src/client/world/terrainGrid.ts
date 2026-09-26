// The terrain mesh of a curated map as nested square rings around the
// camera (a geometry clipmap, docs/phase-3-design.md E7, 9 and A32; the
// CPU variant is deviation A59). Pure: no three.js, no DOM, so the unit
// tests check the very arrays the renderer uploads.
//
// Level L has the spacing base·2^L and 2·half cells across; level 0 is a
// full grid, every other level has a hole where the level inside it lies.
// Every vertex lies on the sim's ground (heightAt, bilinear), so the mesh
// misses the ground only inside a triangle: by at most |d| / (4k²) with k
// vertices per 2 m cell (A32), 4.3 cm at 0.5 m on Bulli Bay's roughest
// drivable ground. Where a level meets the coarser one around it, its
// border vertices between two coarse vertices take the mean of their
// neighbours on that border, so both levels share every border edge and no
// crack opens.
//
// Centres: level L's centre is a multiple of 4·spacing (a vertex of the
// coarser level lies on each of its corners) and follows the camera with
// hysteresis, so a level rebuilds when the camera has moved 3 spacings from
// its centre, not at every metre. With `half` ≥ MIN_HALF each level stays
// inside the hole of the next one.

export type HeightFn = (x: number, z: number) => number;

export interface TerrainGridConfig {
    // Spacing of level 0 (m)
    base: number;
    // Cells from the centre to the border of each level (even)
    half: number;
    levels: number;
}

// Smallest `half` that keeps every level inside the next one's hole: the
// centres of two neighbouring levels are at most 3·s and 6·s from the
// camera (s: the finer spacing), so 9·s apart, and the finer level reaches
// half·s from its centre while the coarser reaches 2·half·s
export const MIN_HALF = 10;
// A level re-centres when the camera is this many spacings from its centre
export const RECENTRE_SPACINGS = 3;

export function levelSpacing(config: TerrainGridConfig, level: number): number {
    return config.base * 2 ** level;
}

/** Centre of a level for a camera position, keeping `previous` while the camera stays within RECENTRE_SPACINGS. */
export function levelCentre(spacing: number, camera: number, previous: number | null): number {
    if (previous !== null && Math.abs(camera - previous) <= RECENTRE_SPACINGS * spacing) return previous;
    const step = 4 * spacing;
    return Math.round(camera / step) * step;
}

export interface Square {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

export function levelSquare(spacing: number, half: number, cx: number, cz: number): Square {
    return { minX: cx - half * spacing, maxX: cx + half * spacing, minZ: cz - half * spacing, maxZ: cz + half * spacing };
}

export interface LevelArrays {
    // (2·half + 1)² vertices, row by row (z outer, x inner)
    positions: Float32Array;
    normals: Float32Array;
    // World x, z in metres over the texture period (the tiling maps)
    uvs: Float32Array;
    index: Uint32Array;
    // Indices in use (cells in the hole or masked are left out)
    indexCount: number;
}

export function createLevelArrays(half: number): LevelArrays {
    const n = 2 * half + 1;
    return {
        positions: new Float32Array(n * n * 3),
        normals: new Float32Array(n * n * 3),
        uvs: new Float32Array(n * n * 2),
        index: new Uint32Array(4 * half * half * 6),
        indexCount: 0
    };
}

// Heights of the (2·half + 3)² grid around the level (one more ring for the
// normals), row by row
function sampleHeights(height: HeightFn, spacing: number, half: number, cx: number, cz: number, out: Float64Array): void {
    const n = 2 * half + 3;
    for (let j = 0; j < n; j++) {
        const z = cz + (j - half - 1) * spacing;
        for (let i = 0; i < n; i++) out[j * n + i] = height(cx + (i - half - 1) * spacing, z);
    }
}

/**
 * Fills the vertex arrays of a level centred on (cx, cz): heights from
 * `height`, the border stitched to the coarser level, normals from central
 * differences, texture coordinates in world metres / uvPeriod.
 */
export function fillLevelVertices(height: HeightFn, spacing: number, half: number, cx: number, cz: number,
    out: LevelArrays, uvPeriod: number, scratch?: Float64Array): void {
    const n = 2 * half + 1, m = n + 2;
    const h = scratch && scratch.length >= m * m ? scratch : new Float64Array(m * m);
    sampleHeights(height, spacing, half, cx, cz, h);
    // Border stitching: odd vertices on the border take the mean of their
    // even neighbours along it (the coarser level's edge there)
    const at = (i: number, j: number) => (j + 1) * m + (i + 1);
    for (let k = 1; k < n - 1; k += 2) {
        for (const [i0, j0, di, dj] of [[k, 0, 1, 0], [k, n - 1, 1, 0], [0, k, 0, 1], [n - 1, k, 0, 1]] as const) {
            h[at(i0, j0)] = (h[at(i0 - di, j0 - dj)] + h[at(i0 + di, j0 + dj)]) / 2;
        }
    }
    const { positions, normals, uvs } = out;
    const inv = 1 / uvPeriod;
    let v = 0;
    for (let j = 0; j < n; j++) {
        const z = cz + (j - half) * spacing;
        for (let i = 0; i < n; i++, v++) {
            const x = cx + (i - half) * spacing;
            const y = h[at(i, j)];
            positions[v * 3] = x;
            positions[v * 3 + 1] = y;
            positions[v * 3 + 2] = z;
            // Central differences over two spacings (smooth at coarse levels)
            const gx = (h[at(i + 1, j)] - h[at(i - 1, j)]) / (2 * spacing);
            const gz = (h[at(i, j + 1)] - h[at(i, j - 1)]) / (2 * spacing);
            const l = Math.sqrt(gx * gx + 1 + gz * gz);
            normals[v * 3] = -gx / l;
            normals[v * 3 + 1] = 1 / l;
            normals[v * 3 + 2] = -gz / l;
            uvs[v * 2] = x * inv;
            uvs[v * 2 + 1] = -z * inv;
        }
    }
}

/**
 * Fills the index of a level: two triangles per cell, counter-clockwise
 * seen from above, without the cells inside `hole` (the finer level) and
 * the cells for which `skip` says so (holes in the ground, e.g. under the
 * pier).
 */
export function fillLevelIndex(spacing: number, half: number, cx: number, cz: number, hole: Square | null,
    out: LevelArrays, skip?: (x0: number, z0: number, x1: number, z1: number) => boolean): void {
    const n = 2 * half + 1;
    const index = out.index;
    let t = 0;
    // A small tolerance: the hole's border lies on this level's grid lines
    const eps = spacing * 1e-3;
    for (let j = 0; j < n - 1; j++) {
        const z0 = cz + (j - half) * spacing, z1 = z0 + spacing;
        const inRowHole = hole !== null && z0 >= hole.minZ - eps && z1 <= hole.maxZ + eps;
        for (let i = 0; i < n - 1; i++) {
            const x0 = cx + (i - half) * spacing, x1 = x0 + spacing;
            if (inRowHole && x0 >= hole!.minX - eps && x1 <= hole!.maxX + eps) continue;
            if (skip && skip(x0, z0, x1, z1)) continue;
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            index[t++] = a; index[t++] = c; index[t++] = b;
            index[t++] = b; index[t++] = c; index[t++] = d;
        }
    }
    out.indexCount = t;
}

// ---- Beyond the map's data ----

// Integer hash noise for the hills beyond the map (looks only: no sim, no
// hash, so Math.floor on doubles is all it needs)
function hash2(i: number, j: number): number {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(z);
    const fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
    const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * w;
}

/** Fractal value noise in [0, 1). */
export function fbm(x: number, z: number, octaves = 4): number {
    let sum = 0, amplitude = 0.5, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
        sum += amplitude * valueNoise(x * f + o * 17.3, z * f - o * 9.1);
        norm += amplitude;
        amplitude *= 0.5;
        f *= 2.07;
    }
    return sum / norm;
}

const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

export interface HorizonOptions {
    // The data square (m)
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    // Ground below this at the border stays flat outside (the sea)
    landFrom: number;
}

// Beyond a coast the hills ease in over COAST_EASE m from the shore line
// along the border (probed every COAST_STEP m) instead of rising as a
// sharp wedge above it
export const COAST_EASE = 120;
const COAST_STEP = 10;

/**
 * Height of the rendered ground: the sim's ground on the map, and beyond
 * its data the border height rising into hills over the first few hundred
 * metres (only where the border is land, easing in over COAST_EASE m from
 * a coast; the sea stays the sea).
 */
export function horizonHeight(ground: HeightFn, options: HorizonOptions): HeightFn {
    const clampX = (x: number) => (x < options.minX ? options.minX : x > options.maxX ? options.maxX : x);
    const clampZ = (z: number) => (z < options.minZ ? options.minZ : z > options.maxZ ? options.maxZ : z);
    const isLand = (x: number, z: number) => smooth(options.landFrom, options.landFrom + 10, ground(x, z));
    return (x, z) => {
        const cx = clampX(x);
        const cz = clampZ(z);
        const border = ground(cx, cz);
        if (cx === x && cz === z) return border;
        const dx = x - cx, dz = z - cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        const here = isLand(cx, cz);
        if (here <= 0) return border;
        // The nearest sea along the border: x where z lies beyond it, z where x does
        let shore = COAST_EASE;
        for (let o = COAST_STEP; o < shore; o += COAST_STEP) {
            const sea = (cz !== z && (isLand(clampX(cx + o), cz) <= 0 || isLand(clampX(cx - o), cz) <= 0))
                || (cx !== x && (isLand(cx, clampZ(cz + o)) <= 0 || isLand(cx, clampZ(cz - o)) <= 0));
            if (sea) shore = o;
        }
        const land = here * smooth(0, COAST_EASE, shore);
        const ridge = 1 - Math.abs(fbm(x / 900 + 3.1, z / 900 - 1.7, 3) * 2 - 1);
        const hills = smooth(0, 700, d) * (50 + 170 * fbm(x / 520, z / 520) * (0.55 + 0.9 * ridge));
        return border + land * hills;
    };
}
