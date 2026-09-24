// Downtown Loop (docs/phase-2-design.md, 5.2): a circuit of 3 laps
// anticlockwise through today's city (road centre lines at -98, -46, 6, 58,
// 110). It never crosses itself, so racers never meet head-on.
//
//           x=-98                        x=6          x=58
//  z=110      +----------<-- G3 ---------------------------+
//             |                                            |
//             |                                            ^ G2
//  z=58       |                           +---- G1 -->-----+
//             |                           |
//             v G4                        ^ G0 start/finish (6,-10),
//             |                           |    grid down to z = -44
//  z=-46      |                           +---<-- G7 ------+
//             |                                            ^ G6
//  z=-98      +------------ G5 -->-------------------------+

import { MAP_VERSION_FOR_RACES } from '../mapVersion.js';
import type { TrackDef, Vec2 } from '../types.js';
import { cornerArrows, cornerChevrons, sideStreetBarriers } from './hints.js';

const CENTERLINE: Vec2[] = [
    { x: 6, z: -10 }, { x: 6, z: 58 }, { x: 58, z: 58 }, { x: 58, z: 110 }, { x: -98, z: 110 },
    { x: -98, z: -98 }, { x: 58, z: -98 }, { x: 58, z: -46 }, { x: 6, z: -46 }
];
// Vertices 1..8 are the eight 90° corners
const CORNERS = [1, 2, 3, 4, 5, 6, 7, 8];
const HALF_PI = Math.PI / 2;

export const DOWNTOWN_LOOP: TrackDef = {
    id: 'downtown-loop',
    name: 'Downtown Loop',
    kind: 'circuit',
    laps: 3,
    mapVersion: MAP_VERSION_FOR_RACES,
    trackVersion: 1,
    centerline: CENTERLINE,
    lineOptions: { radius: 19, apexShift: 0 },
    // Mid-block between two crossings, 16 m wide (the road plus the sidewalks)
    gates: [
        { x: 6, z: -10, yaw: 0, width: 16, visual: 'startFinish' },
        { x: 32, z: 58, yaw: HALF_PI, width: 16, visual: 'arch' },
        { x: 58, z: 84, yaw: 0, width: 16, visual: 'arch' },
        { x: -20, z: 110, yaw: -HALF_PI, width: 16, visual: 'arch' },
        { x: -98, z: -20, yaw: Math.PI, width: 16, visual: 'arch' },
        { x: -20, z: -98, yaw: HALF_PI, width: 16, visual: 'arch' },
        { x: 58, z: -72, yaw: 0, width: 16, visual: 'arch' },
        { x: 32, z: -46, yaw: -HALF_PI, width: 16, visual: 'arch' }
    ],
    // Staggered in two lanes, 8 m apart in a lane, 6.9 m diagonally
    grid: [
        { x: 3.2, z: -16, yaw: 0 }, { x: 8.8, z: -20, yaw: 0 }, { x: 3.2, z: -24, yaw: 0 }, { x: 8.8, z: -28, yaw: 0 },
        { x: 3.2, z: -32, yaw: 0 }, { x: 8.8, z: -36, yaw: 0 }, { x: 3.2, z: -40, yaw: 0 }, { x: 8.8, z: -44, yaw: 0 }
    ],
    hints: [
        ...sideStreetBarriers(CENTERLINE, true),
        ...cornerChevrons(CENTERLINE, CORNERS, 9.5, true),
        ...cornerArrows(CENTERLINE, CORNERS, 30)
    ],
    minimap: { minX: -114, maxX: 74, minZ: -114, maxZ: 126 }
};
