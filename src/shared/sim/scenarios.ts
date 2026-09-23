// Scripted golden scenarios of the v2 simulation (docs/phase-1a-design.md,
// section 14.4). They live in shared so the Node tests and, later, the
// sandbox in the browser (window.__bulliSim.runGolden) run the very same
// input scripts.

import type { TerrainConfig } from '../protocol.js';
import { createSimWorld, type ColliderInput, type RampDef, type SimWorld } from '../world/colliders.js';
import { MEGA_SCALE } from '../constants.js';
import { BTN_BOOST, BTN_HANDBRAKE, BTN_JUMP, BTN_RESET, DEG } from './constants.js';
import { copyVehicleState, createVehicleState, type AssistProfile, type CarClassId, type SimCar, type VehicleState } from './types.js';
import { CAR_CLASS_IDS } from './vehicleClasses.js';
import { createSimCar, placeVehicle } from './vehicle.js';
import { stepWorld } from './world.js';

// Flat terrain of the default size: all waves have amplitude 0
export const FLAT_TERRAIN: TerrainConfig = {
    size: 1000,
    segments: 1,
    frequency1: 0,
    amplitude1: 0,
    frequency2: 0,
    amplitude2: 0,
    frequency3: 0,
    amplitude3: 0
};

export function createFlatWorld(colliders: ColliderInput[] = [], ramps: RampDef[] = []): SimWorld {
    return createSimWorld(FLAT_TERRAIN, colliders, ramps);
}

// A car on the ground at (x, z) heading yaw, moving forward at speed
export function spawnCar(
    world: SimWorld, id: string, classId: CarClassId, x: number, z: number, yaw: number, speed = 0,
    profile: AssistProfile = 'standard'
): SimCar {
    const car = createSimCar(id, classId, profile);
    placeVehicle(car.state, world, x, z, yaw);
    car.state.vx = Math.sin(yaw) * speed;
    car.state.vz = Math.cos(yaw) * speed;
    return car;
}

export function forwardSpeed(s: VehicleState): number {
    return s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
}

export function slipAngle(s: VehicleState): number {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const u = s.vx * fx + s.vz * fz;
    const w = s.vx * fz - s.vz * fx;
    return u > 1 ? Math.atan2(w, u) : 0;
}

export interface ScenarioRun {
    cars: SimCar[];
    world: SimWorld;
}

export interface SimScenario {
    name: string;
    ticks: number;
    create(): ScenarioRun;
    // Sets each car's input (and mods) for the tick. May read the state, like
    // a scripted driver; it must stay deterministic.
    drive(tick: number, run: ScenarioRun): void;
}

function byId(run: ScenarioRun, id: string): SimCar {
    const car = run.cars.find(candidate => candidate.id === id);
    if (!car) throw new Error(`scenario has no car ${id}`);
    return car;
}

function setInput(car: SimCar, throttle: number, steer = 0, brake = 0, buttons = 0): void {
    car.input.throttle = throttle;
    car.input.steer = steer;
    car.input.brake = brake;
    car.input.buttons = buttons;
}

// A player who steers into a slide (towards the travel direction)
function counterSteer(car: SimCar): number {
    // + 0 turns a -0 from Math.round into 0, so goldens stay plain JSON
    return Math.round(Math.max(-1, Math.min(1, 2 * slipAngle(car.state))) * 127) + 0;
}

// Full throttle straight and into a turn, then the brake held through the
// stop into reverse: vtop, accel, grip and braking of one class
function launchBrakeReverse(classId: CarClassId): SimScenario {
    return {
        name: `launch-brake-reverse-${classId}`,
        ticks: 300,
        create() {
            const world = createFlatWorld();
            return { world, cars: [spawnCar(world, 'a', classId, 0, -400, 0)] };
        },
        drive(tick, run) {
            if (tick < 180) setInput(run.cars[0], 255, tick < 90 ? 0 : 64);
            else setInput(run.cars[0], 0, 0, 255);
        }
    };
}


export const SIM_SCENARIOS: SimScenario[] = [
    {
        name: 'accel-grip-bulli',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            return { world, cars: [spawnCar(world, 'a', 'bulli', 0, -400, 0)] };
        },
        drive(tick, run) {
            setInput(run.cars[0], 255, tick < 90 ? 0 : 64);
        }
    },
    {
        name: 'handbrake-drift-sport',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            return { world, cars: [spawnCar(world, 'a', 'sport', 0, -300, 0, 25)] };
        },
        drive(tick, run) {
            if (tick < 30) setInput(run.cars[0], 255, 127, 0, BTN_HANDBRAKE);
            else setInput(run.cars[0], 255, -40);
        }
    },
    {
        name: 'ramp-jump-beetle',
        ticks: 180,
        create() {
            // 16 m long, 3 m high (10.6°), take-off edge at z = -292
            const world = createFlatWorld([], [{ x: 0, z: -300, yaw: 0, width: 8, length: 16, height: 3 }]);
            return { world, cars: [spawnCar(world, 'a', 'beetle', 0, -340, 0, 25)] };
        },
        drive(_tick, run) {
            setInput(run.cars[0], 255);
        }
    },
    {
        name: 'wall-graze-10deg',
        ticks: 180,
        create() {
            // Wall 0.5 m thick along z, inner face at x = 4.75. 49 m/s, not
            // the Bulli's vtop of 50: at exactly vtop the full-throttle drive
            // switches between covering the drag or not, so the last bit of
            // sin/cos(10°) decided the whole run (scripts/sim-golden-drift.ts)
            const world = createFlatWorld([{ kind: 'box', x: 5, z: 0, hw: 0.25, hd: 150, top: Infinity }]);
            return { world, cars: [spawnCar(world, 'a', 'bulli', 0, -100, 10 * DEG, 49)] };
        },
        drive(_tick, run) {
            setInput(run.cars[0], 255);
        }
    },
    {
        name: 'contact-frontal',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            return {
                world,
                cars: [
                    spawnCar(world, 'a', 'bulli', 0, -25, 0, 50),
                    spawnCar(world, 'b', 'bulli', 0, 25, Math.PI, 50)
                ]
            };
        },
        drive(_tick, run) {
            for (const car of run.cars) setInput(car, 255);
        }
    },
    {
        name: 'contact-t-bone',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            return {
                world,
                cars: [
                    spawnCar(world, 'pickup', 'pickup', -30, 0, Math.PI / 2, 25),
                    spawnCar(world, 'beetle', 'beetle', 0, 0, 0)
                ]
            };
        },
        drive(_tick, run) {
            setInput(byId(run, 'pickup'), 255);
            setInput(byId(run, 'beetle'), 0);
        }
    },
    {
        name: 'contact-pit',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            return {
                world,
                cars: [
                    // The sport noses into the right rear quarter at 20°; a
                    // straight rear-end hit would push through the centre of
                    // mass and hardly turn the Bulli
                    spawnCar(world, 'bulli', 'bulli', 0, -200, 0, 30),
                    spawnCar(world, 'sport', 'sport', 2.8, -204, -20 * DEG, 36)
                ]
            };
        },
        drive(_tick, run) {
            const bulli = byId(run, 'bulli');
            setInput(bulli, 200, counterSteer(bulli));
            setInput(byId(run, 'sport'), 255);
        }
    },
    {
        name: 'contact-chain-three',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            return {
                world,
                cars: [
                    // c3 reaches c2 first, then c2 is pushed into c1
                    spawnCar(world, 'c1', 'bulli', 0, -300, 0, 35),
                    spawnCar(world, 'c2', 'bulli', 0, -312, 0, 40),
                    spawnCar(world, 'c3', 'bulli', 0, -320, 0, 45)
                ]
            };
        },
        drive(_tick, run) {
            for (const car of run.cars) setInput(car, 0);
        }
    },
    {
        name: 'contact-mega-vs-beetle',
        ticks: 180,
        create() {
            const world = createFlatWorld();
            const mega = spawnCar(world, 'mega', 'bulli', 0, -30, 0, 30);
            mega.mods.mega = true;
            mega.state.scale = MEGA_SCALE;
            return { world, cars: [mega, spawnCar(world, 'beetle', 'beetle', 0.5, 0, 0)] };
        },
        drive(_tick, run) {
            setInput(byId(run, 'mega'), 255);
            setInput(byId(run, 'beetle'), 0);
        }
    },
    {
        name: 'ghost-through-car-and-building',
        ticks: 180,
        create() {
            const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 10, hd: 12, top: Infinity }]);
            const ghost = spawnCar(world, 'ghost', 'bulli', 0, -60, 0, 30);
            ghost.mods.ghost = true;
            return { world, cars: [ghost, spawnCar(world, 'parked', 'bulli', 0, -30, 0)] };
        },
        drive(tick, run) {
            const ghost = byId(run, 'ghost');
            // The Party ghost ends while the car is inside the building
            ghost.mods.ghost = tick < 100;
            setInput(ghost, 255);
            setInput(byId(run, 'parked'), 0);
        }
    },
    {
        name: 'boost-handbrake-bulli',
        ticks: 240,
        create() {
            const world = createFlatWorld();
            const car = spawnCar(world, 'a', 'bulli', 0, -450, 0, 45);
            car.state.boostMeter = 1;
            return { world, cars: [car] };
        },
        drive(tick, run) {
            // Boost past vtop, let go, boost the rest of the meter, then
            // roll on the handbrake alone from above vtop
            const boost = tick < 100 || (tick >= 110 && tick < 180);
            if (tick < 180) setInput(run.cars[0], 255, 0, 0, boost ? BTN_BOOST : 0);
            else setInput(run.cars[0], 0, 0, 0, BTN_HANDBRAKE);
        }
    },
    {
        name: 'jump-reset-jeep',
        ticks: 240,
        create() {
            const world = createFlatWorld();
            return { world, cars: [spawnCar(world, 'a', 'jeep', 0, -400, 0, 20)] };
        },
        drive(tick, run) {
            // Jump, press again within the coyote time (the cooldown holds
            // it back), steer in the air and land; then hold reset until it
            // fires and drive on through the contact ghost
            let buttons = 0;
            if ((tick >= 10 && tick < 14) || (tick >= 16 && tick < 18)) buttons = BTN_JUMP;
            else if (tick >= 120 && tick < 160) buttons = BTN_RESET;
            setInput(run.cars[0], 200, tick >= 20 && tick < 60 ? 60 : 0, 0, buttons);
        }
    },
    {
        name: 'slalom-touch-beetle',
        ticks: 240,
        create() {
            // The assist profile of every phone player, on the loosest rear
            const world = createFlatWorld();
            return { world, cars: [spawnCar(world, 'a', 'beetle', 0, -300, 0, 35, 'touch')] };
        },
        drive(tick, run) {
            // Full lock, switching sides every 50 ticks with a handbrake tap:
            // slides past 30°, into the counter-steer and the spin guard
            const steer = Math.floor(tick / 50) % 2 === 0 ? 127 : -127;
            setInput(run.cars[0], 255, steer, 0, tick % 50 < 12 ? BTN_HANDBRAKE : 0);
        }
    },
    {
        name: 'proxy-bump-sport',
        ticks: 180,
        create() {
            // A kinematic car with a soft contact, like a remote car the
            // prediction extrapolates at constant speed (phase-1b-design.md
            // 8.5); in 1a this was the remote player's proxy with strength 0.7
            const world = createFlatWorld();
            const proxy = spawnCar(world, 'proxy', 'bulli', 0, -200, 0, 25);
            proxy.kinematic = true;
            proxy.contactScale = 0.7;
            return { world, cars: [proxy, spawnCar(world, 'sport', 'sport', 2.8, -206, -20 * DEG, 33)] };
        },
        drive(_tick, run) {
            setInput(byId(run, 'sport'), 255);
        }
    },
    ...CAR_CLASS_IDS.map(launchBrakeReverse)
];

export function findScenario(name: string): SimScenario {
    const scenario = SIM_SCENARIOS.find(candidate => candidate.name === name);
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    return scenario;
}

// Runs a scenario from the default tuning. afterTick sees the run after
// each tick (tick = index of the tick just simulated).
export function runScenario(scenario: SimScenario, afterTick?: (tick: number, run: ScenarioRun) => void): ScenarioRun {
    const run = scenario.create();
    for (let tick = 0; tick < scenario.ticks; tick++) {
        scenario.drive(tick, run);
        stepWorld(run.cars, run.world);
        afterTick?.(tick, run);
    }
    return run;
}

export interface ScenarioFrame {
    tick: number;                            // ticks simulated so far
    cars: Record<string, VehicleState>;
}

// State of every car after every `every` ticks, the golden record
export function recordScenario(scenario: SimScenario, every = 30): ScenarioFrame[] {
    const frames: ScenarioFrame[] = [];
    runScenario(scenario, (tick, run) => {
        const done = tick + 1;
        if (done % every !== 0 && done !== scenario.ticks) return;
        const cars: Record<string, VehicleState> = {};
        for (const car of run.cars) cars[car.id] = copyVehicleState(createVehicleState(), car.state);
        frames.push({ tick: done, cars });
    });
    return frames;
}

// Goldens are only valid with the shipped tuning (global, classes and
// assist profiles), not after panel changes
export { tuningIsDefault } from './tuning.js';
