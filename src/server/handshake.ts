import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import * as v from 'valibot';
import { HelloSchema, PROTOCOL_VERSION, type RejectReason, type ServerMessage } from '../shared/protocol.js';
import { CLOSE_FULL, CLOSE_HELLO, CLOSE_VERSION, SNAPSHOT_RATE, TICK_RATE } from '../shared/net/constants.js';
import { isCarClassId } from '../shared/sim/vehicleClasses.js';
import { cleanName } from './dispatch.js';
import type { RoomManager } from './rooms/lobby.js';
import { Session, type Transport } from './session.js';

// The first message of a connection (docs/phase-1b-design.md, 3.2): the
// protocol version, the player's name, car and profile and the room kind.
// Another version is turned away with reload: true (the client loads the
// current build); anything else that is not a valid hello is closed.

const CLOSE_CODES: Record<RejectReason, number> = {
    version: CLOSE_VERSION,
    hello: CLOSE_HELLO,
    full: CLOSE_FULL
};

export function reject(transport: Transport, reason: RejectReason): void {
    const msg: ServerMessage = { type: 'reject', reason, reload: reason === 'version', serverProtocol: PROTOCOL_VERSION };
    try { transport.send(JSON.stringify(msg)); } catch { /* closing anyway */ }
    transport.close(CLOSE_CODES[reason], reason);
}

export interface HandshakeContext {
    lobby: RoomManager;
    // The build stamp of the client this server serves (null in dev)
    serverBuild: string | null;
}

/** The session for a valid hello (welcomed and in a room), or null after a reject. */
export function acceptHello(transport: Transport, text: string, ctx: HandshakeContext): Session | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        reject(transport, 'hello');
        return null;
    }
    const version = (raw as { protocolVersion?: unknown } | null)?.protocolVersion;
    if ((raw as { type?: unknown } | null)?.type === 'hello' && typeof version === 'number' && version !== PROTOCOL_VERSION) {
        reject(transport, 'version');
        return null;
    }
    const parsed = v.safeParse(HelloSchema, raw);
    if (!parsed.success) {
        reject(transport, 'hello');
        return null;
    }
    const hello = parsed.output;
    const id = uuidv4();
    const token = randomBytes(16).toString('base64url');
    const color = Math.floor(Math.random() * 0xffffff);
    const name = cleanName(hello.name) || `Player ${Math.floor(Math.random() * 1000)}`;
    const session = new Session(id, transport, name, color, token);
    session.connId = hello.connId;
    session.build = hello.build;
    session.carType = isCarClassId(hello.carType) ? hello.carType : 'bulli';
    session.profile = hello.profile;
    session.send({
        type: 'welcome',
        playerId: id,
        sessionToken: token,
        resumed: false,
        serverBuild: ctx.serverBuild,
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
        color,
        name
    });
    ctx.lobby.join(session, hello.room);
    console.log(`Player ${name} (${id}) joined ${session.room?.id}`);
    return session;
}
