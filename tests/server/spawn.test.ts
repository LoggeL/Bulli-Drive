import { describe, expect, it } from 'vitest';
import { mapFor } from '../../src/server/maps.js';
import { SPAWN_PLAYER_SPACING, slotOrder, slotSpawn } from '../../src/server/rooms/spawn.js';
import type { SpawnSlot } from '../../src/shared/map/mapData.js';
import { heightAt } from '../../src/shared/map/heightfield.js';
import { roadSurfaceIdAt } from '../../src/shared/map/roadNetwork.js';
import { pointInPolygon } from '../../src/shared/map/geometry.js';
import { overlapsColliders } from '../../src/shared/sim/collision.js';
import { createSimCar, placeVehicle } from '../../src/shared/sim/vehicle.js';

// Where cars spawn (src/server/rooms/spawn.ts): the fixed slots of the
// map, groups in turn, the first clear slot of a group. The expected slots
// are worked out by hand from a small list; the map's own slots are checked
// against the map (on a road or area, dry, clear of every collider).

const slot = (group: string, x: number, z: number, yaw = 0): SpawnSlot => ({ group, x, z, yaw });
// Two groups of three slots 20 m apart, and a group of one
const SLOTS: SpawnSlot[] = [
    slot('a', 0, 0), slot('a', 20, 0), slot('a', 40, 0),
    slot('b', 0, 500, 1), slot('b', 20, 500, 1), slot('b', 40, 500, 1),
    slot('c', 900, 900, 2)
];
const at = (list: SpawnSlot[]) => list.map(s => `${s.group}${s.x}`);

describe('slotOrder', () => {
    it('lets the groups take turns and rotates a group each round', () => {
        expect(at(slotOrder(SLOTS, 0))).toEqual(['a0', 'a20', 'a40', 'b0', 'b20', 'b40', 'c900']);
        expect(at(slotOrder(SLOTS, 1))).toEqual(['b0', 'b20', 'b40', 'c900', 'a0', 'a20', 'a40']);
        expect(at(slotOrder(SLOTS, 2))).toEqual(['c900', 'a0', 'a20', 'a40', 'b0', 'b20', 'b40']);
        // Round 1 (turns 3 to 5): every group starts at its second slot
        expect(at(slotOrder(SLOTS, 3))).toEqual(['a20', 'a40', 'a0', 'b20', 'b40', 'b0', 'c900']);
        expect(at(slotOrder(SLOTS, 7))).toEqual(['b40', 'b0', 'b20', 'c900', 'a40', 'a0', 'a20']);
    });
});

describe('slotSpawn', () => {
    it('takes the first slot of the group whose turn it is, with its heading', () => {
        expect(slotSpawn(SLOTS, 0, [])).toEqual({ x: 0, z: 0, yaw: 0 });
        expect(slotSpawn(SLOTS, 1, [])).toEqual({ x: 0, z: 500, yaw: 1 });
        expect(slotSpawn(SLOTS, 2, [])).toEqual({ x: 900, z: 900, yaw: 2 });
    });

    it('keeps 12 m from the other cars: exactly 12 m is enough, just under is not', () => {
        expect(slotSpawn(SLOTS, 0, [{ x: 0, z: SPAWN_PLAYER_SPACING }])).toEqual({ x: 0, z: 0, yaw: 0 });
        expect(slotSpawn(SLOTS, 0, [{ x: 0, z: SPAWN_PLAYER_SPACING - 0.01 }])).toEqual({ x: 20, z: 0, yaw: 0 });
    });

    it('hands a full group over to the next one', () => {
        const cars = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 0 }];
        expect(slotSpawn(SLOTS, 0, cars)).toEqual({ x: 0, z: 500, yaw: 1 });
    });

    it('stays out of the pickup circles', () => {
        expect(slotSpawn(SLOTS, 0, [], [{ x: 1, z: 1, radius: 4 }])).toEqual({ x: 20, z: 0, yaw: 0 });
        // A slot just outside the circle is fine
        expect(slotSpawn(SLOTS, 0, [], [{ x: 0, z: 4, radius: 4 }])).toEqual({ x: 0, z: 0, yaw: 0 });
    });

    it('takes the slot farthest from the other cars when none is clear', () => {
        // A car next to every slot; the one beside b40 is 5 m away, the others 1 m
        const cars = SLOTS.map(s => ({ x: s.x + (s.group === 'b' && s.x === 40 ? 5 : 1), z: s.z }));
        expect(slotSpawn(SLOTS, 0, cars)).toEqual({ x: 40, z: 500, yaw: 1 });
    });

    it('needs slots', () => {
        expect(() => slotSpawn([], 0, [])).toThrow();
    });
});

describe('the map\'s spawn slots', () => {
    const map = mapFor();
    const inArea = (x: number, z: number) => map.net.areas.some(area => pointInPolygon(area.polygon, x, z));

    it('are 16 for Free Roam in four places, 16 round the arena and 8 in the harbour yards', () => {
        expect(map.spawns.freeRoam).toHaveLength(16);
        expect(new Set(map.spawns.freeRoam.map(s => s.group))).toEqual(new Set(['plaza', 'diner', 'beach', 'lookout']));
        expect(map.spawns.party.filter(s => s.group === 'arena')).toHaveLength(16);
        expect(map.spawns.party.filter(s => s.group === 'harbor')).toHaveLength(8);
        expect(map.spawns.party).toHaveLength(24);
    });

    it('stand on a road or an area, above the water, and a car there touches no collider', () => {
        for (const [slots, world] of [[map.spawns.freeRoam, map.simWorld], [map.spawns.party, map.partyWorld]] as const) {
            for (const s of slots) {
                expect(roadSurfaceIdAt(map.net, s.x, s.z) >= 0 || inArea(s.x, s.z), `${s.group} ${s.x} ${s.z}`).toBe(true);
                expect(heightAt(map.hf, s.x, s.z)).toBeGreaterThan(map.hf.spec.waterLevel + 0.5);
                for (const classId of ['bulli', 'pickup'] as const) {
                    const car = createSimCar('p', classId);
                    placeVehicle(car.state, world, s.x, s.z, s.yaw);
                    expect(overlapsColliders(car.state, car.params, world), `${classId} at ${s.group} ${s.x} ${s.z}`).toBe(false);
                }
            }
        }
    });

    it('keep the Party\'s slots in its zone: the arena\'s inside the arena, the yards\' on their roads outside it', () => {
        const arena = map.net.areas.find(area => area.id === map.sources.pois.arena.area)!;
        const zone = map.partyZone;
        for (const s of map.spawns.party) {
            expect(pointInPolygon(arena.polygon, s.x, s.z), `${s.group} ${s.x} ${s.z}`).toBe(s.group === 'arena');
            if (s.group === 'harbor') expect(roadSurfaceIdAt(map.net, s.x, s.z)).toBeGreaterThanOrEqual(0);
            expect(s.x > zone.minX + 3 && s.x < zone.maxX - 3 && s.z > zone.minZ + 3 && s.z < zone.maxZ - 3, `${s.x} ${s.z}`).toBe(true);
        }
    });
});
