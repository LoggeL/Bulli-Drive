import { GRACE_MS } from '../shared/net/constants.js';
import type { Session } from './session.js';

// All sessions of the process by player id and by token
// (docs/phase-1b-design.md, 2.1 and 11.1). A session whose socket is gone
// stays GRACE_MS: its car waits in the room as an idle ghost, and a 'hello'
// with its token takes it over again. After that it leaves its room for good.

export class SessionRegistry {
    private readonly byId = new Map<string, Session>();
    private readonly byToken = new Map<string, Session>();

    constructor(private readonly graceMs = GRACE_MS) {}

    add(session: Session): void {
        this.byId.set(session.id, session);
        if (session.token) this.byToken.set(session.token, session);
    }

    remove(session: Session): boolean {
        if (this.byId.get(session.id) !== session) return false;
        this.byId.delete(session.id);
        if (this.byToken.get(session.token) === session) this.byToken.delete(session.token);
        return true;
    }

    has(session: Session): boolean {
        return this.byId.get(session.id) === session;
    }

    get(id: string): Session | undefined {
        return this.byId.get(id);
    }

    findByToken(token: string | undefined): Session | undefined {
        return token ? this.byToken.get(token) : undefined;
    }

    /** The socket is gone: the grace time starts. */
    disconnect(session: Session, nowMs: number): void {
        if (!this.has(session)) return;
        session.disconnectedAt = nowMs;
    }

    /** Sessions whose grace time ran out by now; they are removed. */
    expire(nowMs: number): Session[] {
        const gone: Session[] = [];
        for (const session of this.byId.values()) {
            if (!session.connected && nowMs - session.disconnectedAt >= this.graceMs) gone.push(session);
        }
        for (const session of gone) this.remove(session);
        return gone;
    }

    all(): IterableIterator<Session> {
        return this.byId.values();
    }

    get size(): number {
        return this.byId.size;
    }

    /** The session whose player has been gone longest, or null if all are connected. */
    longestInGrace(): Session | null {
        let oldest: Session | null = null;
        for (const session of this.byId.values()) {
            if (session.connected) continue;
            if (!oldest || session.disconnectedAt < oldest.disconnectedAt) oldest = session;
        }
        return oldest;
    }

    /** Sessions waiting for their player to come back. */
    get inGrace(): number {
        let n = 0;
        for (const session of this.byId.values()) if (!session.connected) n++;
        return n;
    }
}
