import { describe, expect, it } from 'vitest';
import { alongPolyline, polylineLength, postsAlong, railPieces } from '../../src/client/world/railings.js';

// Where the kit's guard rail and barrier pieces stand along a rail line
// (src/client/world/railings.ts, docs/phase-3-design.md 5.5 and A26).
// Expected values by hand.

describe('rail lines', () => {
    const line: [number, number][] = [[0, 0], [6, 0], [6, 8]];

    it('measure and walk along the polyline', () => {
        expect(polylineLength(line)).toBe(14);
        expect(alongPolyline(line, 3)).toEqual([3, 0]);
        expect(alongPolyline(line, 10)).toEqual([6, 4]);
        // Clamped to the ends
        expect(alongPolyline(line, 20)).toEqual([6, 8]);
    });

    it('cut into kit pieces, the rest as a shortened last piece', () => {
        // 10 m straight line, 3.81 m pieces: 2 full and 2.38 m left over
        const pieces = railPieces([[0, 0], [10, 0]], 3.81, () => [0, -1]);
        expect(pieces).toHaveLength(3);
        expect(pieces[0].scale).toBe(1);
        expect(pieces[2].scale).toBeCloseTo(2.38 / 3.81, 12);
        // A rest under 1 m stretches the last piece instead
        const stretched = railPieces([[0, 0], [8, 0]], 3.81, () => [0, -1]);
        expect(stretched).toHaveLength(2);
        expect(stretched[1].scale).toBeCloseTo(4.19 / 3.81, 12);
    });

    it('turn every piece\'s traffic side (local +z) towards the road', () => {
        // Along +x the local +z is (-dz, dx) = (0, 1): the road at -z makes
        // the pieces run backwards (-x), whose local +z is (0, -1)
        const north = railPieces([[0, 0], [10, 0]], 3.81, () => [0, -1]);
        for (const piece of north) expect(piece.bx).toBeLessThan(piece.ax);
        const south = railPieces([[0, 0], [10, 0]], 3.81, () => [0, 1]);
        for (const piece of south) expect(piece.bx).toBeGreaterThan(piece.ax);
        // Either way the pieces cover the line end to end
        expect(Math.min(...north.map(p => Math.min(p.ax, p.bx)))).toBe(0);
        expect(Math.max(...north.map(p => Math.max(p.ax, p.bx)))).toBe(10);
    });

    it('put posts at even spacing, both ends included', () => {
        expect(postsAlong([[0, 0], [9, 0]], 3)).toEqual([[0, 0], [3, 0], [6, 0], [9, 0]]);
        // 10 m at 3 m: three gaps of 10/3
        expect(postsAlong([[0, 0], [10, 0]], 3)).toHaveLength(4);
    });
});
