// Deterministic re-simulation of a time trial run (docs/phase-2-design.md,
// 15.2): a fresh car on grid slot 0 of the race world, the recorded inputs
// tick by tick through the same rules as the room (freeze filter, launch,
// stepWorld, the reset check, the gate test). The server runs it in the
// same process with the same code as the room, so the result is bit for
// bit the room's; on submit it checks the finish time, and on the way it
// records the ghost's pose track.

import type { AssistProfile, CarClassId, VehicleInput, VehicleState } from '../sim/types.js';
import { createVehicleInput, createVehicleState, copyVehicleState } from '../sim/types.js';
import { createSimCar, spawnVehicle } from '../sim/vehicle.js';
import { stepWorld } from '../sim/world.js';
import type { SimWorld } from '../world/colliders.js';
import { createGhostPose, GhostTrackWriter } from './ghostTrack.js';
import { raceInputFilter } from './inputFilter.js';
import { applyLaunchMods, LaunchRecorder, type LaunchResult } from './launch.js';
import { advanceProgress, createRaceProgress, resetBeforeNextGate, type Course } from './progress.js';
import { GHOST_POSE_EVERY } from './rules.js';

export const RUN_INPUT_BYTES = 4;

/** Appends-in-place: writes input into bytes at tick index i (4 B per tick). */
export function writeRunInput(bytes: Uint8Array, i: number, input: VehicleInput): void {
    const at = i * RUN_INPUT_BYTES;
    bytes[at] = input.steer & 0xff;
    bytes[at + 1] = input.throttle;
    bytes[at + 2] = input.brake;
    bytes[at + 3] = input.buttons;
}

export function readRunInput(bytes: Uint8Array, i: number, out: VehicleInput): VehicleInput {
    const at = i * RUN_INPUT_BYTES;
    const steer = bytes[at];
    out.steer = steer > 127 ? steer - 256 : steer;
    out.throttle = bytes[at + 1];
    out.brake = bytes[at + 2];
    out.buttons = bytes[at + 3];
    return out;
}

/** Grows as needed; the input of every tick from the grid spawn on. */
export class RunRecorder {
    private bytes = new Uint8Array(RUN_INPUT_BYTES * 3600);
    ticks = 0;

    push(input: VehicleInput): void {
        if ((this.ticks + 1) * RUN_INPUT_BYTES > this.bytes.byteLength) {
            const grown = new Uint8Array(this.bytes.byteLength * 2);
            grown.set(this.bytes);
            this.bytes = grown;
        }
        writeRunInput(this.bytes, this.ticks++, input);
    }

    clear(): void {
        this.ticks = 0;
    }

    finish(): Uint8Array {
        return this.bytes.slice(0, this.ticks * RUN_INPUT_BYTES);
    }
}

export interface ReplayRun {
    carType: CarClassId;
    profile: AssistProfile;
    // Ticks from the grid spawn to startTick
    spawnToStart: number;
    // The input the room used in each tick after the grid spawn, before
    // the race filter (the launch needs the raw throttle)
    inputs: Uint8Array;
}

export interface ReplayResult {
    finishTicks: number | null;
    gateTicks: number[];
    launch: LaunchResult;
    // Pose samples every GHOST_POSE_EVERY ticks from startTick on
    poses: Uint8Array;
    // The car after the last replayed tick
    state: VehicleState;
    ticks: number;
}

/**
 * Replays the run on grid slot 0 of the course's race world. Tick i (1 =
 * the first after the spawn) is race tick i with startTick = spawnToStart,
 * exactly like the room counts from the grid spawn.
 */
export function replayRun(world: SimWorld, course: Course, run: ReplayRun): ReplayResult {
    const slot = course.track.grid[0];
    const car = createSimCar('ghost', run.carType, run.profile);
    spawnVehicle(car.state, world, slot.x, slot.z, slot.yaw);
    const S = run.spawnToStart;
    const progress = createRaceProgress();
    const recorder = new LaunchRecorder();
    const input = createVehicleInput();
    const poses = new GhostTrackWriter();
    const pose = createGhostPose();
    const cars = [car];
    const ticks = Math.floor(run.inputs.byteLength / RUN_INPUT_BYTES);
    let launch: LaunchResult = 'normal';
    let i = 0;
    for (i = 1; i <= ticks && progress.status === 'racing'; i++) {
        readRunInput(run.inputs, i - 1, input);
        if (i <= S) recorder.record(i, input.throttle);
        raceInputFilter(i < S ? 'countdown' : 'racing', i, S, input);
        if (i === S) launch = recorder.result(S);
        applyLaunchMods(launch, i, S, car.mods);
        const x0 = car.state.x, z0 = car.state.z;
        car.input.steer = input.steer;
        car.input.throttle = input.throttle;
        car.input.brake = input.brake;
        car.input.buttons = input.buttons;
        stepWorld(cars, world);
        if (i < S) continue;
        const reset = car.events.reset;
        if (reset) resetBeforeNextGate(progress, course, car.state, world);
        advanceProgress(progress, course, i, S, x0, z0, car.state.x, car.state.z, car.state.vx, car.state.vz, reset);
        if ((i - S) % GHOST_POSE_EVERY === 0) {
            const s = car.state;
            pose.x = s.x; pose.y = s.y; pose.z = s.z; pose.yaw = s.yaw;
            poses.push(pose);
        }
    }
    return {
        finishTicks: progress.finishTicks,
        gateTicks: [...progress.gateTimes],
        launch,
        poses: poses.finish(),
        state: copyVehicleState(createVehicleState(), car.state),
        ticks: i - 1
    };
}
