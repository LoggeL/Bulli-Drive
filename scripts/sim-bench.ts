// Sim cost benchmark (docs/phase-1a-design.md, 14.9): 32 cars x
// 60 ticks of stepWorld in Node, target < 2 ms per tick. A measurement, not
// a gate: it was a wall-clock bound in the unit tests, which run in
// parallel workers on shared CI runners (flaky) and still passed with the
// sim 6x slower (insensitive). Here it runs alone and only warns.
//
//   npm run perf:sim                 # prints ms per tick
//   npm run perf:sim -- --ticks=600  # a longer measurement
//
// In GitHub Actions a result over the target shows as a ::warning:: in the
// job summary; the exit code stays 0.

import { DEFAULT_TERRAIN_CONFIG } from '../src/shared/constants.js';
import { spawnCar } from '../src/shared/sim/scenarios.js';
import { CAR_CLASS_IDS } from '../src/shared/sim/vehicleClasses.js';
import { stepWorld } from '../src/shared/sim/world.js';
import { createSimWorld } from '../src/shared/world/colliders.js';

const TARGET_MS_PER_TICK = 2;
const CARS = 32;

const ticksArg = process.argv.find(arg => arg.startsWith('--ticks='));
const ticks = ticksArg ? Number(ticksArg.slice('--ticks='.length)) : 60;
if (!(ticks > 0)) throw new Error('--ticks must be a positive number');

const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, [], []);
const cars = Array.from({ length: CARS }, (_, i) =>
    spawnCar(world, `car${String(i).padStart(2, '0')}`, CAR_CLASS_IDS[i % CAR_CLASS_IDS.length],
        (i % 8) * 6 - 21, Math.floor(i / 8) * 8 - 12, 0, 20));
for (const car of cars) {
    car.input.throttle = 255;
    car.input.steer = 40;
}

// Warm up the JIT, then take the best of three runs (least disturbed)
for (let tick = 0; tick < 60; tick++) stepWorld(cars, world);
let best = Infinity;
for (let run = 0; run < 3; run++) {
    const start = performance.now();
    for (let tick = 0; tick < ticks; tick++) stepWorld(cars, world);
    best = Math.min(best, (performance.now() - start) / ticks);
}

console.log(`stepWorld, ${CARS} cars: ${best.toFixed(3)} ms per tick (target < ${TARGET_MS_PER_TICK} ms)`);
if (best >= TARGET_MS_PER_TICK) {
    const message = `stepWorld with ${CARS} cars takes ${best.toFixed(3)} ms per tick, over the ${TARGET_MS_PER_TICK} ms target`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`);
}
