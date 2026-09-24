import type { RoadEdge, RoadNetworkFile, RoadNode, RoadProfile } from '../../../src/shared/map/roadSchema.js';

// Small hand-built road networks for the map tests

export const PROFILE: RoadProfile = {
    width: 10,
    lanes: [1, 1],
    surface: 'asphalt',
    markings: { center: 'dashedYellow', lanes: 'none', edges: false },
    curb: { left: false, right: false, height: 0 },
    sidewalk: { left: 0, right: 0 },
    shoulder: 0,
    wear: 0
};

export function node(id: string, x: number, z: number, kind: RoadNode['kind'] = 'end', extra: Partial<RoadNode> = {}): RoadNode {
    return { id, x, z, kind, ...extra };
}

export function edge(id: string, from: string, to: string, points: [number, number][] = [], extra: Partial<RoadEdge> = {}): RoadEdge {
    return { id, from, to, curve: { type: 'catmullRom', points }, profile: 'road', ...extra };
}

export function network(nodes: RoadNode[], edges: RoadEdge[], extra: Partial<RoadNetworkFile> = {}): RoadNetworkFile {
    return {
        format: 'bulli-roads', version: 1, mapId: 'test',
        profiles: { road: PROFILE, dirt: { ...PROFILE, width: 6, surface: 'dirt' } },
        nodes, edges, areas: [], ...extra
    };
}
