import type { MapData } from '../../shared/map/mapData.js';
import type { RoomKind } from '../../shared/protocol.js';
import { FLAT_TERRAIN } from '../../shared/sim/scenarios.js';
import { createSimWorld, type SimWorld } from '../../shared/world/colliders.js';
import { state } from '../state.js';

// The static collision world of the v2 sim: the map's own, built from the
// same sources and terrain as the server's (shared/map/mapData.ts,
// docs/phase-3-design.md, 14 M3), never from what the client happened to
// render. Free Roam drives in the map's world, the Party in the arena's
// (its gate closed), a race room in its race world (map + track).

let mapData: MapData | null = null;
let roomWorld: SimWorld | null = null;
// A race room drives in its race world (map + track, race/RaceClient.ts)
let worldOverride: SimWorld | null = null;
// Without a map (a unit test, the page before its map): flat and empty
let fallback: SimWorld | null = null;

/** The map is loaded: its colliders and ground become the client's. */
export function setGameMapWorld(map: MapData): void {
    mapData = map;
    roomWorld = map.simWorld;
    state.worldColliders = map.colliders;
    state.groundHeight = map.simWorld.terrainHeight;
}

/** The world of a room kind (the Party: the arena); also the current world from now on. */
export function roomSimWorld(kind: RoomKind): SimWorld {
    roomWorld = mapData ? (kind === 'party' ? mapData.partyWorld : mapData.simWorld) : currentSimWorld();
    return roomWorld;
}

/** The world of a race room (null: the room's own again). */
export function setWorldOverride(world: SimWorld | null): void {
    worldOverride = world;
}

/** The world the local car drives in now. */
export function currentSimWorld(): SimWorld {
    if (worldOverride) return worldOverride;
    if (roomWorld) return roomWorld;
    if (!fallback) fallback = createSimWorld(FLAT_TERRAIN, []);
    return fallback;
}
