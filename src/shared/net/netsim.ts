// Dev netsim (docs/phase-1b-design.md, 11.5): a bad network on purpose, in
// front of a real WebSocket. The client turns it on with
// ?netsim=RTT,JITTER,LOSS[,MODE], the server with
// NETSIM="rtt=150,jitter=30,loss=3,mode=tcp"; both add up when both are on.
//
// Per direction a message is held for half the round trip plus a uniform
// ±jitter/2. A "lost" message in tcp mode (the default) comes 200 ms + RTT
// late and everything after it in the same direction waits behind it: a
// WebSocket runs on TCP, so loss shows up as head-of-line blocking, never as
// a missing message. Mode drop discards lost binary frames instead (inputs
// and snapshots may go missing, the JSON events never do), for robustness
// tests only. The order of the messages always stays.
//
// No timers of its own: the caller hands in its clock and setTimeout, so
// the browser, the server and the tests run the same code.

import type { RandomSource } from '../math/rng.js';

export type NetsimMode = 'tcp' | 'drop';

export interface NetsimOptions {
    // Round trip the netsim adds (ms), split evenly over both directions
    rttMs: number;
    // Uniform ±jitterMs/2 per message and direction (ms)
    jitterMs: number;
    // Share of messages lost, 0..1
    loss: number;
    mode: NetsimMode;
}

// A retransmit in tcp mode: the lost message comes this much plus one RTT late
export const NETSIM_RETRANSMIT_MS = 200;
const MAX_RTT_MS = 5000;
const MAX_JITTER_MS = 2000;
const MAX_LOSS_PERCENT = 50;

function inRange(value: number, max: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= max;
}

function options(rtt: number, jitter: number, lossPercent: number, mode: string | undefined): NetsimOptions | null {
    if (!inRange(rtt, MAX_RTT_MS) || !inRange(jitter, MAX_JITTER_MS) || !inRange(lossPercent, MAX_LOSS_PERCENT)) return null;
    const m = (mode ?? 'tcp').trim().toLowerCase();
    if (m !== 'tcp' && m !== 'drop') return null;
    if (rtt === 0 && jitter === 0 && lossPercent === 0) return null;
    return { rttMs: rtt, jitterMs: jitter, loss: lossPercent / 100, mode: m };
}

/** The client flag ?netsim=RTT,JITTER,LOSS[,MODE] (loss in percent); null when off or invalid. */
export function parseNetsimFlag(text: string | null | undefined): NetsimOptions | null {
    if (!text) return null;
    const parts = text.split(',').map(part => part.trim());
    if (parts.length < 1 || parts.length > 4) return null;
    const [rtt, jitter = '0', loss = '0', mode] = parts;
    if ([rtt, jitter, loss].some(part => part === '' || !/^\d+(\.\d+)?$/.test(part))) return null;
    return options(Number(rtt), Number(jitter), Number(loss), mode);
}

/** The server variable NETSIM="rtt=150,jitter=30,loss=3,mode=tcp"; null when off or invalid. */
export function parseNetsimEnv(text: string | null | undefined): NetsimOptions | null {
    if (!text) return null;
    const values: Record<string, string> = {};
    for (const pair of text.split(',')) {
        const [key, value] = pair.split('=').map(part => part?.trim());
        if (!key || value === undefined || !['rtt', 'jitter', 'loss', 'mode'].includes(key)) return null;
        values[key] = value;
    }
    for (const key of ['rtt', 'jitter', 'loss']) {
        if (values[key] !== undefined && !/^\d+(\.\d+)?$/.test(values[key])) return null;
    }
    return options(Number(values.rtt ?? 0), Number(values.jitter ?? 0), Number(values.loss ?? 0), values.mode);
}

/** "150/30/3% tcp", for overlays and logs. */
export function describeNetsim(o: NetsimOptions): string {
    return `${o.rttMs}/${o.jitterMs}/${Math.round(o.loss * 1000) / 10}% ${o.mode}`;
}

export interface NetsimClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
}

interface Pending {
    at: number;
    deliver: () => void;
}

/** One direction of a connection. */
export class NetsimLink {
    private readonly queue: Pending[] = [];
    private head = 0;
    private lastAt = -Infinity;
    private timerAt = Infinity;
    // Totals, for overlays and tests
    sent = 0;
    dropped = 0;
    delayed = 0;
    // Set by close(): nothing is delivered any more
    private closed = false;

    constructor(
        readonly options: NetsimOptions,
        private readonly random: RandomSource,
        private readonly clock: NetsimClock
    ) {}

    /**
     * Hands a message to the link; deliver runs when it arrives. binary:
     * only binary frames can be dropped (mode drop). lossless: a message
     * that must never be late or lost on its own (the close of the socket
     * still waits behind everything before it).
     */
    send(deliver: () => void, binary: boolean, lossless = false): void {
        if (this.closed) return;
        this.sent++;
        const o = this.options;
        const now = this.clock.now();
        let at = now + o.rttMs / 2 + (this.random() - 0.5) * o.jitterMs;
        if (!lossless && o.loss > 0 && this.random() < o.loss) {
            if (o.mode === 'drop' && binary) {
                this.dropped++;
                return;
            }
            if (o.mode === 'tcp') {
                at += NETSIM_RETRANSMIT_MS + o.rttMs;
                this.delayed++;
            }
        }
        // In order, like TCP: nothing overtakes what went before
        at = Math.max(at, this.lastAt, now);
        this.lastAt = at;
        this.queue.push({ at, deliver });
        this.arm();
    }

    /** Messages waiting in the link. */
    get pending(): number {
        return this.queue.length - this.head;
    }

    /** Stops the link: whatever still waits is thrown away. */
    close(): void {
        this.closed = true;
        this.queue.length = 0;
        this.head = 0;
    }

    private arm(): void {
        if (this.head >= this.queue.length) return;
        const at = this.queue[this.head].at;
        if (at >= this.timerAt) return;
        this.timerAt = at;
        this.clock.setTimeout(this.flush, Math.max(0, at - this.clock.now()));
    }

    private readonly flush = (): void => {
        this.timerAt = Infinity;
        const now = this.clock.now();
        while (!this.closed && this.head < this.queue.length && this.queue[this.head].at <= now) {
            const item = this.queue[this.head++];
            item.deliver();
        }
        if (this.head > 64 && this.head * 2 > this.queue.length) {
            this.queue.splice(0, this.head);
            this.head = 0;
        }
        if (!this.closed) this.arm();
    };
}

/** Both directions of one connection, seeded. */
export class NetsimConnection {
    readonly up: NetsimLink;
    readonly down: NetsimLink;

    constructor(readonly options: NetsimOptions, random: RandomSource, clock: NetsimClock) {
        this.up = new NetsimLink(options, random, clock);
        this.down = new NetsimLink(options, random, clock);
    }

    close(): void {
        this.up.close();
        this.down.close();
    }
}
