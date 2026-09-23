import { beforeEach, describe, expect, it } from 'vitest';
import { cityData, coins, coinsById, initWorld, powerups, powerupsById, trees } from '../../src/server/world.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';
import { sha256, stableStringify } from '../helpers.js';

// Same golden hash as tests/shared/worldGen.test.ts: the server state after
// initWorld() must equal what the unchanged server produced on main (1d39c07).
const GOLDEN_WORLD_SHA = 'e2255cf50f1dbf97a3ecc33e9a47e1eaaddfbf5b6ff7590293080627723cbe20';

describe('server initWorld', () => {
    beforeEach(() => initWorld());

    it('fills the live state with the golden world', () => {
        expect(sha256(stableStringify({ city: cityData, powerups, coins, trees }))).toBe(GOLDEN_WORLD_SHA);
    });

    it('indexes powerups and coins by id', () => {
        expect(powerupsById.size).toBe(powerups.length);
        expect(coinsById.size).toBe(coins.length);
        for (const p of powerups) expect(powerupsById.get(p.id)).toBe(p);
        for (const c of coins) expect(coinsById.get(c.id)).toBe(c);
    });

    it('is re-entrant and resets collected state', () => {
        const cityRef = cityData;
        coins[0].collected = true;
        powerups[3].collected = true;
        initWorld();
        expect(cityData).toBe(cityRef);
        expect(coins.length).toBe(30);
        expect(cityData.buildings.length).toBe(30);
        expect(coins.some(c => c.collected) || powerups.some(p => p.collected)).toBe(false);
        expect(stableStringify({ city: cityData, powerups, coins, trees })).toBe(stableStringify(generateWorld()));
    });
});
