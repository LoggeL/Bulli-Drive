// Hill Sprint (docs/phase-2-design.md, 5.3): from the city's northern part
// south through the city, out over the flat blend ring into the hills and
// over three ramps (MAP_RAMPS) to a lookout at 13.8 m, looking back at the
// city. The way out leads south on x = 58, where the terrain's blend ring
// is flat.

import { HILL_ROAD } from '../../world/mapFeatures.js';
import { MAP_VERSION_FOR_RACES } from '../mapVersion.js';
import type { TrackDef, Vec2 } from '../types.js';
import { cornerChevrons, sideStreetBarriers } from './hints.js';

// Starts 38 m behind the start gate, so the grid lies on the line and the
// standings order the cars on it by the distance to the start gate
const CENTERLINE: Vec2[] = [{ x: 58, z: 104 }, ...HILL_ROAD.line.slice(1)];

export const HILL_SPRINT: TrackDef = {
    id: 'hill-sprint',
    name: 'Hill Sprint',
    kind: 'sprint',
    laps: 1,
    mapVersion: MAP_VERSION_FOR_RACES,
    trackVersion: 1,
    centerline: CENTERLINE,
    lineOptions: { radius: 40, apexShift: 0 },
    gates: [
        // 2 m clear of the crossing at z = 58 (its edge is at z = 64)
        { x: 58, z: 66, yaw: Math.PI, width: 16, visual: 'start' },
        { x: 58, z: -72, yaw: Math.PI, width: 16, visual: 'arch' },
        { x: 69, z: -175, yaw: 2.727, width: 18, visual: 'arch' },
        { x: 125, z: -208, yaw: Math.PI / 2, width: 18, visual: 'arch' },
        { x: 205, z: -191.5, yaw: 0.987, width: 18, visual: 'arch' },
        { x: 303.5, z: -110, yaw: 0.553, width: 18, visual: 'arch' },
        { x: 350, z: -24, yaw: 0, width: 18, visual: 'arch' },
        { x: 356, z: 30, yaw: 0.540, width: 20, visual: 'finish' }
    ],
    // Staggered like the loop's, the last slot 4 m short of the crossing at z = 110
    grid: [
        { x: 60.8, z: 72, yaw: Math.PI }, { x: 55.2, z: 76, yaw: Math.PI }, { x: 60.8, z: 80, yaw: Math.PI },
        { x: 55.2, z: 84, yaw: Math.PI }, { x: 60.8, z: 88, yaw: Math.PI }, { x: 55.2, z: 92, yaw: Math.PI },
        { x: 60.8, z: 96, yaw: Math.PI }, { x: 55.2, z: 100, yaw: Math.PI }
    ],
    hints: [
        ...sideStreetBarriers(CENTERLINE, false),
        // Delineators every 15 m, 5.5 m either side, outside the city
        { kind: 'delineators', line: HILL_ROAD.line.map(p => ({ x: p.x, z: p.z })), offset: 5.5, spacing: 15 },
        // The four sharpest bends outside the city
        ...cornerChevrons(CENTERLINE, [2, 4, 8, 9], 11, false)
    ],
    minimap: { minX: 30, maxX: 390, minZ: -230, maxZ: 120 }
};
