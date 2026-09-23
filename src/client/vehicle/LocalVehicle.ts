import * as THREE from 'three';
import { MEGA_SCALE } from '../../shared/constants.js';
import { DT } from '../../shared/sim/constants.js';
import { copyVehicleState, createVehicleState, type AssistProfile, type CarClassId, type SimCar } from '../../shared/sim/types.js';
import { createSimCar, placeVehicle, resetVehicle } from '../../shared/sim/vehicle.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import { stepWorld } from '../../shared/sim/world.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import { gameHooks } from '../game/hooks.js';
import { FixedStepLoop } from '../game/loop.js';
import { inputManager } from '../input/InputManager.js';
import { state } from '../state.js';
import { collectRemoteProxies } from './remoteProxies.js';

// The local car on the v2 physics (docs/phase-1a-design.md, 12.2/12.3): the
// sim car, the fixed-step loop, the prev/curr pair for the render
// interpolation and the pose, springs and legacy adapter fields written
// onto the Bulli model. Only exists with ?physics=v2.

const TWO_PI = Math.PI * 2;
const POWERUP_KEYS = ['speed', 'size', 'jump', 'shield', 'magnet', 'ghost'] as const;
// Visual spring from the accelerations (renderer only, never in the sim)
const PITCH_PER_ACCEL = 0.0035;      // rad per m/s²
const ROLL_PER_ACCEL = 0.0045;
const MAX_PITCH = 4 * Math.PI / 180;
const MAX_ROLL = 5 * Math.PI / 180;
const SPRING_RATE = 10;
const SQUASH_RATE = 8;
// A flip cut short by the landing turns the rest within about 6 frames
const FLIP_FINISH_RATE = 18;
// Terrain tilt like the legacy car: ±2 m samples, eased
const SLOPE_STEP = 2.0;
const TILT_RATE = 6;
// Reset hint (6.7): pushing into a wall at a standstill for a second
const STUCK_TICKS = 60;

// The model and adapter fields LocalVehicle drives (entities/Bulli.ts)
export interface VehicleHost {
    group: THREE.Group;
    flipGroup: THREE.Group;
    wheels: THREE.Group[];
    carType: string;
    powerups: Record<(typeof POWERUP_KEYS)[number], { active: boolean; timer: number }>;
    speed: number;
    maxSpeed: number;
    angle: number;
    isFlipping: boolean;
    canRecover: boolean;
}

// Strongest events of all ticks run in one frame, for sounds and particles
export interface FrameEvents {
    wallImpact: number;
    wallX: number;
    wallZ: number;
    carImpact: number;
    landedImpact: number;
    jumped: boolean;
    boostStarted: boolean;
    reset: boolean;
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function damp(rate: number, dt: number): number {
    return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

export function assistProfileForDevice(): AssistProfile {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
        ? 'touch'
        : 'standard';
}

export class LocalVehicle {
    readonly car: SimCar;
    world: SimWorld;
    readonly loop = new FixedStepLoop();
    // Sim state before the last tick; car.state is the one after it
    private readonly prev = createVehicleState();
    alpha = 0;
    private readonly cars: SimCar[] = [];
    readonly events: FrameEvents = {
        wallImpact: 0, wallX: 0, wallZ: 0, carImpact: 0, landedImpact: 0,
        jumped: false, boostStarted: false, reset: false
    };
    // Counters for the e2e hook
    ticks = 0;
    jumps = 0;
    resets = 0;
    private stuckTicks = 0;
    resetHint = false;
    // The hint came on during this frame
    hintChanged = false;
    // Interpolated pose of the last frame
    readonly pose = { x: 0, y: 0, z: 0, yaw: 0, ground: 0, flip: 0, scale: 1 };
    private visualFlip = 0;
    private finishingFlip = false;
    private pitchSpring = 0;
    private rollSpring = 0;
    private squash = 0;
    private tiltPitch = 0;
    private tiltRoll = 0;

    readonly classId: CarClassId;
    // Assist profile; the tuning panel may switch it (then refreshCarParams)
    profile: AssistProfile;
    // Remote players in the contact set of the last tick
    proxyCount = 0;
    // For ?debug=perf: CPU time of all ticks so far (ms) and the cars
    // stepped in the last one (perfMonitor turns them into per-frame costs)
    simMsTotal = 0;
    simCars = 0;

    constructor(id: string, classId: CarClassId, profile: AssistProfile, world: SimWorld) {
        this.car = createSimCar(id, classId, profile);
        this.classId = classId;
        this.profile = profile;
        this.world = world;
    }

    get autoGas(): boolean {
        return inputManager.autoGasActive;
    }

    static forHost(host: VehicleHost, world: SimWorld): LocalVehicle {
        const classId: CarClassId = isCarClassId(host.carType) ? host.carType : 'bulli';
        const vehicle = new LocalVehicle(state.myId ?? 'local', classId, assistProfileForDevice(), world);
        vehicle.place(host.group.position.x, host.group.position.z, host.angle);
        return vehicle;
    }

    get forwardSpeed(): number {
        const s = this.car.state;
        return s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
    }

    get slipAngle(): number {
        const s = this.car.state;
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
        const u = s.vx * fx + s.vz * fz;
        return u > 1 ? Math.atan2(s.vx * fz - s.vz * fx, u) : 0;
    }

    // At rest on the ground, e.g. at spawn or from the e2e hook
    place(x: number, z: number, yaw: number): void {
        placeVehicle(this.car.state, this.world, x, z, yaw);
        this.car.state.flipAngle = 0;
        this.syncPrev();
    }

    // Server respawn (Party mode): full reset at the new spot
    respawn(x: number, z: number): void {
        const s = this.car.state;
        s.x = x;
        s.z = z;
        s.scale = 1;
        s.boostMeter = 0;
        resetVehicle(s, this.car.params, this.world);
        this.syncPrev();
        this.loop.reset();
    }

    private syncPrev(): void {
        copyVehicleState(this.prev, this.car.state);
        this.visualFlip = 0;
        this.finishingFlip = false;
    }

    /** Runs the ticks due this frame and writes the interpolated pose onto host. */
    update(dt: number, host: VehicleHost, now: number): void {
        const ev = this.events;
        ev.wallImpact = ev.carImpact = ev.landedImpact = 0;
        ev.jumped = ev.boostStarted = ev.reset = false;
        this.hintChanged = false;
        const start = performance.now();
        this.alpha = this.loop.advance(dt, lag => this.tick(host, now - lag * 1000));
        this.simMsTotal += performance.now() - start;
        this.applyPose(dt, host);
    }

    /**
     * Counts the powerup timers down, a Party rule (section 10): per tick
     * while the sim runs, per frame while it is frozen (modal, dead, GL
     * context lost), so they run out then too, like in legacy.
     */
    countPowerups(host: VehicleHost, seconds: number): void {
        for (const key of POWERUP_KEYS) {
            const powerup = host.powerups[key];
            if (!powerup.active) continue;
            powerup.timer -= seconds;
            if (powerup.timer <= 0) powerup.active = false;
        }
    }

    // now: the time this tick simulates (performance.now() scale)
    private tick(host: VehicleHost, now: number): void {
        const car = this.car;
        copyVehicleState(this.prev, car.state);

        this.countPowerups(host, DT);
        const mods = car.mods;
        mods.turbo = host.powerups.speed.active;
        mods.mega = host.powerups.size.active;
        mods.superJump = host.powerups.jump.active;
        mods.ghost = host.powerups.ghost.active;
        mods.shield = host.powerups.shield.active || state.respawnShield;

        inputManager.sampleTick(car.input);

        const cars = this.cars;
        cars.length = 0;
        cars.push(car);
        collectRemoteProxies(now, this.world, cars);
        this.proxyCount = cars.length - 1;
        // Sandbox dummies (game/hooks.ts), empty in the game
        for (const hook of gameHooks.beforeTick) hook(this);
        for (const extra of gameHooks.extraCars) cars.push(extra);
        this.simCars = cars.length;
        stepWorld(cars, this.world);
        this.ticks++;
        for (const hook of gameHooks.afterTick) hook(this);

        const tickEvents = car.events;
        const ev = this.events;
        if (tickEvents.wallImpact > ev.wallImpact) {
            ev.wallImpact = tickEvents.wallImpact;
            ev.wallX = tickEvents.wallX;
            ev.wallZ = tickEvents.wallZ;
        }
        ev.carImpact = Math.max(ev.carImpact, tickEvents.carImpact);
        ev.landedImpact = Math.max(ev.landedImpact, tickEvents.landedImpact);
        if (tickEvents.jumped) {
            ev.jumped = true;
            this.jumps++;
        }
        if (tickEvents.boostStarted) ev.boostStarted = true;
        if (tickEvents.reset) {
            ev.reset = true;
            this.resets++;
            // No interpolation across the jump onto the road
            this.syncPrev();
        }

        const s = car.state;
        const hadHint = this.resetHint;
        const stuck = car.input.throttle > 127 && Math.abs(this.forwardSpeed) < 1 && s.wallTicks < 2;
        this.stuckTicks = stuck ? this.stuckTicks + 1 : 0;
        if (this.stuckTicks >= STUCK_TICKS) this.resetHint = true;
        else if (!stuck && Math.abs(this.forwardSpeed) > 3) this.resetHint = false;
        if (tickEvents.reset) this.resetHint = false;
        if (this.resetHint && !hadHint) this.hintChanged = true;
    }

    private applyPose(dt: number, host: VehicleHost): void {
        const a = this.alpha;
        const prev = this.prev;
        const curr = this.car.state;
        const pose = this.pose;
        pose.x = prev.x + (curr.x - prev.x) * a;
        pose.z = prev.z + (curr.z - prev.z) * a;
        pose.y = prev.y + (curr.y - prev.y) * a;
        pose.yaw = prev.yaw + (curr.yaw - prev.yaw) * a;
        pose.scale = prev.scale + (curr.scale - prev.scale) * a;
        pose.ground = this.world.groundHeight(pose.x, pose.z);

        // Flip: interpolated while it runs; when the sim ends it (full turn
        // or landing) the model turns on to a full circle
        if (curr.flipAngle > 0) {
            this.finishingFlip = false;
            const from = prev.flipAngle > 0 && prev.flipAngle <= curr.flipAngle ? prev.flipAngle : 0;
            this.visualFlip = from + (curr.flipAngle - from) * a;
        } else if (prev.flipAngle > 0 || this.finishingFlip) {
            this.finishingFlip = true;
            const start = Math.max(this.visualFlip, prev.flipAngle);
            this.visualFlip = start + (TWO_PI - start) * damp(FLIP_FINISH_RATE, dt) + 0.02;
            if (this.visualFlip >= TWO_PI - 0.01) {
                this.visualFlip = 0;
                this.finishingFlip = false;
            }
        } else {
            this.visualFlip = 0;
        }
        pose.flip = this.visualFlip;

        const group = host.group;
        group.position.set(pose.x, pose.ground, pose.z);
        group.scale.setScalar(pose.scale);
        host.flipGroup.position.y = Math.max(0, pose.y - pose.ground);
        host.flipGroup.rotation.x = pose.flip;

        // Tilt: terrain slope plus a spring from the accelerations
        const fwdX = Math.sin(pose.yaw), fwdZ = Math.cos(pose.yaw);
        const ground = this.world.groundHeight;
        const hFwd = ground(pose.x + fwdX * SLOPE_STEP, pose.z + fwdZ * SLOPE_STEP);
        const hBack = ground(pose.x - fwdX * SLOPE_STEP, pose.z - fwdZ * SLOPE_STEP);
        const hLeft = ground(pose.x + fwdZ * SLOPE_STEP, pose.z - fwdX * SLOPE_STEP);
        const hRight = ground(pose.x - fwdZ * SLOPE_STEP, pose.z + fwdX * SLOPE_STEP);
        const tilt = damp(TILT_RATE, dt);
        this.tiltPitch += (Math.atan2(hBack - hFwd, SLOPE_STEP * 2) - this.tiltPitch) * tilt;
        this.tiltRoll += (Math.atan2(hLeft - hRight, SLOPE_STEP * 2) - this.tiltRoll) * tilt;
        const u = this.forwardSpeed;
        const grounded = curr.grounded;
        // Nose up when accelerating, down when braking; body leans out of turns
        const pitchTarget = grounded ? clamp(-curr.loadX * PITCH_PER_ACCEL, -MAX_PITCH, MAX_PITCH) : 0;
        const rollTarget = grounded ? clamp(u * curr.yawRate * ROLL_PER_ACCEL, -MAX_ROLL, MAX_ROLL) : 0;
        const spring = damp(SPRING_RATE, dt);
        this.pitchSpring += (pitchTarget - this.pitchSpring) * spring;
        this.rollSpring += (rollTarget - this.rollSpring) * spring;
        if (this.events.landedImpact > 3) this.squash = Math.max(this.squash, Math.min(0.15, this.events.landedImpact * 0.012));
        this.squash -= this.squash * damp(SQUASH_RATE, dt);
        host.flipGroup.scale.y = 1 - this.squash;

        group.rotation.order = 'YXZ';
        group.rotation.y = pose.yaw;
        group.rotation.x = this.tiltPitch + this.pitchSpring;
        group.rotation.z = this.tiltRoll + this.rollSpring;

        // Wheels: spin with the road speed, the front pair steers
        const wheels = host.wheels;
        for (let i = 0; i < wheels.length; i++) {
            const wheel = wheels[i];
            wheel.rotation.x -= u * 0.5 * Math.min(dt, 0.1);
            if (i < 2) {
                wheel.rotation.order = 'YXZ';
                wheel.rotation.y = curr.steerAngle;
            }
        }

        // Legacy adapter: speeds in units per 1/60 s tick (section 12.3)
        host.speed = u / 60;
        host.maxSpeed = this.car.params.topSpeed / 60;
        host.angle = pose.yaw;
        host.isFlipping = curr.flipAngle > 0;
        host.canRecover = this.resetHint;
    }

    // Anything left for the server to see move (like the legacy check)
    get moving(): boolean {
        const s = this.car.state;
        return Math.hypot(s.vx, s.vz) > 0.01
            || Math.abs(s.yawRate) > 0.001
            || !s.grounded
            || s.flipAngle > 0
            || this.visualFlip > 0
            || Math.abs(s.scale - (this.car.mods.mega ? MEGA_SCALE : 1)) > 0.001;
    }
}
