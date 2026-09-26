import { describe, expect, it } from 'vitest';
import { mapFor } from '../../src/server/maps.js';
import { heightAt } from '../../src/shared/map/heightfield.js';
import { nearestRoad } from '../../src/shared/map/roadNetwork.js';
import { groundUnderDecks, TERRAIN_GRID } from '../../src/client/world/terrain.js';
import { SURFACE, ZONE } from '../../src/shared/map/types.js';
import { makeHeightfield } from '../shared/map/fixtures.js';
import {
    createLevelArrays, fillLevelIndex, fillLevelVertices, horizonHeight, levelCentre, levelSpacing, levelSquare,
    MIN_HALF, RECENTRE_SPACINGS, type HeightFn, type LevelArrays, type TerrainGridConfig
} from '../../src/client/world/terrainGrid.js';

// The terrain rings of the client (src/client/world/terrainGrid.ts,
// docs/phase-3-design.md E7, A32 and A59): the arrays the renderer uploads,
// checked on hand-made heights and on Bulli Bay's baked ground. The review
// of M3 measured the rendered ground up to 3.3 m away from the sim's ground
// (the old city's terrain under cars that drive on the heightfield); the
// mesh now lies on heightAt within the bound of A32.

interface Level {
    spacing: number;
    cx: number;
    cz: number;
    arrays: LevelArrays;
}

// All levels for a camera at (x, z), filled like TerrainField.update does
function buildRings(height: HeightFn, config: TerrainGridConfig, x: number, z: number): Level[] {
    const levels: Level[] = [];
    for (let l = 0; l < config.levels; l++) {
        const spacing = levelSpacing(config, l);
        const cx = levelCentre(spacing, x, null), cz = levelCentre(spacing, z, null);
        const arrays = createLevelArrays(config.half);
        fillLevelVertices(height, spacing, config.half, cx, cz, arrays, 6);
        const inner = levels[l - 1];
        fillLevelIndex(spacing, config.half, cx, cz, inner ? levelSquare(inner.spacing, config.half, inner.cx, inner.cz) : null, arrays);
        levels.push({ spacing, cx, cz, arrays });
    }
    return levels;
}

// Height of the mesh at (x, z): the triangle of the index that contains the
// point (the renderer's triangulation), interpolated; null in no triangle
function meshHeight(level: Level, half: number, x: number, z: number): number | null {
    const n = 2 * half + 1;
    const i = Math.floor((x - level.cx) / level.spacing + half), j = Math.floor((z - level.cz) / level.spacing + half);
    if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return null;
    const { positions, index, indexCount } = level.arrays;
    const cell = new Set([j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1]);
    for (let t = 0; t < indexCount; t += 3) {
        const v = [index[t], index[t + 1], index[t + 2]];
        if (!v.every(k => cell.has(k))) continue;
        const [ax, ay, az] = [positions[v[0] * 3], positions[v[0] * 3 + 1], positions[v[0] * 3 + 2]];
        const [bx, by, bz] = [positions[v[1] * 3], positions[v[1] * 3 + 1], positions[v[1] * 3 + 2]];
        const [cx, cy, cz] = [positions[v[2] * 3], positions[v[2] * 3 + 1], positions[v[2] * 3 + 2]];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (u < -1e-9 || w < -1e-9 || u + w > 1 + 1e-9) continue;
        return u * ay + w * by + (1 - u - w) * cy;
    }
    return null;
}

// The finest level that draws a triangle at (x, z)
function renderedHeight(levels: Level[], half: number, x: number, z: number): number {
    for (const level of levels) {
        const h = meshHeight(level, half, x, z);
        if (h !== null) return h;
    }
    throw new Error(`no level covers (${x}, ${z})`);
}

describe('level centres', () => {
    it('snap to four spacings and follow the camera with hysteresis', () => {
        // Spacing 2: centres on multiples of 8
        expect(levelCentre(2, 13, null)).toBe(16);
        expect(levelCentre(2, 11.9, null)).toBe(8);
        // Kept while the camera is within 3 spacings (6 m) of the centre
        expect(levelCentre(2, 21.9, 16)).toBe(16);
        expect(levelCentre(2, 10.1, 16)).toBe(16);
        expect(levelCentre(2, 22.1, 16)).toBe(24);
        expect(RECENTRE_SPACINGS).toBe(3);
    });
});

describe('a level on hand-made ground', () => {
    it('puts every vertex on the ground, on the grid round its centre', () => {
        const plane: HeightFn = (x, z) => 0.1 * x - 0.2 * z + 3;
        const arrays = createLevelArrays(4);
        fillLevelVertices(plane, 2, 4, 8, -16, arrays, 6);
        // 9 × 9 vertices from (0, -24) to (16, -8), row by row
        expect(arrays.positions.length).toBe(81 * 3);
        expect([...arrays.positions.slice(0, 3)]).toEqual([0, 3 + 4.8, -24].map(v => Math.fround(v)));
        const last = 80 * 3;
        expect([...arrays.positions.slice(last, last + 3)]).toEqual([16, Math.fround(1.6 + 1.6 + 3), -8]);
        // A plane: the normal is (-0.1, 1, 0.2) normalised everywhere
        const l = Math.sqrt(0.01 + 1 + 0.04);
        expect(arrays.normals[0]).toBeCloseTo(-0.1 / l, 6);
        expect(arrays.normals[1]).toBeCloseTo(1 / l, 6);
        expect(arrays.normals[2]).toBeCloseTo(0.2 / l, 6);
        // uv: world metres over the period
        expect(arrays.uvs[2 * 80]).toBeCloseTo(16 / 6, 6);
        expect(arrays.uvs[2 * 80 + 1]).toBeCloseTo(8 / 6, 6);
    });

    it('stitches its border to the coarser level: odd border vertices take their neighbours\' mean', () => {
        const bowl: HeightFn = (x, z) => x * x + z * z;
        const arrays = createLevelArrays(4);
        fillLevelVertices(bowl, 1, 4, 0, 0, arrays, 6);
        const y = (i: number, j: number) => arrays.positions[(j * 9 + i) * 3 + 1];
        // Top border (z = -4), x = -3: between x = -4 and -2: (32 + 20) / 2
        expect(y(1, 0)).toBe(26);
        // Its exact height would be 9 + 16 = 25
        expect(bowl(-3, -4)).toBe(25);
        // Even border vertices and the inside stay exact
        expect(y(2, 0)).toBe(20);
        expect(y(1, 1)).toBe(18);
        // Right border (x = 4), z = 1: between z = 0 and 2: (16 + 20) / 2
        expect(y(8, 5)).toBe(18);
    });

    it('leaves out the cells of the level inside it', () => {
        const arrays = createLevelArrays(4);
        // Level 1 (spacing 2, 8 × 8 cells) round (0, 0) with level 0
        // (spacing 1, half 4) round (0, 0) inside: its square from -4 to 4
        // covers 4 × 4 of the coarse cells
        fillLevelIndex(2, 4, 0, 0, levelSquare(1, 4, 0, 0), arrays);
        expect(arrays.indexCount).toBe((64 - 16) * 6);
        // And every cell without a hole
        fillLevelIndex(2, 4, 0, 0, null, arrays);
        expect(arrays.indexCount).toBe(64 * 6);
        // A skipped cell (the pier) is missing too
        fillLevelIndex(2, 4, 0, 0, null, arrays, (x0, z0) => x0 === 0 && z0 === 0);
        expect(arrays.indexCount).toBe(63 * 6);
    });

    it('faces every triangle up (counter-clockwise seen from above)', () => {
        const arrays = createLevelArrays(4);
        fillLevelVertices(() => 0, 1, 4, 0, 0, arrays, 6);
        fillLevelIndex(1, 4, 0, 0, null, arrays);
        const P = arrays.positions;
        for (let t = 0; t < arrays.indexCount; t += 3) {
            const [a, b, c] = [arrays.index[t], arrays.index[t + 1], arrays.index[t + 2]];
            const ux = P[b * 3] - P[a * 3], uz = P[b * 3 + 2] - P[a * 3 + 2];
            const vx = P[c * 3] - P[a * 3], vz = P[c * 3 + 2] - P[a * 3 + 2];
            // y of (b - a) × (c - a)
            expect(uz * vx - ux * vz).toBeGreaterThan(0);
        }
    });
});

describe('the rings on Bulli Bay', () => {
    const map = mapFor();
    const ground: HeightFn = (x, z) => heightAt(map.hf, x, z);

    it('keep every level inside the hole of the next one, with the smallest half the tiers use', () => {
        expect(Math.min(...Object.values(TERRAIN_GRID).map(config => config.half))).toBeGreaterThanOrEqual(MIN_HALF);
        for (const config of Object.values(TERRAIN_GRID)) {
            // Cameras that re-centre the levels at different times
            for (const [x, z] of [[0, 0], [37.3, -411.9], [-551.1, 12.6], [612.9, -770.2]]) {
                const levels = buildRings(ground, config, x, z);
                for (let l = 0; l + 1 < levels.length; l++) {
                    const inner = levelSquare(levels[l].spacing, config.half, levels[l].cx, levels[l].cz);
                    const outer = levelSquare(levels[l + 1].spacing, config.half, levels[l + 1].cx, levels[l + 1].cz);
                    expect(inner.minX).toBeGreaterThanOrEqual(outer.minX);
                    expect(inner.maxX).toBeLessThanOrEqual(outer.maxX);
                    expect(inner.minZ).toBeGreaterThanOrEqual(outer.minZ);
                    expect(inner.maxZ).toBeLessThanOrEqual(outer.maxZ);
                    // The inner square's corners are vertices of the coarser grid
                    expect(((inner.minX - outer.minX) / levels[l + 1].spacing) % 1).toBe(0);
                    expect(((inner.minZ - outer.minZ) / levels[l + 1].spacing) % 1).toBe(0);
                }
            }
        }
    });

    it('meet without cracks: the finer border lies on the coarser level\'s edges', () => {
        const config = TERRAIN_GRID.low;
        const levels = buildRings(ground, config, 471.3, -390.1);
        const n = 2 * config.half + 1;
        for (let l = 0; l + 1 < levels.length; l++) {
            const fine = levels[l], coarse = levels[l + 1];
            for (let k = 0; k < n; k++) {
                for (const [i, j] of [[k, 0], [k, n - 1], [0, k], [n - 1, k]]) {
                    const v = (j * n + i) * 3;
                    const x = fine.arrays.positions[v], y = fine.arrays.positions[v + 1], z = fine.arrays.positions[v + 2];
                    // Nudged into the coarse level's ring (the border cells of the hole)
                    const h = meshHeight(coarse, config.half, x + (i === 0 ? -1e-6 : i === n - 1 ? 1e-6 : 0), z + (j === 0 ? -1e-6 : j === n - 1 ? 1e-6 : 0));
                    expect(h).not.toBeNull();
                    // Float32 positions: a few hundredths of a millimetre
                    expect(Math.abs(y - h!)).toBeLessThan(1e-4);
                }
            }
        }
    });

    it('lie on the sim\'s ground near the camera: within 5 cm up to 25 m, 3 cm on the roads up to 60 m (A32)', () => {
        const config = TERRAIN_GRID.high;
        // Main Street, a hairpin of the Ridge Road, the beach, the rough
        // slope below the lookout
        const cameras: [number, number][] = [[-446, -20], [471.3, -390.1], [-640, -130], [620, -700]];
        let worst = 0, worstRoad = 0, roadPoints = 0;
        for (const [cx, cz] of cameras) {
            const levels = buildRings(ground, config, cx, cz);
            for (let k = 0; k < 400; k++) {
                // A fixed spiral of points round the camera
                const r = 25 * Math.sqrt((k + 0.5) / 400), a = k * 2.399963;
                const x = cx + r * Math.cos(a), z = cz + r * Math.sin(a);
                worst = Math.max(worst, Math.abs(renderedHeight(levels, config.half, x, z) - ground(x, z)));
            }
            for (let k = 0; k < 600; k++) {
                const r = 60 * Math.sqrt((k + 0.5) / 600), a = k * 2.399963;
                const x = cx + r * Math.cos(a), z = cz + r * Math.sin(a);
                const road = nearestRoad(map.net, x, z, 12);
                if (!road || road.distance > road.edge.halfWidth) continue;
                roadPoints++;
                worstRoad = Math.max(worstRoad, Math.abs(renderedHeight(levels, config.half, x, z) - ground(x, z)));
            }
        }
        expect(roadPoints).toBeGreaterThan(200);
        expect(worst).toBeLessThanOrEqual(0.05);
        expect(worstRoad).toBeLessThanOrEqual(0.03);
    });
});

describe('the ground beyond the map', () => {
    const square = { minX: -100, maxX: 100, minZ: -100, maxZ: 100, landFrom: 1 };

    it('is the map\'s ground inside, the border height where the border is sea', () => {
        const height = horizonHeight((x, z) => (x < 0 ? -12 : 20 + 0 * z), square);
        expect(height(50, 20)).toBe(20);
        expect(height(-100, 0)).toBe(-12);
        // Beyond a sea border: still the sea floor, however far
        expect(height(-900, 0)).toBe(-12);
    });

    it('eases the hills in over 120 m from a coast along the border, no wedge above the shore line', () => {
        // Sea west of x = 0, land east of it; beyond the north border (z < -100)
        const wide = { ...square, minX: -500, maxX: 500 };
        const coast = horizonHeight((x) => (x < 0 ? -12 : 20), wide);
        const flat = horizonHeight(() => 20, wide);
        const rise = (x: number) => coast(x, -600) - 20;
        // The sea along the border probed every 10 m: 120 m and more inland
        // the full hills; at the shore line (the sea 10 m off) and 60 m
        // inland (70 m off) the smoothstep of 10/120 and 70/120
        const eased = (x: number, off: number) => (flat(x, -600) - 20) * (off / 120) ** 2 * (3 - 2 * off / 120);
        expect(rise(120)).toBeCloseTo(flat(120, -600) - 20, 9);
        expect(rise(0)).toBeCloseTo(eased(0, 10), 9);
        expect(rise(0)).toBeLessThan(2);
        expect(rise(60)).toBeCloseTo(eased(60, 70), 9);
        // Beyond the sea: the sea floor
        expect(coast(-50, -600)).toBe(-12);
    });

    it('rises into hills beyond a land border, from the border height on', () => {
        const height = horizonHeight(() => 20, square);
        expect(height(100, 0)).toBe(20);
        // Right beyond the border it has hardly risen, 600 m out it is tens of metres higher
        expect(height(102, 0) - 20).toBeLessThan(0.1);
        for (const z of [-80, 0, 80]) expect(height(700, z) - 20).toBeGreaterThan(40);
    });
});

describe('the ground under the pier (terrain mesh only)', () => {
    it('drops the deck\'s grid points to the beach round them, so the mesh beside the pier stays down', () => {
        // A deck 5 m high on the grid points x ≥ 0, |z| ≤ 4 (wood), the beach
        // at 1.5 m, sloping to 1 m at z = ±20
        const beach = (z: number) => 1.5 - Math.max(0, Math.abs(z) - 4) / 32;
        const hf = makeHeightfield((x, z) => (x >= 0 && Math.abs(z) <= 4 ? 5 : beach(z)), () => ZONE.beach,
            (x, z) => (x >= 0 && Math.abs(z) <= 4 ? SURFACE.wood : SURFACE.sand));
        // The sim's ground half a cell beside the deck: halfway up to it
        expect(heightAt(hf, 20, 5)).toBeCloseTo((5 + beach(6)) / 2, 2);
        const decks = groundUnderDecks(hf);
        // The mesh's ground there: the lowest beach point round the deck's
        // edge (z = ±6: 1.4375 m) on both corners of the cell
        expect(heightAt(decks, 20, 5)).toBeCloseTo((beach(6) + beach(6)) / 2, 2);
        // Away from the deck, and on the sim's copy, nothing changes
        expect(heightAt(decks, 20, 11)).toBe(heightAt(hf, 20, 11));
        expect(heightAt(hf, 20, 0)).toBeCloseTo(5, 2);
    });
});
