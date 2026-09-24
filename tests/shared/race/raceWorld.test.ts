import { describe, expect, it } from 'vitest';
import { createRaceWorld, lineResetPose, trackColliders, trackHash } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { DOWNTOWN_LOOP, HILL_SPRINT } from '../../../src/shared/race/tracks/index.js';
import type { TrackDef } from '../../../src/shared/race/types.js';
import { BTN_RESET } from '../../../src/shared/sim/constants.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { createMapData } from '../../../src/shared/world/mapData.js';

// The race world (docs/phase-2-design.md, 5.6 and 10.3)

const map = createMapData();

describe('trackColliders', () => {
    const track = (hints: TrackDef['hints']): TrackDef => ({ ...DOWNTOWN_LOOP, hints });

    it('turns a barrier row into a box across its yaw, 0.6 m deep and 1 m high', () => {
        const [alongX, alongZ] = trackColliders(track([
            { kind: 'barrier', x: 5, z: 7, yaw: 0, length: 12 },
            { kind: 'barrier', x: -5, z: 3, yaw: -Math.PI / 2, length: 10 }
        ]));
        // Facing +z the row runs along x (the left axis)
        expect(alongX).toEqual({ kind: 'box', x: 5, z: 7, hw: 6, hd: 0.3, top: 1 });
        expect(alongZ).toEqual({ kind: 'box', x: -5, z: 3, hw: 0.3, hd: 5, top: 1 });
        expect(() => trackColliders(track([{ kind: 'barrier', x: 0, z: 0, yaw: 0.3, length: 12 }]))).toThrow();
    });

    it('gives a chevron board two posts 1.2 m either side, and the looks-only hints nothing', () => {
        const posts = trackColliders(track([
            { kind: 'chevron', x: 10, z: 20, yaw: Math.PI / 2, dir: 'left' },
            { kind: 'arrow', x: 0, z: 0, yaw: 0 },
            { kind: 'delineators', line: [{ x: 0, z: 0 }, { x: 0, z: 100 }], offset: 5.5, spacing: 15 }
        ]));
        expect(posts).toHaveLength(2);
        // Facing +x the board runs along z (left of yaw π/2 is -z)
        expect(posts.map(p => [p.x, p.z])).toEqual([[10, 21.2], [10, 18.8]].map(([x, z]) => [expect.closeTo(x, 12), expect.closeTo(z, 12)]));
        expect(posts.every(p => p.kind === 'circle' && p.r === 0.35)).toBe(true);
        // Facing +z the board runs along x, the left post first
        const north = trackColliders(track([{ kind: 'chevron', x: 10, z: 20, yaw: 0, dir: 'right' }]));
        expect(north.map(p => [p.x, p.z])).toEqual([[8.8, 20], [11.2, 20]]);
    });
});

describe('createRaceWorld', () => {
    it('is the map plus the ramp edges plus the track, with the slipstream on and no road grid', () => {
        for (const track of [DOWNTOWN_LOOP, HILL_SPRINT]) {
            const world = createRaceWorld(map, track);
            const own = trackColliders(track);
            expect(world.slipstream).toBe(true);
            expect(world.roads).toBeNull();
            expect(world.ramps).toHaveLength(3);
            // Contract order: the map's colliders first, the track's last
            expect(world.colliders.slice(0, map.colliders.length).map(c => [c.x, c.z]))
                .toEqual(map.colliders.map(c => [c.x, c.z]));
            expect(world.colliders.slice(-own.length).map(c => [c.x, c.z])).toEqual(own.map(c => [c.x, c.z]));
            const edges = world.colliders.slice(map.colliders.length, world.colliders.length - own.length);
            expect(edges.length).toBeGreaterThan(0);
            expect(edges.every(c => c.ramp !== undefined && c.ramp >= 0 && c.ramp < 3)).toBe(true);
        }
        // The map's own world stays as it was
        expect(map.simWorld.slipstream).toBeUndefined();
        expect(map.simWorld.resetPose).toBeUndefined();
    });

    it('resets a car onto the racing line, facing along it, instead of onto the road grid', () => {
        const world = createRaceWorld(map, DOWNTOWN_LOOP);
        // On the western leg (x = -98, driven towards -z), 6 m off the line, facing the wrong way
        const car = spawnCar(world, 'a', 'bulli', -92, 30, 0);
        car.state.draft = 0.6;
        for (let tick = 0; tick < 30; tick++) {
            car.input.buttons = BTN_RESET;
            stepVehicle(car, world);
        }
        expect(car.events.reset).toBe(true);
        expect(car.state.x).toBeCloseTo(-98, 9);
        expect(car.state.z).toBeCloseTo(30, 9);
        expect(car.state.yaw).toBeCloseTo(Math.PI, 12);
        expect(car.state.draft).toBe(0);
    });

    it('uses the reset pose ahead of the road grid in any world that has one', () => {
        const world = createFlatWorld();
        world.roads = { xLines: [0], zLines: [], minX: -100, maxX: 100, minZ: -100, maxZ: 100, snapRange: 40 };
        world.resetPose = lineResetPose(buildRacingLine(HILL_SPRINT));
        const car = spawnCar(world, 'a', 'beetle', 20, 0, 0);
        // No slipstream step in this world: only the reset clears the draft
        car.state.draft = 0.6;
        for (let tick = 0; tick < 29; tick++) {
            car.input.buttons = BTN_RESET;
            stepVehicle(car, world);
        }
        expect(car.state.draft).toBe(0.6);
        for (let tick = 0; tick < 1; tick++) {
            car.input.buttons = BTN_RESET;
            stepVehicle(car, world);
        }
        // Nearest line point: the Hill Sprint's straight x = 58, heading -z
        expect(car.state.x).toBeCloseTo(58, 9);
        expect(car.state.z).toBeCloseTo(0, 9);
        expect(car.state.yaw).toBeCloseTo(Math.PI, 12);
        expect(car.state.draft).toBe(0);
    });
});

describe('trackHash', () => {
    it('is 8 hex digits, the same for equal data and different after any change', () => {
        const hash = trackHash(DOWNTOWN_LOOP);
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        expect(trackHash(JSON.parse(JSON.stringify(DOWNTOWN_LOOP)))).toBe(hash);
        const moved = { ...DOWNTOWN_LOOP, gates: DOWNTOWN_LOOP.gates.map((g, k) => (k === 3 ? { ...g, width: 17 } : g)) };
        expect(trackHash(moved)).not.toBe(hash);
        expect(trackHash(HILL_SPRINT)).not.toBe(hash);
    });
});
