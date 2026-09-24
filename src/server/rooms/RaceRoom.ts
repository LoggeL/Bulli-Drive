import type { RaceResultEntry, RaceStateBody, RaceStatusEntry, ServerMessage } from '../../shared/protocol.js';
import { CAR_RACE_GHOST } from '../../shared/net/codec.js';
import { mulberry32 } from '../../shared/math/rng.js';
import { raceInputFilter, inStartGhost } from '../../shared/race/inputFilter.js';
import { applyLaunchMods, LaunchRecorder, type LaunchResult } from '../../shared/race/launch.js';
import { LineDriver } from '../../shared/race/lineDriver.js';
import {
    advanceProgress, createCourse, createRaceProgress, resetBeforeNextGate, skipToPoint,
    type Course, type RaceProgress
} from '../../shared/race/progress.js';
import { createRaceWorld, trackHash } from '../../shared/race/raceWorld.js';
import {
    COUNTDOWN_PREP_TICKS, COUNTDOWN_TICKS, DNF_AFTER_FIRST_TICKS, LOBBY_ALL_READY_TICKS, LOBBY_AUTOSTART_TICKS,
    MAX_RACERS, RACE_FIELD_TARGET, RACE_SNAPSHOT_EVERY, RACE_STATUS_EVERY, RESULTS_TICKS
} from '../../shared/race/rules.js';
import { computeStandings, gapAhead } from '../../shared/race/standings.js';
import { nextTrack, TRACKS } from '../../shared/race/tracks/index.js';
import type { BotLevel, RacePhase, RaceVote, TrackDef, TrackId } from '../../shared/race/types.js';
import { stopInput } from '../../shared/sim/inputs.js';
import type { SimCar, VehicleInput, VehicleState } from '../../shared/sim/types.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import type { MapData } from '../../shared/world/mapData.js';
import { BotSession, drawBots } from '../race/botRoster.js';
import { Room, type BotController, type LeaveReason, type RoomMember, type RoomMessage } from './Room.js';
import type { SpawnPose } from './spawn.js';

// The race (docs/phase-2-design.md, 6 to 14): lobby, countdown, racing,
// finished and results, in the room tick. Every rule runs against the
// server's cars: the freeze before the start, the launch, the gates with
// sub-tick times, progress and positions, wrong way, the reset check, the
// ghost rules against griefing, DNF, the vote for the next race. Server-side
// bots fill the field. The client only predicts and shows.

export interface RaceRoomOptions {
    track?: TrackId;
    // Seed of the bots (names, classes, lanes, starts); one per room
    seed?: number;
}

interface TrackRuntime {
    track: TrackDef;
    world: SimWorld;
    course: Course;
    hash: string;
}

// One race world per map and track and process, like MapData
const runtimes = new WeakMap<MapData, Map<TrackId, TrackRuntime>>();

export function trackRuntime(map: MapData, id: TrackId): TrackRuntime {
    let perMap = runtimes.get(map);
    if (!perMap) {
        perMap = new Map();
        runtimes.set(map, perMap);
    }
    let runtime = perMap.get(id);
    if (!runtime) {
        const track = TRACKS[id];
        runtime = { track, world: createRaceWorld(map, track), course: createCourse(track), hash: trackHash(track) };
        perMap.set(id, runtime);
    }
    return runtime;
}

export interface Racer {
    readonly id: string;
    // null once the member left the room
    member: RoomMember | null;
    readonly bot: boolean;
    readonly grid: number;
    // Kept for the results after the member left
    readonly slot: number;
    readonly name: string;
    readonly carType: string;
    readonly progress: RaceProgress;
    readonly launch: LaunchRecorder;
    launchResult: LaunchResult;
    // Position before the tick's stepWorld (the gate test)
    prevX: number;
    prevZ: number;
    driver: LineDriver | null;
}

const RACE_PHASES_RUNNING: readonly RacePhase[] = ['racing', 'finished'];

// Race messages go through the room like shooting in the Party
type Msg<T extends RoomMessage['type']> = Extract<RoomMessage, { type: T }>;

// raceConfig at most once per second per player
const CONFIG_INTERVAL_TICKS = 60;

export class RaceRoom extends Room {
    phase: RacePhase = 'lobby';
    trackId: TrackId;
    botLevel: BotLevel = 'medium';
    startTick: number | null = null;
    phaseEndTick: number | null = null;
    racers: Racer[] = [];
    readonly ready = new Set<string>();
    readonly votes = new Map<string, RaceVote>();
    // How the next grid is ordered: the last result, then the join order
    protected gridOrder: string[] = [];
    // Results of the last race (for tests and late readers)
    lastResults: RaceResultEntry[] | null = null;
    protected readonly mode: 'race' | 'timetrial' = 'race';
    // Countdown preparation and the delay after everyone is ready (the time
    // trial restarts quicker)
    protected prepTicks = COUNTDOWN_PREP_TICKS;
    protected allReadyTicks = LOBBY_ALL_READY_TICKS;
    // Bots fill the field up to this many cars (0: none)
    protected fieldTarget = RACE_FIELD_TARGET;
    private readonly racerById = new Map<string, Racer>();
    private readonly lobbySlots = new Map<string, number>();
    private readonly joinSeq = new Map<string, number>();
    private joinCount = 0;
    private readySince = -1;
    private allReadySince = -1;
    private dnfTick = -1;
    private raceSeq = 0;
    private readonly seed: number;
    private dirty = false;
    private readonly lastConfigTick = new Map<string, number>();
    // The racers' car states for the bots' traffic view, per tick
    private readonly traffic: VehicleState[] = [];

    constructor(index: number, map: MapData, now: () => number = Date.now, options: RaceRoomOptions = {}, kind: 'race' | 'timetrial' = 'race') {
        super(kind, index, map, now);
        this.trackId = options.track ?? 'downtown-loop';
        this.seed = options.seed ?? (index * 7919 + 17);
        this.snapshotEvery = RACE_SNAPSHOT_EVERY;
    }

    get runtime(): TrackRuntime {
        return trackRuntime(this.map, this.trackId);
    }

    get track(): TrackDef {
        return this.runtime.track;
    }

    protected get world(): SimWorld {
        return this.runtime.world;
    }

    racer(id: string): Racer | undefined {
        return this.racerById.get(id);
    }

    /** The racers' cars this tick (what the bots see of the traffic). */
    get trafficStates(): readonly VehicleState[] {
        return this.traffic;
    }

    // ---- State for the clients ----

    raceState(): RaceStateBody {
        const track = this.track;
        let votes: RaceStateBody['votes'] = null;
        if (this.phase === 'results') {
            votes = { rematch: 0, next: 0 };
            for (const choice of this.votes.values()) votes[choice]++;
        }
        return {
            mode: this.mode,
            phase: this.phase,
            trackId: this.trackId,
            trackVersion: track.trackVersion,
            trackHash: this.runtime.hash,
            laps: track.laps,
            botLevel: this.botLevel,
            startTick: this.startTick,
            phaseEndTick: this.phaseEndTick,
            racers: this.racers.map(r => ({ id: r.id, grid: r.grid, bot: r.bot })),
            ready: [...this.ready].sort(),
            votes
        };
    }

    private markDirty(): void {
        this.dirty = true;
    }

    private sendRaceState(): void {
        this.dirty = false;
        this.broadcast({ type: 'raceState', ...this.raceState() });
    }

    // ---- Membership ----

    protected onJoin(member: RoomMember): void {
        this.joinSeq.set(member.id, this.joinCount++);
    }

    protected onLeave(member: RoomMember, _reason: LeaveReason): void {
        this.ready.delete(member.id);
        this.votes.delete(member.id);
        this.lobbySlots.delete(member.id);
        this.lastConfigTick.delete(member.id);
        const racer = this.racerById.get(member.id);
        if (racer) {
            racer.member = null;
            if (racer.progress.status === 'racing') racer.progress.status = 'left';
        }
        this.markDirty();
        if (!member.bot && this.humanCount === 0) this.emptied();
    }

    // The last player left: bots out, back to the lobby, the track stays
    private emptied(): void {
        for (const m of [...this.orderedMembers]) if (m.bot) this.leave(m, 'closed');
        this.clearRace();
        this.phase = 'lobby';
        this.phaseEndTick = null;
        this.ready.clear();
        this.votes.clear();
        this.readySince = this.allReadySince = -1;
    }

    private clearRace(): void {
        this.racers = [];
        this.racerById.clear();
        this.startTick = null;
        this.dnfTick = -1;
    }

    /** Humans past the splash screen in grid priority: the last result, then who came first. */
    protected humansInGridOrder(): RoomMember[] {
        const rank = new Map(this.gridOrder.map((id, i) => [id, i]));
        return this.orderedMembers
            .filter(m => !m.bot && m.ready)
            .sort((a, b) => {
                const ra = rank.get(a.id) ?? Infinity, rb = rank.get(b.id) ?? Infinity;
                if (ra !== rb) return ra - rb;
                return (this.joinSeq.get(a.id) ?? 0) - (this.joinSeq.get(b.id) ?? 0);
            });
    }

    private gridPose(k: number): SpawnPose & { grid: number } {
        const slot = this.track.grid[k];
        return { x: slot.x, z: slot.z, yaw: slot.yaw, grid: k };
    }

    // A player past the splash screen gets a free grid slot in the lobby;
    // later (or with the grid full) they watch
    protected spawnPose(member: RoomMember): (SpawnPose & { grid?: number }) | null {
        if (this.phase !== 'lobby' || member.bot) return null;
        const taken = new Set(this.lobbySlots.values());
        for (let k = 0; k < MAX_RACERS; k++) {
            if (taken.has(k)) continue;
            this.lobbySlots.set(member.id, k);
            this.markDirty();
            return this.gridPose(k);
        }
        return null;
    }

    // Every human past the splash screen onto the grid (the lobby after a
    // race, a track change): in grid order, the rest without a car
    private placeLobby(T: number): void {
        this.lobbySlots.clear();
        this.humansInGridOrder().forEach((m, k) => {
            if (k < MAX_RACERS) {
                this.lobbySlots.set(m.id, k);
                this.spawnCar(m, this.gridPose(k), T, k);
            } else {
                this.despawnCar(m, T);
            }
        });
    }

    protected carChangeAllowed(_member: RoomMember): boolean {
        return this.phase === 'lobby';
    }

    // ---- Messages (6.4) ----

    protected onGameMessage(member: RoomMember, msg: RoomMessage): void {
        switch (msg.type) {
            case 'raceReady': return this.onReady(member, msg);
            case 'raceConfig': return this.onConfig(member, msg);
            case 'raceVote': return this.onVote(member, msg);
            case 'timeTrialRestart': return this.onRestart(member);
            default: return;
        }
    }

    private onReady(member: RoomMember, msg: Msg<'raceReady'>): void {
        if (this.phase !== 'lobby' || member.bot || !member.ready) return;
        if (msg.ready === this.ready.has(member.id)) return;
        if (msg.ready) this.ready.add(member.id);
        else this.ready.delete(member.id);
        this.markDirty();
    }

    private onConfig(member: RoomMember, msg: Msg<'raceConfig'>): void {
        if (this.phase !== 'lobby' || member.bot) return;
        const last = this.lastConfigTick.get(member.id);
        if (last !== undefined && this.tick - last < CONFIG_INTERVAL_TICKS) return;
        this.lastConfigTick.set(member.id, this.tick);
        if (msg.botLevel && msg.botLevel !== this.botLevel) {
            this.botLevel = msg.botLevel;
            this.markDirty();
        }
        if (msg.track && msg.track !== this.trackId) {
            this.trackId = msg.track;
            this.markDirty();
            // The lobby cars go onto the new track's grid
            this.placeLobby(this.tick);
        }
    }

    private onVote(member: RoomMember, msg: Msg<'raceVote'>): void {
        if (this.phase !== 'results' || member.bot) return;
        this.votes.set(member.id, msg.choice);
        this.markDirty();
    }

    protected onRestart(_member: RoomMember): void { /* time trial only */ }

    // ---- The tick (7) ----

    protected beginTick(T: number): void {
        if (this.phase === 'countdown' && this.startTick !== null && T >= this.startTick) {
            this.phase = 'racing';
            this.markDirty();
        }
        this.traffic.length = 0;
        for (const r of this.racers) {
            const car = r.member?.car;
            if (car && r.member!.alive) this.traffic.push(car.state);
        }
    }

    protected filterInput(member: RoomMember, input: VehicleInput, T: number): void {
        const racer = this.racerById.get(member.id);
        if (racer && this.startTick !== null && T <= this.startTick) racer.launch.record(T, input.throttle);
        if (racer) this.onRacerInput(racer, input, T);
        raceInputFilter(this.phase, T, this.startTick, input);
    }

    // The input a racer's car takes this tick, before the race filter (time trial: recorded)
    protected onRacerInput(_racer: Racer, _input: VehicleInput, _tick: number): void { /* none */ }

    protected beforeStep(T: number): void {
        const S = this.startTick;
        const running = RACE_PHASES_RUNNING.includes(this.phase);
        for (const r of this.racers) {
            const car = r.member?.car;
            if (!car || !r.member!.alive) continue;
            r.prevX = car.state.x;
            r.prevZ = car.state.z;
            if (!running || S === null) continue;
            if (T === S) {
                r.launchResult = r.launch.result(S);
                this.emit({ type: 'launch', id: r.id, result: r.launchResult, tick: T });
            }
            applyLaunchMods(r.launchResult, T, S, car.mods);
        }
    }

    // Anti-griefing (11): the start ghost for everyone, and wrong-way,
    // finished and DNF cars; the base keeps a car a ghost while it still
    // overlaps another when this ends
    protected forceGhost(member: RoomMember, T: number): boolean {
        const racer = this.racerById.get(member.id);
        if (!racer) return false;
        if (RACE_PHASES_RUNNING.includes(this.phase) && inStartGhost(T, this.startTick)) return true;
        const p = racer.progress;
        return p.wrongWay || p.status === 'finished' || p.status === 'dnf';
    }

    protected carFlags(m: RoomMember): number {
        const racer = this.racerById.get(m.id);
        const p = racer?.progress;
        const ghost = !!p && (p.wrongWay || p.status === 'finished' || p.status === 'dnf');
        return super.carFlags(m) | (ghost ? CAR_RACE_GHOST : 0);
    }

    protected afterStep(T: number): void {
        switch (this.phase) {
            case 'lobby': this.lobbyTick(T); break;
            case 'racing':
            case 'finished': this.raceTick(T); break;
            case 'results': this.resultsTick(T); break;
            default: break;
        }
        if (this.dirty) this.sendRaceState();
    }

    // E2E (20.3): the gates before the point count as passed. The placement
    // happens after the tick's gate test, and the next tick starts from the
    // new place, so no crossing spans the jump; skipToPoint also makes the
    // next projection a global one.
    protected onPlaced(member: RoomMember, _T: number): void {
        const racer = this.racerById.get(member.id);
        if (!racer || !member.car || !RACE_PHASES_RUNNING.includes(this.phase)) return;
        skipToPoint(racer.progress, this.runtime.course, member.car.state.x, member.car.state.z);
    }

    // ---- Lobby ----

    private lobbyTick(T: number): void {
        const humans = this.orderedMembers.filter(m => !m.bot && m.ready);
        const readyCount = humans.filter(m => this.ready.has(m.id)).length;
        let due: number | null = null;
        if (readyCount === 0) {
            this.readySince = this.allReadySince = -1;
        } else {
            if (this.readySince < 0) this.readySince = T;
            const all = readyCount === humans.length;
            if (!all) this.allReadySince = -1;
            else if (this.allReadySince < 0) this.allReadySince = T;
            due = this.readySince + LOBBY_AUTOSTART_TICKS;
            if (all) due = Math.min(due, this.allReadySince + this.allReadyTicks);
        }
        if (due !== this.phaseEndTick) {
            this.phaseEndTick = due;
            this.markDirty();
        }
        if (due !== null && T >= due) this.startCountdown(T);
    }

    /**
     * The countdown starts at T0 (6.1): the ready humans drive (at most
     * MAX_RACERS), the others watch; bots fill the field; everyone goes onto
     * the grid; startTick = T0 + prep + COUNTDOWN_TICKS.
     */
    protected startCountdown(T0: number, drivers?: RoomMember[]): void {
        const humans = drivers ?? this.humansInGridOrder().filter(m => this.ready.has(m.id)).slice(0, MAX_RACERS);
        for (const m of this.orderedMembers) {
            if (!m.bot && !humans.includes(m)) this.despawnCar(m, T0);
        }
        for (const m of [...this.orderedMembers]) if (m.bot) this.leave(m, 'closed');
        this.clearRace();
        this.raceSeq++;
        const random = mulberry32((this.seed * 31 + this.raceSeq) >>> 0);
        const botCount = Math.max(0, Math.min(this.fieldTarget, MAX_RACERS) - humans.length);
        const bots = drawBots(botCount, random).map((identity, k) => {
            const session = new BotSession(`bot-${this.index}-${this.raceSeq}-${k}`, identity.name, identity.color, identity.carType);
            return { session, controller: new RaceBot(this) };
        });
        this.startTick = T0 + this.prepTicks + COUNTDOWN_TICKS;
        this.phase = 'countdown';
        this.phaseEndTick = this.startTick;
        this.votes.clear();
        const field: { member: RoomMember; controller: RaceBot | null }[] = humans.map(member => ({ member, controller: null }));
        for (const bot of bots) field.push({ member: this.join(bot.session, { ready: true, bot: bot.controller }), controller: bot.controller });
        this.lobbySlots.clear();
        field.forEach(({ member, controller }, k) => {
            this.spawnCar(member, this.gridPose(k), T0, k);
            const car = member.car!;
            const racer: Racer = {
                id: member.id, member, bot: !!member.bot, grid: k, slot: member.slot,
                name: member.session.name, carType: member.session.carType,
                progress: createRaceProgress(), launch: new LaunchRecorder(), launchResult: 'normal',
                prevX: car.state.x, prevZ: car.state.z,
                driver: controller ? new LineDriver(this.runtime.course, car.params, this.botLevel, random) : null
            };
            racer.driver?.startRace(this.startTick!);
            if (controller) controller.racer = racer;
            this.racers.push(racer);
            this.racerById.set(member.id, racer);
        });
        this.onCountdown(T0);
        this.markDirty();
    }

    // The countdown began (time trial: recording, ghost)
    protected onCountdown(_T0: number): void { /* none */ }

    // ---- Race ----

    private raceTick(T: number): void {
        const S = this.startTick!;
        const { course } = this.runtime;
        const crossed: { r: Racer; laps: number }[] = [];
        for (const r of this.racers) {
            const m = r.member;
            const car = m?.car;
            if (!m || !car || !m.alive || r.progress.status !== 'racing') continue;
            const p = r.progress;
            const reset = car.events.reset;
            if (reset) resetBeforeNextGate(p, course, car.state, this.world);
            const wasWrong = p.wrongWay;
            const laps = p.lapTimes.length;
            const time = advanceProgress(p, course, T, S, r.prevX, r.prevZ, car.state.x, car.state.z, car.state.vx, car.state.vz, reset);
            if (time >= 0) crossed.push({ r, laps });
            if (p.wrongWay !== wasWrong) this.emit({ type: 'wrongWay', id: r.id, on: p.wrongWay });
        }
        const order = this.standings();
        for (const { r, laps } of crossed) {
            const p = r.progress;
            const pos = order.indexOf(r);
            const ahead = pos > 0 ? order[pos - 1] : null;
            const k = p.passed - 1;
            const gap = ahead ? gapAhead(p, ahead.progress, k) : null;
            const lapEnded = p.lapTimes.length > laps;
            this.emit({
                type: 'gate', id: r.id, passed: p.passed, gate: this.gateIndexOf(k), lap: p.lap, tick: T, time: p.gateTimes[k],
                ...(gap !== null ? { gapAhead: gap } : {}),
                ...(lapEnded ? { lapTime: p.lapTimes[p.lapTimes.length - 1] } : {})
            });
            if (p.status === 'finished') {
                this.emit({ type: 'finish', id: r.id, pos: pos + 1, time: p.finishTicks! });
                this.onRacerFinished(r, T);
                if (this.phase === 'racing') {
                    this.phase = 'finished';
                    this.dnfTick = T + DNF_AFTER_FIRST_TICKS;
                    this.phaseEndTick = this.dnfTick;
                    this.markDirty();
                }
            }
        }
        if (T % RACE_STATUS_EVERY === 0) this.sendStatus(T, order);
        const humansRacing = this.racers.some(r => !r.bot && r.progress.status === 'racing');
        if (!humansRacing || (this.phase === 'finished' && T >= this.dnfTick)) this.enterResults(T);
    }

    private gateIndexOf(crossing: number): number {
        const n = this.track.gates.length;
        return this.track.kind === 'circuit' ? crossing % n : crossing;
    }

    // A racer crossed the finish line (time trial: the run is complete)
    protected onRacerFinished(_racer: Racer, _tick: number): void { /* none */ }

    /** The racers in race order (9). */
    standings(): Racer[] {
        return computeStandings(this.racers.map(r => ({ slot: r.slot, progress: r.progress, racer: r }))).map(e => e.racer);
    }

    private sendStatus(T: number, order: Racer[]): void {
        const list: RaceStatusEntry[] = order.map(r => ({ id: r.id, passed: r.progress.passed, lap: r.progress.lap, status: r.progress.status }));
        this.broadcast({ type: 'raceStatus', tick: T, order: list });
    }

    protected enterResults(T: number): void {
        for (const r of this.racers) if (r.progress.status === 'racing') r.progress.status = 'dnf';
        const final = this.standings();
        this.phase = 'results';
        this.phaseEndTick = T + RESULTS_TICKS;
        this.votes.clear();
        const entries: RaceResultEntry[] = final.map((r, i) => ({
            id: r.id, name: r.name, bot: r.bot, carType: r.carType, pos: i + 1, status: r.progress.status,
            finishTicks: r.progress.finishTicks, bestLapTicks: r.progress.bestLap
        }));
        this.lastResults = entries;
        // The next grid: this result, humans only
        this.gridOrder = final.filter(r => !r.bot).map(r => r.id);
        // The last finish events first, then the final order and the results
        this.flushEventsNow();
        this.sendStatus(T, final);
        this.broadcast(this.resultsMessage(entries));
        this.markDirty();
    }

    protected resultsMessage(entries: RaceResultEntry[]): Extract<ServerMessage, { type: 'raceResults' }> {
        return { type: 'raceResults', trackId: this.trackId, entries };
    }

    // ---- Results ----

    private resultsTick(T: number): void {
        const humans = this.orderedMembers.filter(m => !m.bot && m.ready);
        const allVoted = humans.length > 0 && humans.every(m => this.votes.has(m.id));
        if (allVoted || (this.phaseEndTick !== null && T >= this.phaseEndTick)) this.toLobby(T);
    }

    // E10: a rematch only with a majority, the next track on a tie or without votes
    protected trackAfterVote(rematch: number, next: number): TrackId {
        return rematch > next ? this.trackId : nextTrack(this.trackId);
    }

    /**
     * Back to the lobby (E10): rematch only by a majority of the human
     * votes, otherwise the next track; the bots leave; whoever voted is
     * ready; everyone onto the grid in the new order (E15).
     */
    protected toLobby(T: number): void {
        let rematch = 0, next = 0;
        for (const choice of this.votes.values()) {
            if (choice === 'rematch') rematch++;
            else next++;
        }
        this.trackId = this.trackAfterVote(rematch, next);
        this.ready.clear();
        for (const id of this.votes.keys()) this.ready.add(id);
        this.votes.clear();
        for (const m of [...this.orderedMembers]) if (m.bot) this.leave(m, 'closed');
        this.clearRace();
        this.phase = 'lobby';
        this.phaseEndTick = null;
        this.readySince = this.allReadySince = -1;
        this.placeLobby(T);
        this.markDirty();
    }
}

/** A server bot's driving: the LineDriver while it races, else it stops. */
export class RaceBot implements BotController {
    racer: Racer | null = null;

    constructor(private readonly room: RaceRoom) {}

    drive(_member: RoomMember, car: SimCar, tick: number, out: VehicleInput): void {
        const racer = this.racer;
        const room = this.room;
        // Racing from the countdown on; finished, DNF (the results) or gone: stop
        if (!racer?.driver || racer.progress.status !== 'racing') {
            stopInput(car.state, out);
            return;
        }
        // A missed gate: the reset puts the car back before it (10.3)
        if (racer.progress.missedGate) racer.driver.requestReset();
        racer.driver.drive(car.state, car.params, tick, room.startTick, room.trafficStates, out);
    }
}
