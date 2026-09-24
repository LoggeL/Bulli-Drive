import type { MapData } from '../../shared/world/mapData.js';
import { Room } from './Room.js';

// Free Roam (docs/phase-1b-design.md, 2.2): the same map, driving, jumping,
// honking and bumping, but no items, no shooting, no HP and no scoreboard.
// Every game message beyond driving is ignored (Room.onGameMessage); after
// a spawn only the sim's contact ghost protects the car.
export class FreeRoamRoom extends Room {
    constructor(index: number, map: MapData, now: () => number = Date.now) {
        super('freeroam', index, map, now);
    }
}
