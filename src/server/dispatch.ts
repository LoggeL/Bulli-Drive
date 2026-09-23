import { parseClientMessage } from '../shared/protocol.js';
import { MAX_NAME_LENGTH, VALID_CAR_TYPES } from '../shared/constants.js';
import { JOIN_ROOM_INTERVAL_MS, RENAME_INTERVAL_MS } from './config.js';
import type { RoomManager } from './rooms/lobby.js';
import type { Session } from './session.js';

// Entry point for every parsed inbound frame. Anything that does not match
// the shared ClientMessageSchema is dropped silently, so a broken or hostile
// client cannot crash a handler. Name, car and room belong to the session;
// everything else goes to the session's room.
export function handleClientMessage(lobby: RoomManager, session: Session, data: unknown, now = Date.now()): void {
    const msg = parseClientMessage(data);
    if (!msg) return;

    switch (msg.type) {
        case 'rename': {
            if (now - session.lastRenameAt < RENAME_INTERVAL_MS) return;
            const cleanName = msg.name.replace(/[\x00-\x1f\x7f]/g, '').trim().substring(0, MAX_NAME_LENGTH);
            if (!cleanName) return;
            session.lastRenameAt = now;
            session.name = cleanName;
            if (session.room && session.member) session.room.onRenamed(session.member);
            return;
        }
        case 'setCarType':
            if (VALID_CAR_TYPES.includes(msg.carType)) session.carType = msg.carType;
            return;
        case 'joinRoom': {
            if (now - session.lastJoinRoomAt < JOIN_ROOM_INTERVAL_MS) return;
            session.lastJoinRoomAt = now;
            const member = lobby.switch(session, msg.kind);
            if (!member || !session.room) return;
            console.log(`${session.name} moved to ${session.room.id}`);
            session.send({ type: 'roomJoined', ...session.room.snapshotFor(member) });
            return;
        }
        default:
            if (session.room && session.member) session.room.onMessage(session.member, msg);
    }
}
