import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { FURNITURE_COLLIDERS, FURNITURE_ZONES, placeFurniture, type Furniture, type FurnitureContext } from '../../../src/shared/map/furniture.js';
import { zoneAt } from '../../../src/shared/map/heightfield.js';
import { pointInPolygon } from '../../../src/shared/map/geometry.js';
import { buildRoadNetwork, insideCorridor, isOnRoad } from '../../../src/shared/map/roadNetwork.js';
import { BoxIndex, boxContains, placementBox } from '../../../src/shared/map/structures.js';
import { ZONE } from '../../../src/shared/map/types.js';
import { edge, makeHeightfield, network, node, PROFILE } from './fixtures.js';

// Street furniture (src/shared/map/furniture.ts, docs/phase-3-design.md
// 11.1): on small hand-built maps with positions worked out by hand from
// the rules, and invariants of Bulli Bay's own data.

const BOUNDARY: [number, number][] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];

function context(net: ReturnType<typeof buildRoadNetwork>, zone = () => ZONE.downtown as number): FurnitureContext {
    return { net, hf: makeHeightfield(() => 1, zone), areas: net.areas, boundary: BOUNDARY, buildings: new BoxIndex(), reserved: [], plants: [], fountains: [] };
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
        // post 0.2 m and 0.2 m clearance), a palm of size 2 (trunk 0.7 m)
        // 1.4 m from the second (clearance 0.2 + 0.7 + 0.6 = 1.5 m), a
        // reserved place at the third
        ctx.buildings.add({ x: -68, z: -8.9, hw: 3, hd: 3, ux: 0, uz: 1 });
        const pieces = placeFurniture({
            ...ctx,
            plants: [{ kind: 'palm', x: -32, z: -7, size: 2, seed: 0 }],
            reserved: [{ x: 4, z: -5.6, hw: 1, hd: 1, ux: 0, uz: 1 }]
        });
        expect(where(pieces, 'lamp').filter(l => l[1] === -5.6).map(l => l[0])).toEqual([40, 76]);
    });

    it('keeps a bench its whole length clear of a building', () => {
        // The northern bench at (-50, -7.45) is 2 m long: a building 1.1 m
        // behind its middle is inside its 1.0 + 0.2 m; the lights and the
        // bench at x = 22 stay
        const ctx = context(net);
        ctx.buildings.add({ x: -50, z: -10.55, hw: 2, hd: 2, ux: 0, uz: 1 });
        expect(where(placeFurniture(ctx), 'bench').filter(b => b[1] < 0).map(b => b[0])).toEqual([22]);
    });

    it('stays off other carriageways, out of the lots and inside the map', () => {
        // A second road 9.4 m north (z = -9.4, 10 m wide): its carriageway
        // from -14.4 to -4.4 covers the northern lights (-5.6) and benches
        // (-7.45); a lot over x 30..50 on the south side; the map ends at
        // x = 60
        const two = buildRoadNetwork(network(
            [node('w', -90, 0), node('e', 90, 0), node('w2', -90, -9.4), node('e2', 90, -9.4)],
            [edge('main', 'w', 'e'), edge('north', 'w2', 'e2')],
            {
                profiles: { road: { ...PROFILE, sidewalk: { left: 3, right: 0 } } },
                areas: [{ id: 'lot', surface: 'asphalt', curb: false, polygon: [[30, 3], [50, 3], [50, 12], [30, 12]], connects: [] }]
            }
        ));
        const boundary: [number, number][] = [[-100, -100], [60, -100], [60, 100], [-100, 100]];
        const pieces = placeFurniture({ ...context(two), boundary }).filter(p => p.z > -8 && p.z < 8);
        // main's left (north) side is under the other road; its right side
        // has no sidewalk: nothing is left near main
        expect(pieces).toEqual([]);
        // The same with sidewalks on main's right: lights at -68, -32, 4 and
        // the hydrant at 83 would stand south; 40 is in the lot, 76 and 83
        // beyond the border
        const south = buildRoadNetwork(network(
            [node('w', -90, 0), node('e', 90, 0)], [edge('main', 'w', 'e')],
            {
                profiles: { road: { ...PROFILE, sidewalk: { left: 0, right: 3 } } },
                areas: [{ id: 'lot', surface: 'asphalt', curb: false, polygon: [[30, 3], [50, 3], [50, 12], [30, 12]], connects: [] }]
            }
        ));
        expect(where(placeFurniture({ ...context(south), boundary }), 'lamp').map(l => l[0])).toEqual([-68, -32, 4]);
    });

    it('keeps its own pieces apart: a light next to another street\'s bench is left out', () => {
        // A second street 14.55 m north, from x = -72: its southern lights
        // at x = -50 and 22 (s = 22 and 94) would stand 1.5 m from the
        // benches of main's north side (light 0.2 + bench 1.0 + 0.6 = 1.8 m)
        const two = buildRoadNetwork(network(
            [node('w', -90, 0), node('e', 90, 0), node('w2', -72, -14.55), node('e2', 90, -14.55)],
            [edge('a-main', 'w', 'e'), edge('b-north', 'w2', 'e2')],
            { profiles: { road: { ...PROFILE, sidewalk: { left: 3, right: 3 } } } }
        ));
        const pieces = placeFurniture(context(two));
        const northernBenches = where(pieces, 'bench').filter(b => b[1] === -7.45).map(b => b[0]);
        expect(northernBenches).toEqual([-50, 22]);
        // b-north's lights on its south side (z = -14.55 + 5.6 = -8.95)
        expect(where(pieces, 'lamp').filter(l => l[1] === -8.95).map(l => l[0])).toEqual([-14, 58]);
    });

    it('furnishes paved roads with a sidewalk of 1.5 m and more, and blocks of 12 m and more', () => {
        const road = (profile: Partial<typeof PROFILE>, length = 180) => buildRoadNetwork(network(
            [node('w', -length / 2, 0), node('e', length / 2, 0)], [edge('main', 'w', 'e')],
            { profiles: { road: { ...PROFILE, ...profile } } }
        ));
        // Dirt with sidewalks: nothing
        expect(placeFurniture(context(road({ surface: 'dirt', sidewalk: { left: 3, right: 3 } })))).toEqual([]);
        // 1.5 m on the left: the lights there (no hydrant: that is on the right)
        expect(where(placeFurniture(context(road({ sidewalk: { left: 1.5, right: 1.4 } }))), 'lamp')).toHaveLength(5);
        expect(placeFurniture(context(road({ sidewalk: { left: 1.4, right: 1.4 } })))).toEqual([]);
        // Benches stay 2 m inside their block: on a 116 m road (block 4 to
        // 112) the second bench (s = 112) is left out, the first stands at
        // s = 40, x = -58 + 40 = -18, on both sides
        expect(where(placeFurniture(context(road({ sidewalk: { left: 3, right: 3 } }, 116))), 'bench').map(b => b[0])).toEqual([-18, -18]);
        // A block of 19 - 8 = 11 m (a 19 m road, dead ends: 4 m off each):
        // nothing; 20 m (12 m): its hydrant at 16 - 3 = 13, x = 3
        expect(placeFurniture(context(road({ sidewalk: { left: 2, right: 2 } }, 19)))).toEqual([]);
        expect(where(placeFurniture(context(road({ sidewalk: { left: 2, right: 2 } }, 20))), 'hydrant')).toEqual([[3, 5.6, 0, -1]]);
    });

    it('turns a hydrant on a north-south street towards the road', () => {
        // Southwards along +z: left of the travel is +x, the right sidewalk
        // is west (x = -5.6); the hydrant faces east (+x)
        const ns = buildRoadNetwork(network([node('n', 0, -90), node('s', 0, 90)], [edge('main', 'n', 's')], {
            profiles: { road: { ...PROFILE, sidewalk: { left: 2, right: 2 } } }
        }));
        expect(where(placeFurniture(context(ns)), 'hydrant')).toEqual([[-5.6, 83, 1, 0]]);
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

describe('placeFurniture on a square', () => {
    it('rings the fountain with eight benches 11 m out facing it, a trash can beside every other one', () => {
        // A 60 m square area east of a road, its fountain at (30, 0)
        const net = buildRoadNetwork(network([node('w', -90, -60), node('e', -90, 60)], [edge('ns', 'w', 'e')], {
            areas: [{ id: 'square', surface: 'concrete', curb: false, polygon: [[0, -30], [60, -30], [60, 30], [0, 30]], connects: [] }]
        }));
        const pieces = placeFurniture({ ...context(net), fountains: [[30, 0]] });
        const benches = pieces.filter(p => p.kind === 'bench');
        expect(benches).toHaveLength(8);
        // The first at 22.5° from +z: (30 + 11 sin 22.5°, 11 cos 22.5°), facing back
        const s = Math.sin(Math.PI / 8), c = Math.cos(Math.PI / 8);
        expect(benches[0].x).toBeCloseTo(30 + 11 * s, 3);
        expect(benches[0].z).toBeCloseTo(11 * c, 3);
        expect([benches[0].ux, benches[0].uz]).toEqual([-Math.round(s * 1000) / 1000, -Math.round(c * 1000) / 1000]);
        for (const bench of benches) expect(Math.hypot(bench.x - 30, bench.z)).toBeCloseTo(11, 2);
        // Trash cans 2.1 m along the ring's tangent from benches 0, 2, 4, 6
        const cans = pieces.filter(p => p.kind === 'trashCan');
        expect(cans).toHaveLength(4);
        expect(cans[0].x).toBeCloseTo(30 + 11 * s + 2.1 * c, 3);
        expect(cans[0].z).toBeCloseTo(11 * c - 2.1 * s, 3);
        // Without the square round it: none
        expect(placeFurniture({ ...context(net), fountains: [[-30, 0]] }).filter(p => p.kind === 'bench')).toEqual([]);
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

    it('leaves out an approach without lanes towards the junction or without a sidewalk on its right', () => {
        // wc one-way against its direction (lanes [0, 1]): no pole on its
        // south side; ce without a sidewalk on its left (1 m on the right):
        // no pole for its westbound lanes; a 1 m sidewalk is enough
        const net = buildRoadNetwork(network(
            [node('w', -90, 0), node('e', 90, 0), node('n', 0, -90), junction],
            [edge('wc', 'w', 'c', [], { profile: 'against' }), edge('ce', 'c', 'e', [], { profile: 'bare' }), edge('nc', 'n', 'c', [], { profile: 'narrow' })],
            { profiles: {
                road: { ...PROFILE, sidewalk: { left: 2, right: 2 } },
                against: { ...PROFILE, lanes: [0, 1], sidewalk: { left: 2, right: 2 } },
                bare: { ...PROFILE, sidewalk: { left: 0, right: 2 } },
                narrow: { ...PROFILE, sidewalk: { left: 1.5, right: 1 } }
            } }
        ));
        expect(where(placeFurniture(context(net)), 'signal')).toEqual([[-5.6, -8, 0, 1]]);
    });

    it('stands no signal at a junction without settings, and none at an unsignalled one', () => {
        const plain = (junctionSettings?: object) => buildRoadNetwork(network(
            [node('w', -90, 0), node('e', 90, 0), node('c', 0, 0, 'junction', junctionSettings ? { junction: junctionSettings } : {})],
            [edge('wc', 'w', 'c'), edge('ce', 'c', 'e')],
            { profiles: { road: { ...PROFILE, sidewalk: { left: 2, right: 2 } } } }
        ));
        expect(where(placeFurniture(context(plain())), 'signal')).toEqual([]);
        expect(where(placeFurniture(context(plain({ shape: 'auto', control: 'stop', crosswalks: true }))), 'signal')).toEqual([]);
    });

    it('lists the signalled junctions by id, then the edges by id', () => {
        // Nodes and edges given out of order: b (x 60) before a (x -60),
        // edge zz before ab and bz
        const signal = { junction: { shape: 'auto' as const, control: 'signal' as const, crosswalks: true } };
        const net = buildRoadNetwork(network(
            [node('b', 60, 0, 'junction', signal), node('a', -60, 0, 'junction', signal), node('w', -90, 0), node('e', 90, 0), node('n1', -60, -90), node('n2', 60, -90)],
            [edge('zz', 'w', 'a'), edge('ab', 'a', 'b'), edge('bz', 'b', 'e'), edge('na', 'n1', 'a'), edge('nb', 'n2', 'b')],
            { profiles: { road: { ...PROFILE, sidewalk: { left: 2, right: 2 } } } }
        ));
        const pieces = placeFurniture(context(net));
        // The first signals stand at a (x < 0), the last at b
        const signals = pieces.filter(p => p.kind === 'signal');
        expect(signals[0].x).toBeLessThan(0);
        expect(signals.at(-1)!.x).toBeGreaterThan(0);
        // The hydrants in the order ab, bz, na, nb, zz, each 3 m before its
        // block's end on the right: a and b clear 7 + 4 = 11 m, dead ends
        // 4 m. ab (120 m): 109 - 3 = 106, x = 46; bz (30 m): 26 - 3 = 23,
        // x = 83; na, nb (90 m south): 79 - 3 = 76, z = -14, west of them;
        // zz (30 m): 19 - 3 = 16, x = -74
        const hydrants = where(pieces, 'hydrant').map(h => [h[0], h[1]]);
        expect(hydrants).toEqual([[46, 5.6], [83, 5.6], [-65.6, -14], [54.4, -14], [-74, 5.6]]);
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

    it('stands off the carriageways, in Downtown and the park, clear of buildings, each on its collider, benches round the fountain', () => {
        expect(map.furniture.length).toBeGreaterThan(200);
        const buildings = new BoxIndex();
        for (const lot of map.buildings) buildings.add(placementBox(lot));
        for (const piece of map.furniture) {
            const tag = `${piece.kind} at ${piece.x}, ${piece.z}`;
            // On the plaza (an area) off the roads and sidewalks round it,
            // elsewhere off every drivable surface
            if (map.net.areas.some(area => pointInPolygon(area.polygon, piece.x, piece.z))) expect(insideCorridor(map.net, piece.x, piece.z, 0), tag).toBe(false);
            else expect(isOnRoad(map.net, piece.x, piece.z), tag).toBe(false);
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
        // The plaza's ring: all eight benches round the fountain (-350, -70)
        expect(map.furniture.filter(p => p.kind === 'bench' && Math.abs(Math.hypot(p.x + 350, p.z + 70) - 11) < 0.01)).toHaveLength(8);
    });
});
