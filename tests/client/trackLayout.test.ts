import { describe, expect, it } from 'vitest';
import { barrierPieces, chevronPosts, delineatorPosts, gateEnds, ribbonEdges } from '../../src/client/race/trackLayout.js';
import { fitFrame, mapHeading, toMap } from '../../src/client/race/trackMap.js';
import { BARRIER_DEPTH, CHEVRON_POST_RADIUS, trackColliders } from '../../src/shared/race/raceWorld.js';
import { TRACKS } from '../../src/shared/race/tracks/index.js';

// Placement of the track dressing (src/client/race/trackLayout.ts) and the
// track map frame (trackMap.ts), docs/phase-2-design.md 17.3 and 17.4.
// Expected values by hand; the barriers and chevron posts are also checked
// against the race world's colliders (a visible post where a car hits one).

describe('gateEnds', () => {
    it('spans the gate across the driving direction, the left end on the left', () => {
        // Facing +z the left is +x
        const { left, right } = gateEnds({ x: 6, z: -10, yaw: 0, width: 16, visual: 'arch' });
        expect(left.x).toBeCloseTo(14, 12);
        expect(left.z).toBeCloseTo(-10, 12);
        expect(right.x).toBeCloseTo(-2, 12);
        // Facing +x the left is -z; 1 m beyond the ends
        const east = gateEnds({ x: 0, z: 0, yaw: Math.PI / 2, width: 10, visual: 'arch' }, 1);
        expect(east.left.x).toBeCloseTo(0, 12);
        expect(east.left.z).toBeCloseTo(-6, 12);
        expect(east.right.z).toBeCloseTo(6, 12);
    });
});

describe('barrierPieces', () => {
    it('splits a 12 m row into six 2 m barriers along the row, red and white in turn', () => {
        // yaw 0: the row runs along the left axis, x
        const pieces = barrierPieces({ kind: 'barrier', x: 10, z: 5, yaw: 0, length: 12 });
        expect(pieces.map(p => Math.round(p.x * 1e9) / 1e9)).toEqual([5, 7, 9, 11, 13, 15]);
        expect(pieces.every(p => Math.abs(p.z - 5) < 1e-12)).toBe(true);
        expect(pieces.map(p => p.red)).toEqual([true, false, true, false, true, false]);
    });

    it('stands inside the collider box of every barrier row of both tracks', () => {
        for (const track of Object.values(TRACKS)) {
            const boxes = trackColliders(track).filter(c => c.kind === 'box');
            const rows = track.hints.filter(h => h.kind === 'barrier');
            expect(boxes).toHaveLength(rows.length);
            rows.forEach((row, i) => {
                const box = boxes[i] as Extract<typeof boxes[number], { kind: 'box' }>;
                // The depth of the box is the barrier's
                expect(Math.min(box.hw, box.hd) * 2).toBeCloseTo(BARRIER_DEPTH, 12);
                for (const piece of barrierPieces(row)) {
                    expect(Math.abs(piece.x - box.x)).toBeLessThanOrEqual(box.hw);
                    expect(Math.abs(piece.z - box.z)).toBeLessThanOrEqual(box.hd);
                }
            });
        }
    });
});

describe('chevronPosts', () => {
    it('puts the posts of every chevron board exactly on its colliders', () => {
        for (const track of Object.values(TRACKS)) {
            const circles = trackColliders(track).filter(c => c.kind === 'circle');
            const posts = track.hints.filter(h => h.kind === 'chevron').flatMap(hint => chevronPosts(hint));
            expect(posts.length).toBe(circles.length);
            expect(posts.length).toBeGreaterThan(0);
            for (const post of posts) {
                const hit = circles.find(c => Math.hypot(c.x - post.x, c.z - post.z) < 1e-9);
                expect(hit, `collider under the post at ${post.x}, ${post.z}`).toBeDefined();
                expect((hit as { r: number }).r).toBe(CHEVRON_POST_RADIUS);
            }
        }
    });
});

describe('delineatorPosts', () => {
    it('sets a pair every spacing along the line, half a spacing in, across the corners', () => {
        // 30 m north, then 30 m east (+x): every 15 m from 7.5 m on
        const posts = delineatorPosts([{ x: 0, z: 0 }, { x: 0, z: 30 }, { x: 30, z: 30 }], 5, 15);
        expect(posts).toHaveLength(8);
        // At s = 7.5 on the first leg (facing +z, left is +x)
        expect(posts[0]).toEqual({ x: 5, z: 7.5, yaw: 0 });
        expect(posts[1]).toEqual({ x: -5, z: 7.5, yaw: 0 });
        // s = 37.5: 7.5 m into the second leg, facing +x (left is -z)
        expect(posts[4].x).toBeCloseTo(7.5, 12);
        expect(posts[4].z).toBeCloseTo(25, 12);
        expect(posts[5].z).toBeCloseTo(35, 12);
        expect(posts[4].yaw).toBeCloseTo(Math.PI / 2, 12);
    });
});

describe('ribbonEdges', () => {
    it('puts the edges half the width either side, square to the mean direction', () => {
        const edges = ribbonEdges([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 20 }], 10);
        expect(edges[0].left).toEqual({ x: 5, z: 0 });
        expect(edges[0].right).toEqual({ x: -5, z: 0 });
        // Middle point: mean direction (10, 20) normalised; left (20, -10)/√500 · 5
        const k = 5 / Math.sqrt(500);
        expect(edges[1].left.x).toBeCloseTo(20 * k, 12);
        expect(edges[1].left.z).toBeCloseTo(10 - 10 * k, 12);
    });
});

describe('the track map frame', () => {
    it('fits the bounds with padding, north (+z) up and +x on the left as seen from above', () => {
        const frame = fitFrame({ minX: 0, maxX: 100, minZ: 0, maxZ: 50 }, 120, 120, 10);
        // 100 px for 100 m (the wider side)
        expect(frame.scale).toBe(1);
        expect(toMap(frame, 50, 25)).toEqual({ px: 60, py: 60 });
        expect(toMap(frame, 100, 50)).toEqual({ px: 10, py: 35 });
        expect(toMap(frame, 0, 0)).toEqual({ px: 110, py: 85 });
        // Taller than wide: the height decides
        expect(fitFrame({ minX: 0, maxX: 50, minZ: 0, maxZ: 100 }, 120, 120, 10).scale).toBe(1);
    });

    it('turns the heading into a canvas rotation: +z up, +x to the left', () => {
        const up = (angle: number) => ({ x: Math.sin(angle), y: -Math.cos(angle) });
        // Facing +z: straight up
        expect(up(mapHeading(0)).x).toBeCloseTo(0, 12);
        expect(up(mapHeading(0)).y).toBeCloseTo(-1, 12);
        // Facing +x (yaw π/2): to the left on the map
        expect(up(mapHeading(Math.PI / 2)).x).toBeCloseTo(-1, 12);
    });
});
