import { describe, expect, it } from 'vitest';
import type { BuildingData, CityData, RoadData } from '../../src/shared/protocol.js';
import { clearsStaticObstacles, randomSpawn, randomSpawnPose, spawnYaw } from '../../src/server/rooms/spawn.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';

// Where cars spawn (src/server/rooms/spawn.ts), with a scripted random
// source so every draw is known. The expected points are worked out by hand
// from the rules: road points keep 2 m from the road edge and 4 m from its
// ends, the plaza (centre (-20, -20), 40 m block) keeps 4 m from its edge,
// buildings get 4 m of margin, the fountain 9 m, the plaza planters and
// parasols 2 m on their radius, other players 12 m.

// Returns the values in order, then fails the test if more are drawn
function scripted(...values: number[]): () => number {
    let i = 0;
    return () => {
        if (i >= values.length) throw new Error(`random drawn ${i + 1} times, scripted ${values.length}`);
        return values[i++];
    };
}

function road(x: number, z: number, rotation: number, width = 12, length = 100): RoadData {
    return { x, z, width, length, rotation };
}

function building(x: number, z: number, width: number, depth: number): BuildingData {
    return { x, z, width, depth, height: 10, color: 0 };
}

const city = (roads: RoadData[], buildings: BuildingData[] = []): CityData => ({ roads, buildings });

// A road far from the plaza, running along z (rotation 0)
const NORTH_SOUTH = road(100, 200, 0);
// Same road turned by 90°: it runs along x
const EAST_WEST = road(100, 200, Math.PI / 2);

// Draw order: plaza chance, then road index, across, along (road) or x, z (plaza)
const ROAD = 0.5;
const PLAZA = 0.1;

describe('randomSpawn: where on a road', () => {
    it('keeps 2 m from the edges and 4 m from the ends of a road along z', () => {
        const c = city([NORTH_SOUTH]);
        // Across -1 -> 6 - 2 = 4 m left, along -1 -> 50 - 4 = 46 m back
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 0, 0))).toEqual({ x: 96, z: 154 });
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 1, 1))).toEqual({ x: 104, z: 246 });
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 0.5, 0.75))).toEqual({ x: 100, z: 223 });
    });

    it('turns the across and along axes with the road', () => {
        const p = randomSpawn(city([EAST_WEST]), [], [], scripted(ROAD, 0, 0, 1));
        // Across now points along +z, along along +x
        expect(p.x).toBeCloseTo(146, 9);
        expect(p.z).toBeCloseTo(196, 9);
    });

    it('picks the road by the second draw', () => {
        const c = city([road(100, 200, 0), road(300, 200, 0), road(500, 200, 0)]);
        expect(randomSpawn(c, [], [], scripted(ROAD, 0.99, 0.5, 0.5))).toEqual({ x: 500, z: 200 });
        expect(randomSpawn(c, [], [], scripted(ROAD, 0.34, 0.5, 0.5))).toEqual({ x: 300, z: 200 });
    });

    it('never places a car off a road narrower than its margins', () => {
        // Width 3 and length 6: both margins eat the whole road, the car
        // spawns on its centre line and centre
        const c = city([road(100, 200, 0, 3, 6)]);
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 0, 1))).toEqual({ x: 100, z: 200 });
    });
});

describe('randomSpawn: on the plaza', () => {
    it('draws a point inside the plaza, 4 m from the block edge, with a chance of 20 %', () => {
        const c = city([NORTH_SOUTH]);
        // Half size 40 / 2 - 4 = 16 around (-20, -20)
        expect(randomSpawn(c, [], [], scripted(PLAZA, 0, 1))).toEqual({ x: -36, z: -4 });
        expect(randomSpawn(c, [], [], scripted(0.19, 1, 0))).toEqual({ x: -4, z: -36 });
        // 0.2 is no longer the plaza
        expect(randomSpawn(c, [], [], scripted(0.2, 0, 0.5, 0.5))).toEqual({ x: 100, z: 200 });
    });

    it('uses the plaza only when the city has no roads', () => {
        // A road draw gives nothing; the next attempt is the plaza
        expect(randomSpawn(city([]), [], [], scripted(ROAD, PLAZA, 0, 0))).toEqual({ x: -36, z: -36 });
    });
});

describe('clearsStaticObstacles', () => {
    it('keeps 4 m from every side of a building', () => {
        // 10 x 6 m at (100, 200): clear from 9 m in x, 7 m in z
        const c = city([], [building(100, 200, 10, 6)]);
        expect(clearsStaticObstacles(c, { x: 108.9, z: 200 })).toBe(false);
        expect(clearsStaticObstacles(c, { x: 109.1, z: 200 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: 90.9, z: 200 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: 91.1, z: 200 })).toBe(false);
        expect(clearsStaticObstacles(c, { x: 100, z: 206.9 })).toBe(false);
        expect(clearsStaticObstacles(c, { x: 100, z: 207.1 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: 100, z: 192.9 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: 100, z: 193.1 })).toBe(false);
        // From exactly 9 m on it is clear
        expect(clearsStaticObstacles(c, { x: 109, z: 200 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: 100, z: 207 })).toBe(true);
        // Inside in x but not in z (and the other way round) is clear
        expect(clearsStaticObstacles(c, { x: 105, z: 210 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: 112, z: 202 })).toBe(true);
    });

    it('keeps 9 m from the fountain in the middle of the plaza', () => {
        const c = city([]);
        expect(clearsStaticObstacles(c, { x: -20, z: -20 })).toBe(false);
        expect(clearsStaticObstacles(c, { x: -20 + 8.9, z: -20 })).toBe(false);
        expect(clearsStaticObstacles(c, { x: -20 + 9.1, z: -20 })).toBe(true);
        expect(clearsStaticObstacles(c, { x: -20, z: -20 - 8.9 })).toBe(false);
        expect(clearsStaticObstacles(c, { x: -20, z: -20 - 9.1 })).toBe(true);
    });

    it('keeps 2 m from the four planters (r 1.6 at ±13 m) and parasols (r 0.9 at ±7.54 m)', () => {
        const c = city([]);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                // Planter: clear from 3.6 m, tested outwards in x
                const px = -20 + sx * 13, pz = -20 + sz * 13;
                expect(clearsStaticObstacles(c, { x: px + sx * 3.5, z: pz }), `planter ${sx} ${sz}`).toBe(false);
                expect(clearsStaticObstacles(c, { x: px + sx * 3.7, z: pz }), `planter ${sx} ${sz}`).toBe(true);
                // Parasol: clear from 2.9 m, tested outwards in z
                const qx = -20 + sx * 13 * 0.58, qz = -20 + sz * 13 * 0.58;
                expect(clearsStaticObstacles(c, { x: qx, z: qz + sz * 2.8 }), `parasol ${sx} ${sz}`).toBe(false);
                expect(clearsStaticObstacles(c, { x: qx, z: qz + sz * 3.0 }), `parasol ${sx} ${sz}`).toBe(true);
            }
        }
    });
});

describe('randomSpawn: rejected points', () => {
    const c = city([NORTH_SOUTH], [building(100, 250, 10, 10)]);
    // Road points: (100, 246) and (100, 241.4) lie within the building's
    // 4 m margin (z > 241), (100, 200) and (100, 177) are clear
    const centre = [ROAD, 0, 0.5, 0.5];
    const nearEnd = [ROAD, 0, 0.5, 0.25];

    it('draws again after a point inside a building', () => {
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 0.5, 1, ...centre))).toEqual({ x: 100, z: 200 });
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 0.5, 0.95, ...centre))).toEqual({ x: 100, z: 200 });
        // (100, 236.8) is 13.2 m from the building's centre: clear
        expect(randomSpawn(c, [], [], scripted(ROAD, 0, 0.5, 0.9))).toEqual({ x: 100, z: 236.8 });
    });

    it('keeps 12 m from the other cars of the room', () => {
        expect(randomSpawn(c, [{ x: 100, z: 211.9 }], [], scripted(...centre, ...nearEnd))).toEqual({ x: 100, z: 177 });
        expect(randomSpawn(c, [{ x: 100, z: 212.1 }], [], scripted(...centre))).toEqual({ x: 100, z: 200 });
        expect(randomSpawn(c, [{ x: 100, z: 212 }], [], scripted(...centre))).toEqual({ x: 100, z: 200 });
        expect(randomSpawn(c, [{ x: 111.9, z: 200 }], [], scripted(...centre, ...nearEnd))).toEqual({ x: 100, z: 177 });
        // Every other car counts, not only the first
        expect(randomSpawn(c, [{ x: 0, z: 0 }, { x: 100, z: 205 }], [], scripted(...centre, ...nearEnd))).toEqual({ x: 100, z: 177 });
    });

    it('stays out of the pickup circles', () => {
        expect(randomSpawn(c, [], [{ x: 103, z: 200, radius: 3.1 }], scripted(...centre, ...nearEnd))).toEqual({ x: 100, z: 177 });
        expect(randomSpawn(c, [], [{ x: 103, z: 200, radius: 2.9 }], scripted(...centre))).toEqual({ x: 100, z: 200 });
        expect(randomSpawn(c, [], [{ x: 0, z: 0, radius: 1 }, { x: 100, z: 202, radius: 3 }], scripted(...centre, ...nearEnd)))
            .toEqual({ x: 100, z: 177 });
    });
});

describe('randomSpawn: fallback after 80 rejected draws', () => {
    // The generated city: roads along z at x = -98, -46, 6, 58, 110 and
    // along x at z = the same values, so 25 crossings, plus four plaza
    // corners at (-20 ± 11.2, -20 ± 11.2)
    const generated = generateWorld().city!;
    // Every draw lands on the crossing (6, 6): road 5 of 10, centre
    const always = (): number => 0.5;

    it('takes the crossing or plaza corner farthest from the other cars', () => {
        let draws = 0;
        const counting = (): number => { draws++; return 0.5; };
        // A car on (6, 6) blocks every draw. The farthest candidates are the
        // corners (-98, -98) and (110, 110), both 104·√2 away: the first wins
        expect(randomSpawn(generated, [{ x: 6, z: 6 }], [], counting)).toEqual({ x: -98, z: -98 });
        // 80 attempts of 4 draws each, then no more randomness
        expect(draws).toBe(80 * 4);
        // A car near (-98, -98): (-98, 110), (110, -98) and (110, 110) are
        // now 104·√2 from the nearest car; the first of them wins
        expect(randomSpawn(generated, [{ x: 6, z: 6 }, { x: -90, z: -90 }], [], always)).toEqual({ x: -98, z: 110 });
        // Cars near three corners leave (110, 110)
        const three = [{ x: 6, z: 6 }, { x: -90, z: -90 }, { x: -90, z: 100 }, { x: 100, z: -90 }];
        expect(randomSpawn(generated, three, [], always)).toEqual({ x: 110, z: 110 });
    });

    it('skips candidates on a pickup, unless every candidate is on one', () => {
        const blocker = [{ x: 6, z: 6 }];
        // (-98, -98) lies on a coin: the next candidate as far away, (-98, 110)
        expect(randomSpawn(generated, blocker, [{ x: -98, z: -98, radius: 5 }], always)).toEqual({ x: -98, z: 110 });
        // One pickup circle over the whole map: pickups are ignored
        expect(randomSpawn(generated, blocker, [{ x: 0, z: 0, radius: 1000 }], always)).toEqual({ x: -98, z: -98 });
    });

    it('never picks a candidate inside a building', () => {
        // A building over the crossing (-98, -98) and the draw point
        const c = { ...generated, buildings: [...generated.buildings, building(-98, -98, 4, 4), building(6, 6, 4, 4)] };
        expect(randomSpawn(c, [], [], always)).toEqual({ x: -98, z: -46 });
    });

    it('crosses only roads along z with roads along x', () => {
        // One road along z at x = 100, one along x at z = 300 (centred on
        // x = 500): their crossing is (100, 300), not (500, 300). A pickup
        // circle over the whole map rejects every draw; a car sits on the
        // crossing, so any other candidate would be preferred
        const c = city([road(100, 200, 0), road(500, 300, Math.PI / 2)]);
        expect(randomSpawn(c, [{ x: 100, z: 300 }], [{ x: 0, z: 0, radius: 1000 }], always)).toEqual({ x: 100, z: 300 });
    });

    // Known issue (regression lock, reported): the four plaza corner
    // candidates at ±11.2 m lie 2.5 m from the planters at ±13 m, inside
    // their 3.6 m clearance, so they never pass clearsStaticObstacles; and
    // the defensive last resort (-8.8, -8.8) is one of them.
    it('never takes a plaza corner as a candidate', () => {
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                expect(clearsStaticObstacles(city([]), { x: -20 + sx * 11.2, z: -20 + sz * 11.2 })).toBe(false);
            }
        }
    });

    it('returns the fixed last resort when no candidate is clear', () => {
        // No roads, and a building over the whole plaza
        const c = city([], [building(-20, -20, 60, 60)]);
        expect(randomSpawn(c, [], [], always)).toEqual({ x: -20 + 16 * 0.7, z: -20 + 16 * 0.7 });
    });
});

describe('spawnYaw', () => {
    const generated = generateWorld().city!;

    it('faces along the road under the point, either way', () => {
        // (6, 30) lies only on the road along z at x = 6 (rotation 0)
        expect(spawnYaw(generated, { x: 6, z: 30 }, scripted(0.4))).toBe(0);
        expect(spawnYaw(generated, { x: 6, z: 30 }, scripted(0.5))).toBe(Math.PI);
        // (30, 6) only on the road along x at z = 6 (rotation π/2)
        expect(spawnYaw(generated, { x: 30, z: 6 }, scripted(0.4))).toBe(Math.PI / 2);
        expect(spawnYaw(generated, { x: 30, z: 6 }, scripted(0.9))).toBe(Math.PI * 1.5);
    });

    it('counts the road edge as on the road and a road end as off it', () => {
        // 6 m from the centre line of the 12 m road: on it
        expect(spawnYaw(generated, { x: 12, z: 30 }, scripted(0.4, 0.3))).toBe(0);
        // 2 m off the centre of the road along x
        expect(spawnYaw(generated, { x: 30, z: 8 }, scripted(0.4, 0.3))).toBe(Math.PI / 2);
        // Exactly at the end of a lone road (along z, 50 m from its centre)
        expect(spawnYaw(city([NORTH_SOUTH]), { x: 100, z: 250 }, scripted(0.4, 0.3))).toBe(0);
        expect(spawnYaw(city([NORTH_SOUTH]), { x: 100, z: 250.01 }, scripted(0.4, 0.3))).toBe(Math.PI / 2);
        // Beyond the far end of the 220 m road (z = 6 + 110): no road
        expect(spawnYaw(generated, { x: 6, z: 117 }, scripted(0.4, 0.3))).toBe(Math.PI / 2);
    });

    it('picks one of the four axes on a crossing and off the roads', () => {
        // The crossing (6, 6) is on two roads
        expect(spawnYaw(generated, { x: 6, z: 6 }, scripted(0.4, 0))).toBe(0);
        expect(spawnYaw(generated, { x: 6, z: 6 }, scripted(0.4, 0.3))).toBe(Math.PI / 2);
        expect(spawnYaw(generated, { x: 6, z: 6 }, scripted(0.4, 0.6))).toBe(Math.PI);
        expect(spawnYaw(generated, { x: 6, z: 6 }, scripted(0.4, 0.99))).toBe(Math.PI * 1.5);
        // The plaza, off every road
        expect(spawnYaw(generated, { x: -20, z: -5 }, scripted(0.4, 0.3))).toBe(Math.PI / 2);
    });
});

describe('randomSpawnPose', () => {
    it('spawns on a road facing along it', () => {
        const c = city([NORTH_SOUTH]);
        expect(randomSpawnPose(c, [], [], scripted(...[ROAD, 0, 0.5, 0.5], 0.7))).toEqual({ x: 100, z: 200, yaw: Math.PI });
    });

    it('spawns on free road in the generated city with the real random source', () => {
        const generated = generateWorld().city!;
        for (let i = 0; i < 200; i++) {
            const pose = randomSpawnPose(generated, [{ x: 6, z: 6 }]);
            expect(clearsStaticObstacles(generated, pose)).toBe(true);
            expect(Math.hypot(pose.x - 6, pose.z - 6)).toBeGreaterThanOrEqual(12);
            expect(Math.abs(pose.yaw / (Math.PI / 2) - Math.round(pose.yaw / (Math.PI / 2)))).toBeLessThan(1e-9);
        }
    });
});
