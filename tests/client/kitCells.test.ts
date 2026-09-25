import { describe, expect, it } from 'vitest';
import {
    cellDistance, cellIndex, cellKey, cellLod, CELL_SIZES, occupiedCells, selectCells, type CellDistances, type CellRef
} from '../../src/client/world/kitCells.js';

// The kit's merged cells (src/client/world/kitCells.ts, docs/phase-3-design.md
// 9 and A41): every piece is drawn exactly once, at the LOD of its cell's
// distance. Expected values by hand.

const DISTANCES: CellDistances = { lod0: 60, lod1: 180, sight: 4000, hysteresis: 8, shadowReach: 110, nearLod: 0 };

function covering(cells: CellRef[], x: number, z: number): CellRef[] {
    return cells.filter(cell => cellIndex(x, cell.level) === cell.i && cellIndex(z, cell.level) === cell.j);
}

describe('cells', () => {
    it('index the 2 km square from -1000 m in 250, 125 and 62.5 m', () => {
        expect(CELL_SIZES).toEqual([250, 125, 62.5]);
        expect(cellIndex(-1000, 0)).toBe(0);
        expect(cellIndex(-750.01, 0)).toBe(0);
        expect(cellIndex(-750, 0)).toBe(1);
        expect(cellIndex(0, 1)).toBe(8);
        expect(cellIndex(62.4, 2)).toBe(16);
        expect(cellKey(2, 16, 3)).toBe('2:16:3');
    });

    it('measure the distance to the cell square', () => {
        // Chunk (4, 4) spans 0..250 on both axes
        expect(cellDistance(100, 100, 0, 4, 4)).toBe(0);
        expect(cellDistance(-30, 100, 0, 4, 4)).toBe(30);
        expect(cellDistance(-30, -40, 0, 4, 4)).toBe(50);
    });

    it('merge LOD2 for chunks, LOD1 for quarters, LOD0 (or the near LOD) for the finest', () => {
        expect([cellLod(0), cellLod(1), cellLod(2)]).toEqual([2, 1, 0]);
        expect([cellLod(0, 1), cellLod(1, 1), cellLod(2, 1)]).toEqual([2, 1, 1]);
        expect([cellLod(0, 2), cellLod(1, 2), cellLod(2, 2)]).toEqual([2, 2, 2]);
    });
});

describe('the cells to draw', () => {
    // Pieces on a 20 m grid over the whole map
    const points: { x: number; z: number }[] = [];
    for (let x = -990; x < 1000; x += 20) for (let z = -990; z < 1000; z += 20) points.push({ x, z });
    const occupied = occupiedCells(points);

    it('draw every piece exactly once, for any camera', () => {
        for (const [cx, cz] of [[0, 0], [-446, -20], [812.5, -812.5], [-999, 999], [125.1, 124.9]]) {
            const cells = selectCells(occupied, cx, cz, DISTANCES);
            for (const p of points) expect(covering(cells, p.x, p.z), `(${p.x}, ${p.z}) seen from (${cx}, ${cz})`).toHaveLength(1);
        }
    });

    it('draw the finest cells at the camera, whole chunks far away', () => {
        const cells = selectCells(occupied, -446, -20, DISTANCES);
        expect(covering(cells, -446, -20)[0].level).toBe(2);
        // 150 m away: a 125 m quarter (LOD1); 600 m away: a chunk (LOD2)
        expect(covering(cells, -446 + 150, -20)[0].level).toBe(1);
        expect(covering(cells, -446 + 600, -20)[0].level).toBe(0);
    });

    it('draw nothing beyond the sight', () => {
        const cells = selectCells(occupied, -900, -900, { ...DISTANCES, sight: 300 });
        expect(covering(cells, 900, 900)).toHaveLength(0);
        expect(covering(cells, -890, -890)).toHaveLength(1);
        // A chunk 150 m away is drawn, one 400 m away is not
        expect(covering(cells, -510, -990)).toHaveLength(1);
        expect(covering(cells, -260, -990)).toHaveLength(0);
    });

    it('split near chunks into cells that stop at the sight too', () => {
        // Chunks within 250 m split into 125 m cells, the sight is 200 m:
        // the cell from -625 to -500 (275 m away) is left out, the one from
        // -750 to -625 (150 m) drawn
        const cells = selectCells(occupied, -900, -900, { ...DISTANCES, lod0: -1, lod1: 250, sight: 200 });
        expect(covering(cells, -700, -990)).toEqual([{ level: 1, i: 2, j: 0 }]);
        expect(covering(cells, -600, -990)).toHaveLength(0);
    });

    it('never split with negative distances (phones: no LOD0; software: chunks only)', () => {
        for (const cell of selectCells(occupied, 10, 10, { ...DISTANCES, lod0: -1 })) expect(cell.level).toBeLessThan(2);
        for (const cell of selectCells(occupied, 10, 10, { ...DISTANCES, lod0: -1, lod1: -1 })) expect(cell.level).toBe(0);
    });

    it('keeps a split cell split within the hysteresis band', () => {
        // Chunk (4, 4) spans 0..250; its nearest point to x = -185 is 185 m
        // away, just beyond lod1 = 180
        const before = selectCells(occupied, -175, 100, DISTANCES);
        expect(covering(before, 10, 100)[0].level).toBeGreaterThan(0);
        const keys = new Set(before.map(cell => cellKey(cell.level, cell.i, cell.j)));
        expect(covering(selectCells(occupied, -185, 100, DISTANCES, keys), 10, 100)[0].level).toBeGreaterThan(0);
        expect(covering(selectCells(occupied, -185, 100, DISTANCES), 10, 100)[0].level).toBe(0);
        // Beyond the band it merges
        expect(covering(selectCells(occupied, -190, 100, DISTANCES, keys), 10, 100)[0].level).toBe(0);
    });
});
