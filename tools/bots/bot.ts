// A headless game client over a real WebSocket (docs/phase-1b-design.md,
// 15.2): the same handshake, clock sync, prediction and input packets as
// the browser, through the shared NetClient, without three or the DOM. It
// drives with RoadDriver (driver.ts) and keeps numbers for the tests and
// the load runs: bytes, snapshots, corrections, contacts, reconnects.
//
// Modes:
// - drive: pure pursuit over the road grid
// - ram: drives, and every few seconds chases the nearest car into a bump
// - idle: connected and spawned, but sends no inputs (the server makes the
//   car an idle ghost)
// - reconnect: drives and every so often drops its socket hard; comes back
//   after 1-5 s with the session token (11.1)
// - hop: drives and switches between Party and Free Roam every 20 s
// - flood: floods the server with input packets until it is kicked (4003)
// - manual: the caller sets the input (scripted scenarios in the tests)
// - race: joins a race room, picks the track, says ready and races along
//   the racing line (LineDriver on its own prediction, with the race
//   world, the freeze and the start ghost like the browser;
//   docs/phase-2-design.md, 20.2); raceOverride scripts single ticks
// - timetrial: the same alone in a time trial room
//
// The clock is performance.now(); the caller runs pump() every few ms
// (BotSwarm does it for many bots with one timer).

import WebSocket from 'ws';
import { NetClient } from '../../src/shared/net/client.js';
import { CAR_IDLE, CAR_LAGGY, decodeSnapshot, encodeInputPacket, type Snapshot } from '../../src/shared/net/codec.js';
import {
    CLOCK_BURST_INTERVAL_MS, CLOCK_BURST_PINGS, CLOCK_INTERVAL_MS, CLOSE_POLICY, TICK_MS
} from '../../src/shared/net/constants.js';
import { NetsimConnection, type NetsimOptions } from '../../src/shared/net/netsim.js';
import { closeAction, reconnectDelayMs } from '../../src/shared/net/reconnect.js';
import { mulberry32, type RandomSource } from '../../src/shared/math/rng.js';
import {
    PROTOCOL_VERSION, type ClientMessage, type GameEvent, type MemberInfo, type RaceStateBody, type RoomInfo, type RoomKind,
    type ServerMessage
} from '../../src/shared/protocol.js';
import { raceGhostFloor, raceInputFilter, racePhaseAt } from '../../src/shared/race/inputFilter.js';
import { LineDriver, type TrafficCar } from '../../src/shared/race/lineDriver.js';
import { createCourse, createRaceProgress, trackLine, type Course, type RaceProgress } from '../../src/shared/race/progress.js';
import { createRaceWorld } from '../../src/shared/race/raceWorld.js';
import { TRACKS } from '../../src/shared/race/tracks/index.js';
import type { BotLevel, RacePhase, TrackId } from '../../src/shared/race/types.js';
import type { SimWorld } from '../../src/shared/world/colliders.js';
import {
    createVehicleInput, type CarClassId, type SimCar, type VehicleInput, type VehicleParams, type VehicleState
} from '../../src/shared/sim/types.js';
import { createSimCar } from '../../src/shared/sim/vehicle.js';
import { cityRoadGrid } from '../../src/shared/world/cityGen.js';
import { createMapData, type MapData } from '../../src/shared/world/mapData.js';
import { RoadDriver, type ChaseTarget } from './driver.js';

export const BOT_MODES = ['drive', 'ram', 'idle', 'reconnect', 'hop', 'flood', 'manual', 'race', 'timetrial'] as const;
export type BotMode = typeof BOT_MODES[number];

export function isBotMode(value: string): value is BotMode {
    return (BOT_MODES as readonly string[]).includes(value);
}

const CAR_CLASSES: CarClassId[] = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

export interface BotOptions {
    // ws://host:port/ws
    url: string;
    name: string;
    mode: BotMode;
    seed: number;
    room?: RoomKind;
    carType?: CarClassId;
    // A bad network in front of this bot's socket (both directions)
    netsim?: NetsimOptions | null;
    // Mode reconnect: a drop every dropEveryMs (±30 %), back after
    // reconnectMinMs..reconnectMaxMs
    dropEveryMs?: number;
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    // Mode hop: a room switch this often
    hopEveryMs?: number;
    // Mode ram: a chase at most this often, only for cars this close (m)
    ramEveryMs?: number;
    ramRange?: number;
    // Mode flood: starts this long after the spawn
    floodAfterMs?: number;
    // Modes race and timetrial: the track to pick and how the bot drives
    track?: TrackId;
    driverLevel?: BotLevel;
    // Mode race: the level of the server's bots to pick
    serverBotLevel?: BotLevel;
    log?: (line: string) => void;
}

// A message of the race modes, kept for the tests
export type RaceMessage = Extract<ServerMessage, { type: 'raceState' | 'raceStatus' | 'raceResults' | 'ghostData' }>;

// What a race bot sees of a race: the state, the status and results, its events
export interface RaceSeen {
    state: RaceStateBody | null;
    messages: RaceMessage[];
    events: GameEvent[];
}

// A scripted tick of a race bot: write the input and return true to use it
// instead of the line driver's
export type RaceOverride = (tick: number, startTick: number, s: VehicleState, input: VehicleInput) => boolean;

// What a bot saw of another car in the last snapshot with it
export interface SeenCar {
    x: number;
    z: number;
    vx: number;
    vz: number;
    flags: number;
    serverTick: number;
    at: number;
}

export interface ContactSeen {
    at: number;
    other: string;
    dv: number;
}

export interface CloseRecord {
    at: number;
    code: number;
    // The bot closed it itself (a drop, the end of the run)
    own: boolean;
}

// Counters that only grow; rates come from two samples
export interface BotCounters {
    at: number;
    bytesIn: number;
    bytesInText: number;
    bytesInBinary: number;
    bytesOut: number;
    snapshots: number;
    // Snapshots with the own car in them (spawned and alive), and those in
    // which the server had made it a lag ghost or an idle ghost (5.4)
    selfSnapshots: number;
    laggySnapshots: number;
    idleSnapshots: number;
}

export interface BotStats {
    counters: BotCounters;
    malformed: number;
    nonFinite: number;
    rejects: string[];
    kicked: string | null;
    welcomes: { at: number; playerId: string; resumed: boolean }[];
    rooms: { at: number; room: RoomInfo; slot: number; resumed: boolean }[];
    closes: CloseRecord[];
    contacts: ContactSeen[];
    spawns: number;
    deaths: number;
    drops: number;
    hops: number;
    // Problems a test should fail on (unexpected closes, a wrong world, ...)
    errors: string[];
}

let sharedMap: MapData | null = null;

// The map of a seed, built once per process and shared by every bot
function mapFor(seed: number): MapData {
    if (!sharedMap || sharedMap.seed !== seed) sharedMap = createMapData(seed);
    return sharedMap;
}

// WebSocket frame header the payload travels in (server to client, unmasked)
function frameOverhead(bytes: number): number {
    return bytes < 126 ? 2 : bytes < 65536 ? 4 : 10;
}

function randomConnId(random: RandomSource): string {
    return Array.from({ length: 4 }, () => Math.floor(random() * 0xffffffff).toString(36)).join('');
}

export class Bot {
    readonly options: Required<Omit<BotOptions, 'netsim' | 'log' | 'carType' | 'track' | 'serverBotLevel'>>
        & Pick<BotOptions, 'netsim' | 'log' | 'track' | 'serverBotLevel'> & { carType: CarClassId };
    readonly net: NetClient;
    readonly driver: RoadDriver;
    readonly stats: BotStats;
    readonly random: RandomSource;
    // Remote cars by player id, from the snapshots
    readonly seen = new Map<string, SeenCar>();
    // The input used in mode manual
    readonly manualInput: VehicleInput = createVehicleInput();
    // Modes race and timetrial
    readonly race: RaceSeen = { state: null, messages: [], events: [] };
    raceOverride: RaceOverride | null = null;
    private raceDriver: LineDriver | null = null;
    private raceDriverFor = -1;
    private raceCourse: Course | null = null;
    private raceProgress: RaceProgress = createRaceProgress();
    private readonly raceWorlds = new Map<TrackId, SimWorld>();
    private raceConfigSent = false;
    connId: string;
    sessionToken: string | null = null;
    playerId: string | null = null;
    room: RoomInfo | null = null;
    slot = -1;
    lastSnapshot: Snapshot | null = null;
    // The socket is open and the room state arrived
    inRoom = false;
    private ws: WebSocket | null = null;
    private link: NetsimConnection | null = null;
    private generation = 0;
    private car: SimCar | null = null;
    private readonly input: VehicleInput = createVehicleInput();
    private stopped = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private resumeTicket: string | null = null;
    private restartDelayMs: number | null = null;
    // Clock pings of the current room
    private pingsSent = 0;
    private nextPingAt = 0;
    // Mode schedules (performance.now)
    private nextDropAt = Infinity;
    private nextHopAt = Infinity;
    private nextRamAt = 0;
    private ramUntil = 0;
    private floodAt = Infinity;
    private spawnedAt = -1;
    private dead = false;
    private map: MapData | null = null;
    private readonly chase: ChaseTarget = { x: 0, z: 0, vx: 0, vz: 0 };

    constructor(options: BotOptions) {
        this.random = mulberry32(options.seed * 2654435761 >>> 0);
        this.options = {
            room: options.mode === 'race' ? 'race' : options.mode === 'timetrial' ? 'timetrial' : 'party',
            dropEveryMs: 20_000,
            reconnectMinMs: 1000,
            reconnectMaxMs: 5000,
            hopEveryMs: 20_000,
            ramEveryMs: 6000,
            ramRange: 90,
            floodAfterMs: 2000,
            driverLevel: 'medium',
            // Keys left undefined keep their default
            ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as BotOptions,
            carType: options.carType ?? CAR_CLASSES[Math.floor(this.random() * CAR_CLASSES.length)]
        };
        this.connId = randomConnId(this.random);
        this.net = new NetClient(bytes => this.sendBinary(bytes));
        this.driver = new RoadDriver(cityRoadGrid(), this.random);
        this.stats = {
            counters: {
                at: 0, bytesIn: 0, bytesInText: 0, bytesInBinary: 0, bytesOut: 0,
                snapshots: 0, selfSnapshots: 0, laggySnapshots: 0, idleSnapshots: 0
            },
            malformed: 0, nonFinite: 0, rejects: [], kicked: null, welcomes: [], rooms: [], closes: [],
            contacts: [], spawns: 0, deaths: 0, drops: 0, hops: 0, errors: []
        };
    }

    get name(): string {
        return this.options.name;
    }

    get mode(): BotMode {
        return this.options.mode;
    }

    /** The socket is open (it may still wait for the room state). */
    get connected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /** The own car is in the sim and the prediction runs. */
    get driving(): boolean {
        const p = this.net.prediction;
        return this.inRoom && !!p && p.spawned && p.tick >= 0;
    }

    /** The own car's predicted state (null before the spawn). */
    get ownState(): VehicleState | null {
        const p = this.net.prediction;
        return p && p.spawned ? p.car.state : null;
    }

    get stoppedForGood(): boolean {
        return this.stopped || this.stats.kicked !== null;
    }

    private log(line: string): void {
        this.options.log?.(`[${this.name}] ${line}`);
    }

    private error(line: string): void {
        this.stats.errors.push(line);
        this.log(`error: ${line}`);
    }

    // ---- Connection ----

    connect(): void {
        if (this.stopped) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const generation = ++this.generation;
        const ws = new WebSocket(this.options.url, { perMessageDeflate: false });
        this.ws = ws;
        this.inRoom = false;
        const netsim = this.options.netsim;
        const link = netsim ? new NetsimConnection(netsim, mulberry32(this.options.seed * 7919 + generation), {
            now: () => performance.now(),
            setTimeout: (fn, ms) => setTimeout(fn, ms)
        }) : null;
        this.link = link;
        const current = () => generation === this.generation;

        ws.on('open', () => {
            if (current()) this.sendHello();
        });
        ws.on('message', (data: Buffer, isBinary: boolean) => {
            if (!current()) return;
            const bytes = data.byteLength;
            const c = this.stats.counters;
            c.bytesIn += bytes + frameOverhead(bytes);
            if (isBinary) c.bytesInBinary += bytes;
            else c.bytesInText += bytes;
            const deliver = () => {
                if (current()) this.onFrame(data, isBinary);
            };
            if (link) link.down.send(deliver, isBinary);
            else deliver();
        });
        ws.on('close', (code: number, reason: Buffer) => {
            if (!current()) return;
            // The close waits behind whatever the netsim still holds
            const closed = () => {
                link?.close();
                if (current()) this.onClosed(code, false, reason.toString());
            };
            if (link) link.down.send(closed, false, true);
            else closed();
        });
        ws.on('error', (err: Error) => {
            if (current()) this.log(`socket error: ${err.message}`);
        });
    }

    private sendHello(): void {
        this.sendJson({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            build: null,
            connId: this.connId,
            ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
            ...(this.resumeTicket ? { resume: this.resumeTicket } : {}),
            name: this.name,
            carType: this.options.carType,
            profile: 'standard',
            room: this.room?.kind ?? this.options.room
        });
    }

    sendJson(msg: ClientMessage): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const text = JSON.stringify(msg);
        this.stats.counters.bytesOut += text.length;
        const send = () => {
            if (ws.readyState === WebSocket.OPEN) ws.send(text);
        };
        if (this.link) this.link.up.send(send, false);
        else send();
    }

    private sendBinary(bytes: Uint8Array): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        this.stats.counters.bytesOut += bytes.byteLength;
        const copy = this.link ? bytes.slice() : bytes;
        const send = () => {
            if (ws.readyState === WebSocket.OPEN) ws.send(copy);
        };
        if (this.link) this.link.up.send(send, true);
        else send();
    }

    private onClosed(code: number, own: boolean, reason = ''): void {
        const now = performance.now();
        this.stats.closes.push({ at: now, code, own });
        this.ws = null;
        this.link = null;
        this.inRoom = false;
        this.net.suspend(now);
        if (this.stopped) return;
        const action = closeAction(code, reason);
        if (action !== 'reconnect') {
            if (code === CLOSE_POLICY && this.mode === 'flood') {
                this.stats.kicked = this.stats.kicked ?? 'policy';
                this.log('kicked for flooding, as intended');
                return;
            }
            this.error(`closed by the server with ${code} (${action})`);
            return;
        }
        const delay = this.restartDelayMs ?? reconnectDelayMs(this.reconnectAttempt, this.random);
        this.restartDelayMs = null;
        this.reconnectAttempt++;
        this.log(`closed with ${code}, reconnecting in ${delay} ms`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    /**
     * Drops the socket hard (no close handshake), as a lost connection
     * would, and comes back after holdMs with the session token.
     * holdMs = Infinity: stays away (the grace time runs out).
     */
    dropConnection(holdMs: number): void {
        const ws = this.ws;
        if (!ws) return;
        this.stats.drops++;
        const now = performance.now();
        ++this.generation;
        this.link?.close();
        this.link = null;
        this.ws = null;
        this.inRoom = false;
        ws.terminate();
        this.stats.closes.push({ at: now, code: 1006, own: true });
        this.net.suspend(now);
        this.log(`dropped the connection${Number.isFinite(holdMs) ? `, back in ${Math.round(holdMs)} ms` : ' for good'}`);
        if (Number.isFinite(holdMs)) this.reconnectTimer = setTimeout(() => this.connect(), holdMs);
    }

    /** Moves to a room of the other kind (or of kind). */
    switchRoom(kind?: RoomKind): void {
        const target = kind ?? (this.room?.kind === 'party' ? 'freeroam' : 'party');
        this.stats.hops++;
        this.log(`switching to ${target}`);
        this.sendJson({ type: 'joinRoom', kind: target });
    }

    /** Puts the own car at rest there (servers started with E2E=1 only). */
    place(x: number, z: number, yaw: number): void {
        this.sendJson({ type: 'debugPlace', x, z, yaw });
    }

    /** Closes the socket for good; resolves once it is closed. */
    stop(): Promise<void> {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const ws = this.ws;
        this.link?.close();
        this.link = null;
        if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                ws.terminate();
                resolve();
            }, 2000);
            ws.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.close(1000, 'bot done');
        });
    }

    // ---- Messages ----

    private onFrame(data: Buffer, isBinary: boolean): void {
        if (isBinary) {
            this.onSnapshot(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            return;
        }
        let msg: ServerMessage;
        try {
            msg = JSON.parse(data.toString()) as ServerMessage;
        } catch {
            this.error('malformed JSON from the server');
            return;
        }
        this.onMessage(msg, performance.now());
    }

    private onMessage(msg: ServerMessage, now: number): void {
        switch (msg.type) {
            case 'reject':
                this.stats.rejects.push(msg.reason);
                if (msg.reason !== 'full') this.error(`rejected: ${msg.reason}`);
                return;
            case 'welcome':
                this.onWelcome(msg, now);
                return;
            case 'roomState':
                this.onRoomState(msg, now);
                return;
            case 'playerJoined':
                this.net.setMember(msg.member);
                return;
            case 'playerLeft':
                this.net.removeMember(msg.id);
                this.seen.delete(msg.id);
                return;
            case 'playerUpdated': {
                const member = this.net.members.get(msg.id);
                if (!member) return;
                const next: MemberInfo = {
                    ...member,
                    ...(msg.name !== undefined ? { name: msg.name } : {}),
                    ...(msg.carType !== undefined ? { carType: msg.carType } : {}),
                    ...(msg.profile !== undefined ? { profile: msg.profile } : {})
                };
                this.net.setMember(next);
                return;
            }
            case 'pong':
                this.net.clock.addSample(msg.t, now, msg.tick, msg.sub);
                return;
            case 'events':
                for (const event of msg.list) this.onEvent(event, now);
                return;
            case 'scoreboard':
                return;
            case 'kicked':
                this.stats.kicked = msg.reason;
                if (this.mode !== 'flood') this.error(`kicked: ${msg.reason}`);
                return;
            case 'shutdown':
                this.restartDelayMs = Math.max(0, Math.min(10_000, msg.reconnectInMs));
                this.resumeTicket = msg.resume ?? null;
                return;
            case 'raceState': {
                const { type: _type, ...state } = msg;
                this.race.messages.push(msg);
                this.onRaceState(state);
                return;
            }
            case 'raceStatus':
            case 'raceResults':
            case 'ghostData':
                this.race.messages.push(msg);
                return;
        }
    }

    /** The race messages of one type, in order. */
    raceMessages<T extends RaceMessage['type']>(type: T): Extract<RaceMessage, { type: T }>[] {
        return this.race.messages.filter((m): m is Extract<RaceMessage, { type: T }> => m.type === type);
    }

    /** The race events of one type (gate, finish, launch, wrongWay), in order. */
    raceEvents<T extends GameEvent['type']>(type: T): Extract<GameEvent, { type: T }>[] {
        return this.race.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
    }

    private raceWorld(track: TrackId): SimWorld {
        let world = this.raceWorlds.get(track);
        if (!world) {
            world = createRaceWorld(this.map!, TRACKS[track]);
            this.raceWorlds.set(track, world);
        }
        return world;
    }

    // The race state: the prediction drives in the track's race world with
    // the race rules; the bot picks its track and says ready in the lobby
    private onRaceState(state: RaceStateBody): void {
        const before = this.race.state;
        this.race.state = state;
        const p = this.net.prediction;
        if (p && this.map) {
            p.world = this.raceWorld(state.trackId);
            p.filterInput = (tick, input) => { raceInputFilter(this.phaseAt(tick), tick, this.race.state?.startTick ?? null, input); };
            p.ghostFloor = (tick, car) => { raceGhostFloor(this.phaseAt(tick), tick, this.race.state?.startTick ?? null, car); };
        }
        if (!before || before.trackId !== state.trackId) this.raceCourse = createCourse(TRACKS[state.trackId]);
        if (state.phase === 'countdown' && state.startTick !== null && this.raceDriverFor !== state.startTick) {
            this.raceDriverFor = state.startTick;
            this.raceDriver = null;
            this.raceProgress = createRaceProgress();
        }
        if (state.phase !== 'lobby' || (this.mode !== 'race' && this.mode !== 'timetrial')) return;
        const want = this.options.track;
        if (!this.raceConfigSent && ((want && want !== state.trackId) || this.options.serverBotLevel)) {
            this.raceConfigSent = true;
            this.sendJson({
                type: 'raceConfig',
                ...(want && want !== state.trackId ? { track: want } : {}),
                ...(this.options.serverBotLevel ? { botLevel: this.options.serverBotLevel } : {})
            });
        }
        if ((!want || want === state.trackId) && this.playerId && !state.ready.includes(this.playerId)) {
            this.sendJson({ type: 'raceReady', ready: true });
        }
    }

    // The phase the rules of tick t see: frozen before startTick
    private phaseAt(tick: number): RacePhase {
        const state = this.race.state;
        return racePhaseAt(state?.phase ?? null, state?.startTick ?? null, tick);
    }

    /** Puts the race bot's own input packet with a tick offset on the wire (manipulation tests). */
    sendInputAhead(ticksAhead: number, input: VehicleInput): void {
        const p = this.net.prediction;
        if (!p || p.tick < 0) return;
        this.sendBinary(encodeInputPacket({ flags: 0, seq: p.seq + 1000, tick: p.tick + ticksAhead, inputs: [input] }));
    }

    /** Sends raw bytes as a binary frame (a malformed packet in the tests). */
    sendRawBinary(bytes: Uint8Array): void {
        this.sendBinary(bytes);
    }

    private onWelcome(msg: Extract<ServerMessage, { type: 'welcome' }>, now: number): void {
        this.sessionToken = msg.sessionToken;
        this.resumeTicket = null;
        this.reconnectAttempt = 0;
        this.stats.welcomes.push({ at: now, playerId: msg.playerId, resumed: msg.resumed });
        if (this.playerId && this.playerId !== msg.playerId) this.log(`new session ${msg.playerId}`);
        this.playerId = msg.playerId;
        if (!this.car) this.car = createSimCar(msg.playerId, this.options.carType);
        this.car.id = msg.playerId;
    }

    private onRoomState(msg: Extract<ServerMessage, { type: 'roomState' }>, now: number): void {
        const map = mapFor(msg.world.seed);
        if (map.worldHash !== msg.world.worldHash) this.error(`world ${map.worldHash} differs from the server's ${msg.world.worldHash}`);
        const id = this.playerId ?? '';
        const car = this.car ?? (this.car = createSimCar(id, this.options.carType));
        this.room = msg.room;
        const self = msg.members.find(m => m.id === id);
        this.slot = self?.slot ?? -1;
        this.stats.rooms.push({ at: now, room: msg.room, slot: this.slot, resumed: !!msg.resume });
        this.map = map;
        this.net.enterRoom(map.simWorld, msg.room.kind === 'party', msg.members, car, id);
        this.race.state = null;
        this.raceConfigSent = false;
        if (msg.race) this.onRaceState(msg.race);
        if (msg.resume) this.net.resumeOwn(msg.resume);
        this.net.clock.reset();
        this.seen.clear();
        this.lastSnapshot = null;
        this.pingsSent = 0;
        this.nextPingAt = now;
        this.inRoom = true;
        this.driver.restart();
        this.dead = !!msg.resume && !msg.resume.alive && !!self?.ready && msg.room.kind === 'party';
        // Past the (imaginary) splash screen: drive. A resumed car goes on
        // as it is; the server ignores a second 'ready'
        if (!msg.resume?.alive && !this.dead) this.sendJson({ type: 'ready' });
        this.scheduleModes(now);
    }

    private scheduleModes(now: number): void {
        const o = this.options;
        const spread = (ms: number) => ms * (0.7 + 0.6 * this.random());
        if (this.mode === 'reconnect' && !Number.isFinite(this.nextDropAt)) this.nextDropAt = now + spread(o.dropEveryMs);
        if (this.mode === 'hop' && !Number.isFinite(this.nextHopAt)) this.nextHopAt = now + spread(o.hopEveryMs);
        if (this.mode === 'ram' && this.nextRamAt === 0) this.nextRamAt = now + spread(o.ramEveryMs) / 2;
    }

    private onEvent(event: GameEvent, now: number): void {
        const own = this.net.applyEvent(event);
        switch (event.type) {
            case 'gate':
            case 'finish':
            case 'launch':
            case 'wrongWay':
                this.race.events.push(event);
                if (event.type === 'gate' && event.id === this.playerId) {
                    this.raceProgress.passed = event.passed;
                    this.raceProgress.lap = event.lap;
                }
                if (event.type === 'finish' && event.id === this.playerId) this.raceProgress.status = 'finished';
                return;
            case 'spawn':
            case 'respawn':
                if (!own) return;
                this.stats.spawns++;
                this.dead = false;
                this.spawnedAt = now;
                this.driver.restart();
                if (this.mode === 'flood' && !Number.isFinite(this.floodAt)) this.floodAt = now + this.options.floodAfterMs;
                return;
            case 'killed':
                if (own) {
                    this.stats.deaths++;
                    this.dead = true;
                }
                return;
            case 'contact': {
                const id = this.playerId;
                if (event.a !== id && event.b !== id) return;
                this.stats.contacts.push({ at: now, other: event.a === id ? event.b : event.a, dv: event.dv });
                return;
            }
            default:
                return;
        }
    }

    private onSnapshot(bytes: Uint8Array): void {
        const now = performance.now();
        const snap = decodeSnapshot(bytes);
        if (!snap) {
            this.stats.malformed++;
            this.error('malformed snapshot');
            return;
        }
        if (!this.inRoom) return;
        const c = this.stats.counters;
        c.snapshots++;
        if (snap.self) {
            c.selfSnapshots++;
            if (snap.self.flags & CAR_LAGGY) c.laggySnapshots++;
            if (snap.self.flags & CAR_IDLE) c.idleSnapshots++;
        }
        for (const car of snap.cars) {
            if (![car.x, car.y, car.z, car.yaw, car.vx, car.vy, car.vz, car.yawRate].every(Number.isFinite)) {
                this.stats.nonFinite++;
                continue;
            }
            const id = this.net.idForSlot(car.slot);
            if (!id) continue;
            const seen = this.seen.get(id);
            if (seen) {
                seen.x = car.x; seen.z = car.z; seen.vx = car.vx; seen.vz = car.vz;
                seen.flags = car.flags; seen.serverTick = snap.serverTick; seen.at = now;
            } else {
                this.seen.set(id, { x: car.x, z: car.z, vx: car.vx, vz: car.vz, flags: car.flags, serverTick: snap.serverTick, at: now });
            }
        }
        // Cars that are no longer in the snapshots
        for (const [id, seen] of this.seen) if (seen.serverTick !== snap.serverTick) this.seen.delete(id);
        this.lastSnapshot = snap;
        this.net.reconcileSnapshot(snap, now);
        const s = this.ownState;
        if (s && ![s.x, s.y, s.z, s.vx, s.vz, s.yaw].every(Number.isFinite)) {
            this.stats.nonFinite++;
            this.error('non-finite own state after a correction');
        }
    }

    // ---- Driving ----

    /** Runs the clock pings, the due ticks and the mode's schedule; call every few ms. */
    pump(now = performance.now()): void {
        if (this.stoppedForGood) return;
        this.runSchedule(now);
        if (!this.inRoom || !this.ws) return;
        if (now >= this.nextPingAt && this.net.prediction) {
            this.sendJson({ type: 'ping', t: now });
            this.pingsSent++;
            this.nextPingAt = now + (this.pingsSent < CLOCK_BURST_PINGS ? CLOCK_BURST_INTERVAL_MS : CLOCK_INTERVAL_MS);
        }
        this.net.advanceFrame(now, () => this.runTick(now));
        if (this.mode === 'idle') return;
        this.net.flushInputs();
        if (this.mode === 'flood' && now >= this.floodAt) this.flood();
    }

    private runSchedule(now: number): void {
        if (now >= this.nextDropAt && this.ws && this.inRoom) {
            const o = this.options;
            this.nextDropAt = now + o.dropEveryMs * (0.7 + 0.6 * this.random());
            this.dropConnection(o.reconnectMinMs + this.random() * (o.reconnectMaxMs - o.reconnectMinMs));
        }
        if (now >= this.nextHopAt && this.inRoom) {
            this.nextHopAt = now + this.options.hopEveryMs * (0.85 + 0.3 * this.random());
            this.switchRoom();
        }
    }

    private runTick(now: number): void {
        const input = this.input;
        const p = this.net.prediction!;
        input.steer = input.throttle = input.brake = input.buttons = 0;
        if (p.spawned && !this.dead) {
            if (this.mode === 'race' || this.mode === 'timetrial') {
                this.raceTick(p.tick + 1, p.car.state, p.car.params, input);
            } else if (this.mode === 'manual') {
                Object.assign(input, this.manualInput);
            } else if (this.mode !== 'idle') {
                this.driver.drive(p.car.state, p.car.params, input, this.chaseTarget(now, p.car.state, p.tick));
            }
        }
        this.net.tickWith(input, 0);
    }

    // Modes race and timetrial: the line driver on the own prediction,
    // unless the test scripts the tick; a missed gate holds reset (the
    // server puts the car back before the gate)
    private raceTick(tick: number, s: VehicleState, params: VehicleParams, input: VehicleInput): void {
        const state = this.race.state;
        const self = this.playerId;
        if (!state || !self || state.startTick === null || !state.racers.some(r => r.id === self)) return;
        if (state.phase === 'results' || this.raceProgress.status !== 'racing') return;
        if (this.raceOverride?.(tick, state.startTick, s, input)) return;
        const course = this.raceCourse!;
        if (!this.raceDriver) {
            this.raceDriver = new LineDriver(course, params, this.options.driverLevel, mulberry32(this.options.seed * 31 + state.startTick));
            this.raceDriver.startRace(state.startTick);
        }
        if (tick >= state.startTick) {
            trackLine(this.raceProgress, course, s.x, s.z, false);
            if (this.raceProgress.missedGate) this.raceDriver.requestReset();
        }
        this.raceDriver.drive(s, params, tick, state.startTick, this.traffic(tick), input);
    }

    // The other cars where they are now, from the last snapshots
    private traffic(tick: number): TrafficCar[] {
        const out: TrafficCar[] = [];
        for (const car of this.seen.values()) {
            const ahead = Math.max(0, tick - car.serverTick) * TICK_MS / 1000;
            out.push({ x: car.x + car.vx * ahead, z: car.z + car.vz * ahead, vx: car.vx, vz: car.vz });
        }
        return out;
    }

    // Mode ram: the nearest car in range, where it will be, for a few
    // seconds every ramEveryMs
    private chaseTarget(now: number, s: VehicleState, tick: number): ChaseTarget | null {
        if (this.mode !== 'ram') return null;
        if (now >= this.ramUntil) {
            if (now < this.nextRamAt) return null;
            this.nextRamAt = now + this.options.ramEveryMs * (0.7 + 0.6 * this.random());
            this.ramUntil = now + 4000;
        }
        let best: SeenCar | null = null, bestD = this.options.ramRange;
        for (const car of this.seen.values()) {
            const d = Math.hypot(car.x - s.x, car.z - s.z);
            if (d < bestD) {
                best = car;
                bestD = d;
            }
        }
        if (!best) return null;
        const ahead = Math.max(0, tick - best.serverTick) * TICK_MS / 1000;
        this.chase.x = best.x + best.vx * ahead;
        this.chase.z = best.z + best.vz * ahead;
        this.chase.vx = best.vx;
        this.chase.vz = best.vz;
        return this.chase;
    }

    // Mode flood: far more input packets than any client sends
    private flood(): void {
        const p = this.net.prediction;
        if (!p || p.tick < 0) return;
        const bytes = encodeInputPacket({ flags: 0, seq: p.seq, tick: p.tick, inputs: [this.input] });
        for (let i = 0; i < 12; i++) this.sendBinary(bytes);
    }

    /** A copy of the counters now (rates come from two samples). */
    sample(now = performance.now()): BotCounters {
        return { ...this.stats.counters, at: now };
    }
}

/** Rates between two samples of the same bot. */
export function rates(a: BotCounters, b: BotCounters): { seconds: number; bytesInPerSec: number; snapshotsPerSec: number; bytesOutPerSec: number } {
    const seconds = Math.max(1e-3, (b.at - a.at) / 1000);
    return {
        seconds,
        bytesInPerSec: (b.bytesIn - a.bytesIn) / seconds,
        snapshotsPerSec: (b.snapshots - a.snapshots) / seconds,
        bytesOutPerSec: (b.bytesOut - a.bytesOut) / seconds
    };
}
