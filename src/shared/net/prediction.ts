// Client prediction and reconciliation (docs/phase-1b-design.md, 8.4 and
// 8.5). The own car runs ahead of the server with the local inputs; every
// snapshot says where the server had it after tick T_s. When that differs
// from what was predicted for T_s (or cars in the contact set could have
// pushed it), the car restarts from the server state and the ticks
// T_s+1 .. C are simulated again with the stored inputs. Remote cars near
// the own car (the contact set) are predicted along with it, with their
// last input repeated, so a bump acts on both cars at once.
// No DOM, no three: the browser, the Node tests and the bots use it alike.

import { applyContactGhostFloor, copyInput, stopInput } from '../sim/inputs.js';
import {
    copyVehicleState, createVehicleInput, createVehicleState,
    type AssistProfile, type CarClassId, type SimCar, type VehicleInput, type VehicleModifiers, type VehicleState
} from '../sim/types.js';
import { createSimCar, spawnVehicle } from '../sim/vehicle.js';
import { stepWorld } from '../sim/world.js';
import type { SimWorld } from '../world/colliders.js';
import {
    CAR_IDLE, CAR_LAGGY, decodeRemoteState, flagsToMods, INPUT_FROZEN, INPUT_HIDDEN,
    type CompactCar, type Snapshot
} from './codec.js';
import {
    CONTACT_RADIUS_BASE, CONTACT_RADIUS_HYSTERESIS, CONTACT_RADIUS_MAX, CONTACT_SET_MAX,
    EXTRAPOLATE_MAX_TICKS, HISTORY_TICKS, IDLE_EXIT_GHOST_TICKS, INPUT_REPEAT_TICKS,
    MATCH_POSITION, MATCH_VELOCITY, MATCH_YAW, SNAP_DISTANCE, SNAP_YAW,
    SOFT_CONTACT_FROM, SOFT_CONTACT_SCALE, SOFT_CONTACT_TO, TICK_RATE
} from './constants.js';
import { RenderOffset } from './renderOffset.js';

const HISTORY_MASK = HISTORY_TICKS - 1;
const TWO_PI = Math.PI * 2;

export interface HistoryEntry {
    tick: number;                // -1 = empty
    seq: number;
    flags: number;               // clientFlags the input went out with
    input: VehicleInput;
    hasState: boolean;
    state: VehicleState;         // predicted state AFTER this tick
}

// Who is behind a slot of the snapshots (from roomState / playerJoined)
export interface SlotInfo {
    id: string;
    classId: CarClassId;
    profile: AssistProfile;
}

export interface PredictedRemote {
    slot: number;
    id: string;
    classId: CarClassId;
    profile: AssistProfile;
    car: SimCar;
    // State before the last predicted tick, for the render interpolation
    prev: VehicleState;
    flags: number;
    // Server tick the car was last taken from a snapshot
    baseTick: number;
    // Tick the car has been predicted to
    tick: number;
    // Render offset of its predicted pose (corrections by the snapshots, 8.6)
    offset: RenderOffset;
}

export interface ReconcileResult {
    // Nothing was simulated again: the prediction matched and no car could interfere
    matched: boolean;
    // Position error at T_s before the correction (m) and the yaw error (rad)
    error: number;
    yawError: number;
    // The correction was too large to smooth; the car jumps
    snapped: boolean;
    replayedTicks: number;
    // A car of the contact set touched the own car during the replay
    contact: boolean;
    // The server repeated or stopped inputs this client sent
    lostInputs: boolean;
}

// Supplies the own car's modifiers for a tick (powerup windows, shield)
export type ModsProvider = (tick: number, mods: VehicleModifiers) => void;

function wrapAngle(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

function statesMatch(a: VehicleState, b: VehicleState): boolean {
    return Math.abs(a.x - b.x) < MATCH_POSITION && Math.abs(a.y - b.y) < MATCH_POSITION && Math.abs(a.z - b.z) < MATCH_POSITION
        && Math.abs(a.vx - b.vx) < MATCH_VELOCITY && Math.abs(a.vy - b.vy) < MATCH_VELOCITY && Math.abs(a.vz - b.vz) < MATCH_VELOCITY
        && Math.abs(wrapAngle(a.yaw - b.yaw)) < MATCH_YAW;
}

// Bit for bit, every field
export function statesEqual(a: VehicleState, b: VehicleState): boolean {
    for (const key of Object.keys(a) as (keyof VehicleState)[]) {
        if (!Object.is(a[key], b[key])) return false;
    }
    return true;
}

export class Prediction {
    car: SimCar;
    world: SimWorld;
    // Last tick the client produced (C); -1 before the clock is synced
    tick = -1;
    spawned = false;
    seq = 0;
    // Own car state after tick C - 1 (render interpolation)
    readonly prev = createVehicleState();
    readonly remotes = new Map<number, PredictedRemote>();
    modsFor: ModsProvider = (_tick, mods) => { mods.turbo = mods.mega = mods.superJump = mods.ghost = mods.shield = false; };
    // Flags of the own car in the last snapshot (idle, lag)
    selfFlags = 0;
    // Newest snapshot tick taken into account
    lastSnapshotTick = -1;
    // The next snapshot replaces the state without smoothing (resync, spawn)
    snapNext = true;
    // Ticks run with an input (not replays)
    ticksRun = 0;
    // A resumed session (11.1): the car exists on the server; the next
    // snapshot with the own car brings it in, like a spawn at T_s
    adoptNext = false;

    private readonly history: HistoryEntry[] = [];
    private readonly cars: SimCar[] = [];
    private readonly scratch = createVehicleState();
    private readonly stopScratch = createVehicleInput();
    private readonly slotInfo: (slot: number) => SlotInfo | null;
    // A remote that the contact set dropped keeps its SimCar for a while
    private readonly spareCars = new Map<string, PredictedRemote>();

    constructor(car: SimCar, world: SimWorld, slotInfo: (slot: number) => SlotInfo | null) {
        this.car = car;
        this.world = world;
        this.slotInfo = slotInfo;
        for (let i = 0; i < HISTORY_TICKS; i++) {
            this.history.push({ tick: -1, seq: 0, flags: 0, input: createVehicleInput(), hasState: false, state: createVehicleState() });
        }
    }

    /**
     * Drives another SimCar from now on (a new body or assist profile): it
     * takes over the state, so a spawned car goes on where it was.
     */
    setCar(car: SimCar): void {
        if (car === this.car) return;
        if (this.spawned) copyVehicleState(car.state, this.car.state);
        this.car = car;
    }

    entry(tick: number): HistoryEntry | null {
        const e = this.history[tick & HISTORY_MASK];
        return e.tick === tick ? e : null;
    }

    /** Starts (or restarts) the tick count at C = tick, e.g. after the clock sync or a resync. */
    startAt(tick: number): void {
        for (const e of this.history) { e.tick = -1; e.hasState = false; }
        this.tick = tick - 1;
        this.snapNext = true;
        for (const remote of this.remotes.values()) remote.tick = Math.min(remote.tick, this.tick);
    }

    /**
     * Skips ahead: the next tick is `tick` (the ticks in between get no
     * input; the server repeats and stops like for a lost packet).
     */
    jumpTo(tick: number): void {
        if (tick <= this.tick + 1) return;
        this.tick = tick - 1;
    }

    /**
     * One client tick C + 1 with this input: stored for the packet and, once
     * the car exists, simulated with the contact set. flags are the packet's
     * clientFlags (FROZEN / HIDDEN act as the idle ghost on the server).
     */
    advance(input: VehicleInput, flags: number): HistoryEntry {
        const t = ++this.tick;
        const e = this.history[t & HISTORY_MASK];
        e.tick = t;
        e.seq = ++this.seq;
        e.flags = flags;
        copyInput(e.input, input);
        e.hasState = false;
        if (!this.spawned) return e;
        copyVehicleState(this.prev, this.car.state);
        this.stepOnce(t, e);
        copyVehicleState(e.state, this.car.state);
        e.hasState = true;
        this.ticksRun++;
        return e;
    }

    // One tick of the own car and the contact set
    private stepOnce(t: number, e: HistoryEntry): void {
        const car = this.car;
        copyInput(car.input, e.input);
        this.modsFor(t, car.mods);
        const idle = (e.flags & (INPUT_FROZEN | INPUT_HIDDEN)) !== 0 || (this.selfFlags & (CAR_IDLE | CAR_LAGGY)) !== 0;
        if (idle) applyContactGhostFloor(car);
        else {
            // The server ends the idle ghost with a longer ghost (5.4)
            const before = this.entry(t - 1);
            if (before && (before.flags & (INPUT_FROZEN | INPUT_HIDDEN)) !== 0 && car.state.ghostTicks < IDLE_EXIT_GHOST_TICKS) {
                car.state.ghostTicks = IDLE_EXIT_GHOST_TICKS;
            }
        }
        const cars = this.cars;
        cars.length = 0;
        cars.push(car);
        for (const remote of this.remotes.values()) {
            if (remote.tick !== t - 1) continue;
            this.prepareRemote(remote, t);
            cars.push(remote.car);
        }
        stepWorld(cars, this.world);
        for (const remote of this.remotes.values()) {
            if (remote.tick === t - 1) remote.tick = t;
        }
    }

    // Input repeat up to EXTRAPOLATE_MAX_TICKS past the snapshot, then
    // constant speed; soft contact when predicted far ahead (8.5)
    private prepareRemote(remote: PredictedRemote, t: number): void {
        copyVehicleState(remote.prev, remote.car.state);
        const ahead = t - remote.baseTick;
        remote.car.kinematic = ahead > EXTRAPOLATE_MAX_TICKS;
        remote.car.contactScale = ahead <= SOFT_CONTACT_FROM ? 1
            : ahead >= SOFT_CONTACT_TO ? SOFT_CONTACT_SCALE
                : 1 - (1 - SOFT_CONTACT_SCALE) * (ahead - SOFT_CONTACT_FROM) / (SOFT_CONTACT_TO - SOFT_CONTACT_FROM);
        if ((remote.flags & (CAR_IDLE | CAR_LAGGY)) !== 0) applyContactGhostFloor(remote.car);
    }

    /** The car appears at (x, z) at the end of tick t0 (spawn or respawn event). */
    spawnAt(t0: number, x: number, z: number, yaw: number): void {
        this.spawned = true;
        spawnVehicle(this.car.state, this.world, x, z, yaw);
        if (this.tick < 0) {
            // C has not started yet (clock sync): the car just waits there
            copyVehicleState(this.prev, this.car.state);
            return;
        }
        if (t0 >= this.tick) {
            // The client is not ahead of the server (not synced yet)
            copyVehicleState(this.prev, this.car.state);
            this.tick = Math.max(this.tick, t0);
            const e = this.history[t0 & HISTORY_MASK];
            if (e.tick !== t0) { e.tick = t0; e.seq = this.seq; e.flags = 0; copyInput(e.input, createVehicleInput()); }
            copyVehicleState(e.state, this.car.state);
            e.hasState = true;
            return;
        }
        const e0 = this.entry(t0);
        if (e0) { copyVehicleState(e0.state, this.car.state); e0.hasState = true; }
        this.replay(t0);
    }

    despawn(): void {
        this.spawned = false;
        for (const e of this.history) e.hasState = false;
    }

    /** The own car in the snapshot, or its absence, and the contact set around it. */
    reconcile(snap: Snapshot): ReconcileResult | null {
        const Ts = snap.serverTick;
        if (Ts <= this.lastSnapshotTick) return null;
        this.lastSnapshotTick = Ts;
        const self = snap.self;
        if (self && !this.spawned && this.adoptNext) {
            this.adoptNext = false;
            this.spawned = true;
            this.snapNext = true;
        }
        if (!self || !this.spawned) {
            this.updateContactSet(snap, null);
            return null;
        }
        this.selfFlags = self.flags;
        if (this.tick < 0) {
            // C has not started yet: show the server state, predict nothing
            copyVehicleState(this.car.state, self.state);
            copyVehicleState(this.prev, self.state);
            return null;
        }
        const result: ReconcileResult = {
            matched: false, error: 0, yawError: 0, snapped: false, replayedTicks: 0, contact: false, lostInputs: false
        };
        const e = this.entry(Ts);
        if (e && snap.lastProcessedSeq >= 0 && snap.lastProcessedSeq < e.seq) result.lostInputs = true;

        if (Ts > this.tick || !e || !e.hasState) {
            // Nothing predicted for T_s (the client runs behind the server,
            // just started or respawned): take the server state as it is
            const car = this.car.state;
            result.error = Math.hypot(car.x - self.state.x, car.y - self.state.y, car.z - self.state.z);
            result.yawError = Math.abs(wrapAngle(car.yaw - self.state.yaw));
            copyVehicleState(this.car.state, self.state);
            copyVehicleState(this.prev, self.state);
            if (Ts > this.tick) this.tick = Ts;
            const at = this.history[Ts & HISTORY_MASK];
            if (at.tick !== Ts) { at.tick = Ts; at.seq = this.seq; at.flags = 0; copyInput(at.input, self.input); }
            copyVehicleState(at.state, self.state);
            at.hasState = true;
            this.updateContactSet(snap, self.state);
            if (Ts < this.tick) result.contact = this.replay(Ts);
            result.replayedTicks = this.tick - Ts;
            result.snapped = this.snapNext || result.error >= SNAP_DISTANCE || result.yawError >= SNAP_YAW;
            this.snapNext = false;
            return result;
        }

        result.error = Math.hypot(e.state.x - self.state.x, e.state.y - self.state.y, e.state.z - self.state.z);
        result.yawError = Math.abs(wrapAngle(e.state.yaw - self.state.yaw));
        const exact = statesEqual(e.state, self.state);
        const close = exact || statesMatch(e.state, self.state);
        this.updateContactSet(snap, self.state);
        // Remote cars in the contact set always replay: they restart from
        // this snapshot and have to be brought up to C again
        if (close && this.remotes.size === 0 && !this.snapNext) {
            result.matched = true;
            return result;
        }
        copyVehicleState(e.state, self.state);
        result.snapped = this.snapNext || result.error >= SNAP_DISTANCE || result.yawError >= SNAP_YAW;
        this.snapNext = false;
        const contact = this.replay(Ts);
        result.replayedTicks = this.tick - Ts;
        result.contact = contact;
        return result;
    }

    // Simulates again from the state stored for tick `from` up to C. Returns
    // whether a car of the contact set touched the own car on the way.
    private replay(from: number): boolean {
        const start = this.entry(from);
        if (!start || !start.hasState) return false;
        copyVehicleState(this.car.state, start.state);
        copyVehicleState(this.prev, start.state);
        let contact = false;
        let lastInput: VehicleInput | null = start.input;
        for (let t = from + 1; t <= this.tick; t++) {
            let e = this.history[t & HISTORY_MASK];
            if (e.tick !== t) {
                // No input for this tick (after a resync): repeat like the server
                const repeatFor = t - from;
                const fill = e;
                fill.tick = t;
                fill.seq = this.seq;
                fill.flags = 0;
                if (lastInput && repeatFor <= INPUT_REPEAT_TICKS) copyInput(fill.input, lastInput);
                else copyInput(fill.input, stopInput(this.car.state, this.stopScratch));
                e = fill;
            }
            copyVehicleState(this.prev, this.car.state);
            this.stepOnce(t, e);
            if (this.car.events.carImpactId !== '') contact = true;
            copyVehicleState(e.state, this.car.state);
            e.hasState = true;
            lastInput = e.input;
        }
        return contact;
    }

    // ---- Contact set (8.5) ----

    private updateContactSet(snap: Snapshot, own: VehicleState | null): void {
        const Ts = snap.serverTick;
        const leadS = Math.max(0, this.tick - Ts) / TICK_RATE;
        const candidates: { car: CompactCar; d: number; info: SlotInfo }[] = [];
        if (own) {
            for (const record of snap.cars) {
                const info = this.slotInfo(record.slot);
                if (!info) continue;
                const d = Math.hypot(record.x - own.x, record.z - own.z);
                const vRel = Math.hypot(record.vx - own.vx, record.vz - own.vz);
                let radius = Math.min(CONTACT_RADIUS_MAX, CONTACT_RADIUS_BASE + vRel * leadS);
                const current = this.remotes.get(record.slot);
                if (current && current.id === info.id) radius += CONTACT_RADIUS_HYSTERESIS;
                if (d < radius) candidates.push({ car: record, d, info });
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        if (candidates.length > CONTACT_SET_MAX) candidates.length = CONTACT_SET_MAX;
        const keep = new Set(candidates.map(c => c.car.slot));
        for (const [slot, remote] of this.remotes) {
            if (!keep.has(slot)) {
                this.spareCars.set(remote.id, remote);
                this.remotes.delete(slot);
            }
        }
        for (const { car: record, info } of candidates) {
            let remote = this.remotes.get(record.slot);
            if (remote && (remote.id !== info.id || remote.classId !== info.classId || remote.profile !== info.profile)) {
                this.remotes.delete(record.slot);
                remote = undefined;
            }
            if (!remote) {
                const spare = this.spareCars.get(info.id);
                this.spareCars.delete(info.id);
                remote = spare && spare.classId === info.classId && spare.profile === info.profile
                    ? spare
                    : {
                        slot: record.slot, id: info.id, classId: info.classId, profile: info.profile,
                        car: createSimCar(info.id, info.classId, info.profile),
                        prev: createVehicleState(), flags: 0, baseTick: Ts, tick: Ts, offset: new RenderOffset()
                    };
                // Entering the set blends in (client): no offset from an old stay
                remote.offset.clear();
                remote.slot = record.slot;
                this.remotes.set(record.slot, remote);
            }
            decodeRemoteState(record, remote.car.state);
            copyVehicleState(remote.prev, remote.car.state);
            copyInput(remote.car.input, record.input);
            flagsToMods(record.flags, remote.car.mods);
            remote.flags = record.flags;
            remote.baseTick = Ts;
            remote.tick = Ts;
        }
        if (this.spareCars.size > 32) this.spareCars.clear();
    }

    /** How far the snapshot state lies behind the last predicted tick. */
    get lead(): number {
        return this.lastSnapshotTick < 0 ? 0 : this.tick - this.lastSnapshotTick;
    }

    /** Copies the predicted state after tick t into out; false when unknown. */
    stateAt(tick: number, out: VehicleState): boolean {
        const e = this.entry(tick);
        if (!e || !e.hasState) return false;
        copyVehicleState(out, e.state);
        return true;
    }

    // Scratch state for callers that need one without allocating
    get scratchState(): VehicleState {
        return this.scratch;
    }
}
