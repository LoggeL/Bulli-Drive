import type { BaseTerrain } from '../../../tools/map/baseTerrain.js';

// Base terrain without noise: land east of x = -150 with a beach, rising
// towards the east. Heights follow from the formulas by hand.
export const FLAT_COAST: BaseTerrain = {
    format: 'bulli-base', version: 1, mapId: 'test', seed: 1,
    sea: { floor: -10, shelf: 50 },
    // Land east of x = -150
    coast: [[-150, -1000], [1000, -1000], [1000, 1000], [-150, 1000]],
    beach: { width: 30, top: 2, blend: 20 },
    land: { base: 4, tilt: [0.02, 0], tiltOrigin: [-150, 0] },
    hills: [],
    flats: [],
    cliffs: [],
    noise: { amplitude: 0, wavelength: 480, octaves: 4, gain: 0.5 },
    regions: []
};
