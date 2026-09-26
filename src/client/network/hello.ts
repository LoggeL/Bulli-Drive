import { PROTOCOL_VERSION, type HelloMessage, type ProfileId, type RoomKind } from '../../shared/protocol.js';
import { FIRST_PAINT, savedPaint, STORAGE_KEYS, type MenuStorage } from '../ui/menu/menuState.js';

// The first message on every socket (docs/phase-1b-design.md 3, docs/ui.md
// 5): who this page is (build, connection id, session token or resume
// ticket) and what the menu picked last (name, car, paint), read from the
// browser's storage. Pure, so the tests can pass their own storage.

export interface HelloContext {
    build: string | null;
    connId: string;
    sessionToken?: string;
    resume?: string;
    profile: ProfileId;
    room: RoomKind;
}

function read(storage: MenuStorage, key: string): string | null {
    try {
        return storage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

/**
 * The hello for this page. The paint is the one picked in the menu, and on
 * a first visit FIRST_PAINT: the loading screen's key art shows the Bulli
 * in it, so the loader fades into the same car (docs/ui.md D28).
 */
export function helloFor(storage: MenuStorage, context: HelloContext): HelloMessage {
    return {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        build: context.build,
        connId: context.connId,
        ...(context.sessionToken ? { sessionToken: context.sessionToken } : {}),
        ...(context.resume ? { resume: context.resume } : {}),
        name: read(storage, STORAGE_KEYS.name) || '',
        carType: read(storage, STORAGE_KEYS.car) || 'bulli',
        profile: context.profile,
        room: context.room,
        paint: savedPaint(storage) ?? FIRST_PAINT
    };
}
