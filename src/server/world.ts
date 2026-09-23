import { Powerup, Tree, Coin, CityData } from './types.js';
import { generateWorld } from '../shared/world/worldGen.js';

// Live server-side world state. The layout itself is generated
// deterministically in src/shared/world; only the collected flags change.
export const powerups: Powerup[] = [];
export const powerupsById = new Map<number, Powerup>();
export const trees: Tree[] = [];
export const coins: Coin[] = [];
export const coinsById = new Map<number, Coin>();
export const cityData: CityData = { buildings: [], roads: [] };

export function initWorld() {
    // initWorld is deliberately re-entrant: never append a second copy of the
    // map or retain collected state when regenerating it. The exported
    // containers keep their identity because other modules hold references.
    powerups.length = 0;
    powerupsById.clear();
    trees.length = 0;
    coins.length = 0;
    coinsById.clear();
    cityData.buildings.length = 0;
    cityData.roads.length = 0;

    const world = generateWorld();
    cityData.buildings.push(...world.city.buildings);
    cityData.roads.push(...world.city.roads);
    trees.push(...world.trees);

    for (const powerup of world.powerups) {
        powerups.push(powerup);
        powerupsById.set(powerup.id, powerup);
    }
    for (const coin of world.coins) {
        coins.push(coin);
        coinsById.set(coin.id, coin);
    }
}
