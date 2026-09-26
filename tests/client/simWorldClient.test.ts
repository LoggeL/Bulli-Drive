import { describe, expect, it } from 'vitest';
import { currentSimWorld, roomSimWorld, setGameMapWorld, setWorldOverride } from '../../src/client/vehicle/simWorldClient.js';
import { state } from '../../src/client/state.js';
import { mapFor } from '../../src/server/maps.js';
import { heightAt } from '../../src/shared/map/heightfield.js';
import { createFlatWorld } from '../../src/shared/sim/scenarios.js';

// The client's sim world (src/client/vehicle/simWorldClient.ts): the map's
// own worlds, never one built from what was rendered, per room kind; a race
// room's world on top.

describe('the client\'s sim world', () => {
    it('is empty and flat before the map is there', () => {
        const world = currentSimWorld();
        expect(world.colliders).toHaveLength(0);
        expect(world.groundHeight(-400, -20)).toBe(0);
        expect(currentSimWorld()).toBe(world);
    });

    it('takes the map\'s colliders and ground, the arena\'s world in the Party', () => {
        const map = mapFor();
        setGameMapWorld(map);
        expect(state.worldColliders).toBe(map.colliders);
        expect(state.groundHeight!(-400, -20)).toBe(heightAt(map.hf, -400, -20));
        expect(roomSimWorld('freeroam')).toBe(map.simWorld);
        expect(currentSimWorld()).toBe(map.simWorld);
        expect(roomSimWorld('party')).toBe(map.partyWorld);
        expect(currentSimWorld()).toBe(map.partyWorld);
        expect(roomSimWorld('race')).toBe(map.simWorld);
    });

    it('hands out the race world of a race room instead, and the room\'s world after it', () => {
        const map = mapFor();
        setGameMapWorld(map);
        roomSimWorld('freeroam');
        const race = createFlatWorld();
        setWorldOverride(race);
        expect(currentSimWorld()).toBe(race);
        setWorldOverride(null);
        expect(currentSimWorld()).toBe(map.simWorld);
    });
});
