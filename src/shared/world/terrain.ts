// Procedural terrain height of the sandbox (?sandbox=1) and of the sim's
// own tests: a sum of sine waves from a TerrainConfig, flattened in a
// circle round a centre. It was the ground of the old city before the
// curated map (phase 3); the circle keeps that city's footprint (a square
// from -104 to 116 m on both axes plus half a 12 m road), so the sim's
// golden runs stay bit for bit the same.

import type { TerrainConfig } from '../protocol.js';

const FLAT_CENTER = 6;
const FLAT_HALF_EXTENT = 116;
// Circle that encloses the square
const FLAT_RADIUS = Math.SQRT2 * FLAT_HALF_EXTENT;
// Width of the ring over which the terrain eases back to full height
const BLEND_RADIUS = 40;

// The flat area in the middle of the sine terrain
export const TERRAIN_FLAT_AREA = {
    centerX: FLAT_CENTER,
    centerZ: FLAT_CENTER,
    halfExtent: FLAT_HALF_EXTENT,
    flatRadius: FLAT_RADIUS,
    blendRadius: BLEND_RADIUS
};

export function getTerrainHeight(config: TerrainConfig, x: number, z: number): number {
    const { frequency1, amplitude1, frequency2, amplitude2 } = config;
    // Older configs had no third octave; treat missing values as 0.
    const freq3 = config.frequency3 || 0;
    const amp3 = config.amplitude3 || 0;

    // Flat in the circle, easing back to full height over the ring
    const distFromCenter = Math.hypot(x - FLAT_CENTER, z - FLAT_CENTER);
    let flattenFactor = 1.0;
    if (distFromCenter < FLAT_RADIUS) {
        flattenFactor = 0.0;
    } else if (distFromCenter < FLAT_RADIUS + BLEND_RADIUS) {
        flattenFactor = (distFromCenter - FLAT_RADIUS) / BLEND_RADIUS;
        flattenFactor = flattenFactor * flattenFactor; // Smooth ease-in
    }

    const height = (
        Math.sin(x * frequency1) * amplitude1 +
        Math.cos(z * frequency1) * amplitude1 +
        Math.sin(x * frequency2 + z * frequency2) * amplitude2 +
        Math.sin(x * freq3 + 1.7) * Math.cos(z * freq3 + 2.3) * amp3
    ) * flattenFactor;

    return height;
}
