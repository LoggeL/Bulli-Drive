// Sim cost benchmark (docs/phase-1a-design.md, 14.9; docs/phase-3-design.md,
// 15): 32 cars in one stepWorld, in Node. A measurement, not a gate: it was
// a wall-clock bound in the unit tests, which run in parallel workers on
// shared CI runners (flaky) and still passed with the sim 6x slower
// (insensitive). Here it runs alone and only warns.
//
//   npm run perf:sim                 # prints ms per tick
//   npm run perf:sim -- --ticks=600  # a longer measurement
//
// Two worlds: the flat, empty one of phase 1a (the sim alone, target
// < 2 ms per tick) and Bulli Bay with all its colliders, 32 bots driving
// its roads (the ground, surface and water queries of the heightfield and
// the collider grid in every tick, budget p99 < 4 ms per tick). Besides the
// tick, the reset onto the nearest road (a corridor query of the road
// network, only when a car is reset) is timed on its own.
//
// In GitHub Actions a result over the target shows as a ::warning:: in the
// job summary; the exit code stays 0.

import { DEFAULT_TERRAIN_CONFIG } from '../src/shared/constants.js';
import { loadMap } from '../src/server/maps.js';
import { slotSpawn } from '../src/server/rooms/spawn.js';
import { mulberry32 } from '../src/shared/math/rng.js';
import { spawnCar } from '../src/shared/sim/scenarios.js';
import { createVehicleState } from '../src/shared/sim/types.js';
import { createSimCar, spawnVehicle } from '../src/shared/sim/vehicle.js';
import { CAR_CLASS_IDS } from '../src/shared/sim/vehicleClasses.js';
import { stepWorld } from '../src/shared/sim/world.js';
import { createSimWorld } from '../src/shared/world/colliders.js';
import { RoadDriver } from '../tools/bots/driver.js';

const TARGET_MS_PER_TICK = 2;
const MAP_P99_BUDGET_MS = 4;
const CARS = 32;

const ticksArg = process.argv.find(arg => arg.startsWith('--ticks='));
const ticks = ticksArg ? Number(ticksArg.slice('--ticks='.length)) : 60;
if (!(ticks > 0)) throw new Error('--ticks must be a positive number');

function warn(message: string): void {
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`);
}

// ---- Flat and empty (phase 1a) ----

const flat = createSimWorld(DEFAULT_TERRAIN_CONFIG, [], []);
const flatCars = Array.from({ length: CARS }, (_, i) =>
    spawnCar(flat, `car${String(i).padStart(2, '0')}`, CAR_CLASS_IDS[i % CAR_CLASS_IDS.length],
        (i % 8) * 6 - 21, Math.floor(i / 8) * 8 - 12, 0, 20));
for (const car of flatCars) {
    car.input.throttle = 255;
    car.input.steer = 40;
}
// Warm up the JIT, then take the best of three runs (least disturbed)
for (let tick = 0; tick < 60; tick++) stepWorld(flatCars, flat);
let best = Infinity;
for (let run = 0; run < 3; run++) {
    const start = performance.now();
    for (let tick = 0; tick < ticks; tick++) stepWorld(flatCars, flat);
    best = Math.min(best, (performance.now() - start) / ticks);
}
console.log(`stepWorld, ${CARS} cars, flat: ${best.toFixed(3)} ms per tick (target < ${TARGET_MS_PER_TICK} ms)`);
if (best >= TARGET_MS_PER_TICK) warn(`stepWorld with ${CARS} cars takes ${best.toFixed(3)} ms per tick, over the ${TARGET_MS_PER_TICK} ms target`);

// ---- Bulli Bay: 32 bots on the roads ----

const map = loadMap();
const world = map.simWorld;
const cars = Array.from({ length: CARS }, (_, i) => createSimCar(`bot${String(i).padStart(2, '0')}`, CAR_CLASS_IDS[i % CAR_CLASS_IDS.length]));
const drivers = cars.map((car, i) => {
    const pose = slotSpawn(map.spawns.freeRoam, i, cars.slice(0, i).map(c => c.state));
    spawnVehicle(car.state, world, pose.x, pose.z, pose.yaw);
    const driver = new RoadDriver(mulberry32(i + 1));
    driver.setMap(map, false);
    return driver;
});
const drive = () => cars.forEach((car, i) => drivers[i].drive(car.state, car.params, car.input));
// Warm up for two seconds (the cars spread out), then time every tick
for (let tick = 0; tick < 120; tick++) {
    drive();
    stepWorld(cars, world);
}
const samples = Math.max(ticks, 600);
const times = new Float64Array(samples);
for (let tick = 0; tick < samples; tick++) {
    drive();
    const start = performance.now();
    stepWorld(cars, world);
    times[tick] = performance.now() - start;
}
const sorted = Float64Array.from(times).sort();
const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const mean = times.reduce((sum, t) => sum + t, 0) / samples;
console.log(`stepWorld, ${CARS} bots on Bulli Bay (${world.colliders.length} colliders), ${samples} ticks: `
    + `mean ${mean.toFixed(3)}, p50 ${at(0.5).toFixed(3)}, p99 ${at(0.99).toFixed(3)}, max ${sorted[samples - 1].toFixed(3)} ms `
    + `(budget p99 < ${MAP_P99_BUDGET_MS} ms)`);
if (at(0.99) >= MAP_P99_BUDGET_MS) warn(`stepWorld with ${CARS} cars on Bulli Bay takes ${at(0.99).toFixed(3)} ms per tick at p99, over the ${MAP_P99_BUDGET_MS} ms budget`);

// ---- The reset onto the road (not every tick) ----

const reset = world.resetPose!;
const probe = createVehicleState();
const random = mulberry32(7);
const RESETS = 2000;
let resetMs = 0;
for (let k = 0; k < RESETS; k++) {
    probe.x = -900 + random() * 1800;
    probe.z = -900 + random() * 1800;
    probe.yaw = random() * 6.28;
    const start = performance.now();
    reset(probe);
    resetMs += performance.now() - start;
}
console.log(`reset onto the nearest road: ${(resetMs / RESETS * 1000).toFixed(1)} µs on average (${RESETS} random places)`);
