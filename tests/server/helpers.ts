import type { GameEvent, ServerMessage } from '../../src/shared/protocol.js';
import { decodeSnapshot, type Snapshot } from '../../src/shared/net/codec.js';
import { Session, type Transport } from '../../src/server/session.js';
import type { Room } from '../../src/server/rooms/Room.js';
import { handleClientMessage } from '../../src/server/dispatch.js';
import type { RoomManager } from '../../src/server/rooms/lobby.js';

// A socket that records what the server sends: JSON messages and the
// binary snapshots (decoded)
export class FakeTransport implements Transport {
    readyState = 1;
    bufferedAmount = 0;
    readonly sent: ServerMessage[] = [];
    readonly snapshots: Snapshot[] = [];
    closed: { code?: number; reason?: string } | null = null;

    send(data: string | Uint8Array): void {
        if (typeof data === 'string') this.sent.push(JSON.parse(data));
        else this.snapshots.push(decodeSnapshot(data)!);
    }

    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
        this.readyState = 3;
    }

    // Messages of one type, in the order they were sent
    of<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
        return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    }

    // Every event received, in order
    events<T extends GameEvent['type']>(type?: T): Array<Extract<GameEvent, { type: T }>> {
        return this.of('events').flatMap(m => m.list)
            .filter((e): e is Extract<GameEvent, { type: T }> => !type || e.type === type);
    }

    get lastSnapshot(): Snapshot | undefined {
        return this.snapshots.at(-1);
    }

    clear(): void {
        this.sent.length = 0;
        this.snapshots.length = 0;
    }
}

let nextId = 1;

export function fakeSession(name = `Tester ${nextId}`): Session & { transport: FakeTransport } {
    // Ids sort in creation order (the order of every rule and of stepWorld)
    const id = `player-${String(nextId++).padStart(4, '0')}`;
    return new Session(id, new FakeTransport(), name, 0xff0000) as Session & { transport: FakeTransport };
}

// A controllable clock (ms)
export function fakeClock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
    let time = start;
    return {
        now: () => time,
        advance(ms: number) { time += ms; }
    };
}

/** Marks the session ready (past the splash screen). */
export function ready(lobby: RoomManager, session: Session, now = 0): void {
    handleClientMessage(lobby, session, { type: 'ready' }, now);
}

/** Runs the room n ticks. */
export function steps(room: Room, n: number, nowMs = 0): void {
    for (let i = 0; i < n; i++) room.step(nowMs);
}

/** Feeds the member one input for the room's next tick. */
export function feed(room: Room, session: Session, input: { steer?: number; throttle?: number; brake?: number; buttons?: number } = {}, flags = 0): void {
    const tick = room.tick + 1;
    room.onInput(session.member!, {
        flags, seq: tick, tick,
        inputs: [{ steer: input.steer ?? 0, throttle: input.throttle ?? 0, brake: input.brake ?? 0, buttons: input.buttons ?? 0 }]
    }, 0);
}
