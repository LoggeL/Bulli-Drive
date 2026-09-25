import type {
    GameEvent, MemberInfo, RaceResultEntry, RaceStateBody, RaceStatusEntry, ServerMessage
} from '../../shared/protocol.js';
import { racePhaseAt } from '../../shared/race/inputFilter.js';
import { launchResult, type LaunchResult } from '../../shared/race/launch.js';
import { createCourse, createRaceProgress, lapFor, nextGateIndex, trackLine, type Course, type RaceProgress } from '../../shared/race/progress.js';
import { COUNTDOWN_PREP_TICKS, COUNTDOWN_TICKS, LAUNCH_WINDOW_TICKS, TIMETRIAL_PREP_TICKS } from '../../shared/race/rules.js';
import { formatRaceTime, formatSplit } from '../../shared/race/timing.js';
import type { RacePhase, TrackDef, TrackId } from '../../shared/race/types.js';
import { SIM_HZ } from '../../shared/sim/constants.js';
import { gameTrack } from '../map/gameMap.js';

// What the client knows and shows of a race (docs/phase-2-design.md, 17):
// the race state, the 5 Hz standings, the results, the own events and the
// time trial ghost, turned into plain view data for the race HUD, the lobby
// and the results (race/raceHud.ts, race/raceOverlays.ts). No DOM, no
// three: it runs in the Node tests. The server decides every number; the
// client only counts the running clock from its own prediction tick, so
// time and the car on screen belong together (17.2).

export type ResultsMessage = Extract<ServerMessage, { type: 'raceResults' }>;
export type GhostMessage = Extract<ServerMessage, { type: 'ghostData' }>;

// The GO! after green, and how long a banner and a split stay (ms)
export const GO_SHOWN_TICKS = 60;
export const BANNER_MS = 2500;
export const SPLIT_MS = 3000;
// The results sheet waits this long after the own finish, so the FINISH
// banner and the car crossing the line are seen first
export const RESULTS_DELAY_MS = 2000;

export type BannerKind = 'good' | 'bad' | 'info';
export interface Banner { text: string; kind: BannerKind }

export interface CountdownView {
    // Red lights on (0 while the grid is shown, 1..3), then green
    lights: number;
    green: boolean;
    // 'READY', '3', '2', '1', 'GO!'
    label: string;
    // The launch window is open: a throttle edge now is a perfect start
    windowOpen: boolean;
    // How far the last second before green has run (0..1), for the launch bar
    lastSecond: number;
}

export interface HudView {
    mode: 'race' | 'timetrial';
    // 'P2/6' (a race; null in the time trial)
    position: string | null;
    // 'LAP 2/3' (circuits only)
    lap: string | null;
    time: string;
    // Against the car ahead or the ghost: ahead = negative (green)
    split: { text: string; ahead: boolean } | null;
    countdown: CountdownView | null;
    banner: Banner | null;
    // The player has no car in this race (joined late, not ready)
    spectating: boolean;
}

export interface LobbyDriver { id: string; name: string; ready: boolean; self: boolean }

export interface LobbyView {
    mode: 'race' | 'timetrial';
    trackId: TrackDef['id'];
    trackName: string;
    laps: number;
    botLevel: RaceStateBody['botLevel'];
    drivers: LobbyDriver[];
    selfReady: boolean;
    // Seconds until the countdown starts (null: nobody ready yet)
    startsIn: number | null;
}

export interface ResultRow {
    pos: number;
    name: string;
    bot: boolean;
    self: boolean;
    car: string;
    time: string;
    bestLap: string | null;
}

export interface ResultsView {
    mode: 'race' | 'timetrial';
    trackName: string;
    rows: ResultRow[];
    // Seconds until the next lobby
    closesIn: number | null;
    votes: { rematch: number; next: number } | null;
    selfVote: 'rematch' | 'next' | null;
    // Time trial
    record: string | null;
    personal: string | null;
    improved: boolean;
}

export interface NextGateView {
    // Index of the gate in track.gates
    gate: number;
    x: number;
    z: number;
    // Along the racing line (m, never negative)
    distance: number;
    // Past it by more than MISSED_GATE_DISTANCE without crossing
    missed: boolean;
}

export type GateLook = 'next' | 'passed' | 'ahead';

const CAR_NAMES: Record<string, string> = { bulli: 'Bulli', beetle: 'Beetle', pickup: 'Pickup', sport: 'Sport', jeep: 'Jeep' };

export function carName(carType: string): string {
    return CAR_NAMES[carType] ?? carType;
}

const courses = new Map<TrackDef['id'], Course>();

function courseOf(track: TrackDef): Course {
    let course = courses.get(track.id);
    if (!course) {
        course = createCourse(track);
        courses.set(track.id, course);
    }
    return course;
}

/**
 * The countdown at render tick t (float) for start tick S: the grid shown
 * (READY) until S - 180, one red light each at S - 180, S - 120 and S - 60,
 * green at S and GO! for GO_SHOWN_TICKS. The launch window is the
 * LAUNCH_WINDOW_TICKS before S (12.2). null before and after.
 */
export function countdownAt(t: number, S: number, prepTicks: number): CountdownView | null {
    const d = t - S;
    if (d < -(COUNTDOWN_TICKS + prepTicks) || d >= GO_SHOWN_TICKS) return null;
    if (d >= 0) return { lights: 3, green: true, label: 'GO!', windowOpen: false, lastSecond: 1 };
    const lights = d < -180 ? 0 : d < -120 ? 1 : d < -60 ? 2 : 3;
    return {
        lights,
        green: false,
        label: lights === 0 ? 'READY' : String(4 - lights),
        windowOpen: d >= -LAUNCH_WINDOW_TICKS,
        lastSecond: lights === 3 ? (d + 60) / 60 : 0
    };
}

/**
 * The rotation (degrees, clockwise on screen) of an arrow at the top of the
 * screen that points from (x, z) to the target, for a camera looking along
 * cameraYaw. Yaw 0 looks along +z, and a larger yaw turns left.
 */
export function arrowDegrees(x: number, z: number, targetX: number, targetZ: number, cameraYaw: number): number {
    const bearing = Math.atan2(targetX - x, targetZ - z) - cameraYaw;
    const wrapped = bearing - 2 * Math.PI * Math.floor((bearing + Math.PI) / (2 * Math.PI));
    return -wrapped * 180 / Math.PI;
}

function seconds(ticks: number): number {
    return Math.max(0, Math.ceil(ticks / SIM_HZ));
}

export class RaceModel {
    // The tracks by ID: the loaded map's (the tests give their own)
    constructor(private readonly trackOf: (id: TrackId) => TrackDef = gameTrack) {}

    selfId = '';
    state: RaceStateBody | null = null;
    // Race order from the last raceStatus
    order: RaceStatusEntry[] = [];
    results: ResultsMessage | null = null;
    ghost: GhostMessage | null = null;
    // Own launch as the server decided it (the 'launch' event)
    launchEvent: LaunchResult | null = null;
    finish: { pos: number; time: number } | null = null;
    private finishAtMs = -Infinity;
    wrongWay = false;
    vote: 'rematch' | 'next' | null = null;
    // The own crossings and the line tracking for the next-gate arrow
    readonly progress: RaceProgress = createRaceProgress();
    private banner: (Banner & { untilMs: number }) | null = null;
    private split: { ticks: number; untilMs: number } | null = null;
    private launchCache: { start: number; result: LaunchResult } | null = null;
    private teleport = true;

    get track(): TrackDef | null {
        return this.state ? this.trackOf(this.state.trackId) : null;
    }

    get course(): Course | null {
        const track = this.track;
        return track ? courseOf(track) : null;
    }

    get mode(): 'race' | 'timetrial' {
        return this.state?.mode ?? 'race';
    }

    /** Whether the own player drives in the current (or last) race. */
    get racing(): boolean {
        return !!this.state?.racers.some(r => r.id === this.selfId);
    }

    /** The phase tick t sees (the client runs ahead of the state). */
    phaseAt(tick: number): RacePhase {
        return racePhaseAt(this.state?.phase ?? null, this.state?.startTick ?? null, tick);
    }

    /** Leaves the room: nothing carries over. */
    clear(): void {
        this.state = null;
        this.order = [];
        this.results = null;
        this.ghost = null;
        this.startOver();
    }

    // A new race: the own progress and everything shown about it start over
    private startOver(): void {
        Object.assign(this.progress, createRaceProgress());
        this.launchEvent = null;
        this.launchCache = null;
        this.finish = null;
        this.finishAtMs = -Infinity;
        this.wrongWay = false;
        this.banner = null;
        this.split = null;
        this.vote = null;
        this.teleport = true;
    }

    setState(body: RaceStateBody): void {
        const before = this.state;
        this.state = body;
        if (before && before.trackId !== body.trackId) this.ghost = null;
        if (body.startTick !== null && body.startTick !== before?.startTick) {
            this.startOver();
            this.order = [];
        }
        if (body.phase === 'lobby' || body.phase === 'countdown') this.results = null;
        if (body.phase === 'lobby') {
            this.order = [];
            this.vote = null;
        }
    }

    onStatus(order: RaceStatusEntry[]): void {
        this.order = order;
    }

    onResults(message: ResultsMessage): void {
        this.results = message;
        this.wrongWay = false;
    }

    onGhost(message: GhostMessage): void {
        this.ghost = message;
    }

    private showBanner(text: string, kind: BannerKind, nowMs: number, ms = BANNER_MS): void {
        this.banner = { text, kind, untilMs: nowMs + ms };
    }

    /** A game event; only the own race events change what is shown. */
    onEvent(event: GameEvent, nowMs: number): void {
        switch (event.type) {
            case 'gate': {
                if (event.id !== this.selfId) return;
                const track = this.track;
                const lapBefore = this.progress.lap;
                this.progress.passed = event.passed;
                this.progress.lap = event.lap;
                this.progress.gateTimes[event.passed - 1] = event.time;
                const ghostTime = this.ghost?.gateTicks[event.passed - 1];
                const splitTicks = this.mode === 'timetrial'
                    ? (ghostTime !== undefined && Number.isFinite(ghostTime) ? event.time - ghostTime : null)
                    : (event.gapAhead ?? null);
                this.split = splitTicks !== null && Number.isFinite(splitTicks) ? { ticks: splitTicks, untilMs: nowMs + SPLIT_MS } : null;
                if (track?.kind === 'circuit' && event.lap === track.laps && lapBefore < track.laps && event.passed < track.laps * track.gates.length + 1) {
                    this.showBanner('FINAL LAP', 'info', nowMs);
                }
                return;
            }
            case 'finish':
                if (event.id !== this.selfId) return;
                this.finish = { pos: event.pos, time: event.time };
                this.finishAtMs = nowMs;
                this.progress.status = 'finished';
                this.wrongWay = false;
                this.showBanner(this.mode === 'timetrial' ? `FINISH ${formatRaceTime(event.time)}` : `FINISH – P${event.pos}`, 'good', nowMs, 4000);
                return;
            case 'wrongWay':
                if (event.id === this.selfId) this.wrongWay = event.on;
                return;
            case 'launch':
                if (event.id !== this.selfId) return;
                this.launchEvent = event.result;
                if (event.result === 'perfect') this.showBanner('PERFECT START!', 'good', nowMs);
                else if (event.result === 'early') this.showBanner('TOO EARLY', 'bad', nowMs);
                return;
            case 'spawn':
            case 'respawn':
                // A new place (the grid): the line is searched globally
                if (event.id === this.selfId) this.teleport = true;
                return;
            default:
                return;
        }
    }

    /**
     * The own launch for startTick S: the server's word once the event came,
     * before that the rule of 12.2 on the own raw throttle history.
     */
    launchFor(S: number, throttleAt: (tick: number) => number): LaunchResult {
        if (this.launchEvent) return this.launchEvent;
        if (this.launchCache?.start !== S) this.launchCache = { start: S, result: launchResult(throttleAt, S) };
        return this.launchCache.result;
    }

    /** Whether the countdown is running at tick t (the grid frozen, the lights on). */
    counting(tick: number): boolean {
        const S = this.state?.startTick;
        return this.phaseAt(tick) === 'countdown' && this.state?.phase !== 'lobby' && S !== null && S !== undefined;
    }

    /** The race HUD at render tick t (float) and time nowMs; null outside a race's countdown and run. */
    hud(t: number, nowMs: number): HudView | null {
        const state = this.state;
        const track = this.track;
        if (!state || !track || state.phase === 'lobby' || state.startTick === null) return null;
        const S = state.startTick;
        const racer = state.racers.find(r => r.id === this.selfId) ?? null;
        let position: string | null = null;
        if (state.mode === 'race' && racer) {
            const index = this.order.findIndex(e => e.id === this.selfId);
            const count = this.order.length || state.racers.length;
            position = `P${index >= 0 ? index + 1 : racer.grid + 1}/${count}`;
        }
        const lap = track.kind === 'circuit' ? `LAP ${lapFor(track, this.progress.passed)}/${track.laps}` : null;
        const time = this.finish ? formatRaceTime(this.finish.time) : formatRaceTime(Math.max(0, t - S));
        const split = this.split && nowMs < this.split.untilMs
            ? { text: formatSplit(this.split.ticks), ahead: this.split.ticks < 0 }
            : null;
        let banner: Banner | null = null;
        if (this.wrongWay) banner = { text: 'WRONG WAY', kind: 'bad' };
        else if (this.banner && nowMs < this.banner.untilMs) banner = { text: this.banner.text, kind: this.banner.kind };
        else if (racer && this.progress.status === 'racing' && this.progress.missedGate) banner = { text: 'MISSED CHECKPOINT', kind: 'bad' };
        return {
            mode: state.mode,
            position,
            lap,
            time,
            split,
            countdown: state.phase === 'results' ? null : countdownAt(t, S, state.mode === 'timetrial' ? TIMETRIAL_PREP_TICKS : COUNTDOWN_PREP_TICKS),
            banner,
            spectating: !racer
        };
    }

    /**
     * The next gate for the own car at (x, z): tracks the car on the racing
     * line (like the server) and measures the way to the gate. null when
     * the player does not race or has finished.
     */
    nextGate(x: number, z: number): NextGateView | null {
        const course = this.course;
        if (!course || !this.racing || this.progress.status !== 'racing' || this.state?.phase === 'results') return null;
        const k = nextGateIndex(course.track, this.progress.passed);
        if (k < 0) return null;
        trackLine(this.progress, course, x, z, this.teleport);
        this.teleport = false;
        const gate = course.track.gates[k];
        return { gate: k, x: gate.x, z: gate.z, distance: Math.max(0, Math.round(this.progress.remaining)), missed: this.progress.missedGate };
    }

    /** How gate i looks: the next one bright, the ones passed this lap dim. */
    gateLook(i: number): GateLook {
        const track = this.track;
        if (!track || !this.racing || this.progress.status !== 'racing') return 'ahead';
        const next = nextGateIndex(track, this.progress.passed);
        if (i === next) return 'next';
        // On a circuit the finish line comes last in a lap: with gate 0 next
        // after the first crossing, every other gate of the lap is behind
        const passedThisLap = track.kind === 'circuit'
            ? this.progress.passed > 0 && (next === 0 || i < next)
            : i < this.progress.passed;
        return passedThisLap ? 'passed' : 'ahead';
    }

    /** The lobby sheet for the humans past the splash screen. */
    lobby(members: Iterable<MemberInfo>, tick: number): LobbyView | null {
        const state = this.state;
        const track = this.track;
        if (!state || !track || state.phase !== 'lobby') return null;
        const drivers: LobbyDriver[] = [];
        for (const m of members) {
            // The own member counts from the lobby on (the room tells the
            // others when a player is past the splash, not the player itself)
            if (m.bot || (!m.ready && m.id !== this.selfId)) continue;
            drivers.push({ id: m.id, name: m.name, ready: state.ready.includes(m.id), self: m.id === this.selfId });
        }
        return {
            mode: state.mode,
            trackId: track.id,
            trackName: track.name,
            laps: track.laps,
            botLevel: state.botLevel,
            drivers,
            selfReady: state.ready.includes(this.selfId),
            startsIn: state.phaseEndTick !== null ? seconds(state.phaseEndTick - tick) : null
        };
    }

    /** The results sheet, while the room shows them (RESULTS_DELAY_MS after the own finish). */
    resultsView(tick: number, nowMs: number): ResultsView | null {
        const state = this.state;
        const results = this.results;
        if (!state || !results || state.phase !== 'results' || nowMs - this.finishAtMs < RESULTS_DELAY_MS) return null;
        const track = this.trackOf(results.trackId);
        const rows = results.entries.map((e: RaceResultEntry): ResultRow => ({
            pos: e.pos,
            name: e.name,
            bot: e.bot,
            self: e.id === this.selfId,
            car: carName(e.carType),
            time: e.status === 'finished' && e.finishTicks !== null ? formatRaceTime(e.finishTicks)
                : e.status === 'left' ? 'DNF (left)' : 'DNF',
            bestLap: track.kind === 'circuit' ? (e.bestLapTicks !== null ? formatRaceTime(e.bestLapTicks) : '–') : null
        }));
        return {
            mode: state.mode,
            trackName: track.name,
            rows,
            closesIn: state.phaseEndTick !== null ? seconds(state.phaseEndTick - tick) : null,
            votes: state.votes,
            selfVote: this.vote,
            record: results.record ? `${formatRaceTime(results.record.finishTicks)} · ${results.record.name}` : null,
            personal: results.personal ? formatRaceTime(results.personal.finishTicks) : null,
            improved: results.personal?.improved ?? false
        };
    }
}
