import type { TrackDef, TrackId } from '../../src/shared/race/types.js';

// The two tracks of phase 2 on the old city, as the client tests of the
// race model measure against them by hand (docs/phase-2-design.md, 5.3):
// the Downtown Loop round the city blocks and the Hill Sprint that starts
// at (58, 104) and runs south on x = 58. Without their hints (the model
// does not read them).

const HALF_PI = Math.PI / 2;

export const OLD_DOWNTOWN_LOOP: TrackDef = {
    id: 'downtown-loop', name: 'Downtown Loop', kind: 'circuit', laps: 3, mapVersion: 3, trackVersion: 1,
    centerline: [
        { x: 6, z: -10 }, { x: 6, z: 58 }, { x: 58, z: 58 }, { x: 58, z: 110 }, { x: -98, z: 110 },
        { x: -98, z: -98 }, { x: 58, z: -98 }, { x: 58, z: -46 }, { x: 6, z: -46 }
    ],
    lineOptions: { radius: 19, apexShift: 0 },
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
    grid: [
        { x: 3.2, z: -16, yaw: 0 }, { x: 8.8, z: -20, yaw: 0 }, { x: 3.2, z: -24, yaw: 0 }, { x: 8.8, z: -28, yaw: 0 },
        { x: 3.2, z: -32, yaw: 0 }, { x: 8.8, z: -36, yaw: 0 }, { x: 3.2, z: -40, yaw: 0 }, { x: 8.8, z: -44, yaw: 0 }
    ],
    hints: [],
    minimap: { minX: -114, maxX: 74, minZ: -114, maxZ: 126 },
    ramps: []
};

export const OLD_HILL_SPRINT: TrackDef = {
    id: 'hill-sprint', name: 'Hill Sprint', kind: 'sprint', laps: 1, mapVersion: 3, trackVersion: 1,
    centerline: [
        { x: 58, z: 104 }, { x: 58, z: -150 }, { x: 80, z: -200 }, { x: 110, z: -208 }, { x: 180, z: -208 },
        { x: 230, z: -175 }, { x: 285, z: -140 }, { x: 322, z: -80 }, { x: 350, z: -35 }, { x: 350, z: 20 },
        { x: 362, z: 40 }
    ],
    lineOptions: { radius: 40, apexShift: 0 },
    gates: [
        { x: 58, z: 66, yaw: Math.PI, width: 16, visual: 'start' },
        { x: 58, z: -72, yaw: Math.PI, width: 16, visual: 'arch' },
        { x: 69, z: -175, yaw: 2.727, width: 18, visual: 'arch' },
        { x: 125, z: -208, yaw: HALF_PI, width: 18, visual: 'arch' },
        { x: 205, z: -191.5, yaw: 0.987, width: 18, visual: 'arch' },
        { x: 303.5, z: -110, yaw: 0.553, width: 18, visual: 'arch' },
        { x: 350, z: -24, yaw: 0, width: 18, visual: 'arch' },
        { x: 356, z: 30, yaw: 0.540, width: 20, visual: 'finish' }
    ],
    grid: [
        { x: 60.8, z: 72, yaw: Math.PI }, { x: 55.2, z: 76, yaw: Math.PI }, { x: 60.8, z: 80, yaw: Math.PI },
        { x: 55.2, z: 84, yaw: Math.PI }, { x: 60.8, z: 88, yaw: Math.PI }, { x: 55.2, z: 92, yaw: Math.PI },
        { x: 60.8, z: 96, yaw: Math.PI }, { x: 55.2, z: 100, yaw: Math.PI }
    ],
    hints: [],
    minimap: { minX: 30, maxX: 390, minZ: -230, maxZ: 120 },
    ramps: []
};

export function oldTrack(id: TrackId): TrackDef {
    return id === 'downtown-loop' ? OLD_DOWNTOWN_LOOP : OLD_HILL_SPRINT;
}
