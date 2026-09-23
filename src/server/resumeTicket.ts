import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as v from 'valibot';
import { ASSIST_PROFILE_IDS, ROOM_KINDS } from '../shared/protocol.js';
import { RESUME_TICKET_MS } from '../shared/net/constants.js';

// Resume tickets (docs/phase-1b-design.md, 11.3): a restart loses every
// session in memory, so 'shutdown' hands each client a signed ticket with
// what should survive it: name, colour, car and, in the Party, the score.
// The next process checks the signature and the expiry and takes them
// over. Format: base64url(payload).base64url(HMAC-SHA256(payload, secret)).
// The secret comes from SESSION_SECRET; without it every process makes its
// own and tickets of the one before are void (the player starts at 0).

const TicketSchema = v.object({
    v: v.literal(1),
    name: v.pipe(v.string(), v.maxLength(64)),
    color: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffffff)),
    carType: v.pipe(v.string(), v.maxLength(32)),
    profile: v.picklist(ASSIST_PROFILE_IDS),
    roomKind: v.picklist(ROOM_KINDS),
    score: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000_000_000)),
    // Wall clock (ms): tickets cross processes
    exp: v.pipe(v.number(), v.finite()),
    // One use per ticket
    n: v.pipe(v.string(), v.maxLength(32))
});

export type ResumeTicket = v.InferOutput<typeof TicketSchema>;
export type TicketContent = Omit<ResumeTicket, 'v' | 'exp' | 'n'>;

export class TicketSigner {
    private readonly secret: Buffer;
    // Nonces already used, with their expiry: a ticket works once
    private readonly used = new Map<string, number>();

    constructor(secret: string | Buffer, private readonly now: () => number = Date.now) {
        this.secret = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
    }

    /** The secret from the environment, or a random one (with a warning) for this process only. */
    static fromEnv(env: NodeJS.ProcessEnv = process.env): TicketSigner {
        const secret = env.SESSION_SECRET;
        if (secret && secret.length >= 16) return new TicketSigner(secret);
        if (secret) console.warn('SESSION_SECRET is shorter than 16 characters; using a random one');
        else console.warn('SESSION_SECRET is not set: resume tickets do not survive this process');
        return new TicketSigner(randomBytes(32));
    }

    sign(content: TicketContent): string {
        const ticket: ResumeTicket = {
            v: 1, ...content, exp: this.now() + RESUME_TICKET_MS, n: randomBytes(9).toString('base64url')
        };
        const payload = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
        return `${payload}.${this.mac(payload)}`;
    }

    /** The ticket's content when it is genuine, unexpired and unused; null otherwise. */
    redeem(text: string): ResumeTicket | null {
        const dot = text.indexOf('.');
        if (dot <= 0 || dot !== text.lastIndexOf('.')) return null;
        const payload = text.slice(0, dot);
        const given = Buffer.from(text.slice(dot + 1), 'base64url');
        const expected = Buffer.from(this.mac(payload), 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
        let raw: unknown;
        try {
            raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        const parsed = v.safeParse(TicketSchema, raw);
        if (!parsed.success) return null;
        const ticket = parsed.output;
        const now = this.now();
        if (ticket.exp <= now || ticket.exp > now + 2 * RESUME_TICKET_MS) return null;
        this.prune(now);
        if (this.used.has(ticket.n)) return null;
        this.used.set(ticket.n, ticket.exp);
        return ticket;
    }

    private mac(payload: string): string {
        return createHmac('sha256', this.secret).update(payload).digest('base64url');
    }

    private prune(now: number): void {
        for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n);
    }
}
