import type { GridSpec, Heightfield } from '../../../src/shared/map/heightfield.js';
import type { RoadEdge, RoadNetworkFile, RoadNode, RoadProfile } from '../../../src/shared/map/roadSchema.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';

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

// A 200 × 200 m heightfield (2 m grid) from functions of the position
export function makeHeightfield(height: (x: number, z: number) => number, zone: (x: number, z: number) => number = () => ZONE.downtown,
    surface: (x: number, z: number) => number = () => SURFACE.grass): Heightfield {
    const spec: GridSpec = { cols: 101, rows: 101, cellSize: 2, originX: -100, originZ: -100, heightOffset: -20, heightScale: 0.01, waterLevel: 0, zoneCell: 8 };
    const q = new Uint16Array(101 * 101), s = new Uint8Array(101 * 101);
    for (let j = 0; j < 101; j++) {
        for (let i = 0; i < 101; i++) {
            const x = -100 + 2 * i, z = -100 + 2 * j;
            q[j * 101 + i] = Math.round((height(x, z) + 20) / 0.01);
            s[j * 101 + i] = surface(x, z);
        }
    }
    const zones = new Uint8Array(25 * 25);
    for (let j = 0; j < 25; j++) for (let i = 0; i < 25; i++) zones[j * 25 + i] = zone(-100 + 8 * i + 4, -100 + 8 * j + 4);
    return { spec, q, surface: s, zones, mapVersion: 1, sourceHash: new Uint8Array(16) };
}
