import type { WebSocket } from 'ws';
import { mulberry32 } from '../shared/math/rng.js';
import { describeNetsim, NetsimConnection, parseNetsimEnv, type NetsimOptions } from '../shared/net/netsim.js';
import type { TrafficMeter } from './health.js';
import type { Transport } from './session.js';

// One WebSocket as the rest of the server sees it: a Transport that counts
// the traffic and, with the dev netsim on (docs/phase-1b-design.md, 11.5),
// holds every message in both directions for the simulated latency, jitter
// and loss. Pings and pongs go through the netsim too, so the lag ghost
// sees the simulated round trip.

const OPEN = 1;
const CLOSING = 2;

/** The netsim from NETSIM, only outside production unless NETSIM_ALLOW=1. */
export function netsimFromEnv(env: NodeJS.ProcessEnv = process.env): NetsimOptions | null {
    if (!env.NETSIM) return null;
    const options = parseNetsimEnv(env.NETSIM);
    if (!options) {
        console.warn(`NETSIM="${env.NETSIM}" is not valid (expected rtt=150,jitter=30,loss=3,mode=tcp); ignored`);
        return null;
    }
    if (env.NODE_ENV === 'production' && env.NETSIM_ALLOW !== '1') {
        console.warn('NETSIM is ignored in production (set NETSIM_ALLOW=1 to force it)');
        return null;
    }
    console.warn(`NETSIM active on every connection: ${describeNetsim(options)}`);
    return options;
}

let seedCounter = 1;

const clock = {
    now: () => performance.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms)
};

export class SocketConnection implements Transport {
    // Clock time of the last pong (liveness, server/index.ts)
    lastPongAt = performance.now();
    private readonly netsim: NetsimConnection | null;
    private closeRequested = false;
    private queuedBytes = 0;

    constructor(
        readonly ws: WebSocket,
        private readonly traffic: TrafficMeter,
        netsim: NetsimOptions | null
    ) {
        this.netsim = netsim ? new NetsimConnection(netsim, mulberry32(0x5eed + seedCounter++ * 7919), clock) : null;
    }

    get readyState(): number {
        const state = this.ws.readyState;
        return state === OPEN && this.closeRequested ? CLOSING : state;
    }

    get bufferedAmount(): number {
        return this.ws.bufferedAmount + this.queuedBytes;
    }

    send(data: string | Uint8Array): void {
        const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        const binary = typeof data !== 'string';
        if (!this.netsim) {
            this.ws.send(data);
            this.traffic.noteOut(size);
            return;
        }
        this.queuedBytes += size;
        this.netsim.down.send(() => {
            this.queuedBytes -= size;
            if (this.ws.readyState !== OPEN) return;
            this.ws.send(data);
            this.traffic.noteOut(size);
        }, binary);
    }

    /** Closes after everything sent before (the netsim keeps the order). */
    close(code?: number, reason?: string): void {
        if (this.closeRequested) return;
        this.closeRequested = true;
        if (!this.netsim) {
            this.ws.close(code, reason);
            return;
        }
        this.netsim.down.send(() => this.ws.close(code, reason), false, true);
    }

    /** Terminates the socket at once (dead connection). */
    terminate(): void {
        this.netsim?.close();
        this.ws.terminate();
    }

    ping(payload: Buffer): void {
        const send = () => {
            if (this.ws.readyState === OPEN) {
                try { this.ws.ping(payload); } catch { /* closing */ }
            }
        };
        if (this.netsim) this.netsim.down.send(send, false, true);
        else send();
    }

    /** Runs handle for an arriving message (or pong) after the netsim's delay. */
    inbound(binary: boolean, bytes: number, handle: () => void): void {
        this.traffic.noteIn(bytes);
        if (this.netsim) this.netsim.up.send(handle, binary);
        else handle();
    }

    /** The socket closed: nothing waiting is delivered any more. */
    dispose(): void {
        this.netsim?.close();
    }
}
