import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { FURNITURE_COLLIDERS, FURNITURE_ZONES, placeFurniture, type Furniture, type FurnitureContext } from '../../../src/shared/map/furniture.js';
import { zoneAt } from '../../../src/shared/map/heightfield.js';
import { buildRoadNetwork, isOnRoad } from '../../../src/shared/map/roadNetwork.js';
import { BoxIndex, boxContains, placementBox } from '../../../src/shared/map/structures.js';
import { ZONE } from '../../../src/shared/map/types.js';
import { edge, makeHeightfield, network, node, PROFILE } from './fixtures.js';

// Street furniture (src/shared/map/furniture.ts, docs/phase-3-design.md
// 11.1): on small hand-built maps with positions worked out by hand from
// the rules, and invariants of Bulli Bay's own data.

const BOUNDARY: [number, number][] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];

function context(net: ReturnType<typeof buildRoadNetwork>, zone = () => ZONE.downtown as number): FurnitureContext {
    return { net, hf: makeHeightfield(() => 1, zone), areas: net.areas, boundary: BOUNDARY, buildings: new BoxIndex(), reserved: [], plants: [] };
}

const where = (pieces: Furniture[], kind: Furniture['kind']) => pieces.filter(p => p.kind === kind).map(p => [p.x, p.z, p.ux, p.uz]);

describe('placeFurniture on a straight street', () => {
    // East-west from (-90, 0) to (90, 0), 10 m wide, 3 m sidewalks, two
    // dead ends (trim 0): the blocks run from s = 4 to 176, i.e. x = -86 to 86
    const net = buildRoadNetwork(network([node('w', -90, 0), node('e', 90, 0)], [edge('main', 'w', 'e')], {
        profiles: { road: { ...PROFILE, sidewalk: { left: 3, right: 3 } } }
    }));

    it('puts lights every 36 m on both sides near the curb, their arms over the road', () => {
        const pieces = placeFurniture(context(net));
        // s = 4 + 18 + 36k: x = -68, -32, 4, 40, 76; 5 + 0.6 m from the
        // centre line, left (north, -z) and right; local x = (uz, -ux)
        // points at the road: (0, 1) on the north side, (0, -1) on the south
        const lamps = where(pieces, 'lamp');
        expect(lamps).toHaveLength(10);
        expect(lamps.filter(l => l[1] === -5.6)).toEqual([-68, -32, 4, 40, 76].map(x => [x, -5.6, -1, 0]));
        expect(lamps.filter(l => l[1] === 5.6)).toEqual([-68, -32, 4, 40, 76].map(x => [x, 5.6, 1, 0]));
    });

    it('puts a hydrant at the end of the block on the right, benches and trash cans at the back of wide sidewalks', () => {
        const pieces = placeFurniture(context(net));
        // Hydrant: s = 176 - 3 (x = 83), right side, facing the road (-z)
        expect(where(pieces, 'hydrant')).toEqual([[83, 5.6, 0, -1]]);
        // Benches every 72 m from s = 40 (x = -50, 22), 5 + 3 - 0.55 = 7.45 m
        // out, facing the road; a trash can 2.1 m along
        expect(where(pieces, 'bench')).toEqual([[-50, -7.45, 0, 1], [22, -7.45, 0, 1], [-50, 7.45, 0, -1], [22, 7.45, 0, -1]]);
        expect(where(pieces, 'trashCan').map(p => [p[0], p[1]])).toEqual([[-47.9, -7.45], [24.1, -7.45], [-47.9, 7.45], [24.1, 7.45]]);
        expect(where(pieces, 'signal')).toEqual([]);
    });

    it('furnishes only Downtown and the park, and only wide enough sidewalks', () => {
        expect(placeFurniture(context(net, () => ZONE.residential))).toEqual([]);
        expect(placeFurniture(context(net, () => ZONE.park)).length).toBe(19);
        const narrow = buildRoadNetwork(network([node('w', -90, 0), node('e', 90, 0)], [edge('main', 'w', 'e')], {
            profiles: { road: { ...PROFILE, sidewalk: { left: 1.4, right: 2 } } }
        }));
        // Only the right side (2 m: lights and the hydrant, no benches)
        const pieces = placeFurniture(context(narrow));
        expect(pieces.every(p => p.z > 0)).toBe(true);
        expect(pieces.map(p => p.kind).sort()).toEqual(['hydrant', 'lamp', 'lamp', 'lamp', 'lamp', 'lamp']);
    });

    it('keeps clear of buildings, plants and reserved places', () => {
        const ctx = context(net);
        // A building reaching to 0.3 m of the first northern light (its
        // post 0.2 m and 0.2 m clearance), a palm at the second, a reserved
        // place at the third
        ctx.buildings.add({ x: -68, z: -8.9, hw: 3, hd: 3, ux: 0, uz: 1 });
        const pieces = placeFurniture({
            ...ctx,
            plants: [{ kind: 'palm', x: -32, z: -6.5, size: 1, seed: 0 }],
            reserved: [{ x: 4, z: -5.6, hw: 1, hd: 1, ux: 0, uz: 1 }]
        });
        expect(where(pieces, 'lamp').filter(l => l[1] === -5.6).map(l => l[0])).toEqual([40, 76]);
    });
});

describe('placeFurniture behind a junction', () => {
    // A 10 m road from a junction at (0, 0) east to a dead end at (180, 0),
    // 2 m sidewalks; a side road north makes (0, 0) a junction
    const build = (radius?: number) => buildRoadNetwork(network(
        [node('c', 0, 0, 'junction', { junction: { shape: 'auto', control: 'stop', crosswalks: false, ...(radius ? { radius } : {}) } }),
            node('e', 180, 0), node('n', 0, -90)],
        [edge('ce', 'c', 'e'), edge('cn', 'c', 'n')],
        { profiles: { road: { ...PROFILE, sidewalk: { left: 2, right: 2 } } } }
    ));
    const firstLight = (radius?: number) => Math.min(...where(placeFurniture(context(build(radius))), 'lamp').filter(l => l[1] > 0 && l[0] > 0).map(l => l[0]));

    it('keeps the trim radius + 4 m clear, and at a wider trimmed (acute) junction that surplus once more', () => {
        // Default trim 5 + 2 = 7: the block starts at 11, the first light
        // 18 m on at x = 29
        expect(firstLight()).toBe(29);
        // Trimmed to 20 m (13 m more than the default): 20 + 4 + 13 = 37,
        // the first light at 55
        expect(firstLight(20)).toBe(55);
    });
});

describe('placeFurniture at a signalled junction', () => {
    // Two 10 m roads crossing at (0, 0), 2 m sidewalks: trim radius
    // 5 + 2 = 7 m, a pole a metre before it on the right of each approach
    const junction = node('c', 0, 0, 'junction', { junction: { shape: 'auto', control: 'signal', crosswalks: true } });
    const net = buildRoadNetwork(network(
        [node('w', -90, 0), node('e', 90, 0), node('n', 0, -90), node('s', 0, 90), junction],
        [edge('wc', 'w', 'c'), edge('ce', 'c', 'e'), edge('nc', 'n', 'c'), edge('cs', 'c', 's')],
        { profiles: { road: { ...PROFILE, sidewalk: { left: 2, right: 2 } } } }
    ));

    it('stands a signal pole on the right of every approach, the arm over the lanes, the heads towards the traffic', () => {
        const signals = where(placeFurniture(context(net)), 'signal');
        // In the order of the junction's edges. Local +z along the
        // approaching traffic (heads face local -z back at it), local
        // x = (uz, -ux) towards the road
        expect(signals).toEqual([
            // wc, arriving from the west: traffic goes east on the south side
            [-8, 5.6, 1, 0],
            // ce, leaving c eastwards: traffic comes west on the north side
            [8, -5.6, -1, 0],
            // nc, arriving from the north: traffic goes south on the west side
            [-5.6, -8, 0, 1],
            // cs, leaving c southwards: traffic comes north on its right (east)
            [5.6, 8, 0, -1]
        ]);
    });

    it('leaves out the approach without lanes towards the junction (a one-way road away from it)', () => {
        const oneWay = buildRoadNetwork(network(
            [node('w', -90, 0), node('e', 90, 0), junction],
            [edge('wc', 'w', 'c'), edge('ce', 'c', 'e', [], { profile: 'oneway' })],
            { profiles: { road: { ...PROFILE, sidewalk: { left: 2, right: 2 } }, oneway: { ...PROFILE, lanes: [1, 0], sidewalk: { left: 2, right: 2 } } } }
        ));
        expect(where(placeFurniture(context(oneWay)), 'signal')).toEqual([[-8, 5.6, 1, 0]]);
    });
});

describe('Bulli Bay\'s street furniture', () => {
    const map = mapFor();

    it('stands off the carriageways, in Downtown and the park, clear of buildings and plants, each on its collider', () => {
        expect(map.furniture.length).toBeGreaterThan(200);
        const buildings = new BoxIndex();
        for (const lot of map.buildings) buildings.add(placementBox(lot));
        for (const piece of map.furniture) {
            const tag = `${piece.kind} at ${piece.x}, ${piece.z}`;
            expect(isOnRoad(map.net, piece.x, piece.z), tag).toBe(false);
            expect(FURNITURE_ZONES, tag).toContain(zoneAt(map.hf, piece.x, piece.z));
            expect(buildings.contains(piece.x, piece.z, 0.2), tag).toBe(false);
            expect(Math.hypot(piece.ux, piece.uz), tag).toBeCloseTo(1, 3);
            const collider = map.colliders.find(c => (c.kind === 'circle' || c.kind === 'obox') && c.x === piece.x && c.z === piece.z);
            expect(collider, tag).toBeDefined();
            if (piece.kind === 'bench') expect(boxContains(collider as never, piece.x + piece.uz * 0.9, piece.z - piece.ux * 0.9, 0.01), tag).toBe(true);
            else expect(collider).toMatchObject({ kind: 'circle', r: FURNITURE_COLLIDERS[piece.kind].r, top: FURNITURE_COLLIDERS[piece.kind].top });
        }
        // Main Street's signals: its junctions with the four avenues
        expect(map.furniture.filter(p => p.kind === 'signal').length).toBeGreaterThanOrEqual(16);
    });
});
