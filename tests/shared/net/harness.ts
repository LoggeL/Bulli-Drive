import { handleClientMessage } from '../../../src/server/dispatch.js';
import { mapFor } from '../../../src/server/maps.js';
import { RoomManager } from '../../../src/server/rooms/lobby.js';
import { roomOptions } from '../../../src/server/rooms/Room.js';
import { Session, type Transport } from '../../../src/server/session.js';
import { NetClient } from '../../../src/shared/net/client.js';
import { decodeInputPacket, decodeSnapshot } from '../../../src/shared/net/codec.js';
import { CLOCK_BURST_PINGS, TICK_MS } from '../../../src/shared/net/constants.js';
import type { ReconcileResult } from '../../../src/shared/net/prediction.js';
import { createPose, interpolatePose, type Pose } from '../../../src/shared/net/renderOffset.js';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import type { ClientMessage, RoomKind, ServerMessage } from '../../../src/shared/protocol.js';
import { createVehicleInput, createVehicleState, type CarClassId, type SimCar, type VehicleInput } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';

// A whole game without sockets and without a browser: the real server
// rooms, and clients made of the shared NetClient, connected by links with
// latency, jitter and loss in simulated time (docs/phase-1b-design.md, 15.1).
// Everything is seeded; the same run gives the same numbers.

export interface LinkOptions {
    // One way, ms
    latencyMs: number;
    // Uniform ±jitter/2 per message, ms
    jitterMs: number;
    // Share of messages "lost": in TCP mode delivered 200 ms + RTT late,
    // with everything after it waiting behind (head-of-line blocking)
    loss: number;
}

export const NO_NET: LinkOptions = { latencyMs: 0, jitterMs: 0, loss: 0 };

// One direction of a connection: ordered like TCP
export class Link {
    private readonly queue: { at: number; deliver: () => void }[] = [];
    private lastAt = 0;
    constructor(private readonly options: LinkOptions, private readonly random: () => number) {}

    send(now: number, deliver: () => void): void {
        const o = this.options;
        let at = now + o.latencyMs + (this.random() - 0.5) * o.jitterMs;
        if (o.loss > 0 && this.random() < o.loss) at += 200 + 2 * o.latencyMs;
        at = Math.max(at, this.lastAt);
        this.lastAt = at;
        this.queue.push({ at, deliver });
    }

    deliverUntil(now: number): void {
        while (this.queue.length && this.queue[0].at <= now) this.queue.shift()!.deliver();
    }

    /** The connection broke: nothing in flight arrives. */
    clear(): void {
        this.queue.length = 0;
        this.lastAt = 0;
    }
}

export class TestServer {
    readonly lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
    time = 0;
    private nextStep = 0;

    constructor() {
        roomOptions.allowDebugPlace = true;
    }

    /** Runs the rooms up to time now (ms). */
    advance(now: number): void {
        while (this.nextStep <= now) {
            this.time = this.nextStep;
            this.lobby.stepAll(this.nextStep);
            this.nextStep += TICK_MS;
        }
        this.time = now;
    }

    dispose(): void {
        for (const room of this.lobby.list()) room.dispose();
        roomOptions.allowDebugPlace = false;
    }
}

export type InputScript = (tick: number, client: TestClient) => VehicleInput;

let nextClientId = 1;

export class TestClient {
    readonly id: string;
    readonly net: NetClient;
    readonly session: Session;
    readonly car: SimCar;
    readonly results: { tick: number; result: ReconcileResult }[] = [];
    readonly events: ServerMessage[] = [];
    private readonly up: Link;
    private readonly down: Link;
    private pingsSent = 0;
    private nextPingAt = 0;
    // A clock that is off from the server's by this much (a jump in a test)
    clockSkewMs = 0;
    // The socket is up (disconnect / reconnect in a test)
    online = true;
    script: InputScript = () => createVehicleInput();
    private readonly input = createVehicleInput();

    constructor(
        readonly server: TestServer,
        name: string,
        classId: CarClassId = 'bulli',
        net: LinkOptions = NO_NET,
        seed = nextClientId,
        kind: RoomKind = 'freeroam'
    ) {
        this.id = `client-${String(nextClientId++).padStart(3, '0')}-${name}`;
        const random = mulberry32(seed * 7919);
        this.up = new Link(net, random);
        this.down = new Link(net, random);
        this.car = createSimCar(this.id, classId);
        this.net = new NetClient(bytes => {
            if (!this.online) return;
            const copy = bytes.slice();
            this.up.send(this.server.time, () => {
                const packet = decodeInputPacket(copy);
                const member = this.session.member;
                if (packet && member && this.session.room) this.session.room.onInput(member, packet, this.server.time);
            });
        });
        this.session = new Session(this.id, this.transport(), name, 0x336699);
        this.session.carType = classId;
        this.server.lobby.join(this.session, kind);
    }

    // A socket to the server: open until the client drops it
    private transport(): Transport {
        const client = this;
        let open = true;
        const transport: Transport & { drop(): void } = {
            get readyState() { return open ? 1 : 3; },
            bufferedAmount: 0,
            send: data => {
                if (!open) return;
                const copy = typeof data === 'string' ? data : data.slice();
                this.down.send(this.server.time, () => { if (open) client.receive(copy); });
            },
            close: () => { open = false; },
            drop: () => { open = false; }
        };
        return transport;
    }

    /** The connection breaks: nothing in flight arrives, the server starts the grace time. */
    disconnect(): void {
        this.online = false;
        (this.session.transport as Transport & { drop(): void }).drop();
        this.up.clear();
        this.down.clear();
        this.session.disconnectedAt = this.server.time;
        this.net.suspend(this.now);
    }

    /** Back on a new socket with the session token: the server resumes the member (11.1). */
    reconnect(): void {
        this.online = true;
        this.session.attach(this.transport());
        const room = this.session.room!, member = this.session.member!;
        room.resume(member);
    }

    private get now(): number {
        return this.server.time + this.clockSkewMs;
    }

    sendJson(msg: ClientMessage): void {
        if (!this.online) return;
        const text = JSON.stringify(msg);
        this.up.send(this.server.time, () => handleClientMessage(this.server.lobby, this.session, JSON.parse(text), this.server.time));
    }

    private receive(data: string | Uint8Array): void {
        const now = this.now;
        if (typeof data !== 'string') {
            const snap = decodeSnapshot(data);
            if (!snap) throw new Error('malformed snapshot');
            const result = this.net.reconcileSnapshot(snap, now);
            if (result) this.results.push({ tick: snap.serverTick, result });
            return;
        }
        const msg = JSON.parse(data) as ServerMessage;
        this.events.push(msg);
        switch (msg.type) {
            case 'roomState':
                this.net.enterRoom(mapFor().simWorld, msg.room.kind === 'party', msg.members, this.car, this.id);
                if (msg.resume) this.net.resumeOwn(msg.resume);
                this.net.clock.reset();
                this.pingsSent = 0;
                this.nextPingAt = now;
                return;
            case 'playerJoined':
                this.net.setMember(msg.member);
                return;
            case 'playerLeft':
                this.net.removeMember(msg.id);
                return;
            case 'pong':
                this.net.clock.addSample(msg.t, now, msg.tick, msg.sub);
                return;
            case 'events':
                for (const event of msg.list) this.net.applyEvent(event);
                return;
            default:
                return;
        }
    }

    /** Delivers what arrived, pings, runs the due ticks and sends the inputs. */
    pump(): void {
        const now = this.now;
        this.up.deliverUntil(this.server.time);
        this.down.deliverUntil(this.server.time);
        if (now >= this.nextPingAt && this.net.prediction) {
            this.sendJson({ type: 'ping', t: now });
            this.pingsSent++;
            this.nextPingAt = now + (this.pingsSent < CLOCK_BURST_PINGS ? 100 : 1000);
        }
        this.net.advanceFrame(now, () => {
            const script = this.script(this.net.tick + 1, this);
            this.input.steer = script.steer;
            this.input.throttle = script.throttle;
            this.input.brake = script.brake;
            this.input.buttons = script.buttons;
            this.net.tickWith(this.input, 0);
        });
        this.net.flushInputs();
    }

    /** The server's car of this client. */
    get serverCar(): SimCar | null {
        return this.session.member?.car ?? null;
    }
}

/** Runs server and clients for ms of simulated time in steps of stepMs. */
export function run(server: TestServer, clients: TestClient[], ms: number, stepMs = 4, each?: () => void): void {
    const end = server.time + ms;
    while (server.time < end) {
        const now = Math.min(end, server.time + stepMs);
        server.advance(now);
        for (const client of clients) client.pump();
        each?.();
    }
}

export function input(throttle: number, steer = 0, brake = 0, buttons = 0): VehicleInput {
    return { steer, throttle, brake, buttons };
}

/**
 * Renders a client's own car at 60 fps in simulated time, as the browser
 * would: the prediction's pose plus the render offset, which fades each
 * frame. Per frame it measures the jump: how far the picture moved beyond
 * the car's own motion on the (possibly corrected) predicted path. Without
 * the offset a correction would show up here as a jump of its full size.
 */
export class FrameProbe {
    readonly frameMs = 1000 / 60;
    private nextFrame = 0;
    private last: { tick: number; alpha: number; shown: Pose; raw: Pose } | null = null;
    // Jump of every frame (m), frames right after a snap left out
    readonly jumps: number[] = [];
    // The jump the same frames would have shown without the offset (m)
    readonly rawJumps: number[] = [];
    // Frames with a hard snap (camera jump) and the time of each frame
    snaps = 0;
    readonly times: number[] = [];
    readonly offsets: number[] = [];
    // Remote cars of the contact set: how far their picture moved in a
    // frame beyond what their speed explains (m)
    readonly remoteJumps: number[] = [];
    readonly remoteRawJumps: number[] = [];
    private readonly remoteLast = new Map<string, { shown: Pose; raw: Pose; speed: number }>();
    private readonly shown = createPose();
    private readonly a = createPose();
    private readonly b = createPose();
    private readonly s0 = createVehicleState();
    private readonly s1 = createVehicleState();

    constructor(readonly client: TestClient) {}

    /** Renders the frames due by now (ms). */
    update(now: number): void {
        if (this.nextFrame === 0) this.nextFrame = now;
        while (this.nextFrame <= now) {
            this.frame(this.nextFrame);
            this.nextFrame += this.frameMs;
        }
    }

    // The pose on the current predicted path at an earlier frame's (tick, alpha)
    private pathPose(tick: number, alpha: number, out: Pose): Pose | null {
        const p = this.client.net.prediction!;
        if (!p.stateAt(tick - 1, this.s0) || !p.stateAt(tick, this.s1)) return null;
        return interpolatePose(this.s0, this.s1, alpha, out);
    }

    private remoteFrame(alpha: number): void {
        const p = this.client.net.prediction!;
        const seen = new Set<string>();
        for (const remote of p.remotes.values()) {
            seen.add(remote.id);
            const raw = interpolatePose(remote.prev, remote.car.state, alpha, createPose());
            const shown = remote.offset.applyTo({ ...raw });
            const last = this.remoteLast.get(remote.id);
            const a = remote.prev, b = remote.car.state;
            // The frame spans parts of two ticks: the fastest of the speeds involved
            const speed = Math.max(Math.hypot(a.vx, a.vz), Math.hypot(b.vx, b.vz));
            if (last) {
                const reach = Math.max(speed, last.speed) * this.frameMs / 1000;
                this.remoteJumps.push(Math.max(0, Math.hypot(shown.x - last.shown.x, shown.z - last.shown.z) - reach));
                this.remoteRawJumps.push(Math.max(0, Math.hypot(raw.x - last.raw.x, raw.z - last.raw.z) - reach));
            }
            this.remoteLast.set(remote.id, { shown, raw, speed });
        }
        for (const id of [...this.remoteLast.keys()]) if (!seen.has(id)) this.remoteLast.delete(id);
    }

    private frame(now: number): void {
        const net = this.client.net;
        net.decayOffsets(this.frameMs, now);
        const p = net.prediction;
        if (!p || !p.spawned || p.tick < 0 || !net.shownPose(now, this.shown)) {
            this.last = null;
            return;
        }
        const tick = p.tick, alpha = net.renderAlpha(now);
        this.remoteFrame(alpha);
        const snapped = net.cameraSnap;
        net.cameraSnap = false;
        if (snapped) this.snaps++;
        const last = this.last;
        if (last && !snapped) {
            const before = this.pathPose(last.tick, last.alpha, this.a);
            const nowPose = this.pathPose(tick, alpha, this.b);
            if (before && nowPose) {
                const jx = (this.shown.x - last.shown.x) - (nowPose.x - before.x);
                const jz = (this.shown.z - last.shown.z) - (nowPose.z - before.z);
                this.jumps.push(Math.hypot(jx, jz));
                // Without an offset the picture would jump from the old
                // path to the new one
                this.rawJumps.push(Math.hypot(before.x - last.raw.x, before.z - last.raw.z));
                this.times.push(now);
                this.offsets.push(net.offset.size);
            }
        }
        const o = net.offset;
        this.last = {
            tick, alpha, shown: { ...this.shown },
            raw: { x: this.shown.x - o.x, y: this.shown.y - o.y, z: this.shown.z - o.z, yaw: this.shown.yaw - o.yaw }
        };
    }
}
