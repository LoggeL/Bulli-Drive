import { getTerrainHeight } from '../../shared/world/terrain.js';
import { state } from '../state.js';

/**
 * The sim's ground under (x, z): the map's heightfield once it is loaded
 * (vehicle/simWorldClient.ts sets state.groundHeight), else the terrain of
 * state.terrainConfig (the sandbox), else 0. For everything that stands on
 * the ground the cars drive on: pickups, markers, effects, cars before
 * their spawn. The rendered terrain lies on the same ground (terrain.ts).
 */
export function groundHeight(x: number, z: number): number {
    if (state.groundHeight) return state.groundHeight(x, z);
    return state.terrainConfig ? getTerrainHeight(state.terrainConfig, x, z) : 0;
}
