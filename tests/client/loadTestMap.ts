import fs from 'node:fs';
import path from 'node:path';
import { decodeHeightfield } from '../../src/shared/map/heightfield.js';
import { createMapData, type MapData } from '../../src/shared/map/mapData.js';
import { MAP_OPTIONAL_SOURCE_FILES, MAP_SOURCE_FILES, parseMapSources, type RawMapSources, type RequiredMapSourceKey } from '../../src/shared/map/mapSources.js';
import { MAP_REGISTRY, type MapId } from '../../src/shared/map/registry.js';

const ROOT = path.resolve(__dirname, '../..');
const cache = new Map<MapId, MapData>();

/** Loads any baked curated map (with discoveries.json) directly from repo sources for client unit tests. */
export function loadTestMap(mapId: MapId): MapData {
    const cached = cache.get(mapId);
    if (cached) return cached;

    const srcDir = path.join(ROOT, 'src/shared/maps', mapId);
    const raw = {} as RawMapSources;
    for (const [key, file] of Object.entries(MAP_SOURCE_FILES) as [RequiredMapSourceKey, string][]) {
        raw[key] = JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf8')) as unknown;
    }
    const discFile = path.join(srcDir, MAP_OPTIONAL_SOURCE_FILES.discoveries);
    if (fs.existsSync(discFile)) {
        raw.discoveries = JSON.parse(fs.readFileSync(discFile, 'utf8')) as unknown;
    }
    const sources = parseMapSources(raw);
    const bhf = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/maps', mapId, 'terrain.bhf')));
    const hf = decodeHeightfield(bhf, MAP_REGISTRY[mapId].grid);
    const map = createMapData(sources, hf);
    cache.set(mapId, map);
    return map;
}
