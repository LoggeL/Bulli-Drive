import type {
    ClientMessage,
    GameEvent,
    LeaveReason,
    MemberInfo,
    ProfileId,
    RaceStateBody,
    RoomInfo,
    RoomKind,
    ResumeState,
    RoomStateItems,
    ScoreboardEntry,
    ServerMessage
} from '../../shared/protocol.js';
import {
    CAR_GHOST, CAR_IDLE, CAR_LAGGY, CAR_MEGA, CAR_SHIELD, CAR_SUPER_JUMP, CAR_TURBO,
    COMPACT_BYTES, INPUT_FROZEN, INPUT_HIDDEN, SELF_BLOCK_BYTES, SNAPSHOT_HEADER_BYTES,
    modsToBits, stateFlags, writeCompactCar, writeSelfBlock, writeSnapshotHeader,
    type InputPacket
} from '../../shared/net/codec.js';
import {
    CONTACT_EVENT_MIN_DV, CONTACT_EVENT_PAIR_TICKS, CONTACT_EVENT_RANGE, IDLE_AFTER_TICKS, IDLE_EXIT_GHOST_TICKS,
    IDLE_KICK_MS, INPUT_REPEAT_TICKS, LAGGY_MISS_RATE, LAGGY_RECOVER_TICKS, LAGGY_RTT_MS,
    LAGGY_WINDOW_TICKS, SNAPSHOT_EVERY, TICK_MS
} from '../../shared/net/constants.js';
import { applyContactGhostFloor, copyInput, stopInput } from '../../shared/sim/inputs.js';
import { createVehicleInput, type CarClassId, type SimCar, type VehicleInput } from '../../shared/sim/types.js';
import { createSimCar, placeVehicle, spawnVehicle } from '../../shared/sim/vehicle.js';
import { createVehicleParams, isCarClassId } from '../../shared/sim/vehicleClasses.js';
import { stepWorld } from '../../shared/sim/world.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import type { MapData } from '../../shared/world/mapData.js';
import { CAR_CHANGE_INTERVAL_MS, HONK_INTERVAL_MS } from '../config.js';
import type { Session } from '../session.js';
import { InputBuffer } from './InputBuffer.js';
import { randomSpawnPose, type SpawnKeepOut, type SpawnPoint, type SpawnPose } from './spawn.js';

// A room instance (docs/phase-1b-design.md, 2 and 5): its members, their
// cars and everything that changes while they play. The map (MapData) is
// shared by all rooms and never mutated. The room simulates at 60 Hz
// (step, driven by server/tick.ts): inputs in, stepWorld over all cars,
// rules, events, and every SNAPSHOT_EVERY ticks a binary snapshot per member.

export type { LeaveReason };

// Slots are u8 (the snapshots address cars by slot) and are only handed out
// again after a delay, so a late snapshot never shows a new player in the
// place of the one who left.
export const SLOT_COUNT = 256;
export const SLOT_REUSE_DELAY_MS = 5000;

/**
 * A server-side driver (docs/phase-2-design.md, 6.3): a race bot writes the
 * input of its car for tick T instead of the input buffer.
 */
export interface BotController {
    drive(member: RoomMember, car: SimCar, tick: number, out: VehicleInput): void;
}

export interface RoomMember {
    readonly id: string;
    readonly session: Session;
    readonly slot: number;
    // A server-side bot (no socket, no input buffer), null for a player
    readonly bot: BotController | null;
    // The room held the contact ghost last tick (forceGhost, 5.4 / phase 2, 11)
    forcedGhost: boolean;
    // Past the splash screen: drives, visible to the others, on the scoreboard
    ready: boolean;
    // The car in the sim; null before the first spawn
    car: SimCar | null;
    // In the sim (false while dead)
    alive: boolean;
    readonly inputs: InputBuffer;
    // Last input received (repeated while inputs are missing)
    readonly lastInput: VehicleInput;
    // Ticks in a row without an input, and since the last input at all
    missing: number;
    ticksWithoutInput: number;
    lastProcessedSeq: number;
    // clientFlags of the last input used (FROZEN, HIDDEN)
    clientFlags: number;
    // The tab said it is in the background ('visibility')
    hidden: boolean;
    idle: boolean;
    idleSinceMs: number;
    laggy: boolean;
    lagGoodTicks: number;
    readonly missRing: Uint8Array;
    missCount: number;
    // An input arrived since the car spawned: from then on missing inputs
    // count towards the lag ghost (before, the client is still starting up)
    playing: boolean;
    // After idle: keeps the contact ghost while overlapping another car
    ghostHold: boolean;
    pendingSpawn: boolean;
    pendingPlace: SpawnPose | null;
    carDirty: boolean;
    // A setCar is waiting to be shown to the room: car changes reach the
    // others at most once per CAR_CHANGE_INTERVAL_MS, the latest one wins
    carPending: boolean;
    carShownAtMs: number;
    shownCar: CarClassId;
    shownProfile: ProfileId;
    // Tick the car last spawned or respawned, -1 = never
    spawnTick: number;
}

// Messages about the session itself (name, car, room, clock) are handled
// before they reach a room (server/dispatch.ts)
export type RoomMessage = Exclude<ClientMessage, { type: 'hello' | 'rename' | 'setCar' | 'joinRoom' | 'ping' }>;

interface QueuedEvent {
    event: GameEvent;
    // Only members within CONTACT_EVENT_RANGE of this point
    near?: { x: number; z: number };
    exclude?: string;
}

// Room-wide options (server/index.ts sets them from the environment)
export const roomOptions = {
    // debugPlace is accepted only in the e2e server (E2E=1)
    allowDebugPlace: false
};

function carClass(session: Session): CarClassId {
    return isCarClassId(session.carType) ? session.carType : 'bulli';
}

export abstract class Room {
    readonly id: string;
    // Last simulated tick; counts only while the room has members
    tick = 0;
    readonly members = new Map<string, RoomMember>();
    snapshotEvery = SNAPSHOT_EVERY;
    // Since when the room has no members (ms), 0 while it has some
    emptySinceMs: number;
    // Clock time of the last step (ms), for the pong's tick fraction
    lastStepAtMs = -1;
    // Bytes of snapshots and events sent, for metrics
    bytesOut = 0;
    private readonly slotFreedAt = new Map<number, number>();
    private sorted: RoomMember[] = [];
    private readonly cars: SimCar[] = [];
    private readonly queued: QueuedEvent[] = [];
    private scoreboardDirty = false;
    private readonly pairContactTick = new Map<string, number>();
    private compact = new Uint8Array(COMPACT_BYTES * 32);
    private readonly compactAt = new Map<RoomMember, number>();

    constructor(
        readonly kind: RoomKind,
        readonly index: number,
        readonly map: MapData,
        protected readonly now: () => number = Date.now
    ) {
        this.id = `${kind}-${index}`;
        this.emptySinceMs = now();
    }

    get info(): RoomInfo {
        return { id: this.id, kind: this.kind, index: this.index };
    }

    /**
     * The players in the room. Bots do not count (phase 2, 6.3): instance
     * choice, ticking, closing and the metrics go by players only.
     */
    get size(): number {
        return this.humanCount;
    }

    get humanCount(): number {
        let count = 0;
        for (const m of this.sorted) if (!m.bot) count++;
        return count;
    }

    /** Members in id order: the order of every rule, like stepWorld's. */
    get orderedMembers(): readonly RoomMember[] {
        return this.sorted;
    }

    // ---- Membership ----

    /**
     * Adds the session and sends it the room state. ready = true (a room
     * switch after the splash screen) spawns the car at the next tick.
     */
    join(session: Session, options: { ready?: boolean; bot?: BotController } = {}): RoomMember {
        const member: RoomMember = {
            id: session.id,
            session,
            slot: this.allocateSlot(),
            bot: options.bot ?? null,
            forcedGhost: false,
            ready: false,
            car: null,
            alive: false,
            inputs: new InputBuffer(),
            lastInput: createVehicleInput(),
            missing: 0,
            ticksWithoutInput: 0,
            lastProcessedSeq: -1,
            clientFlags: 0,
            hidden: false,
            idle: false,
            idleSinceMs: 0,
            laggy: false,
            lagGoodTicks: 0,
            missRing: new Uint8Array(LAGGY_WINDOW_TICKS),
            missCount: 0,
            playing: false,
            ghostHold: false,
            pendingSpawn: false,
            pendingPlace: null,
            carDirty: false,
            carPending: false,
            carShownAtMs: -Infinity,
            shownCar: carClass(session),
            shownProfile: session.profile,
            spawnTick: -1
        };
        // Inputs for ticks the room already ran are late
        member.inputs.lastStepped = this.tick;
        this.members.set(member.id, member);
        this.sorted = [...this.members.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        session.room = this;
        session.member = member;
        if (!member.bot) this.emptySinceMs = 0;
        this.onJoin(member);
        // A switch after the splash screen: ready at once, so the room state
        // lists the player (scoreboard) and the car spawns at the next tick
        if (options.ready) {
            member.ready = true;
            member.pendingSpawn = true;
        }
        session.send(this.roomStateFor(member));
        if (options.ready) this.announce(member);
        return member;
    }

    leave(member: RoomMember, reason: LeaveReason): void {
        if (this.members.get(member.id) !== member) return;
        this.members.delete(member.id);
        this.sorted = this.sorted.filter(m => m !== member);
        this.slotFreedAt.set(member.slot, this.now());
        this.onLeave(member, reason);
        if (member.session.member === member) {
            member.session.room = null;
            member.session.member = null;
        }
        if (member.ready) {
            this.broadcast({ type: 'playerLeft', id: member.id, reason });
            this.markScoreboardDirty();
        }
        for (const key of [...this.pairContactTick.keys()]) {
            if (key.includes(member.id)) this.pairContactTick.delete(key);
        }
        if (this.humanCount === 0 && this.emptySinceMs === 0) this.emptySinceMs = this.now();
    }

    // Lowest slot that is neither taken nor freed less than SLOT_REUSE_DELAY_MS ago
    private allocateSlot(): number {
        const taken = new Set([...this.members.values()].map(m => m.slot));
        const now = this.now();
        let fallback = -1;
        for (let slot = 0; slot < SLOT_COUNT; slot++) {
            if (taken.has(slot)) continue;
            const freedAt = this.slotFreedAt.get(slot);
            if (freedAt === undefined || now - freedAt >= SLOT_REUSE_DELAY_MS) return slot;
            if (fallback < 0) fallback = slot;
        }
        if (fallback < 0) throw new Error(`room ${this.id} has no free slot`);
        return fallback;
    }

    memberInfo(member: RoomMember): MemberInfo {
        const session = member.session;
        return {
            id: member.id,
            slot: member.slot,
            name: session.name,
            color: session.color,
            carType: carClass(session),
            profile: session.profile,
            ready: member.ready,
            ...(member.bot ? { bot: true } : {})
        };
    }

    /**
     * The session came back on a new socket within the grace time (11.1):
     * the member, its car and its party state stay; the client gets the
     * room state again with its own car's state to take over.
     */
    resume(member: RoomMember): void {
        if (this.members.get(member.id) !== member) return;
        // The new page counts its inputs from the start again
        member.lastProcessedSeq = -1;
        member.inputs.clear();
        member.inputs.takeWindow();
        member.session.send(this.roomStateFor(member, true));
        // Its own score and rank come with the next scoreboard
        this.markScoreboardDirty();
    }

    resumeState(member: RoomMember): ResumeState {
        return { alive: !!member.car && member.alive, spawnTick: member.spawnTick, powerups: this.powerupWindows(member) };
    }

    roomStateFor(member: RoomMember, resume = false): ServerMessage {
        const members = this.sorted.map(m => this.memberInfo(m));
        const health: Record<string, number> = {};
        for (const m of this.sorted) health[m.id] = this.healthOf(m);
        const preview = randomSpawnPose(this.map.world.city, this.carPositions(), this.spawnKeepOut());
        return {
            type: 'roomState',
            room: this.info,
            tick: this.tick,
            world: { seed: this.map.seed, mapVersion: this.map.mapVersion, worldHash: this.map.worldHash },
            members,
            items: this.roomStateItems(),
            scoreboard: this.scoreboard(),
            health,
            preview,
            ...(resume ? { resume: this.resumeState(member) } : {}),
            ...this.raceField()
        };
    }

    private raceField(): { race?: RaceStateBody } {
        const race = this.raceState();
        return race ? { race } : {};
    }

    // Past the splash screen: the others see the player, the car spawns
    markReady(member: RoomMember): void {
        if (member.ready) return;
        member.ready = true;
        member.pendingSpawn = true;
        this.announce(member);
    }

    private announce(member: RoomMember): void {
        this.broadcast({ type: 'playerJoined', member: this.memberInfo(member) }, member.id);
        this.markScoreboardDirty();
    }

    // ---- Messages ----

    onInput(member: RoomMember, packet: InputPacket, nowMs: number): void {
        member.inputs.accept(packet, this.tick, nowMs);
        // A packet from a visible tab ends the 'visibility' hidden state
        if ((packet.flags & INPUT_HIDDEN) === 0) member.hidden = false;
    }

    onMessage(member: RoomMember, msg: RoomMessage): void {
        switch (msg.type) {
            case 'ready': return this.markReady(member);
            case 'honk': return this.handleHonk(member);
            case 'visibility':
                member.hidden = msg.hidden;
                return;
            case 'debugPlace':
                // Kept until the car exists (a test may place it right after ready)
                if (roomOptions.allowDebugPlace) member.pendingPlace = { x: msg.x, z: msg.z, yaw: msg.yaw };
                return;
            default: return this.onGameMessage(member, msg);
        }
    }

    // The session was renamed or changed its car (server/dispatch.ts). A
    // rename has its own rate limit and goes out at once; a car change is
    // shown at the next tick, and to the room at most once per
    // CAR_CHANGE_INTERVAL_MS (every change rebuilds the car on every
    // client), so a client toggling its car cannot flood the room.
    onSessionChanged(member: RoomMember, change: { name?: boolean; car?: boolean }): void {
        if (change.car) member.carPending = true;
        if (!change.name || !member.ready) return;
        this.broadcast({ type: 'playerUpdated', id: member.id, name: member.session.name });
        this.markScoreboardDirty();
    }

    private showCarChanges(nowMs: number): void {
        for (const m of this.sorted) {
            if (!m.carPending || nowMs - m.carShownAtMs < CAR_CHANGE_INTERVAL_MS || !this.carChangeAllowed(m)) continue;
            m.carPending = false;
            const carType = carClass(m.session), profile = m.session.profile;
            if (carType === m.shownCar && profile === m.shownProfile) continue;
            m.shownCar = carType;
            m.shownProfile = profile;
            m.carShownAtMs = nowMs;
            m.carDirty = true;
            if (m.ready) this.broadcast({ type: 'playerUpdated', id: m.id, carType, profile });
        }
    }

    private handleHonk(member: RoomMember): void {
        if (!member.ready) return;
        const now = this.now();
        const session = member.session;
        if (now - session.lastHonkAt < HONK_INTERVAL_MS) return;
        session.lastHonkAt = now;
        this.emit({ type: 'honk', id: member.id }, { exclude: member.id });
    }

    // ---- The tick (5.3) ----

    step(nowMs: number = this.now()): void {
        const T = ++this.tick;
        this.lastStepAtMs = nowMs;
        this.beginTick(T);
        for (const m of this.sorted) this.takeInput(m, T);
        this.beforeStep(T);
        for (const m of this.sorted) {
            if (m.car && m.alive) this.applyIdleRules(m, T, nowMs);
        }
        const cars = this.cars;
        cars.length = 0;
        for (const m of this.sorted) if (m.car && m.alive) cars.push(m.car);
        if (cars.length > 0) stepWorld(cars, this.world);
        this.contactEvents(T);
        this.afterStep(T);
        this.showCarChanges(nowMs);
        this.spawnAndPlace(T);
        if (T % this.snapshotEvery === 0) {
            this.flushEvents(T);
            this.sendSnapshots(T);
        }
    }

    private takeInput(m: RoomMember, T: number): void {
        const car = m.car;
        if (m.bot) {
            // A bot drives from the server: no buffer, never idle or laggy
            m.missing = m.ticksWithoutInput = 0;
            if (!car || !m.alive) return;
            m.playing = true;
            m.bot.drive(m, car, T, car.input);
            this.filterInput(m, car.input, T);
            return;
        }
        const entry = m.inputs.take(T);
        if (entry) {
            copyInput(m.lastInput, entry.input);
            m.missing = 0;
            m.ticksWithoutInput = 0;
            m.lastProcessedSeq = entry.seq;
            m.clientFlags = entry.flags;
        } else {
            m.missing++;
            m.ticksWithoutInput++;
        }
        if (!car || !m.alive) return;
        if (entry) m.playing = true;
        const missed = entry ? 0 : 1;
        if (!m.idle && m.playing) {
            // Miss rate for the lag ghost (only while the player plays)
            const at = T % LAGGY_WINDOW_TICKS;
            m.missCount += missed - m.missRing[at];
            m.missRing[at] = missed;
        }
        if (entry) copyInput(car.input, entry.input);
        else {
            m.inputs.missed++;
            if (m.missing <= INPUT_REPEAT_TICKS) copyInput(car.input, m.lastInput);
            else stopInput(car.state, car.input);
        }
        // A frozen or hidden client is an idle ghost (5.4) and stops: the
        // server holds it to that instead of trusting the inputs it sends
        if (m.hidden || (m.clientFlags & (INPUT_FROZEN | INPUT_HIDDEN)) !== 0) stopInput(car.state, car.input);
        this.filterInput(m, car.input, T);
    }

    // Idle, background, frozen and lag ghost (5.4)
    private applyIdleRules(m: RoomMember, T: number, nowMs: number): void {
        const car = m.car!;
        // A lost connection makes the car an idle ghost until the player is
        // back or the grace time ends (11.1)
        const idleNow = m.hidden || !m.session.connected || (m.clientFlags & (INPUT_FROZEN | INPUT_HIDDEN)) !== 0
            || m.ticksWithoutInput >= IDLE_AFTER_TICKS;
        if (idleNow && !m.idle) {
            m.idle = true;
            m.idleSinceMs = nowMs;
        } else if (!idleNow && m.idle) {
            m.idle = false;
            if (car.state.ghostTicks < IDLE_EXIT_GHOST_TICKS) car.state.ghostTicks = IDLE_EXIT_GHOST_TICKS;
            m.ghostHold = true;
        }
        const rtt = m.session.rttMs;
        const lagNow = (rtt > LAGGY_RTT_MS) || m.missCount > LAGGY_MISS_RATE * LAGGY_WINDOW_TICKS;
        if (lagNow) {
            m.laggy = true;
            m.lagGoodTicks = 0;
        } else if (m.laggy && ++m.lagGoodTicks >= LAGGY_RECOVER_TICKS) {
            m.laggy = false;
            m.ghostHold = true;
        }
        const forced = this.forceGhost(m, T);
        if (m.forcedGhost && !forced) m.ghostHold = true;
        m.forcedGhost = forced;
        if (m.idle || m.laggy || forced) {
            applyContactGhostFloor(car);
        } else if (m.ghostHold) {
            // No car is thrown out of an overlap when the ghost ends
            if (this.overlapsOtherCar(m)) {
                if (car.state.ghostTicks < 1) car.state.ghostTicks = 1;
            } else if (car.state.ghostTicks === 0) {
                m.ghostHold = false;
            }
        }
        if (m.idle && T % 60 === 0 && nowMs - m.idleSinceMs > IDLE_KICK_MS) this.kickIdle(m);
    }

    private overlapsOtherCar(m: RoomMember): boolean {
        const a = m.car!;
        const ra = a.params.colliderOffset + a.params.colliderRadius;
        for (const other of this.sorted) {
            const b = other.car;
            if (other === m || !b || !other.alive) continue;
            const reach = ra + b.params.colliderOffset + b.params.colliderRadius;
            const dx = a.state.x - b.state.x, dz = a.state.z - b.state.z;
            if (dx * dx + dz * dz < reach * reach) return true;
        }
        return false;
    }

    // Idle kick hook; server/index.ts closes the socket
    onIdleKick: (member: RoomMember) => void = () => { /* set by the server */ };

    private kickIdle(m: RoomMember): void {
        this.onIdleKick(m);
    }

    // Contact events for sound and sparks (3.6), once per pair every few ticks
    private contactEvents(T: number): void {
        for (const m of this.sorted) {
            const car = m.car;
            if (!car || !m.alive) continue;
            const ev = car.events;
            if (ev.carImpact < CONTACT_EVENT_MIN_DV || ev.carImpactId === '') continue;
            const a = m.id < ev.carImpactId ? m.id : ev.carImpactId;
            const b = m.id < ev.carImpactId ? ev.carImpactId : m.id;
            const key = `${a}|${b}`;
            const last = this.pairContactTick.get(key);
            if (last !== undefined && T - last < CONTACT_EVENT_PAIR_TICKS) continue;
            this.pairContactTick.set(key, T);
            this.emit(
                { type: 'contact', a, b, dv: Math.round(ev.carImpact * 100) / 100, x: car.state.x, z: car.state.z },
                { near: { x: car.state.x, z: car.state.z } }
            );
        }
        if (T % 600 === 0) {
            for (const [key, last] of this.pairContactTick) if (T - last > CONTACT_EVENT_PAIR_TICKS) this.pairContactTick.delete(key);
        }
    }

    // New cars, car changes and e2e placements take effect at the end of
    // tick T: the state after T is where the car starts
    private spawnAndPlace(T: number): void {
        for (const m of this.sorted) {
            if (m.carDirty && m.car) {
                m.carDirty = false;
                const params = createVehicleParams(carClass(m.session), m.session.profile);
                Object.assign(m.car.base, params);
                this.emit({ type: 'carChanged', id: m.id, carType: carClass(m.session), profile: m.session.profile, tick: T });
            }
            if (m.pendingSpawn && m.ready) {
                m.pendingSpawn = false;
                const pose = this.spawnPose(m);
                if (pose) this.spawnCar(m, pose, T, pose.grid);
            }
            if (m.pendingPlace && m.car) {
                const place = m.pendingPlace;
                m.pendingPlace = null;
                placeVehicle(m.car.state, this.world, place.x, place.z, place.yaw);
                m.car.state.flipAngle = 0;
                this.onPlaced(m, T);
            }
        }
    }

    /**
     * The car (a new one, in the member's current class) appears at pose at
     * the end of tick T, fresh and at rest; grid: the race's grid slot.
     */
    protected spawnCar(m: RoomMember, pose: SpawnPose, T: number, grid?: number): void {
        m.carDirty = false;
        const carType = carClass(m.session), profile = m.session.profile;
        m.carPending = false;
        if (carType !== m.shownCar || profile !== m.shownProfile) {
            // The others learn the class before the car shows up in it
            m.shownCar = carType;
            m.shownProfile = profile;
            if (m.ready) this.broadcast({ type: 'playerUpdated', id: m.id, carType, profile });
        }
        m.car = createSimCar(m.id, carType, profile);
        spawnVehicle(m.car.state, this.world, pose.x, pose.z, pose.yaw);
        m.alive = true;
        m.idle = false;
        m.laggy = false;
        m.ghostHold = false;
        m.forcedGhost = false;
        m.missRing.fill(0);
        m.missCount = 0;
        m.playing = false;
        m.ticksWithoutInput = 0;
        m.spawnTick = T;
        this.onSpawned(m, T);
        this.emit({ type: 'spawn', id: m.id, tick: T, x: pose.x, z: pose.z, yaw: pose.yaw, ...(grid !== undefined ? { grid } : {}) });
    }

    /** The car leaves the sim at the end of tick T (a race: the player watches). */
    protected despawnCar(m: RoomMember, T: number): void {
        if (!m.car) return;
        m.car = null;
        m.alive = false;
        m.pendingPlace = null;
        this.emit({ type: 'despawn', id: m.id, tick: T });
    }

    /** Where no car spawns besides the static obstacles (the Party's pickups). */
    protected spawnKeepOut(): readonly SpawnKeepOut[] {
        return [];
    }

    /** Positions of the cars in the sim (spawn spacing), without one member. */
    carPositions(except?: RoomMember): SpawnPoint[] {
        const points: SpawnPoint[] = [];
        for (const m of this.sorted) {
            if (m !== except && m.car && m.alive) points.push({ x: m.car.state.x, z: m.car.state.z });
        }
        return points;
    }

    // ---- Events and snapshots ----

    emit(event: GameEvent, options: { near?: { x: number; z: number }; exclude?: string } = {}): void {
        this.queued.push({ event, ...options });
    }

    markScoreboardDirty(): void {
        this.scoreboardDirty = true;
    }

    /** Sends the queued events now instead of with the next snapshot (before a message that must follow them). */
    protected flushEventsNow(): void {
        this.flushEvents(this.tick);
    }

    // All events of the ticks since the last snapshot, before the snapshot
    private flushEvents(T: number): void {
        if (this.scoreboardDirty) {
            this.scoreboardDirty = false;
            const board = this.scoreboard();
            if (board.length > 0 || this.kind === 'party') this.sendScoreboard(board);
        }
        if (this.queued.length === 0) return;
        const simple = this.queued.every(q => !q.near && !q.exclude);
        if (simple) {
            this.broadcast({ type: 'events', tick: T, list: this.queued.map(q => q.event) });
        } else {
            const range2 = CONTACT_EVENT_RANGE * CONTACT_EVENT_RANGE;
            for (const m of this.sorted) {
                if (m.bot) continue;
                const own = m.car && m.alive ? m.car.state : null;
                const list = this.queued.filter(q => {
                    if (q.exclude === m.id) return false;
                    if (!q.near) return true;
                    if (!own) return false;
                    const dx = own.x - q.near.x, dz = own.z - q.near.z;
                    return dx * dx + dz * dz <= range2;
                }).map(q => q.event);
                if (list.length > 0) this.sendTo(m, { type: 'events', tick: T, list });
            }
        }
        this.queued.length = 0;
    }

    /** The car flags others see (3.4); PartyRoom adds its shields. */
    protected carFlags(m: RoomMember): number {
        const car = m.car!;
        const mods = car.mods;
        return stateFlags(car.state)
            | (mods.turbo ? CAR_TURBO : 0) | (mods.mega ? CAR_MEGA : 0) | (mods.superJump ? CAR_SUPER_JUMP : 0)
            | (mods.ghost ? CAR_GHOST : 0) | (mods.shield ? CAR_SHIELD : 0)
            | (m.idle ? CAR_IDLE : 0) | (m.laggy ? CAR_LAGGY : 0);
    }

    private sendSnapshots(T: number): void {
        // The compact part once for the room
        let count = 0;
        this.compactAt.clear();
        for (const m of this.sorted) if (m.car && m.alive && m.ready) count++;
        if (this.compact.byteLength < count * COMPACT_BYTES) this.compact = new Uint8Array(count * COMPACT_BYTES * 2);
        const compactView = new DataView(this.compact.buffer);
        let at = 0;
        for (const m of this.sorted) {
            if (!m.car || !m.alive || !m.ready) continue;
            this.compactAt.set(m, at);
            at = writeCompactCar(compactView, at, m.slot, this.carFlags(m), m.car.state, m.car.input);
        }
        const compactBytes = at;
        for (const m of this.sorted) {
            if (m.bot) continue;
            const own = this.compactAt.get(m);
            const hasSelf = own !== undefined;
            const others = hasSelf ? count - 1 : count;
            const size = SNAPSHOT_HEADER_BYTES + (hasSelf ? SELF_BLOCK_BYTES : 0) + others * COMPACT_BYTES;
            const bytes = new Uint8Array(size);
            const view = new DataView(bytes.buffer);
            const window = m.inputs.takeWindow();
            let pos = writeSnapshotHeader(view, {
                serverTick: T,
                lastProcessedSeq: m.lastProcessedSeq,
                inputSlack: window.slack,
                bufferTarget: m.inputs.updateBufferTarget(),
                carCount: others,
                missedInputs: window.missed
            }, hasSelf);
            if (hasSelf) {
                const car = m.car!;
                pos = writeSelfBlock(view, pos, m.slot, car.state, this.carFlags(m), modsToBits(car.mods), car.input);
                bytes.set(this.compact.subarray(0, own), pos);
                bytes.set(this.compact.subarray(own + COMPACT_BYTES, compactBytes), pos + own);
            } else {
                bytes.set(this.compact.subarray(0, compactBytes), pos);
            }
            if (m.session.sendSnapshot(bytes)) this.bytesOut += size;
        }
    }

    // To every member of this room (ready or not: the splash screen shows
    // the live game behind it)
    broadcast(msg: ServerMessage, excludeId?: string): void {
        const data = JSON.stringify(msg);
        for (const member of this.sorted) {
            if (member.id === excludeId || member.bot) continue;
            member.session.sendRaw(data);
            this.bytesOut += data.length;
        }
    }

    // The same top 10 to everyone, each with its own score and rank; the
    // list is serialized once
    private sendScoreboard(board: ScoreboardEntry[]): void {
        const ranked = this.sorted.filter(m => m.ready).map(m => ({ id: m.id, score: this.scoreOf(m) }));
        // Stable: equal scores keep the id order, as in scoreboard()
        ranked.sort((a, b) => b.score - a.score);
        const rankOf = new Map<string, { score: number; rank: number }>();
        ranked.forEach((r, i) => rankOf.set(r.id, { score: r.score, rank: i + 1 }));
        const list = JSON.stringify(board);
        for (const m of this.sorted) {
            if (m.bot) continue;
            const own = rankOf.get(m.id);
            const data = `{"type":"scoreboard","scoreboard":${list}${own ? `,"own":${JSON.stringify(own)}` : ''}}`;
            m.session.sendRaw(data);
            this.bytesOut += data.length;
        }
    }

    protected sendTo(member: RoomMember, msg: ServerMessage): void {
        if (member.bot) return;
        const data = JSON.stringify(msg);
        member.session.sendRaw(data);
        this.bytesOut += data.length;
    }

    /** The pong's tick and how far the running tick interval has come (3.7). */
    clockAt(nowMs: number): { tick: number; sub: number } {
        const sub = this.lastStepAtMs < 0 ? 0 : Math.max(0, Math.min(0.999, (nowMs - this.lastStepAtMs) / TICK_MS));
        return { tick: this.tick, sub };
    }

    // ---- Extension points of the room types ----

    /** The sim world the cars drive in: the map's; a race room adds its track (phase 2, 5.6). */
    protected get world(): SimWorld {
        return this.map.simWorld;
    }

    // Right after the tick count went up, before any input (a race starts)
    protected beginTick(_tick: number): void { /* none */ }
    // True holds the member's car in the contact ghost this tick like the
    // idle ghost; when it ends, the car stays a ghost while it overlaps
    protected forceGhost(_member: RoomMember, _tick: number): boolean { return false; }
    // Where a member's car appears after 'ready' (grid: a race's grid slot);
    // null: no car (a spectator)
    protected spawnPose(member: RoomMember): (SpawnPose & { grid?: number }) | null {
        return randomSpawnPose(this.map.world.city, this.carPositions(member), this.spawnKeepOut());
    }
    // An e2e placement (debugPlace) moved the car at the end of tick
    protected onPlaced(_member: RoomMember, _tick: number): void { /* none */ }
    // Whether a car change may show now (a race: only in the lobby)
    protected carChangeAllowed(_member: RoomMember): boolean { return true; }
    // The race state for roomState (race and time trial rooms)
    raceState(): RaceStateBody | null { return null; }

    protected onJoin(_member: RoomMember): void { /* no per-member state */ }
    protected onLeave(_member: RoomMember, _reason: LeaveReason): void { /* no per-member state */ }
    // Game messages beyond driving (shooting); ignored by default
    protected onGameMessage(_member: RoomMember, _msg: RoomMessage): void { /* ignored */ }
    // RaceRoom (phase 2): no gas before the start
    protected filterInput(_member: RoomMember, _input: VehicleInput, _tick: number): void { /* unchanged */ }
    // Mods and shields before stepWorld
    protected beforeStep(_tick: number): void { /* none */ }
    // Pickups, damage, timers after stepWorld
    protected afterStep(_tick: number): void { /* none */ }
    // A car (re)appeared at the end of tick
    protected onSpawned(_member: RoomMember, _tick: number): void { /* none */ }
    protected healthOf(_member: RoomMember): number { return 100; }
    // The member's Party score (carried over a new page of the same session)
    scoreOf(_member: RoomMember): number { return 0; }
    // The own powerup windows for a resumed session (Party)
    protected powerupWindows(_member: RoomMember): ResumeState['powerups'] { return []; }
    roomStateItems(): RoomStateItems | null { return null; }
    scoreboard(): ScoreboardEntry[] { return []; }

    // The room is closed and never used again
    dispose(): void {
        for (const member of [...this.members.values()]) this.leave(member, 'closed');
    }
}
