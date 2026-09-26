import { describe, expect, it } from 'vitest';
import type { TrackRoute } from '../../../src/shared/map/mapFiles.js';
import { changeCount, summarizeChanges, tracksUsing } from '../../../tools/worldviewer/logic/changes.js';
import { addEdge, moveNode } from '../../../tools/worldviewer/logic/editOps.js';
import { edge, network, node } from '../../shared/map/fixtures.js';

function fixture() {
    return network([node('a', 0, 0), node('b', 100, 0)], [edge('ab', 'a', 'b')]);
}

describe('change summary', () => {
    it('lists added, removed and changed objects by id', () => {
        const before = fixture();
        const after = addEdge(before, { node: 'b' }, { at: [200, 0] }).file;
        expect(summarizeChanges(before, after)).toEqual({
            // b turned from a dead end into a joint
            nodes: { added: ['node-1'], removed: [], changed: ['b'] },
            edges: { added: ['road-1'], removed: [], changed: [] },
            areas: { added: [], removed: [], changed: [] },
            other: false
        });
        expect(changeCount(summarizeChanges(before, after))).toBe(3);
        expect(summarizeChanges(after, before).nodes).toEqual({ added: [], removed: ['node-1'], changed: ['b'] });
        expect(changeCount(summarizeChanges(after, before))).toBe(3);
    });

    it('counts nothing for an edit that ends where it started', () => {
        const before = fixture();
        const moved = moveNode(moveNode(before, 'a', 5, 5).file, 'a', 0, 0).file;
        expect(changeCount(summarizeChanges(before, moved))).toBe(0);
    });

    it('notices profile changes', () => {
        const before = fixture();
        const after = { ...before, profiles: { ...before.profiles, road: { ...before.profiles.road, width: 11 } } };
        expect(summarizeChanges(before, after).other).toBe(true);
        expect(changeCount(summarizeChanges(before, after))).toBe(1);
    });
});

describe('tracksUsing', () => {
    const track = (id: string, route: string[], start: string, finish?: string): TrackRoute => ({
        id, name: id, kind: finish ? 'sprint' : 'circuit', laps: 1, trackVersion: 1, route,
        start: { edge: start, s: 0 }, finish: finish ? { edge: finish, s: 0 } : undefined,
        gateSpacing: 200, minCornerSpeed: 30
    });

    it('finds tracks by route step in either direction, start and finish', () => {
        const tracks = [
            track('loop', ['ab', '-cd', 'ef'], 'ab'),
            track('sprint', ['gh', 'ij'], 'gh', 'ij'),
            track('other', ['kl'], 'kl')
        ];
        expect(tracksUsing(tracks, ['cd'])).toEqual(['loop']);
        expect(tracksUsing(tracks, ['ij', 'ef'])).toEqual(['loop', 'sprint']);
        expect(tracksUsing(tracks, ['zz'])).toEqual([]);
        // Start and finish count even if the route list missed them
        expect(tracksUsing([track('t', ['x'], 'y', 'z')], ['z'])).toEqual(['t']);
        expect(tracksUsing([track('t', ['x'], 'y')], ['y'])).toEqual(['t']);
    });
});
