import type { ServerMessage } from '../../src/shared/protocol.js';
import { Session, type Transport } from '../../src/server/session.js';

// A socket that records what the server sends
export class FakeTransport implements Transport {
    readyState = 1;
    bufferedAmount = 0;
    readonly sent: ServerMessage[] = [];
    closed: { code?: number; reason?: string } | null = null;

    send(data: string): void {
        this.sent.push(JSON.parse(data));
    }

    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
        this.readyState = 3;
    }

    // Messages of one type, in the order they were sent
    of<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
        return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    }

    clear(): void {
        this.sent.length = 0;
    }
}

let nextId = 1;

export function fakeSession(name = `Tester ${nextId}`): Session & { transport: FakeTransport } {
    const id = `player-${nextId++}`;
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
