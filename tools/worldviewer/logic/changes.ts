// What an edited roads.json changes against the loaded one, and which
// tracks (tracks.json) an edge change touches: the editor shows both before
// the export, because tracks.json is not edited here and a split or merged
// edge breaks the routes that name it.

import type { RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import type { TrackRoute } from '../../../src/shared/map/mapFiles.js';

export interface ChangeList { added: string[]; removed: string[]; changed: string[] }

export interface ChangeSummary {
    nodes: ChangeList;
    edges: ChangeList;
    areas: ChangeList;
    // Profiles or header fields changed
    other: boolean;
}

function compare<T extends { id: string }>(before: readonly T[], after: readonly T[]): ChangeList {
    const old = new Map(before.map(item => [item.id, item]));
    const now = new Map(after.map(item => [item.id, item]));
    return {
        added: after.filter(item => !old.has(item.id)).map(item => item.id),
        removed: before.filter(item => !now.has(item.id)).map(item => item.id),
        // Same id, different content (key order included: it is in the export)
        changed: after.filter(item => {
            const was = old.get(item.id);
            return was !== undefined && was !== item && JSON.stringify(was) !== JSON.stringify(item);
        }).map(item => item.id)
    };
}

export function summarizeChanges(before: RoadNetworkFile, after: RoadNetworkFile): ChangeSummary {
    const { nodes: _n, edges: _e, areas: _a, ...headBefore } = before;
    const { nodes: _n2, edges: _e2, areas: _a2, ...headAfter } = after;
    return {
        nodes: compare(before.nodes, after.nodes),
        edges: compare(before.edges, after.edges),
        areas: compare(before.areas, after.areas),
        other: JSON.stringify(headBefore) !== JSON.stringify(headAfter)
    };
}

export function changeCount(summary: ChangeSummary): number {
    let count = summary.other ? 1 : 0;
    for (const list of [summary.nodes, summary.edges, summary.areas]) {
        count += list.added.length + list.removed.length + list.changed.length;
    }
    return count;
}

// Tracks whose route, start or finish names one of the edges
export function tracksUsing(tracks: readonly TrackRoute[], edgeIds: Iterable<string>): string[] {
    const ids = new Set(edgeIds);
    return tracks.filter(track =>
        track.route.some(step => ids.has(step.startsWith('-') ? step.slice(1) : step))
        || ids.has(track.start.edge)
        || (track.finish !== undefined && ids.has(track.finish.edge))
    ).map(track => track.id);
}
