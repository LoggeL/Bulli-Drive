// Deterministic generation of the complete world (city, powerups, coins,
// trees). Server and client both run it from the seed (roomState.world
// carries only the seed and a hash); tests pin its output with golden hashes.

import { POWERUP_TYPES } from '../constants.js';
import type { CityData, CoinData, PowerupData, TreeData } from '../protocol.js';
import { mulberry32, type RandomSource } from '../math/rng.js';
import { generateCity, isInCityArea, isOnRoad } from './cityGen.js';

// Every generateWorld call starts a fresh generator from this seed, so a
// restart or regeneration produces exactly the same authoritative world.
export const WORLD_SEED = 0xB0111D;

export interface GeneratedWorld {
    city: CityData;
    powerups: PowerupData[];
    coins: CoinData[];
    trees: TreeData[];
}

// Sample random positions in [-range/2, range/2]^2 until reject() passes.
// Returns ok=false (with the last candidate) when all attempts were rejected.
export function placeWithRejection(
    range: number,
    maxAttempts: number,
    random: RandomSource,
    reject: (x: number, z: number) => boolean
): { x: number; z: number; ok: boolean } {
    let x = 0, z = 0;
    for (let attempts = 0; attempts < maxAttempts; attempts++) {
        x = (random() - 0.5) * range;
        z = (random() - 0.5) * range;
        if (!reject(x, z)) return { x, z, ok: true };
    }
    return { x, z, ok: false };
}

export function generateWorld(seed: number = WORLD_SEED): GeneratedWorld {
    const random = mulberry32(seed);
    const city = generateCity(random);
    const powerups: PowerupData[] = [];
    const coins: CoinData[] = [];
    const trees: TreeData[] = [];

    // Powerups: keep them within reach of the action - on city roads or in
    // the open ring just around the city (<=150 from center), never inside a
    // building block or out in the distant wilderness.
    for (let i = 0; i < 25; i++) {
        const type = POWERUP_TYPES[Math.floor(random() * POWERUP_TYPES.length)];
        const spot = placeWithRejection(300, 30, random, (x, z) =>
            (isInCityArea(x, z) && !isOnRoad(x, z)) || (x * x + z * z) > 150 * 150);

        powerups.push({
            id: i,
            x: spot.x,
            z: spot.z,
            type: type.type,
            color: type.color,
            label: type.label,
            collected: false
        });
    }

    // Coins: spread across the playable area (within ~140 of center),
    // skipping the central spawn pad and building-block interiors.
    for (let i = 0; i < 30; i++) {
        const spot = placeWithRejection(280, 30, random, (x, z) =>
            (Math.abs(x) < 25 && Math.abs(z) < 25) || (isInCityArea(x, z) && !isOnRoad(x, z)));

        coins.push({
            id: i,
            x: spot.x,
            z: spot.z,
            collected: false
        });
    }

    // Trees (outside city area; skip the tree if no valid spot was found)
    for (let i = 0; i < 120; i++) {
        const spot = placeWithRejection(600, 20, random, (x, z) =>
            isInCityArea(x, z) || (Math.abs(x) < 40 && Math.abs(z) < 40));
        if (!spot.ok) continue;

        trees.push({
            id: i,
            x: spot.x,
            z: spot.z,
            height: 4 + random() * 5
        });
    }

    return { city, powerups, coins, trees };
}
