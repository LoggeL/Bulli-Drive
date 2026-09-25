import { describe, expect, it } from 'vitest';
import { buildRoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import { pointAt } from '../../../src/shared/map/spline.js';
import type { RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import {
    addEdge, commitEdit, DEFAULT_JUNCTION, deleteEdge, deleteNode, deletePoint, deleteSelection, EditError, insertPoint,
    moveHandle, moveNode, movePoint, nearestLeg, numberedId, removeRail, reverseEdge, roundCoord, setEdgeProps,
    setNodeProps, setSideRail, sideRail, splitEdge, splitRanges, updateRail, withKeys
} from '../../../tools/worldviewer/logic/editOps.js';
import { edge, network, node } from '../../shared/map/fixtures.js';

// The spline editor's operations on hand-built networks. Expected files are
// written out by hand from the rules of each operation (docs/phase-3-design.md
// 5.2 for the node kinds and ranges).
//
//   a (0,0) ── ab ── b (100,0) ── bc ── c (200,0) ── ce ── e (300,0)
//                    joint               junction
//                                          │ cd
//                                        d (200,100)

function fixture(): RoadNetworkFile {
    return network([
        node('a', 0, 0),
        node('b', 100, 0, 'joint'),
        node('c', 200, 0, 'junction', { junction: { shape: 'auto', control: 'signal', crosswalks: true } }),
        node('d', 200, 100),
        node('e', 300, 0)
    ], [
        edge('ab', 'a', 'b', [[50, 0]], { name: 'West Rd', rails: [{ side: 'right', from: 0, to: -1, kind: 'wbeam' }] }),
        edge('bc', 'b', 'c', [], { name: 'West Rd' }),
        edge('cd', 'c', 'd', [], { profile: 'dirt' }),
        edge('ce', 'c', 'e', [], { name: 'East Rd' })
    ]);
}

// Hand lengths of the straight fixture edges
const LENGTHS: Record<string, number> = { ab: 100, ba: 100, bc: 100, cd: 100, ce: 100, cb: 100 };
const lengthOf = (id: string) => LENGTHS[id];

function nodeOf(file: RoadNetworkFile, id: string) {
    return file.nodes.find(n => n.id === id);
}

function edgeOf(file: RoadNetworkFile, id: string) {
    return file.edges.find(e => e.id === id);
}

describe('helpers', () => {
    it('rounds coordinates to 0.1 m without float noise or -0', () => {
        expect(roundCoord(12.345)).toBe(12.3);
        expect(roundCoord(12.36)).toBe(12.4);
        expect(roundCoord(0.1 + 0.2)).toBe(0.3);
        expect(Object.is(roundCoord(-0.04), 0)).toBe(true);
        expect(roundCoord(1.234, 0.01)).toBe(1.23);
    });

    it('inserts new keys at their schema place and keeps existing ones in place', () => {
        const order = ['id', 'name', 'profile', 'maxGrade', 'rails', 'tags'];
        const out = withKeys({ id: 'x', profile: 'p', tags: ['t'], maxGrade: 0.1 }, { rails: [], name: 'N' }, order);
        // maxGrade stays after tags (its existing place); rails goes before
        // tags, the first existing key ranked after it
        expect(Object.keys(out)).toEqual(['id', 'name', 'profile', 'rails', 'tags', 'maxGrade']);
        expect(Object.keys(withKeys({ id: 'x', tags: [] }, { tags: undefined }, order))).toEqual(['id']);
        expect(withKeys({ id: 'x', name: 'a' }, { name: 'b' }, order)).toEqual({ id: 'x', name: 'b' });
        // A replaced key stays where it is, even out of schema order
        expect(Object.keys(withKeys({ id: 'x', tags: [], maxGrade: 0.1 }, { maxGrade: 0.2 }, order))).toEqual(['id', 'tags', 'maxGrade']);
        // Unknown keys go last
        expect(Object.keys(withKeys({ id: 'x', tags: [] }, { extra: 1 }, order))).toEqual(['id', 'tags', 'extra']);
    });

    it('numbers new ids from 1 and skips taken ones', () => {
        expect(numberedId('node', new Set(['node-1', 'node-2']))).toBe('node-3');
        expect(numberedId('node', new Set(['node-2']))).toBe('node-1');
    });

    it('finds the nearest leg of a control polygon', () => {
        const polygon: [number, number][] = [[0, 0], [50, 0], [100, 0]];
        expect(nearestLeg(polygon, [75, 5])).toBe(1);
        expect(nearestLeg(polygon, [20, -3])).toBe(0);
        // Exactly at the shared point: the first leg
        expect(nearestLeg(polygon, [50, 10])).toBe(0);
        // An L: 10 m from the first leg, 5 m from the second
        const corner: [number, number][] = [[0, 0], [0, 50], [50, 50]];
        expect(nearestLeg(corner, [10, 45])).toBe(1);
        expect(nearestLeg(corner, [3, 20])).toBe(0);
        expect(nearestLeg(corner, [45, 40])).toBe(1);
        // The same L moved to (100, 200)
        const moved = corner.map(([x, z]) => [x + 100, z + 200] as [number, number]);
        expect(nearestLeg(moved, [110, 245])).toBe(1);
        expect(nearestLeg(moved, [103, 220])).toBe(0);
        expect(nearestLeg(moved, [96, 230])).toBe(0);
    });
});

describe('commitEdit', () => {
    it('keeps a valid result', () => {
        const result = commitEdit(fixture(), f => moveNode(f, 'd', 210, 100));
        expect(result.ok).toBe(true);
    });

    it('rejects a support point closer than 0.5 m to its node', () => {
        const result = commitEdit(fixture(), f => movePoint(f, 'ab', 0, 0.2, 0.1));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.join()).toContain('closer than 0.5 m');
    });

    it('turns an EditError into errors and does not touch the input', () => {
        const file = fixture();
        const before = JSON.stringify(file);
        const result = commitEdit(file, f => addEdge(f, { node: 'a' }, { node: 'a' }));
        expect(result).toEqual({ ok: false, errors: ['an edge needs two different nodes'] });
        expect(JSON.stringify(file)).toBe(before);
    });

    it('rejects a result the schema refuses', () => {
        const result = commitEdit(fixture(), f => setEdgeProps(f, 'bc', { width: -2 }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.join()).toContain('width');
    });

    it('rejects an empty rail range', () => {
        const result = commitEdit(fixture(), f => updateRail(f, 'ab', 0, { from: 40, to: 30 }));
        expect(result.ok).toBe(false);
    });

    it('lets unexpected errors through', () => {
        expect(() => commitEdit(fixture(), () => { throw new TypeError('bug'); })).toThrow(TypeError);
    });
});

describe('moving', () => {
    it('moves a node to the rounded position and shares the untouched objects', () => {
        const file = fixture();
        const { file: out, select } = moveNode(file, 'd', 210.04, 99.96);
        expect(nodeOf(out, 'd')).toEqual({ id: 'd', x: 210, z: 100, kind: 'end' });
        expect(select).toEqual({ kind: 'node', id: 'd' });
        expect(out.edges).toBe(file.edges);
        expect(nodeOf(out, 'a')).toBe(nodeOf(file, 'a'));
        expect(nodeOf(file, 'd')).toEqual({ id: 'd', x: 200, z: 100, kind: 'end' });
    });

    it('moves the Bézier handles at a moved node along', () => {
        const file = network([node('p', 0, 0), node('q', 30, 0)], [{
            id: 'bz', from: 'p', to: 'q', profile: 'road',
            curve: { type: 'bezier', segments: [{ c1: [5, 5], c2: [10, 5], to: [15, 0] }, { c1: [20, -5], c2: [25, -5] }] }
        }]);
        const out = moveNode(file, 'p', 2, 3).file;
        expect(edgeOf(out, 'bz')!.curve).toEqual({
            type: 'bezier', segments: [{ c1: [7, 8], c2: [10, 5], to: [15, 0] }, { c1: [20, -5], c2: [25, -5] }]
        });
        // From a node away from z = 0: the handle moves by the same (2, 4)
        const again = moveNode(out, 'p', 4, 7).file;
        expect(edgeOf(again, 'bz')!.curve).toEqual({
            type: 'bezier', segments: [{ c1: [9, 12], c2: [10, 5], to: [15, 0] }, { c1: [20, -5], c2: [25, -5] }]
        });
        const end = moveNode(file, 'q', 31, 1).file;
        expect(edgeOf(end, 'bz')!.curve).toEqual({
            type: 'bezier', segments: [{ c1: [5, 5], c2: [10, 5], to: [15, 0] }, { c1: [20, -5], c2: [26, -4] }]
        });
    });

    it('moves, inserts and deletes support points', () => {
        const file = fixture();
        expect(edgeOf(movePoint(file, 'ab', 0, 50, 7.77).file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [[50, 7.8]] });
        const inserted = insertPoint(file, 'ab', 75, 5);
        expect(edgeOf(inserted.file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [[50, 0], [75, 5]] });
        expect(inserted.select).toEqual({ kind: 'point', edge: 'ab', index: 1 });
        expect(edgeOf(insertPoint(file, 'ab', 20, -3).file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [[20, -3], [50, 0]] });
        expect(edgeOf(deletePoint(file, 'ab', 0).file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [] });
        const two = insertPoint(file, 'ab', 75, 5).file;
        expect(edgeOf(movePoint(two, 'ab', 1, 80, 6).file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [[50, 0], [80, 6]] });
        expect(edgeOf(deletePoint(two, 'ab', 1).file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [[50, 0]] });
        expect(() => movePoint(file, 'ab', 1, 0, 0)).toThrow(EditError);
        expect(() => deletePoint(file, 'bc', 0)).toThrow(EditError);
    });

    it('moves Bézier handles but not the last segment end', () => {
        const file = network([node('p', 0, 0), node('q', 30, 0)], [{
            id: 'bz', from: 'p', to: 'q', profile: 'road',
            curve: { type: 'bezier', segments: [{ c1: [5, 5], c2: [10, 5], to: [15, 0] }, { c1: [20, -5], c2: [25, -5] }] }
        }]);
        const out = moveHandle(file, 'bz', 0, 'to', 15, 2);
        expect(edgeOf(out.file, 'bz')!.curve).toEqual({
            type: 'bezier', segments: [{ c1: [5, 5], c2: [10, 5], to: [15, 2] }, { c1: [20, -5], c2: [25, -5] }]
        });
        expect(() => moveHandle(file, 'bz', 1, 'to', 1, 1)).toThrow(EditError);
        expect(edgeOf(moveHandle(file, 'bz', 1, 'c1', 21, -6).file, 'bz')!.curve).toEqual({
            type: 'bezier', segments: [{ c1: [5, 5], c2: [10, 5], to: [15, 0] }, { c1: [21, -6], c2: [25, -5] }]
        });
        expect(() => moveHandle(file, 'bz', 2, 'c1', 1, 1)).toThrow(EditError);
        expect(() => insertPoint(file, 'bz', 10, 0)).toThrow(/Bézier/);
        expect(() => moveHandle(fixture(), 'ab', 0, 'c1', 1, 1)).toThrow(EditError);
    });

    it('sets and clears a fixed node height and the junction control', () => {
        const file = fixture();
        const withY = setNodeProps(file, 'c', { y: 12.346 }).file;
        // y takes its schema place before kind
        expect(Object.keys(nodeOf(withY, 'c')!)).toEqual(['id', 'x', 'z', 'y', 'kind', 'junction']);
        expect(nodeOf(withY, 'c')!.y).toBe(12.35);
        expect(nodeOf(withY, 'c')!.junction).toEqual({ shape: 'auto', control: 'signal', crosswalks: true });
        // Changing the control keeps the height
        expect(nodeOf(setNodeProps(withY, 'c', { control: 'none' }).file, 'c')!.y).toBe(12.35);
        expect('y' in nodeOf(setNodeProps(withY, 'c', { y: null }).file, 'c')!).toBe(false);
        expect(nodeOf(setNodeProps(file, 'c', { control: 'yield' }).file, 'c')!.junction)
            .toEqual({ shape: 'auto', control: 'yield', crosswalks: true });
        expect(() => setNodeProps(file, 'a', { control: 'stop' })).toThrow(EditError);
    });
});

describe('addEdge', () => {
    it('continues a dead end with its road and profile', () => {
        const { file, select } = addEdge(fixture(), { node: 'e' }, { at: [400.04, 0] });
        expect(nodeOf(file, 'e')!.kind).toBe('joint');
        expect(nodeOf(file, 'node-1')).toEqual({ id: 'node-1', x: 400, z: 0, kind: 'end' });
        expect(edgeOf(file, 'road-1')).toEqual({
            id: 'road-1', name: 'East Rd', from: 'e', to: 'node-1', curve: { type: 'catmullRom', points: [] }, profile: 'road'
        });
        expect(Object.keys(edgeOf(file, 'road-1')!)).toEqual(['id', 'name', 'from', 'to', 'curve', 'profile']);
        expect(select).toEqual({ kind: 'node', id: 'node-1' });
    });

    it('makes a joint a junction and keeps a junction', () => {
        const { file } = addEdge(fixture(), { node: 'b' }, { node: 'c' }, { profile: 'dirt' });
        expect(nodeOf(file, 'b')).toEqual({ id: 'b', x: 100, z: 0, kind: 'junction', junction: DEFAULT_JUNCTION });
        expect(nodeOf(file, 'c')!.junction).toEqual({ shape: 'auto', control: 'signal', crosswalks: true });
        // Neither end is a dead end: no name, the requested profile
        expect(edgeOf(file, 'road-1')).toEqual({
            id: 'road-1', from: 'b', to: 'c', curve: { type: 'catmullRom', points: [] }, profile: 'dirt'
        });
    });

    it('takes the profile of the first road at an existing end', () => {
        const { file } = addEdge(fixture(), { at: [200, 200] }, { node: 'd' });
        expect(edgeOf(file, 'road-1')!.profile).toBe('dirt');
        expect(edgeOf(file, 'road-1')!.from).toBe('node-1');
        expect(nodeOf(file, 'd')!.kind).toBe('joint');
    });

    it('builds a free road from two new nodes with the first profile', () => {
        const { file } = addEdge(fixture(), { at: [0, 500] }, { at: [50, 500] });
        expect(file.nodes.slice(-2)).toEqual([
            { id: 'node-1', x: 0, z: 500, kind: 'end' }, { id: 'node-2', x: 50, z: 500, kind: 'end' }
        ]);
        expect(edgeOf(file, 'road-1')!.profile).toBe('road');
        expect(commitEdit(fixture(), f => addEdge(f, { at: [0, 500] }, { at: [50, 500] })).ok).toBe(true);
    });

    it('skips ids that are taken', () => {
        const base = fixture();
        const taken = { ...base, nodes: base.nodes.map(n => n.id === 'd' ? { ...n, id: 'node-1' } : n), edges: base.edges.map(e => e.to === 'd' ? { ...e, to: 'node-1', id: 'road-1' } : e) };
        const { file } = addEdge(taken, { node: 'e' }, { at: [400, 0] });
        expect(nodeOf(file, 'node-2')).toEqual({ id: 'node-2', x: 400, z: 0, kind: 'end' });
        expect(edgeOf(file, 'road-2')!.from).toBe('e');
        const split = splitEdge(taken, 'ab', { x: 25, z: 0, s: 25 });
        expect(split.select).toEqual({ kind: 'node', id: 'node-2' });
    });

    it('refuses two ends at one point and unknown profiles', () => {
        expect(() => addEdge(fixture(), { at: [0, 500] }, { at: [0.2, 500] })).toThrow(/closer than/);
        expect(() => addEdge(fixture(), { node: 'a' }, { at: [0, 500] }, { profile: 'nope' })).toThrow(/unknown profile/);
        expect(() => addEdge(fixture(), { node: 'zz' }, { at: [0, 500] })).toThrow(/unknown node/);
        expect(() => setEdgeProps(fixture(), 'zz', { width: 3 })).toThrow(/unknown edge/);
    });
});

describe('splitRanges', () => {
    it('cuts ranges at the station and shifts the second part to 0', () => {
        const r = (from: number, to: number) => ({ side: 'right' as const, from, to, kind: 'wbeam' as const });
        expect(splitRanges([r(20, 80)], 50)).toEqual([[r(20, -1)], [r(0, 30)]]);
        expect(splitRanges([r(60, -1)], 50)).toEqual([[], [r(10, -1)]]);
        expect(splitRanges([r(0, 30)], 50)).toEqual([[r(0, 30)], []]);
        expect(splitRanges([r(0, 50)], 50)).toEqual([[r(0, -1)], []]);
        expect(splitRanges([r(0, -1)], 50)).toEqual([[r(0, -1)], [r(0, -1)]]);
        // Starting or ending exactly at the split: one part only
        expect(splitRanges([r(50, 80)], 50)).toEqual([[], [r(0, 30)]]);
        expect(splitRanges([r(20, 50)], 50)).toEqual([[r(20, -1)], []]);
    });
});

describe('splitEdge', () => {
    it('inserts a joint and splits the support points, rails and pins', () => {
        const base = fixture();
        const pinned = {
            ...base,
            edges: base.edges.map(e => e.id === 'ab' ? { ...e, elevation: [{ s: 10, y: 1 }, { s: 70, y: 3 }] } : e)
        };
        const { file, select } = splitEdge(pinned, 'ab', { x: 25, z: 0.02, s: 25 });
        expect(select).toEqual({ kind: 'node', id: 'node-1' });
        expect(file.nodes.map(n => n.id)).toEqual(['a', 'node-1', 'b', 'c', 'd', 'e']);
        expect(nodeOf(file, 'node-1')).toEqual({ id: 'node-1', x: 25, z: 0, kind: 'joint' });
        expect(file.edges.map(e => e.id)).toEqual(['ab', 'ab-b', 'bc', 'cd', 'ce']);
        expect(edgeOf(file, 'ab')).toEqual({
            id: 'ab', name: 'West Rd', from: 'a', to: 'node-1', curve: { type: 'catmullRom', points: [] }, profile: 'road',
            elevation: [{ s: 10, y: 1 }], rails: [{ side: 'right', from: 0, to: -1, kind: 'wbeam' }]
        });
        expect(edgeOf(file, 'ab-b')).toEqual({
            id: 'ab-b', name: 'West Rd', from: 'node-1', to: 'b', curve: { type: 'catmullRom', points: [[50, 0]] }, profile: 'road',
            elevation: [{ s: 45, y: 3 }], rails: [{ side: 'right', from: 0, to: -1, kind: 'wbeam' }]
        });
        expect(commitEdit(pinned, f => splitEdge(f, 'ab', { x: 25, z: 0, s: 25 })).ok).toBe(true);
    });

    it('splits on a later leg and keeps a pin at the split station on the second part', () => {
        const base = fixture();
        const pinned = { ...base, edges: base.edges.map(e => e.id === 'ab' ? { ...e, elevation: [{ s: 75, y: 2 }] } : e) };
        const { file } = splitEdge(pinned, 'ab', { x: 75, z: 0, s: 75 });
        expect(edgeOf(file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [[50, 0]] });
        expect(edgeOf(file, 'ab-b')!.curve).toEqual({ type: 'catmullRom', points: [] });
        expect('elevation' in edgeOf(file, 'ab')!).toBe(false);
        expect(edgeOf(file, 'ab-b')!.elevation).toEqual([{ s: 0, y: 2 }]);
        // The joint follows the edge's from node in the file
        const ce = splitEdge(fixture(), 'ce', { x: 250, z: 0, s: 50 }).file;
        expect(ce.nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'node-1', 'd', 'e']);
    });

    it('turns a support point within 1 m into the joint', () => {
        const { file } = splitEdge(fixture(), 'ab', { x: 50.6, z: 0.3, s: 50.6 });
        expect(nodeOf(file, 'node-1')).toEqual({ id: 'node-1', x: 50, z: 0, kind: 'joint' });
        expect(edgeOf(file, 'ab')!.curve).toEqual({ type: 'catmullRom', points: [] });
        expect(edgeOf(file, 'ab-b')!.curve).toEqual({ type: 'catmullRom', points: [] });
    });

    it('puts the second part after the next free id and refuses a split at a node', () => {
        const once = splitEdge(fixture(), 'ab', { x: 25, z: 0, s: 25 }).file;
        const twice = splitEdge(once, 'ab', { x: 10, z: 0, s: 10 }).file;
        expect(twice.edges.map(e => e.id)).toEqual(['ab', 'ab-b-1', 'ab-b', 'bc', 'cd', 'ce']);
        expect(() => splitEdge(fixture(), 'ab', { x: 0.5, z: 0, s: 0.5 })).toThrow(/at a node/);
        expect(() => splitEdge(fixture(), 'ab', { x: 99.5, z: 0, s: 99.5 })).toThrow(/at a node/);
    });
});

describe('reverseEdge', () => {
    it('swaps the ends, reverses the points and mirrors the stations', () => {
        const base = fixture();
        const file = {
            ...base,
            edges: base.edges.map(e => e.id === 'ab' ? {
                ...e,
                curve: { type: 'catmullRom' as const, points: [[30, 0], [60, 0]] as [number, number][] },
                rails: [{ side: 'right' as const, from: 0, to: -1, kind: 'wbeam' as const }, { side: 'left' as const, from: 20, to: 30, kind: 'fence' as const }],
                walls: [{ side: 'left' as const, from: 90, to: -1 }],
                elevation: [{ s: 10, y: 1 }, { s: 70, y: 3 }]
            } : e)
        };
        const out = edgeOf(reverseEdge(file, 'ab', 100).file, 'ab')!;
        expect(out).toEqual({
            id: 'ab', name: 'West Rd', from: 'b', to: 'a', curve: { type: 'catmullRom', points: [[60, 0], [30, 0]] }, profile: 'road',
            rails: [{ side: 'left', from: 0, to: -1, kind: 'wbeam' }, { side: 'right', from: 70, to: 80, kind: 'fence' }],
            walls: [{ side: 'right', from: 0, to: 10 }],
            elevation: [{ s: 30, y: 3 }, { s: 90, y: 1 }]
        });
    });

    it('reverses a Bézier edge into the same curve', () => {
        const file = network([node('p', 0, 0), node('q', 20, 0)], [{
            id: 'bz', from: 'p', to: 'q', profile: 'road',
            curve: { type: 'bezier', segments: [{ c1: [1, 4], c2: [6, 4], to: [10, 0] }, { c1: [13, -3], c2: [18, -3] }] }
        }]);
        const before = buildRoadNetwork(file).edges[0];
        const out = reverseEdge(file, 'bz', before.length).file;
        expect(out.edges[0].curve).toEqual({
            type: 'bezier', segments: [{ c1: [18, -3], c2: [13, -3], to: [10, 0] }, { c1: [6, 4], c2: [1, 4] }]
        });
        // Same points of the plane, run backwards: the length is the same
        // and the reversed curve at s is the original at length - s. pointAt
        // interpolates along 1 m chords, which miss this tight curve (R ≈ 3.5 m)
        // by up to 1/(8R) ≈ 3.6 cm between the samples of the two runs.
        const after = buildRoadNetwork(out).edges[0];
        expect(after.length).toBeCloseTo(before.length, 6);
        for (const s of [0, 5, 10, 15, after.length]) {
            const a = pointAt(after.samples, s), b = pointAt(before.samples, before.length - s);
            expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.05);
        }
    });
});

describe('deleting', () => {
    it('dissolves a joint into one edge through its position', () => {
        const { file, select, notes } = deleteNode(fixture(), 'b', lengthOf);
        expect(file.nodes.map(n => n.id)).toEqual(['a', 'c', 'd', 'e']);
        expect(file.edges.map(e => e.id)).toEqual(['ab', 'cd', 'ce']);
        expect(edgeOf(file, 'ab')).toEqual({
            id: 'ab', name: 'West Rd', from: 'a', to: 'c', curve: { type: 'catmullRom', points: [[50, 0], [100, 0]] }, profile: 'road',
            // The rail ran to the end of ab, which is now the joint at 100 m
            rails: [{ side: 'right', from: 0, to: 100, kind: 'wbeam' }]
        });
        expect(select).toEqual({ kind: 'edge', id: 'ab' });
        // Same name and profile: nothing lost
        expect(notes).toEqual([]);
    });

    it('keeps the direction of the earlier edge when it leaves the joint', () => {
        const base = fixture();
        const file = { ...base, edges: [base.edges[1], base.edges[0], ...base.edges.slice(2)] };
        const out = deleteNode(file, 'b', lengthOf).file;
        expect(edgeOf(out, 'bc')).toEqual({
            id: 'bc', name: 'West Rd', from: 'a', to: 'c', curve: { type: 'catmullRom', points: [[50, 0], [100, 0]] }, profile: 'road',
            rails: [{ side: 'right', from: 0, to: 100, kind: 'wbeam' }]
        });
    });

    it('reverses the later edge when both leave the joint', () => {
        const base = fixture();
        const file = {
            ...base,
            edges: [
                {
                    ...base.edges[1], rails: [{ side: 'left' as const, from: 0, to: 40, kind: 'wood' as const }],
                    walls: [{ side: 'right' as const, from: 10, to: 20 }], elevation: [{ s: 30, y: 5 }]
                },
                edge('ba', 'b', 'a', [[50, 0]], {
                    name: 'West Rd', walls: [{ side: 'left', from: 0, to: 30 }], elevation: [{ s: 20, y: 4 }],
                    rails: [{ side: 'right', from: 50, to: -1, kind: 'fence' }]
                }),
                ...base.edges.slice(2)
            ],
            areas: [{ id: 'lot', polygon: [[0, 0], [1, 0], [1, 1]] as [number, number][], surface: 'asphalt' as const, curb: false, connects: ['b', 'a'] }]
        };
        const out = deleteNode(file, 'b', lengthOf).file;
        // ba reversed (a → b): its right rail 50..end becomes left 0..50,
        // its left wall 0..30 right 70..end (which is now the joint at
        // 100 m), the pin at 20 m moves to 80 m; bc follows from 100 m on
        expect(edgeOf(out, 'bc')).toEqual({
            id: 'bc', name: 'West Rd', from: 'a', to: 'c', curve: { type: 'catmullRom', points: [[50, 0], [100, 0]] }, profile: 'road',
            rails: [{ side: 'left', from: 0, to: 50, kind: 'fence' }, { side: 'left', from: 100, to: 140, kind: 'wood' }],
            walls: [{ side: 'right', from: 70, to: 100 }, { side: 'right', from: 110, to: 120 }],
            elevation: [{ s: 80, y: 4 }, { s: 130, y: 5 }]
        });
        expect(out.areas[0].connects).toEqual(['a']);
    });

    it('refuses to join a Bézier edge', () => {
        const base = fixture();
        const file = { ...base, edges: base.edges.map(e => e.id === 'bc' ? { ...e, curve: { type: 'bezier' as const, segments: [{ c1: [130, 0] as [number, number], c2: [170, 0] as [number, number] }] } } : e) };
        expect(() => deleteNode(file, 'b', lengthOf)).toThrow(/Bézier/);
    });

    it('does not join the two roads of a junction', () => {
        const twoRoads = deleteEdge(fixture(), 'cd').file;
        const { file } = deleteNode(twoRoads, 'c', lengthOf);
        expect(file.edges.map(e => e.id)).toEqual(['ab']);
    });

    it('reverses the later edge when it points the other way and reports lost settings', () => {
        const base = fixture();
        const file = {
            ...base,
            edges: base.edges.map(e => e.id === 'bc' ? {
                id: 'cb', from: 'c', to: 'b', curve: { type: 'catmullRom' as const, points: [] }, profile: 'dirt',
                rails: [{ side: 'left' as const, from: 0, to: 40, kind: 'fence' as const }]
            } : e)
        };
        const { file: out, notes } = deleteNode(file, 'b', lengthOf);
        // cb reversed: its left rail 0..40 becomes right 60..end, then 100 m on
        expect(edgeOf(out, 'ab')!.rails).toEqual([
            { side: 'right', from: 0, to: 100, kind: 'wbeam' },
            { side: 'right', from: 160, to: -1, kind: 'fence' }
        ]);
        expect(edgeOf(out, 'ab')!.to).toBe('c');
        expect(notes).toEqual(['cb: name of ab applies to the merged road', 'cb: profile of ab applies to the merged road']);
    });

    it('removes a junction with its edges and reconciles the neighbours', () => {
        const { file } = deleteNode(fixture(), 'c', lengthOf);
        expect(file.edges.map(e => e.id)).toEqual(['ab']);
        // b had two ends, now one: a dead end without junction settings;
        // d and e lost their only edge and go
        expect(file.nodes).toEqual([
            { id: 'a', x: 0, z: 0, kind: 'end' },
            { id: 'b', x: 100, z: 0, kind: 'end' }
        ]);
    });

    it('removes a dead end with its edge and cleans area connections', () => {
        const base = fixture();
        const file = { ...base, areas: [{ id: 'lot', polygon: [[0, 0], [1, 0], [1, 1]] as [number, number][], surface: 'asphalt' as const, curb: false, connects: ['d', 'a'] }] };
        const { file: out } = deleteNode(file, 'd', lengthOf);
        expect(out.edges.map(e => e.id)).toEqual(['ab', 'bc', 'ce']);
        // c keeps two roads and stays a junction (explicit crossing)
        expect(nodeOf(out, 'c')!.kind).toBe('junction');
        expect(out.areas[0].connects).toEqual(['a']);
    });

    it('turns a junction left with one road into a plain dead end', () => {
        const { file } = deleteEdge(deleteEdge(fixture(), 'cd').file, 'ce');
        expect(nodeOf(file, 'c')).toEqual({ id: 'c', x: 200, z: 0, kind: 'end' });
    });

    it('turns a joint into a dead end when an edge goes', () => {
        const { file } = deleteEdge(fixture(), 'bc');
        expect(nodeOf(file, 'b')).toEqual({ id: 'b', x: 100, z: 0, kind: 'end' });
        expect(nodeOf(file, 'c')!.kind).toBe('junction');
        const base = fixture();
        const withArea = { ...base, areas: [{ id: 'lot', polygon: [[0, 0], [1, 0], [1, 1]] as [number, number][], surface: 'asphalt' as const, curb: false, connects: ['e'] }] };
        const ce = deleteEdge(withArea, 'ce').file;
        expect(nodeOf(ce, 'e')).toBeUndefined();
        expect(ce.areas[0].connects).toEqual([]);
    });

    it('deletes by selection', () => {
        expect(deleteSelection(fixture(), { kind: 'edge', id: 'ce' }, lengthOf).file.edges).toHaveLength(3);
        expect(edgeOf(deleteSelection(fixture(), { kind: 'point', edge: 'ab', index: 0 }, lengthOf).file, 'ab')!.curve)
            .toEqual({ type: 'catmullRom', points: [] });
        expect(deleteSelection(fixture(), { kind: 'node', id: 'e' }, lengthOf).file.nodes).toHaveLength(4);
        expect(() => deleteSelection(fixture(), null, lengthOf)).toThrow(EditError);
        expect(() => deleteSelection(fixture(), { kind: 'handle', edge: 'ab', segment: 0, handle: 'c1' }, lengthOf)).toThrow(EditError);
    });
});

describe('edge settings', () => {
    it('stores width and surface as overrides only while they differ from the profile', () => {
        const wide = setEdgeProps(fixture(), 'bc', { width: 12.04 }).file;
        expect(edgeOf(wide, 'bc')).toEqual({
            id: 'bc', name: 'West Rd', from: 'b', to: 'c', curve: { type: 'catmullRom', points: [] }, profile: 'road',
            overrides: { width: 12 }
        });
        const gravel = setEdgeProps(wide, 'bc', { surface: 'gravel' }).file;
        expect(edgeOf(gravel, 'bc')!.overrides).toEqual({ width: 12, surface: 'gravel' });
        // Back to the profile's width (10): the override goes
        expect(edgeOf(setEdgeProps(gravel, 'bc', { width: 10 }).file, 'bc')!.overrides).toEqual({ surface: 'gravel' });
        const plain = setEdgeProps(gravel, 'bc', { width: null, surface: null }).file;
        expect('overrides' in edgeOf(plain, 'bc')!).toBe(false);
    });

    it('drops overrides that the new profile already has', () => {
        const narrow = setEdgeProps(fixture(), 'bc', { width: 6 }).file;
        // dirt is 6 m wide
        expect('overrides' in edgeOf(setEdgeProps(narrow, 'bc', { profile: 'dirt' }).file, 'bc')!).toBe(false);
        expect(() => setEdgeProps(fixture(), 'bc', { profile: 'nope' })).toThrow(EditError);
    });

    it('sets and clears name, one-way and grade limit', () => {
        const set = setEdgeProps(fixture(), 'cd', { name: 'Ranch Trail', oneWay: true, maxGrade: 0.15 }).file;
        expect(edgeOf(set, 'cd')).toEqual({
            id: 'cd', name: 'Ranch Trail', from: 'c', to: 'd', curve: { type: 'catmullRom', points: [] }, profile: 'dirt',
            oneWay: true, maxGrade: 0.15
        });
        // A change of another field keeps them
        expect(edgeOf(setEdgeProps(set, 'cd', { width: 8 }).file, 'cd')).toMatchObject({ oneWay: true, maxGrade: 0.15, name: 'Ranch Trail' });
        const cleared = setEdgeProps(set, 'cd', { name: '', oneWay: false, maxGrade: null }).file;
        expect(Object.keys(edgeOf(cleared, 'cd')!)).toEqual(['id', 'from', 'to', 'curve', 'profile']);
    });
});

describe('guard rails', () => {
    it('reads what a side carries', () => {
        const file = fixture();
        const ab = edgeOf(file, 'ab')!;
        expect(sideRail(ab, 'right')).toBe('wbeam');
        expect(sideRail(ab, 'left')).toBe('none');
        expect(sideRail({ ...ab, rails: [{ side: 'right', from: 10, to: -1, kind: 'wbeam' }] }, 'right')).toBe('mixed');
        expect(sideRail({ ...ab, rails: [{ side: 'right', from: 0, to: 40, kind: 'wbeam' }] }, 'right')).toBe('mixed');
        expect(sideRail({ ...ab, rails: [
            { side: 'left', from: 0, to: 20, kind: 'wood' }, { side: 'left', from: 20, to: -1, kind: 'wood' }
        ] }, 'left')).toBe('mixed');
        expect(sideRail({ ...ab, rails: [
            { side: 'left', from: 0, to: -1, kind: 'wood' }, { side: 'left', from: 0, to: -1, kind: 'fence' }
        ] }, 'left')).toBe('mixed');
    });

    it('sets a full-length rail per side and removes the key when none is left', () => {
        const both = setSideRail(fixture(), 'ab', 'left', 'concrete').file;
        expect(edgeOf(both, 'ab')!.rails).toEqual([
            { side: 'left', from: 0, to: -1, kind: 'concrete' },
            { side: 'right', from: 0, to: -1, kind: 'wbeam' }
        ]);
        const left = setSideRail(both, 'ab', 'right', null).file;
        expect(edgeOf(left, 'ab')!.rails).toEqual([{ side: 'left', from: 0, to: -1, kind: 'concrete' }]);
        // A right rail goes after the left one
        expect(edgeOf(setSideRail(left, 'ab', 'right', 'fence').file, 'ab')!.rails).toEqual([
            { side: 'left', from: 0, to: -1, kind: 'concrete' },
            { side: 'right', from: 0, to: -1, kind: 'fence' }
        ]);
        expect('rails' in edgeOf(setSideRail(left, 'ab', 'left', null).file, 'ab')!).toBe(false);
        // A new rail on an edge without rails goes to the schema place of rails
        const cd = edgeOf(setSideRail(setEdgeProps(fixture(), 'cd', { maxGrade: 0.1 }).file, 'cd', 'right', 'fence').file, 'cd')!;
        expect(Object.keys(cd)).toEqual(['id', 'from', 'to', 'curve', 'profile', 'maxGrade', 'rails']);
    });

    it('keeps the offset of the replaced rail', () => {
        const base = fixture();
        const file = { ...base, edges: base.edges.map(e => e.id === 'ab' ? { ...e, rails: [{ side: 'right' as const, from: 5, to: 50, kind: 'wbeam' as const, offset: 1.5 }] } : e) };
        expect(edgeOf(setSideRail(file, 'ab', 'right', 'wood').file, 'ab')!.rails).toEqual([
            { side: 'right', from: 0, to: -1, kind: 'wood', offset: 1.5 }
        ]);
        expect(Object.keys(edgeOf(setSideRail(file, 'ab', 'right', 'wood').file, 'ab')!.rails![0])).toEqual(['side', 'from', 'to', 'kind', 'offset']);
        // The offset of the other side's rail does not carry over
        expect(edgeOf(setSideRail(file, 'ab', 'left', 'wood').file, 'ab')!.rails![0]).toEqual({ side: 'left', from: 0, to: -1, kind: 'wood' });
    });

    it('edits and removes single ranges', () => {
        const file = updateRail(fixture(), 'ab', 0, { from: 12.34, to: 80.06, kind: 'fence' }).file;
        expect(edgeOf(file, 'ab')!.rails).toEqual([{ side: 'right', from: 12.3, to: 80.1, kind: 'fence' }]);
        expect(edgeOf(updateRail(file, 'ab', 0, { to: -1 }).file, 'ab')!.rails).toEqual([{ side: 'right', from: 12.3, to: -1, kind: 'fence' }]);
        const two = setSideRail(file, 'ab', 'left', 'wood').file;
        expect(edgeOf(updateRail(two, 'ab', 1, { from: 20 }).file, 'ab')!.rails).toEqual([
            { side: 'left', from: 0, to: -1, kind: 'wood' }, { side: 'right', from: 20, to: 80.1, kind: 'fence' }
        ]);
        expect(edgeOf(removeRail(two, 'ab', 1).file, 'ab')!.rails).toEqual([{ side: 'left', from: 0, to: -1, kind: 'wood' }]);
        expect('rails' in edgeOf(removeRail(file, 'ab', 0).file, 'ab')!).toBe(false);
        expect(() => removeRail(file, 'ab', 1)).toThrow(EditError);
        expect(() => updateRail(file, 'bc', 0, { from: 1 })).toThrow(EditError);
    });
});

describe('selection after an edit', () => {
    it('selects what the editor shows next and reports nothing for plain edits', () => {
        const f = fixture();
        const cases: [ReturnType<typeof moveNode>, unknown][] = [
            [moveNode(f, 'a', 1, 1), { kind: 'node', id: 'a' }],
            [setNodeProps(f, 'c', { y: 3 }), { kind: 'node', id: 'c' }],
            [addEdge(f, { node: 'e' }, { at: [400, 0] }), { kind: 'node', id: 'node-1' }],
            [splitEdge(f, 'ab', { x: 25, z: 0, s: 25 }), { kind: 'node', id: 'node-1' }],
            [reverseEdge(f, 'bc', 100), { kind: 'edge', id: 'bc' }],
            [deleteEdge(f, 'bc'), null],
            [deleteNode(f, 'd', lengthOf), null],
            [setEdgeProps(f, 'bc', { width: 11 }), { kind: 'edge', id: 'bc' }],
            [setSideRail(f, 'bc', 'left', 'wood'), { kind: 'edge', id: 'bc' }],
            [updateRail(f, 'ab', 0, { kind: 'wood' }), { kind: 'edge', id: 'ab' }],
            [removeRail(f, 'ab', 0), { kind: 'edge', id: 'ab' }],
            [insertPoint(f, 'bc', 150, 1), { kind: 'point', edge: 'bc', index: 0 }],
            [movePoint(f, 'ab', 0, 50, 2), { kind: 'point', edge: 'ab', index: 0 }],
            [deletePoint(f, 'ab', 0), { kind: 'edge', id: 'ab' }]
        ];
        for (const [result, select] of cases) {
            expect(result.select).toEqual(select);
            expect(result.notes).toEqual([]);
        }
        const bz = network([node('p', 0, 0), node('q', 30, 0)], [{
            id: 'bz', from: 'p', to: 'q', profile: 'road', curve: { type: 'bezier', segments: [{ c1: [5, 5], c2: [10, 5] }] }
        }]);
        const handle = moveHandle(bz, 'bz', 0, 'c2', 11, 5);
        expect(handle.select).toEqual({ kind: 'handle', edge: 'bz', segment: 0, handle: 'c2' });
        expect(handle.notes).toEqual([]);
    });
});
