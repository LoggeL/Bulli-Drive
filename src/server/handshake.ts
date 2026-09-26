import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import * as v from 'valibot';
import { HelloSchema, PROTOCOL_VERSION, type HelloMessage, type RejectReason, type ServerMessage } from '../shared/protocol.js';
import { CLOSE_FULL, CLOSE_HELLO, CLOSE_TAKEN_OVER, CLOSE_VERSION, SNAPSHOT_RATE, TICK_RATE } from '../shared/net/constants.js';
import { isCarClassId } from '../shared/sim/vehicleClasses.js';
import { isPaintId, paintById, randomPaint } from '../shared/paints.js';
import type { RandomSource } from '../shared/math/rng.js';
import { sessionLog } from './access.js';
import { cleanName } from './dispatch.js';
import type { RoomManager } from './rooms/lobby.js';
import type { TicketSigner } from './resumeTicket.js';
import { Session, type Transport } from './session.js';
import type { SessionRegistry } from './sessions.js';

// The first message of a connection (docs/phase-1b-design.md, 3.2 and
// 11.1): the protocol version, the player's name, car and profile, the room
// kind, and optionally the token of an earlier session or a resume ticket.
// Another version is turned away with reload: true (the client loads the
// current build); anything else that is not a valid hello is closed.
//
// A known token takes its session over:
// - the same page (connId) whose old socket is gone or not yet noticed as
//   gone: the member, its car and its party state go on (resume); an old
//   socket still open is closed with 4005
// - another page while the session waits in its grace time (a reload): the
//   same player behind the splash screen again, with the Party score kept
// - another page while the session is still connected (a duplicated tab,
//   which copies sessionStorage): a new session
// Without a usable token a valid resume ticket from a restart brings back
// colour and Party score.

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
    // Sessions by token (resume); without it every hello is a new session
    sessions?: SessionRegistry;
    tickets?: TicketSigner;
    // At most this many sessions, including those in their grace time: a
    // new one pushes out the one that waited longest, or is turned away
    // when every session is connected (11.7)
    maxSessions?: number;
    // Removes a session in its grace time from its room and the registry
    evict?: (session: Session) => void;
    // The budget of new sessions for this connection's address (11.7)
    admitNewSession?: () => boolean;
    // Draws the paint of a player who brought no wish (Math.random by default)
    random?: RandomSource;
}

export interface HelloResult {
    session: Session;
    // An earlier session was taken over (same player id)
    resumed: boolean;
}

function welcome(session: Session, resumed: boolean, ctx: HandshakeContext): void {
    session.send({
        type: 'welcome',
        playerId: session.id,
        sessionToken: session.token,
        resumed,
        serverBuild: ctx.serverBuild,
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
        color: session.color,
        name: session.name
    });
}

// The session of the token on this new socket, or null for a new session
function takeOver(transport: Transport, hello: HelloMessage, ctx: HandshakeContext): Session | null {
    const session = ctx.sessions?.findByToken(hello.sessionToken);
    if (!session || session.kicked) return null;
    const samePage = session.connId === hello.connId;
    if (session.connected && !samePage) return null;
    const old = session.transport;
    session.attach(transport);
    session.build = hello.build;
    // The page's paint wins (picked again in the menu after a reload)
    const paintColor = isPaintId(hello.paint) ? paintById(hello.paint).hex : session.color;
    const repainted = paintColor !== session.color;
    session.color = paintColor;
    if (old !== transport && old.readyState <= 1) {
        try { old.close(CLOSE_TAKEN_OVER, 'taken over'); } catch { /* gone anyway */ }
    }
    welcome(session, true, ctx);
    const room = session.room, member = session.member;
    if (samePage && room && member) {
        room.resume(member);
        if (repainted) room.onSessionChanged(member, { paint: true });
    } else {
        session.connId = hello.connId;
        ctx.lobby.rejoin(session, hello.room);
    }
    return session;
}

// Room for one more session under maxSessions: evicts the session that has
// waited longest in its grace time; false if all of them are connected
function makeRoom(ctx: HandshakeContext): boolean {
    const sessions = ctx.sessions;
    if (!sessions || ctx.maxSessions === undefined) return true;
    while (sessions.size >= ctx.maxSessions) {
        const oldest = sessions.longestInGrace();
        if (!oldest) return false;
        if (ctx.evict) ctx.evict(oldest);
        else sessions.remove(oldest);
    }
    return true;
}

/** The session for a valid hello (welcomed and in a room), or null after a reject. */
export function acceptHelloResult(transport: Transport, text: string, ctx: HandshakeContext): HelloResult | null {
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
    const resumed = takeOver(transport, hello, ctx);
    if (resumed) {
        sessionLog.log(`Player ${resumed.name} (${resumed.id}) is back in ${resumed.room?.id}`);
        return { session: resumed, resumed: true };
    }

    if (ctx.admitNewSession && !ctx.admitNewSession()) {
        reject(transport, 'full');
        return null;
    }
    if (!makeRoom(ctx)) {
        reject(transport, 'full');
        return null;
    }

    const id = uuidv4();
    const token = randomBytes(16).toString('base64url');
    // The paint picked in the menu, else one from the palette (docs/ui.md 5)
    // (a paint this palette does not know counts as none)
    let color = isPaintId(hello.paint) ? paintById(hello.paint).hex : randomPaint(ctx.random ?? Math.random).hex;
    const name = cleanName(hello.name) || `Player ${Math.floor(Math.random() * 1000)}`;
    const session = new Session(id, transport, name, color, token);
    session.connId = hello.connId;
    session.build = hello.build;
    session.carType = isCarClassId(hello.carType) ? hello.carType : 'bulli';
    session.profile = hello.profile;
    // Back after a restart: the colour and the Party score survive (11.3)
    const ticket = hello.resume ? ctx.tickets?.redeem(hello.resume) : null;
    if (ticket) {
        color = ticket.color;
        session.color = color;
        if (ticket.roomKind === 'party' && hello.room === 'party') session.carryScore = ticket.score;
    }
    ctx.sessions?.add(session);
    welcome(session, false, ctx);
    ctx.lobby.join(session, hello.room);
    sessionLog.log(`Player ${name} (${id}) joined ${session.room?.id}${ticket ? ' with a resume ticket' : ''}`);
    return { session, resumed: false };
}

/** The session for a valid hello, or null after a reject. */
export function acceptHello(transport: Transport, text: string, ctx: HandshakeContext): Session | null {
    return acceptHelloResult(transport, text, ctx)?.session ?? null;
}
