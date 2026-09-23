import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { gameHooks } from '../../src/client/game/hooks.js';
import { inputManager, type DriveKey } from '../../src/client/input/InputManager.js';
import { LocalVehicle, type VehicleHost } from '../../src/client/vehicle/LocalVehicle.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { DT } from '../../src/shared/sim/constants.js';
import { createDummy, driveDummy } from '../../src/shared/sim/dummies.js';
import { copyVehicleState, createVehicleState, type SimCar, type VehicleInput, type VehicleState } from '../../src/shared/sim/types.js';
import { createSandboxWorld, SANDBOX } from '../../src/shared/world/sandbox.js';

// docs/phase-1a-design.md, 14.6 and 22: frame-rate independence of the
// whole client tick, not just of FixedStepLoop. The local car runs through
// LocalVehicle.update as in the game - InputManager with its pulse latch,
// powerup timers counted per tick, the sandbox world and its five dummy
// cars in the same stepWorld - once per rendered frame. The same key script
// per tick index must give the same states per tick at 30, 60 and 144 FPS
// and with irregular frames, bit for bit.
//
// The script is keyed to the tick index on purpose: a key pressed at a
// wall-clock time reaches the sim with the next tick after the frame that
// saw it, so at another frame rate it can land one tick later. That is the
// input latency of the frame, not a dependence of the sim on the frame rate.

const TOTAL_SECONDS = 5;
const TURBO_SECONDS = 1;

type KeyStep = { tick: number; down?: DriveKey[]; up?: DriveKey[] };

// Given after the tick with this index, so it reaches the next one: drive
// into the parked beetle, drift away, a jump tapped within one tick, boost
const SCRIPT: KeyStep[] = [
    { tick: 0, down: ['up'] },
    { tick: 150, down: ['left', 'handbrake'] },
    { tick: 185, up: ['handbrake'] },
    { tick: 200, up: ['left'] },
    // Pressed and released between two ticks: the latch keeps it
    { tick: 210, down: ['jump'], up: ['jump'] },
    { tick: 240, down: ['boost'] },
    { tick: 285, up: ['boost'] }
];

interface Run {
    // Per tick: the local car, then every dummy
    states: VehicleState[][];
    inputs: VehicleInput[];
    turbo: boolean[];
    jumps: number;
    dummyIds: string[];
}

function createHost(): VehicleHost {
    const wheels = [new THREE.Group(), new THREE.Group(), new THREE.Group(), new THREE.Group()];
    const off = () => ({ active: false, timer: 0 });
    return {
        group: new THREE.Group(),
        flipGroup: new THREE.Group(),
        wheels,
        carType: 'bulli',
        powerups: { speed: off(), size: off(), jump: off(), shield: off(), magnet: off(), ghost: off() },
        speed: 0,
        maxSpeed: 0,
        angle: 0,
        isFlipping: false,
        canRecover: false
    };
}

function runWithFrames(frames: number[]): Run {
    const world = createSandboxWorld();
    const specs = SANDBOX.dummies;
    const dummies: SimCar[] = specs.map(spec => createDummy(spec, world));
    const beetle = specs.find(spec => spec.id === 'dummy-beetle')!;

    const host = createHost();
    host.powerups.speed.active = true;
    host.powerups.speed.timer = TURBO_SECONDS;
    const vehicle = new LocalVehicle('local', 'bulli', 'standard', world);
    // 25 m west of the parked beetle, facing it (+x)
    vehicle.place(beetle.x - 25, beetle.z, Math.PI / 2);

    const run: Run = { states: [], inputs: [], turbo: [], jumps: 0, dummyIds: dummies.map(car => car.id) };
    gameHooks.extraCars.push(...dummies);
    gameHooks.beforeTick.push(() => {
        dummies.forEach((car, index) => driveDummy(car, specs[index]));
    });
    gameHooks.afterTick.push(current => {
        const tick = current.ticks - 1;
        run.states.push([current.car, ...dummies].map(car => copyVehicleState(createVehicleState(), car.state)));
        run.inputs.push({ ...current.car.input });
        run.turbo.push(current.car.mods.turbo);
        for (const step of SCRIPT) {
            if (step.tick !== tick) continue;
            for (const key of step.down ?? []) inputManager.keyDown(key);
            for (const key of step.up ?? []) inputManager.keyUp(key);
        }
    });

    let now = 0;
    for (const frame of frames) {
        now += frame * 1000;
        vehicle.update(frame, host, now);
    }
    run.jumps = vehicle.jumps;
    return run;
}

function fixedFrames(frameDt: number): number[] {
    return new Array(Math.round(TOTAL_SECONDS / frameDt)).fill(frameDt);
}

// 4 to 45 ms per frame, like a busy phone; the last one is cut so the
// frames add up to the same total time
function jitteredFrames(seed: number): number[] {
    const random = mulberry32(seed);
    const frames: number[] = [];
    let total = 0;
    while (total < TOTAL_SECONDS) {
        const frame = Math.min(0.004 + random() * 0.041, TOTAL_SECONDS - total);
        frames.push(frame);
        total += frame;
    }
    return frames;
}

function resetClient(): void {
    gameHooks.extraCars.length = 0;
    gameHooks.beforeTick.length = 0;
    gameHooks.afterTick.length = 0;
    inputManager.releaseAll();
}

describe('client tick at any frame rate', () => {
    afterEach(resetClient);

    it('gives the same local car and dummies per tick at 30, 60, 144 FPS and with irregular frames', () => {
        const reference = runWithFrames(fixedFrames(1 / 60));
        resetClient();
        const expectedTicks = TOTAL_SECONDS / DT;
        expect(Math.abs(reference.states.length - expectedTicks)).toBeLessThanOrEqual(1);

        for (const frames of [fixedFrames(1 / 30), fixedFrames(1 / 144), jitteredFrames(11), jitteredFrames(2024)]) {
            const run = runWithFrames(frames);
            resetClient();
            // Summing the frame times in floating point may end one tick early or late
            expect(Math.abs(run.states.length - expectedTicks)).toBeLessThanOrEqual(1);
            const common = Math.min(run.states.length, reference.states.length);
            expect(common).toBeGreaterThanOrEqual(expectedTicks - 1);
            // Bit-identical, not just close
            expect(run.states.slice(0, common)).toStrictEqual(reference.states.slice(0, common));
            expect(run.inputs.slice(0, common)).toStrictEqual(reference.inputs.slice(0, common));
            expect(run.turbo.slice(0, common)).toStrictEqual(reference.turbo.slice(0, common));
            expect(run.jumps).toBe(reference.jumps);
        }

        // The script really did what it claims: turbo for one second,
        // the beetle got rammed, the lapping dummies moved, the tapped
        // jump arrived as exactly one jump, handbrake and boost reached the sim
        const turboTicks = reference.turbo.filter(Boolean).length;
        expect(Math.abs(turboTicks - TURBO_SECONDS / DT)).toBeLessThanOrEqual(1);
        const first = reference.states[0];
        const last = reference.states[reference.states.length - 1];
        const beetle = reference.dummyIds.indexOf('dummy-beetle') + 1;
        expect(Math.hypot(last[beetle].x - first[beetle].x, last[beetle].z - first[beetle].z)).toBeGreaterThan(1);
        const sport = reference.dummyIds.indexOf('dummy-sport') + 1;
        expect(Math.hypot(last[sport].x - first[sport].x, last[sport].z - first[sport].z)).toBeGreaterThan(10);
        expect(reference.jumps).toBe(1);
        expect(reference.states.some(tick => !tick[0].grounded)).toBe(true);
        expect(reference.inputs.some(input => input.buttons !== 0)).toBe(true);
    });
});
