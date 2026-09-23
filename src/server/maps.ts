import { createMapData, type MapData } from '../shared/world/mapData.js';
import { WORLD_SEED } from '../shared/world/worldGen.js';
import { TERRAIN_CONFIG } from './config.js';

// The immutable map data, built once per seed and shared by every room of
// that map (docs/phase-1b-design.md, 2.1). Rooms copy the items they change.
const maps = new Map<number, MapData>();

export function mapFor(seed: number = WORLD_SEED): MapData {
    let map = maps.get(seed);
    if (!map) {
        map = createMapData(seed, TERRAIN_CONFIG);
        maps.set(seed, map);
    }
    return map;
}
