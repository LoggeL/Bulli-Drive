import { describe, expect, it } from 'vitest';
import { mapFor } from '../../../src/server/maps.js';
import { heightAt } from '../../../src/shared/map/heightfield.js';
import { createRaceWorld, lineResetPose, trackColliders, trackHash } from '../../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../../src/shared/race/racingLine.js';
import { trackDef } from '../../../src/shared/race/tracks/index.js';
import type { TrackDef } from '../../../src/shared/race/types.js';
import { overlapsColliders } from '../../../src/shared/sim/collision.js';
import { BTN_RESET } from '../../../src/shared/sim/constants.js';
import { createFlatWorld, spawnCar } from '../../../src/shared/sim/scenarios.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';

// The race world (docs/phase-2-design.md, 5.6 and 10.3; docs/phase-3-design.md,
// 13.2 and A30): the map plus the track, on the map's ground

const map = mapFor();

// A straight sprint from (0, -50) to (0, 2000) with the given hints and ramps
function track(hints: TrackDef['hints'], ramps: TrackDef['ramps'] = []): TrackDef {
    return {
        id: 'hill-sprint', name: 'Test', kind: 'sprint', laps: 1, mapVersion: 1, trackVersion: 1,
        centerline: [{ x: 0, z: -50 }, { x: 0, z: 2000 }], lineOptions: { radius: 0, apexShift: 0 },
        gates: [], grid: [], hints, minimap: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, ramps
    };
}

describe('trackColliders', () => {
    it('turns a barrier row into a box across its yaw, 0.6 m deep and 1 m high', () => {
        const [alongX, alongZ] = trackColliders(track([
            { kind: 'barrier', x: 5, z: 7, yaw: 0, length: 12 },
            { kind: 'barrier', x: -5, z: 3, yaw: -Math.PI / 2, length: 10 }
        ]));
        // Facing +z the row runs along x (the left axis)
        expect(alongX).toEqual({ kind: 'box', x: 5, z: 7, hw: 6, hd: 0.3, top: 1 });
        expect(alongZ).toEqual({ kind: 'box', x: -5, z: 3, hw: 0.3, hd: 5, top: 1 });
    });

    it('turns an oblique barrier row into a turned box: across the yaw, 0.6 m deep', () => {
        const [row] = trackColliders(track([{ kind: 'barrier', x: 10, z: 20, yaw: 0.3, length: 12 }]));
        expect(row).toMatchObject({ kind: 'obox', x: 10, z: 20, hw: 6, hd: 0.3, top: 1 });
        if (row.kind !== 'obox') throw new Error('not an obox');
        // Its depth axis is the yaw's forward (sin 0.3, cos 0.3), within the rounding to 1e-6
        expect(row.ux).toBeCloseTo(Math.sin(0.3), 6);
        expect(row.uz).toBeCloseTo(Math.cos(0.3), 6);
        // A car driving along the yaw is stopped by it, one beside its end is not
        const world = createFlatWorld(trackColliders(track([{ kind: 'barrier', x: 10, z: 20, yaw: 0.3, length: 12 }])));
        const hit = spawnCar(world, 'a', 'bulli', 10, 20, 0.3);
        expect(overlapsColliders(hit.state, hit.params, world)).toBe(true);
        // 9 m along the row's left axis (cos 0.3, -sin 0.3): past its 6 m half length plus the car's 1.3 m
        const beside = spawnCar(world, 'b', 'bulli', 10 + 9 * Math.cos(0.3), 20 - 9 * Math.sin(0.3), 0.3);
        expect(overlapsColliders(beside.state, beside.params, world)).toBe(false);
    });

    it('gives a chevron board two posts 1.2 m either side, and the looks-only hints nothing', () => {
        const posts = trackColliders(track([
            { kind: 'chevron', x: 10, z: 20, yaw: Math.PI / 2, dir: 'left' },
            { kind: 'arrow', x: 0, z: 0, yaw: 0 },
            { kind: 'delineators', line: [{ x: 0, z: 0 }, { x: 0, z: 100 }], offset: 5.5, spacing: 15 }
        ]));
        expect(posts).toHaveLength(2);
        // Facing +x the board runs along z (left of yaw π/2 is -z)
        expect(posts.map(p => p.kind === 'circle' ? [p.x, p.z] : [])).toEqual([[10, 21.2], [10, 18.8]].map(([x, z]) => [expect.closeTo(x, 12), expect.closeTo(z, 12)]));
        expect(posts.every(p => p.kind === 'circle' && p.r === 0.35)).toBe(true);
    });
});

describe('createRaceWorld', () => {
    it('is the map plus the edges of the track\'s ramps plus its hints, on the map\'s ground, with the slipstream on', () => {
        for (const id of ['downtown-loop', 'hill-sprint'] as const) {
            const def = trackDef(map, id);
            const world = createRaceWorld(map, def);
            const own = trackColliders(def);
            expect(world.slipstream).toBe(true);
            expect(world.resetPose).toBeDefined();
            expect(world.ramps).toHaveLength(map.ramps.length + def.ramps.length);
            // Contract order: the map's colliders first, the track's last
            expect(world.colliders.slice(0, map.colliders.length)).toEqual(map.simWorld.colliders);
            expect(own.length).toBeGreaterThan(0);
            const where = (c: { kind: string; x?: number; z?: number }) => [c.kind, c.x, c.z];
            expect(world.colliders.slice(-own.length).map(where)).toEqual(own.map(where));
            // Between them only the edge walls of the track's own ramps
            const between = world.colliders.slice(map.colliders.length, world.colliders.length - own.length);
            expect(between.length > 0).toBe(def.ramps.length > 0);
            expect(between.every(c => c.ramp !== undefined && c.ramp >= map.ramps.length)).toBe(true);
            // The same ground, surfaces and water as the map
            expect(world.terrainHeight(-400, -20)).toBe(heightAt(map.hf, -400, -20));
            expect(world.waterLevel).toBe(map.simWorld.waterLevel);
            expect(world.surfaceAt(-700, 0)).toBe(map.simWorld.surfaceAt(-700, 0));
        }
        // The map's own world stays as it was: no slipstream, its road reset
        expect(map.simWorld.slipstream).toBeUndefined();
    });

    it('puts the track\'s ramps after the map\'s, so their edge walls point at them', () => {
        const def = trackDef(map, 'hill-sprint');
        expect(def.ramps.length).toBeGreaterThan(0);
        const world = createRaceWorld(map, def);
        def.ramps.forEach((ramp, i) => {
            expect(world.ramps[map.ramps.length + i]).toMatchObject({ x: ramp.x, z: ramp.z, yaw: ramp.yaw });
            expect(world.rampAt(ramp.x, ramp.z)).toBe(map.ramps.length + i);
        });
    });

    it('resets a car onto the racing line, facing along it, instead of onto the road', () => {
        const def = trackDef(map, 'downtown-loop');
        const world = createRaceWorld(map, def);
        const line = buildRacingLine(def);
        // 4 m beside the line's 40th point, facing the wrong way
        const p = line.points[40];
        const lx = p.tz, lz = -p.tx;
        const car = spawnCar(world, 'a', 'bulli', p.x + lx * 4, p.z + lz * 4, Math.atan2(-p.tx, -p.tz));
        car.state.draft = 0.6;
        for (let tick = 0; tick < 30; tick++) {
            car.input.buttons = BTN_RESET;
            stepVehicle(car, world);
        }
        expect(car.events.reset).toBe(true);
        expect(Math.hypot(car.state.x - p.x, car.state.z - p.z)).toBeLessThan(0.5);
        expect(Math.cos(car.state.yaw - Math.atan2(p.tx, p.tz))).toBeGreaterThan(Math.cos(5 * Math.PI / 180));
        expect(car.state.draft).toBe(0);
    });

    it('uses the reset pose in any world that has one', () => {
        const world = createFlatWorld();
        world.resetPose = lineResetPose(buildRacingLine({ ...track([]), centerline: [{ x: 58, z: 100 }, { x: 58, z: -100 }] }));
        const car = spawnCar(world, 'a', 'beetle', 20, 0, 0);
        // No slipstream step in this world: only the reset clears the draft
        car.state.draft = 0.6;
        for (let tick = 0; tick < 29; tick++) {
            car.input.buttons = BTN_RESET;
            stepVehicle(car, world);
        }
        expect(car.state.draft).toBe(0.6);
        car.input.buttons = BTN_RESET;
        stepVehicle(car, world);
        // Nearest line point: on the line x = 58, heading -z
        expect(car.state.x).toBeCloseTo(58, 9);
        expect(car.state.z).toBeCloseTo(0, 9);
        expect(car.state.yaw).toBeCloseTo(Math.PI, 12);
        expect(car.state.draft).toBe(0);
    });
});

describe('trackHash', () => {
    it('is 8 hex digits, the same for equal data and different after any change', () => {
        const loop = trackDef(map, 'downtown-loop');
        const hash = trackHash(loop);
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        expect(trackHash(JSON.parse(JSON.stringify(loop)))).toBe(hash);
        const moved = { ...loop, gates: loop.gates.map((g, k) => (k === 3 ? { ...g, width: g.width + 1 } : g)) };
        expect(trackHash(moved)).not.toBe(hash);
        const ramped = { ...loop, ramps: [{ x: 0, z: 0, yaw: 0, width: 6, length: 10, height: 1 }] };
        expect(trackHash(ramped)).not.toBe(hash);
        expect(trackHash(trackDef(map, 'hill-sprint'))).not.toBe(hash);
    });
});
