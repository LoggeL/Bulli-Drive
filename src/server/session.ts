import type { ProfileId, ServerMessage } from '../shared/protocol.js';
import type { Room, RoomMember } from './rooms/Room.js';

// One connection (docs/phase-1b-design.md, 2.1): who the player is and what
// stays when they change rooms. The car, HP and score belong to the room
// membership instead.

// What a session needs from its socket. The ws WebSocket fits; tests pass a
// recording fake.
export interface Transport {
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
}

const OPEN = 1;
// Snapshots are skipped for a client whose socket is this far behind (the
// next one replaces them anyway, 5.6)
export const SNAPSHOT_SKIP_BYTES = 64 * 1024;

// Input packets: a token bucket of 150 per second with a burst of 30
// (5.2); more is dropped. Sustained floods and invalid messages kick.
export const INPUT_RATE = 150;
export const INPUT_BURST = 30;
export const FLOOD_RATE = 240;
export const FLOOD_WINDOW_MS = 2000;
export const INVALID_LIMIT = 10;
// JSON messages (everything but inputs): a token bucket of 20 per second
// with a burst of 40. A real client sends a handful per second at most
// (clock pings, honk, shots); more is dropped, and a sustained flood kicks
// like an input flood. Holds for every message type, also future ones
// without a limit of their own.
export const MESSAGE_RATE = 20;
export const MESSAGE_BURST = 40;
export const MESSAGE_FLOOD_RATE = 60;
export const INVALID_WINDOW_MS = 10_000;
const RTT_SAMPLES = 5;

export class Session {
    readonly id: string;
    // The socket; a resumed session gets the new one (attach)
    transport: Transport;
    readonly token: string;
    // Since when the socket is gone (ms, the server clock), -1 while
    // connected: the session waits GRACE_MS for the player (11.1)
    disconnectedAt = -1;
    // Score carried over a restart by a resume ticket (11.3); the Party
    // takes it on join
    carryScore = 0;
    // Random per page load (duplicated tabs, 11.1)
    connId = '';
    // The page's build stamp from 'hello'
    build: string | null = null;
    name: string;
    color: number;
    carType = 'bulli';
    profile: ProfileId = 'standard';
    room: Room | null = null;
    member: RoomMember | null = null;
    // Round trip from the WebSocket pings (ms), -1 = not measured yet: the
    // median of the last few, so one hang of the server or the page does not
    // count as a slow connection
    rttMs = -1;
    private readonly rttSamples: number[] = [];
    // Rate-limit bookkeeping (ms timestamps)
    lastHonkAt = 0;
    lastRenameAt = 0;
    lastJoinRoomAt = 0;
    lastPingAt = 0;
    private inputTokens = INPUT_BURST;
    private inputRefillAt = -1;
    private floodWindowStart = -1;
    private floodCount = 0;
    private readonly invalidAt: number[] = [];
    private messageTokens = MESSAGE_BURST;
    private messageRefillAt = -1;
    private messageWindowStart = -1;
    private messageCount = 0;
    // An input packet arrived on this session: a player, not a bare socket
    // (a session without one leaves at once when its socket closes)
    sentInput = false;
    // Bytes sent, for metrics
    bytesOut = 0;
    kicked = false;

    constructor(id: string, transport: Transport, name: string, color: number, token = '') {
        this.id = id;
        this.transport = transport;
        this.name = name;
        this.color = color;
        this.token = token;
    }

    noteRtt(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) return;
        this.rttSamples.push(ms);
        if (this.rttSamples.length > RTT_SAMPLES) this.rttSamples.shift();
        const sorted = [...this.rttSamples].sort((a, b) => a - b);
        this.rttMs = sorted[Math.floor(sorted.length / 2)];
    }

    get open(): boolean {
        return this.transport.readyState === OPEN;
    }

    get connected(): boolean {
        return this.disconnectedAt < 0;
    }

    /** The player is back on a new socket (resume or takeover). */
    attach(transport: Transport): void {
        this.transport = transport;
        this.disconnectedAt = -1;
    }

    // Sends an already serialized message
    sendRaw(data: string | Uint8Array): void {
        if (!this.open) return;
        try {
            this.transport.send(data);
            this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
        } catch (err) {
            console.warn('ws.send failed', err);
        }
    }

    send(msg: ServerMessage): void {
        this.sendRaw(JSON.stringify(msg));
    }

    /** A snapshot, unless the socket is backed up (5.6). Returns whether it went out. */
    sendSnapshot(bytes: Uint8Array): boolean {
        if (this.transport.bufferedAmount > SNAPSHOT_SKIP_BYTES) return false;
        this.sendRaw(bytes);
        return true;
    }

    /**
     * Rate limit for input packets. Returns 'ok', 'drop' (over the limit)
     * or 'kick' (a sustained flood).
     */
    admitInput(nowMs: number): 'ok' | 'drop' | 'kick' {
        if (this.floodWindowStart < 0 || nowMs - this.floodWindowStart >= FLOOD_WINDOW_MS) {
            const rate = this.floodWindowStart < 0 ? 0 : this.floodCount / ((nowMs - this.floodWindowStart) / 1000);
            if (rate > FLOOD_RATE) return 'kick';
            this.floodWindowStart = nowMs;
            this.floodCount = 0;
        }
        this.floodCount++;
        if (this.inputRefillAt < 0) this.inputRefillAt = nowMs;
        this.inputTokens = Math.min(INPUT_BURST, this.inputTokens + (nowMs - this.inputRefillAt) * INPUT_RATE / 1000);
        this.inputRefillAt = nowMs;
        if (this.inputTokens < 1) return 'drop';
        this.inputTokens -= 1;
        return 'ok';
    }

    /**
     * Rate limit for JSON messages: 'ok', 'drop' (over the budget) or
     * 'kick' (a sustained flood).
     */
    admitMessage(nowMs: number): 'ok' | 'drop' | 'kick' {
        if (this.messageWindowStart < 0 || nowMs - this.messageWindowStart >= FLOOD_WINDOW_MS) {
            const rate = this.messageWindowStart < 0 ? 0 : this.messageCount / ((nowMs - this.messageWindowStart) / 1000);
            if (rate > MESSAGE_FLOOD_RATE) return 'kick';
            this.messageWindowStart = nowMs;
            this.messageCount = 0;
        }
        this.messageCount++;
        if (this.messageRefillAt < 0) this.messageRefillAt = nowMs;
        this.messageTokens = Math.min(MESSAGE_BURST, this.messageTokens + (nowMs - this.messageRefillAt) * MESSAGE_RATE / 1000);
        this.messageRefillAt = nowMs;
        if (this.messageTokens < 1) return 'drop';
        this.messageTokens -= 1;
        return 'ok';
    }

    /** Counts an invalid message; true when the limit is reached (kick). */
    noteInvalid(nowMs: number): boolean {
        this.invalidAt.push(nowMs);
        while (this.invalidAt.length && nowMs - this.invalidAt[0] > INVALID_WINDOW_MS) this.invalidAt.shift();
        return this.invalidAt.length > INVALID_LIMIT;
    }
}
