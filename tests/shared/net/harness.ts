import { handleClientMessage } from '../../../src/server/dispatch.js';
import { mapFor } from '../../../src/server/maps.js';
import { RoomManager } from '../../../src/server/rooms/lobby.js';
import { roomOptions } from '../../../src/server/rooms/Room.js';
import { Session, type Transport } from '../../../src/server/session.js';
import { NetClient } from '../../../src/shared/net/client.js';
import { decodeInputPacket, decodeSnapshot } from '../../../src/shared/net/codec.js';
import { CLOCK_BURST_PINGS, TICK_MS } from '../../../src/shared/net/constants.js';
import type { ReconcileResult } from '../../../src/shared/net/prediction.js';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import type { ClientMessage, RoomKind, ServerMessage } from '../../../src/shared/protocol.js';
import { createVehicleInput, type CarClassId, type SimCar, type VehicleInput } from '../../../src/shared/sim/types.js';
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
            const copy = bytes.slice();
            this.up.send(this.server.time, () => {
                const packet = decodeInputPacket(copy);
                const member = this.session.member;
                if (packet && member && this.session.room) this.session.room.onInput(member, packet, this.server.time);
            });
        });
        const transport: Transport = {
            readyState: 1,
            bufferedAmount: 0,
            send: data => {
                const copy = typeof data === 'string' ? data : data.slice();
                this.down.send(this.server.time, () => this.receive(copy));
            },
            close: () => { /* not in these tests */ }
        };
        this.session = new Session(this.id, transport, name, 0x336699);
        this.session.carType = classId;
        this.server.lobby.join(this.session, kind);
    }

    private get now(): number {
        return this.server.time + this.clockSkewMs;
    }

    sendJson(msg: ClientMessage): void {
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
