import * as THREE from 'three';
import { BTN_HANDBRAKE, DT, SIM_TUNING } from '../../shared/sim/constants.js';
import { copyVehicleState, createVehicleState, type AssistProfile, type CarClassId, type SimCar, type VehicleState } from '../../shared/sim/types.js';
import { createSimCar, placeVehicle } from '../../shared/sim/vehicle.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import { stepWorld } from '../../shared/sim/world.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import { gameHooks } from '../game/hooks.js';
import { FixedStepLoop } from '../game/loop.js';
import { inputManager } from '../input/InputManager.js';
import { state } from '../state.js';
import { BodyMotion, type BodyMotionInput } from './bodyMotion.js';
import type { NetDriver } from '../net/netDriver.js';

// The local car on the v2 physics (docs/phase-1a-design.md, 12.2/12.3): the
// sim car, the fixed-step loop, the prev/curr pair for the render
// interpolation and the pose, springs and adapter fields written onto the
// Bulli model. Online a NetDriver ticks it (prediction against the server,
// docs/phase-1b-design.md 8); offline and in the sandbox it steps itself.

const POWERUP_KEYS = ['speed', 'size', 'shield', 'magnet', 'ghost'] as const;
// Reset hint (6.7): pushing into a wall at a standstill for a second
const STUCK_TICKS = 60;

// The model and adapter fields LocalVehicle drives (entities/Bulli.ts)
export interface VehicleHost {
    group: THREE.Group;
    // Wheels, brake lights and blinkers of the model (CarModel.setDriveState)
    setDriveState?(speed: number, steerAngle: number, braking: boolean): void;
    // Ground tilt, body height, pitch, roll and wheels (CarModel.setBodyPose)
    setBodyPose?(motion: BodyMotion, scale: number): void;
    carType: string;
    powerups: Record<(typeof POWERUP_KEYS)[number], { active: boolean; timer: number }>;
    speed: number;
    maxSpeed: number;
    angle: number;
    canRecover: boolean;
}

// Strongest events of all ticks run in one frame, for sounds and particles
export interface FrameEvents {
    wallImpact: number;
    wallX: number;
    wallZ: number;
    carImpact: number;
    landedImpact: number;
    boostStarted: boolean;
    reset: boolean;
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
    // Online: the prediction ticks the car (null offline and in the sandbox)
    net: NetDriver | null = null;
    alpha = 0;
    private readonly cars: SimCar[] = [];
    readonly events: FrameEvents = {
        wallImpact: 0, wallX: 0, wallZ: 0, carImpact: 0, landedImpact: 0,
        boostStarted: false, reset: false
    };
    // Counters for the e2e hook
    ticks = 0;
    private lastResetTick = -Infinity;
    resets = 0;
    // Flights off the ground: how many ended, and the last one's ticks in
    // the air, highest point over the ground (m) and landing impact (m/s)
    flights = 0;
    lastFlight = { ticks: 0, height: 0, landing: 0 };
    private flightTicks = 0;
    private flightHeight = 0;
    private stuckTicks = 0;
    resetHint = false;
    // The hint came on during this frame
    hintChanged = false;
    // Interpolated pose of the last frame
    readonly pose = { x: 0, y: 0, z: 0, yaw: 0, ground: 0, scale: 1 };
    // Body height, pitch, roll and wheels on screen (renderer only)
    readonly body = new BodyMotion();
    private readonly bodyInput: BodyMotionInput = {
        x: 0, z: 0, yaw: 0, airHeight: 0, grounded: true, susp: 0, vy: 0, speed: 0, horizontalSpeed: 0, loadX: 0, yawRate: 0
    };

    readonly classId: CarClassId;
    // Assist profile; the tuning panel may switch it (then refreshCarParams)
    profile: AssistProfile;
    // Remote players in the contact set of the last tick
    proxyCount = 0;
    private readonly renderScratch = { x: 0, y: 0, z: 0, yaw: 0 };
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

    /** Height of the wheels over the ground on screen (m), 0 on the ground. */
    get airHeight(): number {
        return this.body.airHeight;
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
        this.syncPrev();
        this.body.reset();
    }

    private syncPrev(): void {
        copyVehicleState(this.prev, this.car.state);
    }

    /** The state before the current tick after the prediction replayed it. */
    syncPrevFrom(prev: VehicleState): void {
        copyVehicleState(this.prev, prev);
    }

    /**
     * The pose the last frame would show with the current prev/curr pair
     * (x, y, z, yaw), with or without the net render offset. Shared scratch.
     */
    renderPose(withOffset = true): { x: number; y: number; z: number; yaw: number } {
        const a = this.alpha, prev = this.prev, curr = this.car.state, out = this.renderScratch;
        out.x = prev.x + (curr.x - prev.x) * a;
        out.y = prev.y + (curr.y - prev.y) * a;
        out.z = prev.z + (curr.z - prev.z) * a;
        out.yaw = prev.yaw + (curr.yaw - prev.yaw) * a;
        const offset = this.net?.offset;
        if (withOffset && offset) {
            out.x += offset.x; out.y += offset.y; out.z += offset.z; out.yaw += offset.yaw;
        }
        return { ...out };
    }

    /** Runs the ticks due this frame and writes the interpolated pose onto host. */
    update(dt: number, host: VehicleHost, now: number): void {
        if (this.net) {
            // Online the ticks follow the server clock plus the lead (8.3);
            // a timer runs them between frames too (net/netDriver.ts), so
            // the frame events are cleared after they played (endFrame)
            this.pumpNet(host, now);
            this.alpha = this.net.renderAlpha(now);
            this.net.decayOffsets(dt * 1000, now);
        } else {
            this.endFrame();
            const start = performance.now();
            this.alpha = this.loop.advance(dt, lag => this.tick(host, now - lag * 1000));
            this.simMsTotal += performance.now() - start;
        }
        this.applyPose(dt, host);
    }

    /** Online: the ticks due by now, then the inputs out. Also called from a timer between frames. */
    pumpNet(host: VehicleHost, now: number): void {
        const net = this.net;
        if (!net) return;
        const start = performance.now();
        net.advanceFrame(now, () => this.tick(host, now));
        net.flushInputs();
        this.simMsTotal += performance.now() - start;
    }

    /** Clears the events of the frame (after the sounds and particles played). */
    endFrame(): void {
        const ev = this.events;
        ev.wallImpact = ev.carImpact = ev.landedImpact = 0;
        ev.boostStarted = ev.reset = false;
        this.hintChanged = false;
    }

    /**
     * Counts the powerup timers down, a Party rule (section 10): per tick
     * while the sim runs, per frame while it is frozen (modal, dead, GL
     * context lost), so they run out then too.
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

        if (this.net) {
            // The prediction samples, stores and steps (with the contact set)
            if (!this.net.tickLocal(this, now)) return;
            const remotes = this.net.prediction?.remotes.size ?? 0;
            this.proxyCount = remotes;
            this.simCars = 1 + remotes;
        } else {
            this.countPowerups(host, DT);
            const mods = car.mods;
            mods.turbo = host.powerups.speed.active;
            mods.mega = host.powerups.size.active;
            mods.ghost = host.powerups.ghost.active;
            mods.shield = host.powerups.shield.active;

            inputManager.sampleTick(car.input);

            const cars = this.cars;
            cars.length = 0;
            cars.push(car);
            this.proxyCount = 0;
            // Sandbox dummies (game/hooks.ts), empty in the game
            for (const hook of gameHooks.beforeTick) hook(this);
            for (const extra of gameHooks.extraCars) cars.push(extra);
            this.simCars = cars.length;
            stepWorld(cars, this.world);
        }
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
        // Online a correction can bring a reset the player already saw a
        // few ticks later again (the server got the input late); a real
        // second one needs another full hold
        const tick = this.ticks;
        if (tickEvents.boostStarted) ev.boostStarted = true;
        if (tickEvents.reset && this.net && tick - this.lastResetTick < SIM_TUNING.RESET_HOLD_TICKS) {
            this.syncPrev();
        } else if (tickEvents.reset) {
            this.lastResetTick = tick;
            ev.reset = true;
            this.resets++;
            // No interpolation across the move onto the road
            this.syncPrev();
            this.body.reset();
        }

        const s = car.state;
        if (!s.grounded) {
            this.flightTicks++;
            this.flightHeight = Math.max(this.flightHeight, s.y - this.world.groundHeight(s.x, s.z));
        } else if (this.flightTicks > 0) {
            this.flights++;
            this.lastFlight = { ticks: this.flightTicks, height: this.flightHeight, landing: tickEvents.landedImpact };
            this.flightTicks = this.flightHeight = 0;
        }
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
        // A correction of the prediction fades out instead of jumping
        const offset = this.net?.offset;
        if (offset) {
            pose.x += offset.x;
            pose.y += offset.y;
            pose.z += offset.z;
            pose.yaw += offset.yaw;
        }
        pose.scale = prev.scale + (curr.scale - prev.scale) * a;
        pose.ground = this.world.groundHeight(pose.x, pose.z);

        const group = host.group;
        group.position.set(pose.x, pose.ground, pose.z);
        group.scale.setScalar(pose.scale);
        group.rotation.order = 'YXZ';
        group.rotation.y = pose.yaw;

        // The body on its springs and in the air (vehicle/bodyMotion.ts)
        const u = this.forwardSpeed;
        const grounded = curr.grounded;
        const input = this.bodyInput;
        input.x = pose.x;
        input.z = pose.z;
        input.yaw = pose.yaw;
        input.grounded = grounded;
        // Over the terrain: in the air, or standing on a ramp or a low collider
        input.airHeight = pose.y - pose.ground;
        input.susp = prev.susp + (curr.susp - prev.susp) * a;
        input.vy = prev.vy + (curr.vy - prev.vy) * a;
        input.speed = u;
        input.horizontalSpeed = Math.hypot(curr.vx, curr.vz);
        input.loadX = curr.loadX;
        input.yawRate = curr.yawRate;
        this.body.update(dt, input, this.world.groundHeight);
        host.setBodyPose?.(this.body, pose.scale);

        // Wheels roll with the road speed, the front pair steers; the brake
        // lights come on while braking forwards (or with the handbrake)
        const drive = this.car.input;
        const braking = grounded && ((drive.brake > 20 && u > 0.5) || ((drive.buttons & BTN_HANDBRAKE) !== 0 && Math.abs(u) > 0.5));
        host.setDriveState?.(u, curr.steerAngle, braking);

        // Adapter: speeds in units per 1/60 s tick (section 12.3)
        host.speed = u / 60;
        host.maxSpeed = this.car.params.topSpeed / 60;
        host.angle = pose.yaw;
        host.canRecover = this.resetHint;
    }
}
