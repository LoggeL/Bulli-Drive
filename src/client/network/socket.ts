import { state } from '../state.js';
import type { ClientMessage } from '../../shared/protocol.js';
import type { NetsimConnection } from '../../shared/net/netsim.js';

// Single choke-point for client -> server messages. Returns true when the
// frame was actually handed to the socket (or to the dev netsim in front of
// it), false when offline / not open.

let netsim: NetsimConnection | null = null;

/** The netsim of the current socket (net/netsim.ts), null without one. */
export function setSocketNetsim(connection: NetsimConnection | null): void {
    netsim = connection;
}

function send(data: string | Uint8Array, binary: boolean): boolean {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        if (netsim) {
            netsim.up.send(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
            }, binary);
        } else {
            ws.send(data);
        }
        return true;
    } catch (err) {
        console.warn('WebSocket send failed', err);
        return false;
    }
}

export function sendToServer(msg: ClientMessage): boolean {
    return send(JSON.stringify(msg), false);
}

// Binary frames (input packets, shared/net/codec.ts)
export function sendBinary(bytes: Uint8Array): boolean {
    return send(bytes, true);
}
