import type { IncomingMessage } from 'http';

// Who may open how much (docs/phase-1b-design.md, 11.7): limits per client
// address on top of the process-wide MAX_CONNECTIONS and MAX_SESSIONS, so a
// single machine can neither fill every slot with held sockets nor churn
// thousands of sessions (each a simulated car for the grace time).

// ---- The client's address ----

// Loopback, private and link-local peers: a reverse proxy in front of the
// server (Traefik in Docker, the dev machine). Only from those are the
// forwarding headers believed.
export function isPrivateAddress(address: string): boolean {
    const a = address.replace(/^::ffff:/, '').toLowerCase();
    if (a === '::1' || a.startsWith('127.')) return true;
    if (a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
    const m = /^172\.(\d+)\./.exec(a);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:');
}

export function isLoopback(address: string): boolean {
    const a = address.replace(/^::ffff:/, '');
    return a === '::1' || a.startsWith('127.');
}

function header(req: IncomingMessage, name: string): string | null {
    const value = req.headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    const trimmed = text?.trim();
    return trimmed ? trimmed : null;
}

/**
 * The address a connection counts against, or null when none can be told
 * apart (limits per address are off then).
 *
 * CLIENT_IP_HEADER names the header a trusted proxy sets (for example
 * cf-connecting-ip); 'socket' uses the peer address, 'none' turns the
 * limits off. Unset: behind a private peer (the proxy) Cloudflare's
 * CF-Connecting-IP, X-Real-IP or the last X-Forwarded-For entry, in that
 * order; a public peer is the client itself. Live the chain is Cloudflare,
 * Traefik, this server, so CF-Connecting-IP is the player.
 */
export function clientAddress(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string | null {
    const peer = req.socket.remoteAddress ?? '';
    const configured = env.CLIENT_IP_HEADER?.trim().toLowerCase();
    if (configured === 'none') return null;
    if (configured === 'socket') return peer || null;
    if (configured) return header(req, configured);
    if (peer && !isPrivateAddress(peer)) return peer;
    const forwarded = header(req, 'x-forwarded-for')?.split(',').map(s => s.trim()).filter(Boolean);
    return header(req, 'cf-connecting-ip') ?? header(req, 'x-real-ip') ?? forwarded?.at(-1) ?? (peer || null);
}

// ---- Limits per address ----

export interface AddressLimitOptions {
    // Open sockets per address
    maxSockets: number;
    // New sessions (hellos without a session to take over): a token bucket
    helloBurst: number;
    hellosPerMinute: number;
}

interface Entry {
    sockets: number;
    tokens: number;
    refillAt: number;
}

export class AddressLimits {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly options: AddressLimitOptions) {}

    // Loopback (tests, bots and tools on the server's own machine) and
    // unknown addresses are not limited; the process-wide limits still hold
    private exempt(address: string | null): address is null {
        return address === null || isLoopback(address);
    }

    private entry(address: string, nowMs: number): Entry {
        let e = this.entries.get(address);
        if (!e) {
            e = { sockets: 0, tokens: this.options.helloBurst, refillAt: nowMs };
            this.entries.set(address, e);
        }
        return e;
    }

    /** A socket opens: false when the address has its maximum open already. */
    openSocket(address: string | null, nowMs: number): boolean {
        if (this.exempt(address)) return true;
        const e = this.entry(address, nowMs);
        if (e.sockets >= this.options.maxSockets) return false;
        e.sockets++;
        return true;
    }

    closeSocket(address: string | null): void {
        if (this.exempt(address)) return;
        const e = this.entries.get(address);
        if (e && e.sockets > 0) e.sockets--;
    }

    /** A hello that starts a new session: false when the address is over its budget. */
    admitNewSession(address: string | null, nowMs: number): boolean {
        if (this.exempt(address)) return true;
        const e = this.entry(address, nowMs);
        const { helloBurst, hellosPerMinute } = this.options;
        e.tokens = Math.min(helloBurst, e.tokens + (nowMs - e.refillAt) * hellosPerMinute / 60_000);
        e.refillAt = nowMs;
        if (e.tokens < 1) return false;
        e.tokens -= 1;
        return true;
    }

    /** Forgets addresses without sockets whose budget is full again. */
    sweep(nowMs: number): void {
        const { helloBurst, hellosPerMinute } = this.options;
        for (const [address, e] of this.entries) {
            const tokens = e.tokens + (nowMs - e.refillAt) * hellosPerMinute / 60_000;
            if (e.sockets === 0 && tokens >= helloBurst) this.entries.delete(address);
        }
    }

    get size(): number {
        return this.entries.size;
    }
}

// ---- Log lines that a flood of connections could multiply ----

/**
 * At most `limit` lines per window; the rest is counted and summed up in
 * one line when the next window starts.
 */
export class ThrottledLog {
    private windowStart = -Infinity;
    private count = 0;
    private suppressed = 0;

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly write: (line: string) => void = line => console.log(line),
        private readonly now: () => number = () => performance.now()
    ) {}

    log(line: string): void {
        const now = this.now();
        if (now - this.windowStart >= this.windowMs) {
            if (this.suppressed > 0) this.write(`(${this.suppressed} more join/leave lines in the last ${Math.round((now - this.windowStart) / 1000)} s not shown)`);
            this.windowStart = now;
            this.count = 0;
            this.suppressed = 0;
        }
        if (this.count < this.limit) {
            this.count++;
            this.write(line);
        } else {
            this.suppressed++;
        }
    }
}

// Join, resume and leave lines of all players
export const sessionLog = new ThrottledLog(40, 10_000);
