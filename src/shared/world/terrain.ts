// Procedural terrain height, shared by client and server. The heightfield is
// a sum of sine waves from the TerrainConfig of the map,
// flattened over the city footprint so roads and buildings sit level.

import { CITY_LAYOUT } from '../constants.js';
import type { TerrainConfig } from '../protocol.js';
import { CITY_BOUNDS } from './cityGen.js';

// The city footprint is square and sits slightly off the origin (the grid
// ends with an extra road on the + side), so both axes share one half extent.
const CITY_CENTER_X = (CITY_BOUNDS.minX + CITY_BOUNDS.maxX) / 2;
const CITY_CENTER_Z = (CITY_BOUNDS.minZ + CITY_BOUNDS.maxZ) / 2;
const CITY_HALF_EXTENT = (CITY_BOUNDS.maxX - CITY_BOUNDS.minX) / 2;
const CITY_CLEARANCE = CITY_LAYOUT.roadWidth / 2;
// Circle that encloses the footprint plus half a road of clearance
const CITY_FLAT_RADIUS = Math.SQRT2 * (CITY_HALF_EXTENT + CITY_CLEARANCE);
// Width of the ring over which the terrain eases back to full height
const CITY_BLEND_RADIUS = 40;

// Flattened city area, e.g. for keeping procedural scenery out of the city.
export const CITY_TERRAIN_AREA = {
    centerX: CITY_CENTER_X,
    centerZ: CITY_CENTER_Z,
    // Half side length of the footprint including the clearance
    halfExtent: CITY_HALF_EXTENT + CITY_CLEARANCE,
    flatRadius: CITY_FLAT_RADIUS,
    blendRadius: CITY_BLEND_RADIUS
};

export function getTerrainHeight(config: TerrainConfig, x: number, z: number): number {
    const { frequency1, amplitude1, frequency2, amplitude2 } = config;
    // Older configs had no third octave; treat missing values as 0.
    const freq3 = config.frequency3 || 0;
    const amp3 = config.amplitude3 || 0;

    // Flatten the full city footprint plus half a road of clearance. Both the
    // footprint and its slightly offset center come from the shared layout.
    const distFromCenter = Math.hypot(x - CITY_CENTER_X, z - CITY_CENTER_Z);
    let flattenFactor = 1.0;
    if (distFromCenter < CITY_FLAT_RADIUS) {
        flattenFactor = 0.0;
    } else if (distFromCenter < CITY_FLAT_RADIUS + CITY_BLEND_RADIUS) {
        flattenFactor = (distFromCenter - CITY_FLAT_RADIUS) / CITY_BLEND_RADIUS;
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
