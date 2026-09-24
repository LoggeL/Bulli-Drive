// Drivable features of the map outside the city (docs/phase-2-design.md,
// 5.3 and 5.5): the three ramps of the Hill Sprint and the hill road from
// the city's southern edge to the lookout. They belong to the map, not to
// the race: once the map includes them (MAP_VERSION 3) Free Roam and Party
// players can use them too. Until then the race world adds them itself.

import type { TerrainConfig } from '../protocol.js';
import { rampEdgeColliders, type ColliderInput, type RampDef } from './colliders.js';
import { getTerrainHeight } from './terrain.js';

export interface MapRamp extends RampDef {
    name: string;
    look: 'steel' | 'earth';
}

// Base: terrain at the middle of the rear edge (colliders.ts). All three
// face along an axis, as their edge walls are axis-aligned boxes.
export const MAP_RAMPS: readonly MapRamp[] = [
    // R1 "Stadtausfahrt": leaving the city southwards on flat ground
    { name: 'city exit', look: 'steel', x: 58, z: -128, yaw: Math.PI, width: 8, length: 12, height: 1.6 },
    // R2 "Feldweg": eastwards on the rise towards the hills
    { name: 'field track', look: 'earth', x: 150, z: -208, yaw: Math.PI / 2, width: 8, length: 14, height: 2.2 },
    // R3 "Kuppe": northwards just before the lookout
    { name: 'crest', look: 'earth', x: 350, z: -6, yaw: 0, width: 10, length: 16, height: 3.2 }
];

// Hill road (looks only, 10 m wide, follows the terrain): from the city's
// southern edge on x = 58 to the lookout
export const HILL_ROAD = {
    width: 10,
    line: [
        { x: 58, z: -104 }, { x: 58, z: -150 }, { x: 80, z: -200 }, { x: 110, z: -208 }, { x: 180, z: -208 },
        { x: 230, z: -175 }, { x: 285, z: -140 }, { x: 322, z: -80 }, { x: 350, z: -35 }, { x: 350, z: 20 },
        { x: 362, z: 40 }
    ]
} as const;

/** Edge walls of the map ramps on the given terrain; ramp i of MAP_RAMPS has index firstIndex + i. */
export function mapRampColliders(terrain: TerrainConfig, firstIndex = 0): ColliderInput[] {
    const height = (x: number, z: number) => getTerrainHeight(terrain, x, z);
    return MAP_RAMPS.flatMap((ramp, i) => rampEdgeColliders(ramp, firstIndex + i, true, height));
}

/** The ramps as plain RampDefs for createSimWorld. */
export function mapRampDefs(): RampDef[] {
    return MAP_RAMPS.map(({ x, z, yaw, width, length, height }) => ({ x, z, yaw, width, length, height }));
}
