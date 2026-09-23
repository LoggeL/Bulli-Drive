import { CLOSE_RESTART, SHUTDOWN_CLOSE_DELAY_MS, SHUTDOWN_MAX_MS, SHUTDOWN_RECONNECT_MS } from '../shared/net/constants.js';
import type { TicketSigner } from './resumeTicket.js';
import type { Session } from './session.js';

// Graceful shutdown (docs/phase-1b-design.md, 11.2 and 11.3). On SIGTERM
// (a deploy, docker stop) or SIGINT the server takes no new connections,
// stops the tick, tells every client when to come back and hands it a
// resume ticket, gives the sockets a moment to send that, closes them with
// 1012 and exits. It exits at the latest after SHUTDOWN_MAX_MS; Docker
// waits 10 s before it kills.

export interface ShutdownDeps {
    // Stops taking connections (http server close)
    stopAccepting(): void;
    stopTicking(): void;
    // The connected sessions
    sessions(): Iterable<Session>;
    tickets: TicketSigner;
    // Open sockets left; resolves when all are closed
    socketsOpen(): number;
    // Closes every socket that is still open (also those before 'hello')
    closeAll(code: number, reason: string): void;
    exit(code: number): void;
    wait(ms: number): Promise<void>;
    log(message: string): void;
}

/** A resume ticket for the session: name, colour, car and the Party score. */
export function ticketFor(session: Session, tickets: TicketSigner): string {
    const room = session.room, member = session.member;
    return tickets.sign({
        name: session.name.slice(0, 64),
        color: session.color,
        carType: session.carType,
        profile: session.profile,
        roomKind: room?.kind ?? 'party',
        score: room && member ? room.scoreOf(member) : 0
    });
}

export async function gracefulShutdown(deps: ShutdownDeps, signal: string): Promise<void> {
    deps.log(`${signal}: shutting down`);
    let exited = false;
    const exit = (code: number) => {
        if (exited) return;
        exited = true;
        deps.exit(code);
    };
    // Whatever happens below, the process ends in time
    const deadline = deps.wait(SHUTDOWN_MAX_MS).then(() => {
        if (!exited) deps.log('Shutdown took too long; exiting');
        exit(0);
    });

    deps.stopAccepting();
    deps.stopTicking();
    let told = 0;
    for (const session of deps.sessions()) {
        if (!session.connected || !session.open) continue;
        session.send({ type: 'shutdown', reconnectInMs: SHUTDOWN_RECONNECT_MS, resume: ticketFor(session, deps.tickets) });
        told++;
    }
    deps.log(`Told ${told} client${told === 1 ? '' : 's'} to come back in ${SHUTDOWN_RECONNECT_MS} ms`);
    await deps.wait(SHUTDOWN_CLOSE_DELAY_MS);
    deps.closeAll(CLOSE_RESTART, 'restart');
    // The close handshakes, briefly
    for (let i = 0; i < 20 && deps.socketsOpen() > 0; i++) await deps.wait(50);
    exit(0);
    void deadline;
}
