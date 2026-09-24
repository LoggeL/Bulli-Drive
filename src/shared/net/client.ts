// The network side of a client without DOM or three
// (docs/phase-1b-design.md, 8): clock, lead, the prediction of the own car,
// the input packets, the members behind the snapshot slots and the own
// powerup windows. The browser (client/net/netDriver.ts), the bots and the
// Node tests drive the same code; they only supply the inputs, the clock
// (a time in ms) and the socket.

import { ClockSync } from './clock.js';
import { CAR_RESPAWN_SHIELD, encodeInputPacket, type Snapshot } from './codec.js';
import { BUFFER_TARGET_MIN, INPUT_MAX_PER_PACKET, INPUT_REDUNDANCY, TICK_MS } from './constants.js';
import { LeadControl } from './leadControl.js';
import { Prediction, type PredictedRemote, type ReconcileResult, type SlotInfo } from './prediction.js';
import { createPose, interpolatePose, RenderOffset, type Pose } from './renderOffset.js';
import { isPowerupType, POWERUP_TYPE_IDS, RESPAWN_SHIELD_MAX_TICKS, type PowerupType } from '../party/rules.js';
import type { GameEvent, MemberInfo, ResumeState } from '../protocol.js';
import { OFFLINE_PREDICT_MS } from './reconnect.js';
import type { SimCar, VehicleInput } from '../sim/types.js';
import { isCarClassId } from '../sim/vehicleClasses.js';
import type { SimWorld } from '../world/colliders.js';

// Ticks one frame may run at most; further behind, C jumps (the server
// repeats and then stops the missing inputs)
export const MAX_TICKS_PER_FRAME = 20;
// Pongs before C starts: the very first may have waited in a busy page
export const START_AFTER_PONGS = 3;
// A gap this long between two pumps is a stall of the client itself (a
// busy page, GC): the late reports that follow are not the network's (20.5)
export const OWN_STALL_MS = 150;

export interface NetStats {
    snapshots: number;
    corrections: number;
    // Sum and maximum of the position errors at T_s (m), split by contact
    correctionSum: number;
    correctionMax: number;
    contactCorrections: number;
    contactCorrectionSum: number;
    snaps: number;
    replayedTicks: number;
    lostInputs: number;
    resyncs: number;
    exactMatches: number;
    // Ticks the server had to repeat or stop our input, from the snapshots
    missedInputs: number;
    lastSlack: number;
    frames: number;
    bytesOut: number;
    // Largest render offset a correction left (m); corrections too large
    // to smooth (a snap of the picture)
    offsetMax: number;
    renderSnaps: number;
    // Stalls of the client itself (gaps between pumps over OWN_STALL_MS)
    ownStalls: number;
}

export function createNetStats(): NetStats {
    return {
        snapshots: 0, corrections: 0, correctionSum: 0, correctionMax: 0,
        contactCorrections: 0, contactCorrectionSum: 0, snaps: 0, replayedTicks: 0,
        lostInputs: 0, resyncs: 0, exactMatches: 0, missedInputs: 0, lastSlack: 0, frames: 0, bytesOut: 0,
        offsetMax: 0, renderSnaps: 0, ownStalls: 0
    };
}

export class NetClient {
    readonly clock = new ClockSync();
    readonly lead = new LeadControl();
    prediction: Prediction | null = null;
    world: SimWorld | null = null;
    selfId = '';
    // The Party's rules apply (respawn shield, powerup windows)
    party = true;
    bufferTarget = BUFFER_TARGET_MIN;
    readonly members = new Map<string, MemberInfo>();
    private readonly slots = new Map<number, string>();
    // Own powerup windows [start, end) from the pickup events
    readonly windows: Record<PowerupType, { start: number; end: number }>;
    // Tick of the last spawn or respawn of the own car, -1 = none
    spawnTick = -1;
    // Own car flags from the last snapshot and its tick
    selfFlags = 0;
    selfFlagsTick = -1;
    readonly stats: NetStats = createNetStats();
    lastResult: ReconcileResult | null = null;
    // Render offset of the own car: a correction fades out instead of
    // jumping (8.4); the remote cars of the contact set carry their own
    readonly offset = new RenderOffset();
    // Set on every correction too large to smooth: the camera jumps along
    cameraSnap = false;
    private readonly shownBefore = createPose();
    private readonly poseAfter = createPose();
    private readonly remoteShown = new Map<PredictedRemote, Pose>();
    private readonly posePool: Pose[] = [];
    // The last tick whose input went out
    protected sentTick = -1;
    // Since when the connection is gone (ms), -1 while connected: the own
    // car is predicted OFFLINE_PREDICT_MS further, then held (11.1)
    suspendedAt = -1;
    // Time the client last ran (a pump or a snapshot), -1 before the first
    private lastActiveAt = -1;
    // Server tick at local time 0 as the clock said at the last (re)start.
    // C follows this anchor plus the lead, not the clock's later estimates,
    // so the clock's own corrections do not move C; the lead control
    // (inputSlack) does that (8.3)
    private anchor = 0;

    constructor(private readonly sendBytes: (bytes: Uint8Array) => void) {
        this.windows = {} as Record<PowerupType, { start: number; end: number }>;
        for (const type of POWERUP_TYPE_IDS) this.windows[type] = { start: 0, end: 0 };
    }

    // ---- Room ----

    /** A new room (or the first): the prediction starts over in that world. */
    enterRoom(world: SimWorld, party: boolean, members: MemberInfo[], car: SimCar, selfId: string): void {
        this.world = world;
        this.party = party;
        this.selfId = selfId;
        this.members.clear();
        this.slots.clear();
        for (const member of members) this.setMember(member);
        const prediction = new Prediction(car, world, slot => this.slotInfo(slot));
        prediction.modsFor = (tick, mods) => {
            mods.turbo = this.powerupActive('speed', tick);
            mods.mega = this.powerupActive('size', tick);
            mods.superJump = this.powerupActive('jump', tick);
            mods.ghost = this.powerupActive('ghost', tick);
            mods.shield = this.powerupActive('shield', tick) || this.respawnShieldAt(tick);
        };
        this.prediction = prediction;
        this.clearWindows();
        this.spawnTick = -1;
        this.selfFlags = 0;
        this.selfFlagsTick = -1;
        this.sentTick = -1;
        this.lead.start(0, BUFFER_TARGET_MIN);
        this.offset.clear();
        this.suspendedAt = -1;
    }

    /**
     * Back in the room after a lost connection with the same session: the
     * car goes on as the server has it (taken from the next snapshot), with
     * its powerup windows and spawn tick (11.1).
     */
    resumeOwn(resume: ResumeState): void {
        const p = this.prediction;
        if (!p) return;
        this.clearWindows();
        for (const w of resume.powerups) {
            if (isPowerupType(w.type)) this.setWindow(w.type, w.startTick, w.endTick);
        }
        this.spawnTick = resume.spawnTick;
        p.adoptNext = resume.alive;
    }

    /** The connection is gone: the prediction runs out shortly after now. */
    suspend(now: number): void {
        if (this.suspendedAt < 0) this.suspendedAt = now;
    }

    get suspended(): boolean {
        return this.suspendedAt >= 0;
    }

    setMember(member: MemberInfo): void {
        const old = this.members.get(member.id);
        if (old && this.slots.get(old.slot) === old.id) this.slots.delete(old.slot);
        this.members.set(member.id, member);
        this.slots.set(member.slot, member.id);
    }

    removeMember(id: string): void {
        const member = this.members.get(id);
        if (!member) return;
        this.members.delete(id);
        if (this.slots.get(member.slot) === id) this.slots.delete(member.slot);
    }

    idForSlot(slot: number): string | undefined {
        return this.slots.get(slot);
    }

    private slotInfo(slot: number): SlotInfo | null {
        const id = this.slots.get(slot);
        const member = id ? this.members.get(id) : undefined;
        if (!member || member.id === this.selfId) return null;
        return { id: member.id, classId: isCarClassId(member.carType) ? member.carType : 'bulli', profile: member.profile };
    }

    // ---- Powerups and shields of the own car ----

    powerupActive(type: PowerupType, tick: number): boolean {
        const span = this.windows[type];
        return span.start <= tick && tick < span.end;
    }

    clearWindows(): void {
        for (const type of POWERUP_TYPE_IDS) {
            this.windows[type].start = 0;
            this.windows[type].end = 0;
        }
    }

    setWindow(type: PowerupType, start: number, end: number): void {
        this.windows[type].start = start;
        this.windows[type].end = end;
    }

    // The server ends the respawn shield by its own rule; after T_s the
    // client keeps the last snapshot's word, before the first snapshot after
    // a spawn it assumes the shield
    respawnShieldAt(tick: number): boolean {
        if (!this.party || this.spawnTick < 0 || tick <= this.spawnTick) return false;
        if (tick - this.spawnTick > RESPAWN_SHIELD_MAX_TICKS) return false;
        if (this.selfFlagsTick <= this.spawnTick) return true;
        return (this.selfFlags & CAR_RESPAWN_SHIELD) !== 0;
    }

    /** Whether the own car has the respawn shield at the current tick. */
    get respawnShieldNow(): boolean {
        const p = this.prediction;
        return !!p && p.spawned && this.respawnShieldAt(p.tick);
    }

    // ---- Ticks ----

    /** The current client tick C, -1 before the clock is synced. */
    get tick(): number {
        return this.prediction?.tick ?? -1;
    }

    /**
     * Runs the ticks due by now: C follows the server clock plus the lead
     * (8.2, 8.3). runTick runs one tick (the caller samples the input and
     * calls tickWith). Returns alpha, how far the render time lies between
     * the states after C - 1 and C.
     */
    advanceFrame(now: number, runTick: () => void): number {
        const p = this.prediction;
        if (!p || !this.clock.ready || this.clock.count < START_AFTER_PONGS) return 0;
        // Disconnected: a moment more of prediction, then the car holds
        if (this.suspendedAt >= 0 && now - this.suspendedAt > OFFLINE_PREDICT_MS) return this.renderAlpha(now);
        this.stats.frames++;
        this.noteActivity(now);
        if (p.tick < 0) this.resync(now);
        const target = this.targetTick(now);
        if (target - p.tick > MAX_TICKS_PER_FRAME) {
            // Far behind (a stall, a background tab): skip ahead
            p.jumpTo(Math.floor(target) - MAX_TICKS_PER_FRAME + 1);
            this.stats.resyncs++;
        }
        let n = 0;
        while (p.tick + 1 <= target && n < MAX_TICKS_PER_FRAME) {
            runTick();
            n++;
        }
        return Math.max(0, Math.min(1, target - p.tick));
    }

    // A long gap since the client last ran is a stall of its own: the late
    // reports that follow say nothing about the network (20.5)
    private noteActivity(now: number): void {
        if (this.lastActiveAt >= 0 && now - this.lastActiveAt > OWN_STALL_MS) {
            this.lead.holdAfterStall(now, this.clock.rtt, now - this.lastActiveAt);
            this.stats.ownStalls++;
        }
        this.lastActiveAt = now;
    }

    /** One tick with this input (and clientFlags); returns whether the own car was simulated. */
    tickWith(input: VehicleInput, flags: number): boolean {
        const p = this.prediction;
        if (!p || p.tick < 0) return false;
        p.advance(input, flags);
        return p.spawned;
    }

    // The tick C should have reached at local time now (with fraction)
    targetTick(now: number): number {
        return this.anchor + now / TICK_MS + this.lead.lead;
    }

    /** How far the render time lies between the states after C - 1 and C. */
    renderAlpha(now: number): number {
        const p = this.prediction;
        if (!p || p.tick < 0 || !this.clock.ready) return 0;
        return Math.max(0, Math.min(1, this.targetTick(now) - p.tick));
    }

    /** Starts C at a fresh estimate (after joining, back from the background). */
    resync(now: number): void {
        const p = this.prediction;
        if (!p || !this.clock.ready) return;
        this.lead.start(this.clock.rtt, this.bufferTarget);
        this.anchor = this.clock.serverTickAt(now) - now / TICK_MS;
        const start = Math.ceil(this.targetTick(now));
        if (p.tick < 0) {
            p.startAt(start);
            this.sentTick = start - 1;
        } else if (start > p.tick + 1) {
            p.jumpTo(start);
        }
        this.stats.resyncs++;
    }

    /** Sends the inputs of the ticks run since the last packet, each with the two before it. */
    flushInputs(): void {
        const p = this.prediction;
        if (!p || p.tick < 0) return;
        const newest = p.tick;
        if (this.sentTick >= newest) return;
        let from = Math.max(this.sentTick + 1, newest - 60);
        while (from <= newest) {
            const to = Math.min(newest, from + INPUT_MAX_PER_PACKET - 1 - INPUT_REDUNDANCY);
            const oldest = Math.max(to - (INPUT_MAX_PER_PACKET - 1), from - INPUT_REDUNDANCY);
            const inputs: VehicleInput[] = [];
            let flags = 0;
            for (let t = to; t >= oldest; t--) {
                const e = p.entry(t);
                if (!e) break;
                inputs.push(e.input);
                if (t === to) flags = e.flags;
            }
            const top = p.entry(to);
            if (top && inputs.length > 0) {
                const bytes = encodeInputPacket({ flags, seq: top.seq, tick: to, inputs });
                this.stats.bytesOut += bytes.byteLength;
                this.sendBytes(bytes);
            }
            from = to + 1;
        }
        this.sentTick = newest;
    }

    // ---- Snapshots and events ----

    /**
     * Lead control and the reconciliation of the own car for one snapshot,
     * and the render offsets that keep the picture of the own car and of
     * the contact set where it was (8.4, 8.6). alpha: the render
     * interpolation the last frame showed (default: the one for now).
     */
    reconcileSnapshot(snap: Snapshot, now: number, alpha = this.renderAlpha(now)): ReconcileResult | null {
        const p = this.prediction;
        if (!p) return null;
        // What is on screen before the correction
        const ownShown = p.spawned && p.tick >= 0 ? this.ownPose(alpha, true, this.shownBefore) : null;
        this.remoteShown.clear();
        let pooled = 0;
        for (const remote of p.remotes.values()) {
            if (pooled === this.posePool.length) this.posePool.push(createPose());
            const pose = interpolatePose(remote.prev, remote.car.state, alpha, this.posePool[pooled++]);
            this.remoteShown.set(remote, remote.offset.applyTo(pose));
        }
        const result = this.reconcileOnly(snap, now);
        this.smoothRemotes(alpha, now, result?.contact ?? false);
        if (!result || result.matched) return result;
        this.afterReplay();
        if (result.snapped) {
            // Too far to smooth, or the car was just taken over (resume)
            this.offset.clear();
            this.cameraSnap = true;
            return result;
        }
        if (!ownShown) return result;
        if (!this.offset.correct(ownShown, this.ownPose(alpha, false, this.poseAfter), result.contact, now)) {
            this.stats.renderSnaps++;
            this.cameraSnap = true;
        }
        this.stats.offsetMax = Math.max(this.stats.offsetMax, this.offset.size);
        return result;
    }

    // The contact set after a snapshot: a car that stayed in it keeps its
    // picture (offset), one that just came in blends in on the client
    private smoothRemotes(alpha: number, now: number, contact: boolean): void {
        const p = this.prediction;
        if (!p) return;
        for (const remote of p.remotes.values()) {
            const shown = this.remoteShown.get(remote);
            if (!shown) continue;
            remote.offset.correct(shown, interpolatePose(remote.prev, remote.car.state, alpha, this.poseAfter), contact, now);
        }
        this.remoteShown.clear();
    }

    /**
     * The own car's pose on screen at render interpolation alpha, with or
     * without the offset. The browser uses the LocalVehicle's pair instead.
     */
    protected ownPose(alpha: number, withOffset: boolean, out: Pose): Pose {
        const p = this.prediction!;
        interpolatePose(p.prev, p.car.state, alpha, out);
        return withOffset ? this.offset.applyTo(out) : out;
    }

    /** After a replay changed the own car (the browser syncs its render pair). */
    protected afterReplay(): void { /* headless: the prediction's own pair is used */ }

    /** Fades the render offsets for a frame of dtMs at time now. */
    decayOffsets(dtMs: number, now: number): void {
        this.offset.decay(dtMs, now);
        const p = this.prediction;
        if (p) for (const remote of p.remotes.values()) remote.offset.decay(dtMs, now);
    }

    /** The pose on screen for the own car at time now (headless clients, tests). */
    shownPose(now: number, out: Pose): Pose | null {
        const p = this.prediction;
        if (!p || !p.spawned || p.tick < 0) return null;
        return this.ownPose(this.renderAlpha(now), true, out);
    }

    // The reconciliation proper, without the picture
    private reconcileOnly(snap: Snapshot, now: number): ReconcileResult | null {
        const p = this.prediction!;
        this.noteActivity(now);
        this.stats.snapshots++;
        this.stats.missedInputs += snap.missedInputs;
        if (snap.inputSlack !== null) this.stats.lastSlack = snap.inputSlack;
        this.bufferTarget = Math.max(BUFFER_TARGET_MIN, snap.bufferTarget);
        if (p.tick >= 0 && this.lead.onSnapshot(snap.inputSlack, snap.bufferTarget, now, this.clock.rtt)) this.stats.resyncs++;
        if (snap.self) {
            this.selfFlags = snap.self.flags;
            this.selfFlagsTick = snap.serverTick;
        }
        const result = p.reconcile(snap);
        this.lastResult = result;
        if (!result) return null;
        if (result.lostInputs) this.stats.lostInputs++;
        if (result.matched) {
            this.stats.exactMatches++;
            return result;
        }
        this.stats.corrections++;
        if (result.contact) {
            this.stats.contactCorrections++;
            this.stats.contactCorrectionSum += result.error;
        } else {
            this.stats.correctionSum += result.error;
            this.stats.correctionMax = Math.max(this.stats.correctionMax, result.error);
        }
        this.stats.replayedTicks += result.replayedTicks;
        if (result.snapped) this.stats.snaps++;
        return result;
    }

    spawnOwn(tick: number, x: number, z: number, yaw: number): void {
        const p = this.prediction;
        if (!p) return;
        this.clearWindows();
        this.spawnTick = tick;
        p.spawnAt(tick, x, z, yaw);
        this.offset.clear();
        this.cameraSnap = true;
    }

    despawnOwn(): void {
        this.prediction?.despawn();
        this.clearWindows();
        this.offset.clear();
    }

    /**
     * The events that concern the prediction: the own car's spawns, death
     * and powerups, and the other cars' bodies. Returns whether the event
     * was about the own car.
     */
    applyEvent(event: GameEvent): boolean {
        switch (event.type) {
            case 'spawn':
            case 'respawn':
                if (event.id !== this.selfId) return false;
                this.spawnOwn(event.tick, event.x, event.z, event.yaw);
                return true;
            case 'killed':
                if (event.target !== this.selfId) return false;
                this.despawnOwn();
                return true;
            case 'pickup':
                if (event.playerId !== this.selfId || event.kind !== 'powerup' || !isPowerupType(event.powerupType)
                    || event.startTick === undefined || event.endTick === undefined) return false;
                this.setWindow(event.powerupType, event.startTick, event.endTick);
                return true;
            case 'carChanged': {
                const member = this.members.get(event.id);
                if (member) this.setMember({ ...member, carType: event.carType, profile: event.profile });
                return event.id === this.selfId;
            }
            default:
                return false;
        }
    }
}
