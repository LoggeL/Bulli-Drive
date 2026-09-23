import type { ServerMessage } from '../shared/protocol.js';
import type { Room, RoomMember } from './rooms/Room.js';

// One connection (docs/phase-1b-design.md, 2.1): who the player is and what
// stays when they change rooms. Positions, HP and score belong to the room
// membership instead.

// What a session needs from its socket. The ws WebSocket fits; tests pass a
// recording fake.
export interface Transport {
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

const OPEN = 1;
// Movement updates are skipped for a client whose socket is this far behind
// (the next update replaces them anyway)
const DROPPABLE_BACKPRESSURE_BYTES = 256 * 1024;

export class Session {
    readonly id: string;
    readonly transport: Transport;
    name: string;
    color: number;
    carType = 'bulli';
    room: Room | null = null;
    member: RoomMember | null = null;
    // Rate-limit bookkeeping (ms timestamps)
    lastUpdateAt = 0;
    lastHonkAt = 0;
    lastRenameAt = 0;
    lastJoinRoomAt = 0;

    constructor(id: string, transport: Transport, name: string, color: number) {
        this.id = id;
        this.transport = transport;
        this.name = name;
        this.color = color;
    }

    get open(): boolean {
        return this.transport.readyState === OPEN;
    }

    // Sends an already serialized message; droppable ones are skipped while
    // the socket is backed up
    sendRaw(data: string, droppable = false): void {
        if (!this.open) return;
        if (droppable && this.transport.bufferedAmount > DROPPABLE_BACKPRESSURE_BYTES) return;
        try {
            this.transport.send(data);
        } catch (err) {
            console.warn('ws.send failed', err);
        }
    }

    send(msg: ServerMessage): void {
        this.sendRaw(JSON.stringify(msg));
    }
}
