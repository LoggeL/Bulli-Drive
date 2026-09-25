// A bot race on a curated map before the sim integration (M3): the v2 sim
// and the race bots of phase 2 on the baked heightfield and the track's
// ramps. It answers what the validation can only estimate: whether the
// bots finish every track without a reset, how long they take (to
// calibrate drivability.ts) and whether each ramp really throws a car into
// the air.
//
// The sim world here is the minimum M3 has to build as well: ground =
// heightAt, ramps with their edge walls, the reset onto the racing line,
// no other colliders yet (rails are `segment` colliders the sim does not
// know before M3), no surfaces (grip per surface comes with M3).

import { heightAt, type Heightfield } from '../../src/shared/map/heightfield.js';
import type { MapTrackDef } from '../../src/shared/map/routeToTrack.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { raceInputFilter } from '../../src/shared/race/inputFilter.js';
import { LineDriver } from '../../src/shared/race/lineDriver.js';
import { advanceProgress, createCourse, createRaceProgress } from '../../src/shared/race/progress.js';
import { lineResetPose } from '../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../src/shared/race/racingLine.js';
import type { BotLevel, TrackDef } from '../../src/shared/race/types.js';
import { FLAT_TERRAIN } from '../../src/shared/sim/scenarios.js';
import type { CarClassId } from '../../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../src/shared/sim/world.js';
import {
    createSimWorld, rampEdgeColliders, rampRearBase, type RampDef, type SimWorld
} from '../../src/shared/world/colliders.js';

export const TICK_RATE = 60;
// Ticks before the start (countdown), as in the phase 2 bot tests
export const START_TICKS = 60;

// Height of a ramp's surface at (x, z), or -Infinity outside it (the sim's
// formula, colliders.ts: base + height · (along / length + 1/2))
function rampSurface(ramp: RampDef, base: number, x: number, z: number): number {
    const sin = Math.sin(ramp.yaw), cos = Math.cos(ramp.yaw);
    const dx = x - ramp.x, dz = z - ramp.z;
    const along = dx * sin + dz * cos, across = dx * cos - dz * sin;
    if (Math.abs(across) > ramp.width / 2 || Math.abs(along) > ramp.length / 2) return -Infinity;
    return base + ramp.height * (along / ramp.length + 0.5);
}

/** A sim world on the heightfield with the track's ramps and the reset onto its racing line. */
export function createMapRaceWorld(hf: Heightfield, track: MapTrackDef): SimWorld {
    const ground = (x: number, z: number) => heightAt(hf, x, z);
    const ramps = track.ramps;
    const bases = ramps.map(ramp => rampRearBase(ramp, ground));
    const world = createSimWorld(FLAT_TERRAIN, ramps.flatMap((ramp, i) => rampEdgeColliders(ramp, i, true, ground)), ramps, null);
    world.terrainHeight = ground;
    world.groundHeight = (x, z) => {
        let h = ground(x, z);
        for (let i = 0; i < ramps.length; i++) h = Math.max(h, rampSurface(ramps[i], bases[i], x, z));
        return h;
    };
    world.rampAt = (x, z) => {
        let h = ground(x, z), found = -1;
        for (let i = 0; i < ramps.length; i++) {
            const r = rampSurface(ramps[i], bases[i], x, z);
            if (r > h) { h = r; found = i; }
        }
        return found;
    };
    world.rampBases = bases;
    // The colliders stand on the ground at their centre
    for (const collider of world.colliders) collider.base = world.groundHeight(collider.x, collider.z);
    world.bound = hf.spec.originX + (hf.spec.cols - 1) * hf.spec.cellSize;
    world.resetPose = lineResetPose(buildRacingLine(track as unknown as TrackDef));
    world.slipstream = true;
    return world;
}

export interface Flight { x: number; z: number; ticks: number; ramp: number }

export interface DriveResult {
    // Race time from the green light (s), null if the bot did not finish
    time: number | null;
    resets: number;
    // Every stretch in the air of at least 3 ticks, with the ramp it began
    // on (-1: terrain)
    flights: Flight[];
    maxLineDistance: number;
    topSpeed: number;
}

/**
 * One bot alone from grid slot 0 until the finish (or `maxSeconds`), as the
 * phase 2 bot tests race it. Deterministic for a seed.
 */
export function driveTrack(hf: Heightfield, track: MapTrackDef, car: CarClassId, level: BotLevel = 'medium', seed = 1, maxSeconds = 400): DriveResult {
    const def = track as unknown as TrackDef;
    const world = createMapRaceWorld(hf, track);
    const course = createCourse(def, buildRacingLine(def));
    const sim = createSimCar('bot', car);
    const slot = track.grid[0];
    spawnVehicle(sim.state, world, slot.x, slot.z, slot.yaw);
    const driver = new LineDriver(course, sim.params, level, mulberry32(seed));
    driver.startRace(START_TICKS);
    const progress = createRaceProgress();
    const flights: Flight[] = [];
    let resets = 0, topSpeed = 0, air = 0, takeoff: Flight | null = null;
    for (let t = 1; t < START_TICKS + TICK_RATE * maxSeconds && progress.status === 'racing'; t++) {
        driver.drive(sim.state, sim.params, t, START_TICKS, [], sim.input);
        raceInputFilter(t < START_TICKS ? 'countdown' : 'racing', t, START_TICKS, sim.input);
        const x0 = sim.state.x, z0 = sim.state.z;
        const onRamp = world.rampAt(x0, z0);
        stepWorld([sim], world);
        if (sim.events.reset) resets++;
        topSpeed = Math.max(topSpeed, Math.sqrt(sim.state.vx * sim.state.vx + sim.state.vz * sim.state.vz));
        if (!sim.state.grounded) {
            if (air === 0) takeoff = { x: x0, z: z0, ticks: 0, ramp: onRamp };
            air++;
        } else if (air > 0) {
            if (air >= 3 && takeoff) flights.push({ ...takeoff, ticks: air });
            air = 0;
        }
        if (t >= START_TICKS) {
            advanceProgress(progress, course, t, START_TICKS, x0, z0, sim.state.x, sim.state.z, sim.state.vx, sim.state.vz, sim.events.reset);
        }
    }
    return {
        time: progress.finishTicks === null ? null : progress.finishTicks / TICK_RATE,
        resets, flights, maxLineDistance: driver.maxLineDistance, topSpeed
    };
}
