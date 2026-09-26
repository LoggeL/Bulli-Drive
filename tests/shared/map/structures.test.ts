import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    BoxIndex, boxContains, boxCorners, boxesOverlap, KIT_FOOTPRINTS, placeByCentre, placementBox, yawAxis, type OBox
} from '../../../src/shared/map/structures.js';

// Kit pieces in the sim world (src/shared/map/structures.ts): the footprint
// table against the kit's manifest, where a placed piece stands, and the
// turned-box tests of the placement.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('KIT_FOOTPRINTS', () => {
    it('are the footprints and heights the kit manifest gives its pieces', () => {
        const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/models/kit/manifest.json'), 'utf8')) as {
            groups: Record<string, { pieces: Record<string, { footprint: Record<string, number>; height: number }> }>;
        };
        const pieces = Object.assign({}, ...Object.values(manifest.groups).map(g => g.pieces)) as Record<string, { footprint: Record<string, number>; height: number }>;
        for (const [id, footprint] of Object.entries(KIT_FOOTPRINTS)) {
            expect(pieces[id], id).toBeDefined();
            expect(footprint).toEqual({ ...pieces[id].footprint, height: pieces[id].height });
        }
    });
});

describe('placementBox and placeByCentre', () => {
    it('stands a piece with its front at the origin, facing +z, behind it along -z', () => {
        // The diner: 15 m wide, 8 m deep behind its front
        const box = placementBox({ piece: 'landmark_diner', x: 10, z: 20, ux: 0, uz: 1 });
        expect(box).toEqual({ x: 10, z: 16, hw: 7.5, hd: 4, ux: 0, uz: 1 });
        // Facing +x (yaw 90°): the depth runs along -x, the width along z
        const east = placementBox({ piece: 'landmark_diner', x: 10, z: 20, ux: 1, uz: 0 });
        expect(east).toEqual({ x: 6, z: 20, hw: 7.5, hd: 4, ux: 1, uz: 0 });
        expect(boxContains(east, 2.5, 27, 0)).toBe(true);
        expect(boxContains(east, 1.5, 20, 0)).toBe(false);
    });

    it('puts the footprint\'s centre where asked, also for a piece off its origin', () => {
        // The lifeguard tower's footprint runs from x -1.6 to 6.55
        for (const [ux, uz] of [[0, 1], [1, 0], [0.6, 0.8], [-0.8, 0.6]]) {
            const placed = placeByCentre('lifeguard_tower', -588, -250, ux, uz);
            const box = placementBox(placed);
            expect(box.x).toBeCloseTo(-588, 3);
            expect(box.z).toBeCloseTo(-250, 3);
        }
    });

    it('turns a yaw into the forward axis, rounded to micro-units', () => {
        expect(yawAxis(0)).toEqual([0, 1]);
        expect(yawAxis(Math.PI / 2)).toEqual([1, 0]);
        expect(yawAxis(Math.PI)).toEqual([0, -1]);
        expect(yawAxis(1.5708)).toEqual([1, -0.000004]);
    });
});

describe('turned boxes', () => {
    const square: OBox = { x: 0, z: 0, hw: 1, hd: 1, ux: 0, uz: 1 };
    const diamond: OBox = { x: 0, z: 0, hw: 1, hd: 1, ux: Math.SQRT1_2, uz: Math.SQRT1_2 };

    it('overlap by the separating axes: touching is not overlapping, a margin grows the gap', () => {
        expect(boxesOverlap(square, { ...square, x: 1.99 })).toBe(true);
        expect(boxesOverlap(square, { ...square, x: 2 })).toBe(false);
        expect(boxesOverlap(square, { ...square, x: 2.5 }, 0.6)).toBe(true);
        // The diamond reaches √2 along x: a square 2.4 away just misses it,
        // 2.3 away it is hit (1 + √2 = 2.414)
        expect(boxesOverlap(diamond, { ...square, x: 2.42 })).toBe(false);
        expect(boxesOverlap(diamond, { ...square, x: 2.4 })).toBe(true);
        // A diagonal gap no axis-aligned test would see
        expect(boxesOverlap(diamond, { ...diamond, x: 1.45, z: 1.45 })).toBe(false);
        expect(boxesOverlap(diamond, { ...diamond, x: 1.4, z: 1.4 })).toBe(true);
    });

    it('have their corners at ±hw ± hd along the turned axes', () => {
        const corners = boxCorners({ x: 10, z: 0, hw: 2, hd: 1, ux: 1, uz: 0 });
        // Local x = (uz, -ux) = (0, -1), local z = (1, 0)
        expect(corners.map(([x, z]) => [x + 0, z + 0])).toEqual([[9, 2], [9, -2], [11, -2], [11, 2]]);
    });

    it('index finds what overlaps and contains, near and far', () => {
        const index = new BoxIndex();
        index.add(square);
        index.add({ ...diamond, x: 500, z: -300 });
        expect(index.contains(0.9, 0.9)).toBe(true);
        expect(index.contains(1.2, 0)).toBe(false);
        expect(index.contains(1.2, 0, 0.3)).toBe(true);
        expect(index.contains(500, -301.3)).toBe(true);
        expect(index.overlaps({ ...square, x: 501, z: -300 })).toBe(true);
        expect(index.overlaps({ ...square, x: 100, z: 100 })).toBe(false);
    });
});
