// A terrain bake from the text of the map sources, as the worldviewer's
// worker runs it (../src/bakeWorker.ts): the same bytes, hash and bake as
// the CLI (tools/map/bakeSources.ts). Kept apart from the worker glue so it
// runs in the unit tests too.

import { bakeSources, type MapSources } from '../../map/bakeSources.js';

export interface BakeRequest {
    mapId: string;
    // Exact file texts (the hash covers the bytes, formatting included)
    sources: { roads: string; map: string; zones: string; base: string };
}

export interface BakeSummary {
    conflicts: number;
    maxConflictGap: number;
    infeasibleChains: { edges: string[]; infeasible: number }[];
    maxBakedGrade: { edge: string; grade: number };
    networkIssues: string[];
    minHeight: number;
    maxHeight: number;
    timings: Record<string, number>;
}

export type BakeResponse =
    | { ok: true; bytes: Uint8Array; summary: BakeSummary }
    | { ok: false; error: string };

export function runBake(request: BakeRequest): BakeResponse {
    try {
        const encoder = new TextEncoder();
        const { sources: text, mapId } = request;
        const sources: MapSources = {
            roads: encoder.encode(text.roads),
            map: encoder.encode(text.map),
            zones: encoder.encode(text.zones),
            base: encoder.encode(text.base)
        };
        const { bytes, report } = bakeSources(mapId, sources);
        return {
            ok: true,
            bytes,
            summary: {
                conflicts: report.conflicts.count,
                maxConflictGap: report.conflicts.maxGap,
                infeasibleChains: report.infeasibleChains.map(c => ({ edges: c.edges, infeasible: c.infeasible })),
                maxBakedGrade: report.maxBakedGrade,
                networkIssues: report.networkIssues,
                minHeight: report.minHeight,
                maxHeight: report.maxHeight,
                timings: report.timings
            }
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
