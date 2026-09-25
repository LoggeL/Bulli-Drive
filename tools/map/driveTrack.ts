// A bot race on a curated map: the v2 sim and the race bots of phase 2 in
// the track's race world on the map (createRaceWorld: the baked ground with
// its surfaces, every collider of the map, the track's ramps and hints, the
// reset onto the racing line). It answers what the validation can only
// estimate: whether the bots finish every track without a reset, how long
// they take (to calibrate drivability.ts) and whether each ramp really
// throws a car into the air.

import type { MapData } from '../../src/shared/map/mapData.js';
import type { MapTrackDef } from '../../src/shared/map/routeToTrack.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { raceInputFilter } from '../../src/shared/race/inputFilter.js';
import { LineDriver } from '../../src/shared/race/lineDriver.js';
import { advanceProgress, createCourse, createRaceProgress } from '../../src/shared/race/progress.js';
import { createRaceWorld } from '../../src/shared/race/raceWorld.js';
import { buildRacingLine } from '../../src/shared/race/racingLine.js';
import type { BotLevel, TrackDef } from '../../src/shared/race/types.js';
import type { CarClassId } from '../../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../../src/shared/sim/vehicle.js';
import { stepWorld } from '../../src/shared/sim/world.js';

export const TICK_RATE = 60;
// Ticks before the start (countdown), as in the phase 2 bot tests
export const START_TICKS = 60;

// ramp: the index of the track's ramp the flight began on, -1 anywhere else
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
export function driveTrack(map: MapData, track: MapTrackDef, car: CarClassId, level: BotLevel = 'medium', seed = 1, maxSeconds = 400): DriveResult {
    const def = track as unknown as TrackDef;
    const world = createRaceWorld(map, def);
    // The race world's ramps: the map's first, then the track's
    const first = map.ramps.length;
    const course = createCourse(def, buildRacingLine(def), world.surfaceAt);
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
        const at = world.rampAt(x0, z0);
        const onRamp = at >= first ? at - first : -1;
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
