// Geometry of the worldviewer's scene as plain arrays (no three.js, no DOM):
// terrain grid, road ribbons, gates, the ray against the heightfield and
// screen-space picking. The scene code only copies these into buffers.
//
// Coordinates as in the game: x east, z south, y up (docs/phase-3-design.md
// 3.1); yaw as in the sim, forward = (sin yaw, cos yaw).

import type { Heightfield } from '../../../src/shared/map/heightfield.js';
import { leftNormal } from '../../../src/shared/map/spline.js';

export type HeightFn = (x: number, z: number) => number;

export interface MeshArrays {
    positions: Float32Array;
    indices: Uint32Array;
}

// Grid lines sampled at a step: 0, step, 2·step, ... and always the last
// line, so the mesh covers the whole heightfield
export function gridStations(count: number, step: number): number[] {
    const stations: number[] = [];
    for (let i = 0; i < count - 1; i += step) stations.push(i);
    stations.push(count - 1);
    return stations;
}

// Terrain mesh from every step-th grid point: the heights are the grid
// point's own (the bilinear surface through them is heightAt), two
// triangles per cell, counter-clockwise seen from above (+y)
export function terrainArrays(hf: Heightfield, step: number): MeshArrays & { cols: number; rows: number; gridIndex: Uint32Array } {
    const { spec, q } = hf;
    const xs = gridStations(spec.cols, step), zs = gridStations(spec.rows, step);
    const cols = xs.length, rows = zs.length;
    const positions = new Float32Array(cols * rows * 3);
    // Index of each vertex's grid point (for colours from the surface layer)
    const gridIndex = new Uint32Array(cols * rows);
    let v = 0;
    for (const j of zs) {
        for (const i of xs) {
            const k = j * spec.cols + i;
            gridIndex[v] = k;
            positions[v * 3] = spec.originX + i * spec.cellSize;
            positions[v * 3 + 1] = spec.heightOffset + q[k] * spec.heightScale;
            positions[v * 3 + 2] = spec.originZ + j * spec.cellSize;
            v++;
        }
    }
    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let t = 0;
    for (let r = 0; r + 1 < rows; r++) {
        for (let c = 0; c + 1 < cols; c++) {
            const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
            // Rows run to +z, columns to +x: (a, d, b) is counter-clockwise from +y
            indices.set([a, d, b, b, d, e], t);
            t += 6;
        }
    }
    return { positions, indices, cols, rows, gridIndex };
}

export interface RibbonPoint { x: number; z: number; tx: number; tz: number }

// A flat band of the given half width along a centre line, draped on the
// terrain `lift` metres above it: vertex 2k is left of point k (in driving
// direction), 2k + 1 right; two triangles per step, facing +y
export function ribbonArrays(points: readonly RibbonPoint[], halfWidth: number, height: HeightFn, lift: number): MeshArrays {
    const positions = new Float32Array(points.length * 6);
    points.forEach((p, k) => {
        const [nx, nz] = leftNormal(p.tx, p.tz);
        const lx = p.x + nx * halfWidth, lz = p.z + nz * halfWidth;
        const rx = p.x - nx * halfWidth, rz = p.z - nz * halfWidth;
        positions.set([lx, height(lx, lz) + lift, lz, rx, height(rx, rz) + lift, rz], k * 6);
    });
    const steps = Math.max(0, points.length - 1);
    const indices = new Uint32Array(steps * 6);
    for (let k = 0; k < steps; k++) {
        const l0 = 2 * k, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
        indices.set([l0, r0, l1, r0, r1, l1], k * 6);
    }
    return { positions, indices };
}

// The ends of a gate line across the road: left end first (seen in driving
// direction)
export function gateEnds(gate: { x: number; z: number; yaw: number; width: number }): [[number, number], [number, number]] {
    const [nx, nz] = leftNormal(Math.sin(gate.yaw), Math.cos(gate.yaw));
    const h = gate.width / 2;
    return [[gate.x + nx * h, gate.z + nz * h], [gate.x - nx * h, gate.z - nz * h]];
}

export interface Ray { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }

// First hit of a ray with the terrain: marches in steps of `step` until the
// ray is below the ground, then bisects the last step to `tolerance`.
// Returns the ray parameter t (point = origin + t·direction) or null when
// the ray stays above the ground up to maxT.
export function rayTerrain(ray: Ray, height: HeightFn, maxT: number, step: number, tolerance = 0.01): number | null {
    const above = (t: number) => ray.oy + ray.dy * t - height(ray.ox + ray.dx * t, ray.oz + ray.dz * t);
    if (above(0) <= 0) return 0;
    let prev = 0;
    for (let t = step; t <= maxT + step; t += step) {
        const at = Math.min(t, maxT);
        if (above(at) <= 0) {
            let lo = prev, hi = at;
            while (hi - lo > tolerance) {
                const mid = (lo + hi) / 2;
                if (above(mid) > 0) lo = mid; else hi = mid;
            }
            return hi;
        }
        prev = at;
        if (at === maxT) break;
    }
    return null;
}

export interface ScreenCandidate<T> { sx: number; sy: number; item: T }

// The candidate nearest to the pointer within radius pixels, or null. On a
// tie the earlier candidate wins (callers list the more specific first).
export function pickNearest<T>(candidates: Iterable<ScreenCandidate<T>>, mx: number, my: number, radius: number): T | null {
    let best: T | null = null, bestDistance = radius;
    for (const c of candidates) {
        const d = Math.hypot(c.sx - mx, c.sy - my);
        if (d <= bestDistance && (best === null || d < bestDistance)) {
            best = c.item;
            bestDistance = d;
        }
    }
    return best;
}

// Smallest curve radius of a centre line (m); Infinity for a straight one
export function minRadius(samples: readonly { curvature: number }[]): number {
    let max = 0;
    for (const s of samples) max = Math.max(max, Math.abs(s.curvature));
    // 1 / 0 is Infinity
    return 1 / max;
}
