// Review preview of a bake (docs/phase-3-design.md, 6.4): one pixel per grid
// point, north up, surface colours with hill shading, water by depth and
// contour lines every 10 m.

import type { Heightfield } from '../../src/shared/map/heightfield.js';
import { SURFACE } from '../../src/shared/map/types.js';
import type { BakeResult } from './bakeTerrain.js';
import { encodePng } from './png.js';

const COLORS: Record<number, [number, number, number]> = {
    [SURFACE.asphalt]: [70, 70, 74],
    [SURFACE.concrete]: [150, 148, 140],
    [SURFACE.wood]: [150, 105, 60],
    [SURFACE.gravel]: [165, 150, 125],
    [SURFACE.dirt]: [145, 110, 75],
    [SURFACE.grass]: [150, 160, 90],
    [SURFACE.sand]: [225, 205, 150],
    [SURFACE.wetSand]: [185, 165, 120],
    [SURFACE.rock]: [125, 115, 105],
    [SURFACE.water]: [40, 95, 140]
};

export function renderPreview(result: BakeResult): Uint8Array {
    const { cols, rows } = result.heightfield.spec;
    return encodePng(cols, rows, shadedRgb(result.heightfield, result.heights, result.conflictMask));
}

// Heights in metres of a decoded heightfield (for a preview of the
// committed terrain.bhf without baking)
export function heightsOf(hf: Heightfield): Float64Array {
    const out = new Float64Array(hf.q.length);
    for (let k = 0; k < out.length; k++) out[k] = hf.spec.heightOffset + hf.q[k] * hf.spec.heightScale;
    return out;
}

// RGB pixels, one per grid point, row by row (north up)
export function shadedRgb(hf: Heightfield, heights: ArrayLike<number>, conflictMask?: Uint8Array): Uint8Array {
    const { cols, rows, cellSize } = hf.spec;
    const rgb = new Uint8Array(cols * rows * 3);
    // Light from the north-west, 45° up (north = -z = up in the image)
    const lx = -0.5, lz = -0.5, ly = Math.SQRT1_2;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            const h = heights[k];
            const i0 = Math.max(0, i - 1), i1 = Math.min(cols - 1, i + 1);
            const j0 = Math.max(0, j - 1), j1 = Math.min(rows - 1, j + 1);
            const gx = (heights[j * cols + i1] - heights[j * cols + i0]) / ((i1 - i0) * cellSize);
            const gz = (heights[j1 * cols + i] - heights[j0 * cols + i]) / ((j1 - j0) * cellSize);
            const len = Math.hypot(gx, 1, gz);
            const shade = Math.max(0.35, Math.min(1.15, 0.35 + 0.8 * ((-gx * lx - gz * lz + ly) / len)));
            const surface = hf.surface[k];
            let [r, g, b] = COLORS[surface] ?? [255, 0, 255];
            if (surface === SURFACE.water) {
                const depth = Math.min(1, -h / 12);
                r = 90 - 60 * depth; g = 150 - 70 * depth; b = 175 - 40 * depth;
            } else {
                r *= shade; g *= shade; b *= shade;
                // Contour every 10 m
                const band = Math.floor(h / 10);
                if (i > 0 && j > 0 && (Math.floor(heights[k - 1] / 10) !== band || Math.floor(heights[k - cols] / 10) !== band)) {
                    r *= 0.75; g *= 0.75; b *= 0.75;
                }
            }
            if (conflictMask?.[k]) { r = 230; g = 30; b = 30; }
            rgb[3 * k] = Math.max(0, Math.min(255, Math.round(r)));
            rgb[3 * k + 1] = Math.max(0, Math.min(255, Math.round(g)));
            rgb[3 * k + 2] = Math.max(0, Math.min(255, Math.round(b)));
        }
    }
    return rgb;
}
