import { state } from '../state.js';
import { ClientMessage } from '../../shared/protocol.js';

// Single choke-point for client -> server messages. Returns true when the
// frame was actually handed to the socket, false when offline / not open.
export function sendToServer(msg: ClientMessage): boolean {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(msg));
        return true;
    } catch (err) {
        console.warn('sendToServer failed', err);
        return false;
    }
}
