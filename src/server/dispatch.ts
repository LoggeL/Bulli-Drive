import { parseClientMessage } from '../shared/protocol.js';
import { MAX_NAME_LENGTH } from '../shared/constants.js';
import { isCarClassId } from '../shared/sim/vehicleClasses.js';
import { paintById } from '../shared/paints.js';
import { JOIN_ROOM_INTERVAL_MS, PING_INTERVAL_MS, RENAME_INTERVAL_MS } from './config.js';
import type { RoomManager } from './rooms/lobby.js';
import { roomOptions } from './rooms/Room.js';
import type { Session } from './session.js';

// Entry point for every JSON frame after the handshake
// (docs/phase-1b-design.md, 3.5). Anything that does not match the shared
// ClientMessageSchema is dropped and counted as invalid, so a broken or
// hostile client cannot crash a handler. Name, car, paint, room and clock
// belong to the session; everything else goes to the session's room.

export type DispatchResult = 'ok' | 'invalid';

export function cleanName(name: string): string {
    return name.replace(/[\x00-\x1f\x7f]/g, '').trim().substring(0, MAX_NAME_LENGTH);
}

export function handleClientMessage(lobby: RoomManager, session: Session, data: unknown, now: number): DispatchResult {
    const msg = parseClientMessage(data);
    if (!msg) return 'invalid';
    const room = session.room;
    const member = session.member;

    switch (msg.type) {
        case 'hello':
            // Only as the first message (server/index.ts)
            return 'invalid';
        case 'ping': {
            // Clock sync: the room's tick and the fraction of the running tick
            if (now - session.lastPingAt < PING_INTERVAL_MS) return 'ok';
            session.lastPingAt = now;
            if (!room) return 'ok';
            session.send({ type: 'pong', t: msg.t, ...room.clockAt(now) });
            return 'ok';
        }
        case 'rename': {
            if (now - session.lastRenameAt < RENAME_INTERVAL_MS) return 'ok';
            const name = cleanName(msg.name);
            if (!name) return 'ok';
            session.lastRenameAt = now;
            session.name = name;
            if (room && member) room.onSessionChanged(member, { name: true });
            return 'ok';
        }
        case 'setCar': {
            // Unknown car types are ignored
            if (!isCarClassId(msg.carType)) return 'ok';
            if (session.carType === msg.carType && session.profile === msg.profile) return 'ok';
            session.carType = msg.carType;
            session.profile = msg.profile;
            if (room && member) room.onSessionChanged(member, { car: true });
            return 'ok';
        }
        case 'setPaint': {
            // A palette paint only (the schema checks the id); shown to the
            // room with the car changes, rate limited there
            const color = paintById(msg.paint).hex;
            if (session.color === color) return 'ok';
            session.color = color;
            if (room && member) room.onSessionChanged(member, { paint: true });
            return 'ok';
        }
        case 'joinRoom': {
            if (now - session.lastJoinRoomAt < JOIN_ROOM_INTERVAL_MS) return 'ok';
            session.lastJoinRoomAt = now;
            // The new room sends its roomState; the car spawns there right
            // away when the player was past the splash screen
            const joined = lobby.switch(session, msg.kind, { fresh: msg.fresh, track: msg.track });
            if (joined && session.room) console.log(`${session.name} moved to ${session.room.id}`);
            return 'ok';
        }
        case 'debugPlace':
            // Only the e2e server takes it; anywhere else it is invalid (15.4)
            if (!roomOptions.allowDebugPlace) return 'invalid';
            if (room && member) room.onMessage(member, msg);
            return 'ok';
        default:
            if (room && member) room.onMessage(member, msg);
            return 'ok';
    }
}
