import type { Heightfield } from '../../shared/map/heightfield.js';
import { zoneCols } from '../../shared/map/heightfield.js';
import { SURFACE, ZONE } from '../../shared/map/types.js';

// Splat maps of the terrain shading (docs/phase-3-design.md 8.1, "Optik"):
// the baked surface layer (one ID per 2 m grid point) turned into blend
// weights, one texel per grid point, filtered and mip-mapped by the GPU, so
// a sand patch fades into the grass over a grid cell and far rings sample a
// smooth average instead of flickering between IDs.
//
//   A: R sand (dry or wet, also the sea floor), G wet (wet sand, sea
//      floor), B dirt, A gravel
//   B: R rock, G lush grass (lawns of the residential streets and the
//      park; elsewhere the dry golden grass of the base), B paved (under
//      roads and lots: packed earth), A 0
//
// Grass is what is left: 1 - (sand + dirt + gravel + rock + paved).

export interface TerrainSplat {
    width: number;
    height: number;
    a: Uint8Array;
    b: Uint8Array;
}

const LUSH_ZONES = new Set<number>([ZONE.residential, ZONE.park]);

/** Weights (0..255) per grid point for one surface ID and zone, into a[k..k+3] and b[k..k+3]. */
export function splatTexel(surface: number, zone: number, a: Uint8Array, b: Uint8Array, k: number): void {
    a[k] = a[k + 1] = a[k + 2] = a[k + 3] = 0;
    b[k] = b[k + 1] = b[k + 2] = b[k + 3] = 0;
    switch (surface) {
        case SURFACE.sand: a[k] = 255; break;
        case SURFACE.wetSand: a[k] = 255; a[k + 1] = 255; break;
        case SURFACE.water: a[k] = 255; a[k + 1] = 255; break;
        case SURFACE.dirt: a[k + 2] = 255; break;
        case SURFACE.gravel: a[k + 3] = 255; break;
        case SURFACE.rock: b[k] = 255; break;
        case SURFACE.asphalt:
        case SURFACE.concrete:
        case SURFACE.wood:
            b[k + 2] = 255;
            break;
        default:
            if (LUSH_ZONES.has(zone)) b[k + 1] = 255;
    }
}

export function buildTerrainSplat(hf: Heightfield): TerrainSplat {
    const { cols, rows, cellSize, zoneCell } = hf.spec;
    const a = new Uint8Array(cols * rows * 4);
    const b = new Uint8Array(cols * rows * 4);
    const zc = zoneCols(hf.spec);
    const perZone = zoneCell / cellSize;
    for (let j = 0; j < rows; j++) {
        const zj = Math.min(zc - 1, Math.floor(j / perZone));
        for (let i = 0; i < cols; i++) {
            const zi = Math.min(zc - 1, Math.floor(i / perZone));
            const p = j * cols + i;
            splatTexel(hf.surface[p], hf.zones[zj * zc + zi], a, b, p * 4);
        }
    }
    blurChannel(b, cols, rows, 1, LAWN_BLUR);
    return { width: cols, height: rows, a, b };
}

// Lawns fade out over this many grid points (the zones' edges are the 8 m
// steps of the zone layer, which would show as straight lines)
const LAWN_BLUR = 5;

/** Box blur (radius r texels, two passes) of one channel of an RGBA array, in place. */
export function blurChannel(data: Uint8Array, width: number, height: number, channel: number, r: number): void {
    const line = new Float64Array(Math.max(width, height));
    const pass = (count: number, length: number, index: (i: number, k: number) => number) => {
        for (let i = 0; i < count; i++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) sum += data[index(i, Math.min(length - 1, Math.max(0, k))) * 4 + channel];
            for (let k = 0; k < length; k++) {
                line[k] = sum / (2 * r + 1);
                const add = Math.min(length - 1, k + r + 1), drop = Math.max(0, k - r);
                sum += data[index(i, add) * 4 + channel] - data[index(i, drop) * 4 + channel];
            }
            for (let k = 0; k < length; k++) data[index(i, k) * 4 + channel] = Math.round(line[k]);
        }
    };
    pass(height, width, (row, k) => row * width + k);
    pass(width, height, (col, k) => k * width + col);
}
