import { describe, expect, it } from 'vitest';
import type { GridSpec, Heightfield } from '../../../src/shared/map/heightfield.js';
import {
    gateEnds, gridStations, minRadius, pickNearest, rayTerrain, ribbonArrays, terrainArrays, type Ray
} from '../../../tools/worldviewer/logic/viewGeometry.js';

// Scene geometry of the worldviewer with hand-computed values. Axes as in
// the game: x east, z south, y up; yaw 0 drives to +z.

function vertex(positions: Float32Array, i: number): [number, number, number] {
    return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
}

// y component of the triangle's normal (b - a) × (c - a)
function normalY(positions: Float32Array, a: number, b: number, c: number): number {
    const [ax, , az] = vertex(positions, a), [bx, , bz] = vertex(positions, b), [cx, , cz] = vertex(positions, c);
    return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
}

function grid(cols: number, rows: number, q: number[]): Heightfield {
    const spec: GridSpec = {
        cols, rows, cellSize: 2, originX: -10, originZ: 20, heightOffset: -5, heightScale: 0.5, waterLevel: 0, zoneCell: 2
    };
    return { spec, q: Uint16Array.from(q), surface: new Uint8Array(cols * rows), zones: new Uint8Array(1), mapVersion: 1, sourceHash: new Uint8Array(16) };
}

describe('gridStations', () => {
    it('steps through the grid and always ends on the last line', () => {
        expect(gridStations(1001, 2)).toHaveLength(501);
        expect(gridStations(1001, 2).at(-1)).toBe(1000);
        expect(gridStations(10, 4)).toEqual([0, 4, 8, 9]);
        expect(gridStations(9, 4)).toEqual([0, 4, 8]);
        expect(gridStations(5, 1)).toEqual([0, 1, 2, 3, 4]);
    });
});

describe('terrainArrays', () => {
    it('places the vertices on the grid points with their heights', () => {
        // 3 × 3 grid, q row by row (z outer); height = -5 + q · 0.5
        const hf = grid(3, 3, [0, 10, 20, 30, 40, 50, 60, 70, 80]);
        const full = terrainArrays(hf, 1);
        expect(full.cols).toBe(3);
        expect(full.rows).toBe(3);
        expect(vertex(full.positions, 0)).toEqual([-10, -5, 20]);
        // Column 2, row 1: x = -10 + 2·2, z = 20 + 1·2, q = 50
        expect(vertex(full.positions, 5)).toEqual([-6, 20, 22]);
        expect(full.gridIndex[5]).toBe(5);
        expect(full.indices).toHaveLength(2 * 2 * 6);
        // First cell of the second row: grid points 3, 4 (east), 6 (south), 7
        expect(Array.from(full.indices.slice(12, 18))).toEqual([3, 6, 4, 4, 6, 7]);
        const coarse = terrainArrays(hf, 2);
        expect(coarse.cols).toBe(2);
        expect(vertex(coarse.positions, 3)).toEqual([-6, 35, 24]);
        expect(Array.from(coarse.gridIndex)).toEqual([0, 2, 6, 8]);
    });

    it('faces every triangle up', () => {
        const hf = grid(3, 3, [0, 10, 20, 30, 40, 50, 60, 70, 80]);
        const { positions, indices } = terrainArrays(hf, 1);
        for (let t = 0; t < indices.length; t += 3) {
            expect(normalY(positions, indices[t], indices[t + 1], indices[t + 2])).toBeGreaterThan(0);
        }
    });
});

describe('ribbonArrays', () => {
    it('puts the left edge left of the driving direction', () => {
        // Driving east (+x): left is north (-z)
        const east = ribbonArrays([{ x: 0, z: 0, tx: 1, tz: 0 }, { x: 10, z: 0, tx: 1, tz: 0 }], 2, () => 1, 0.25);
        expect(vertex(east.positions, 0)).toEqual([0, 1.25, -2]);
        expect(vertex(east.positions, 1)).toEqual([0, 1.25, 2]);
        expect(vertex(east.positions, 3)).toEqual([10, 1.25, 2]);
        // Driving north (-z): left is west (-x)
        const north = ribbonArrays([{ x: 0, z: 0, tx: 0, tz: -1 }], 3, () => 0, 0);
        expect(vertex(north.positions, 0)).toEqual([-3, 0, 0]);
        expect(vertex(north.positions, 1)).toEqual([3, 0, 0]);
        expect(north.indices).toHaveLength(0);
    });

    it('drapes each edge vertex on its own terrain height and faces up', () => {
        const slope = (x: number, z: number) => x + 2 * z;
        const { positions, indices } = ribbonArrays([{ x: 0, z: 0, tx: 1, tz: 0 }, { x: 4, z: 0, tx: 1, tz: 0 }], 1, slope, 0);
        expect(vertex(positions, 0)[1]).toBe(-2);
        expect(vertex(positions, 1)[1]).toBe(2);
        expect(vertex(positions, 2)[1]).toBe(2);
        expect(indices).toHaveLength(6);
        const three = ribbonArrays([0, 1, 2].map(x => ({ x, z: 0, tx: 1, tz: 0 })), 1, () => 0, 0);
        // Step 1 joins points 1 and 2: vertices 2, 3 (left, right) and 4, 5
        expect(Array.from(three.indices.slice(6))).toEqual([2, 3, 4, 3, 5, 4]);
        for (let t = 0; t < indices.length; t += 3) {
            expect(normalY(positions, indices[t], indices[t + 1], indices[t + 2])).toBeGreaterThan(0);
        }
    });
});

describe('gateEnds', () => {
    it('spans the gate across the driving direction, left end first', () => {
        // yaw 0 drives south (+z): left is east (+x)
        expect(gateEnds({ x: 10, z: 5, yaw: 0, width: 8 })).toEqual([[14, 5], [6, 5]]);
        // yaw π/2 drives east: left is north (-z)
        const [left, right] = gateEnds({ x: 0, z: 0, yaw: Math.PI / 2, width: 10 });
        expect(left[0]).toBeCloseTo(0, 12);
        expect(left[1]).toBeCloseTo(-5, 12);
        expect(right[1]).toBeCloseTo(5, 12);
    });
});

describe('rayTerrain', () => {
    const ray = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): Ray => {
        const l = Math.hypot(dx, dy, dz);
        return { ox, oy, oz, dx: dx / l, dy: dy / l, dz: dz / l };
    };

    it('hits flat ground where the line meets it', () => {
        // 45° down from 10 m: hits after 10·√2
        const t = rayTerrain(ray(0, 10, 0, 1, -1, 0), () => 0, 100, 1)!;
        expect(t).toBeCloseTo(10 * Math.SQRT2, 1);
        expect(Math.abs(t - 10 * Math.SQRT2)).toBeLessThanOrEqual(0.01);
    });

    it('hits a slope and a step between two march steps', () => {
        // Straight down onto h = 0.5·x at x = 4: ground at 2, from 10 → 8
        expect(rayTerrain(ray(4, 10, 0, 0, -1, 0), (x: number) => 0.5 * x, 50, 3)).toBeCloseTo(8, 1);
        // A 1 m high wall at x ≥ 5.3, ray level at y = 0.5: the march steps
        // over x = 5.3 with 2 m steps, the bisection finds it
        const t = rayTerrain(ray(0, 0.5, 0, 1, 0, 0), (x: number) => x >= 5.3 ? 1 : 0, 20, 2)!;
        expect(Math.abs(t - 5.3)).toBeLessThanOrEqual(0.01);
    });

    it('follows the ray along z and stops at maxT', () => {
        // Level to the south at 1 m: a wall at z ≥ 5
        expect(Math.abs(rayTerrain(ray(0, 1, 0, 0, 0, 1), (_x: number, z: number) => z >= 5 ? 20 : 0, 100, 1)! - 5)).toBeLessThanOrEqual(0.01);
        // A 1 m bump at 5 ≤ x ≤ 6 before a far wall: the first hit counts
        const bump = (x: number) => (x >= 5 && x <= 6) || x >= 40 ? 1 : 0;
        expect(Math.abs(rayTerrain(ray(0, 0.5, 0, 1, 0, 0), bump, 50, 0.5)! - 5)).toBeLessThanOrEqual(0.01);
        // A wall between the last full step and maxT is found, one behind maxT is not
        expect(Math.abs(rayTerrain(ray(0, 0.5, 0, 1, 0, 0), (x: number) => x >= 19 ? 1 : 0, 20, 2)! - 19)).toBeLessThanOrEqual(0.01);
        expect(rayTerrain(ray(0, 0.5, 0, 1, 0, 0), (x: number) => x >= 20.5 ? 1 : 0, 20, 2)).toBeNull();
    });

    it('misses when the ray stays above the ground and starts on it when below', () => {
        expect(rayTerrain(ray(0, 10, 0, 1, 1, 0), () => 0, 100, 1)).toBeNull();
        expect(rayTerrain(ray(0, 10, 0, 1, -0.05, 0), () => 0, 100, 1)).toBeNull();
        expect(rayTerrain(ray(0, -1, 0, 1, 0, 0), () => 0, 100, 1)).toBe(0);
        expect(rayTerrain(ray(0, 0, 0, 1, -1, 0), () => 0, 100, 1)).toBe(0);
    });
});

describe('pickNearest', () => {
    it('takes the nearest candidate inside the radius, the earlier on a tie', () => {
        const c = (sx: number, sy: number, item: string) => ({ sx, sy, item });
        expect(pickNearest([c(0, 0, 'a'), c(5, 0, 'b')], 4, 0, 10)).toBe('b');
        expect(pickNearest([c(0, 0, 'a'), c(20, 0, 'b')], 12, 0, 10)).toBe('b');
        expect(pickNearest([c(0, 0, 'a')], 11, 0, 10)).toBeNull();
        expect(pickNearest([c(0, 3, 'a'), c(0, -3, 'b')], 0, 0, 10)).toBe('a');
        expect(pickNearest([c(10, 0, 'a')], 0, 0, 10)).toBe('a');
        expect(pickNearest([c(0, 20, 'a'), c(0, -20, 'b')], 0, 18, 5)).toBe('a');
    });
});

describe('minRadius', () => {
    it('is one over the largest absolute curvature', () => {
        expect(minRadius([{ curvature: 0 }, { curvature: 0.02 }, { curvature: -0.05 }])).toBe(20);
        expect(minRadius([{ curvature: 0 }])).toBe(Infinity);
    });
});
