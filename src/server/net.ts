import { WebSocketServer, WebSocket } from 'ws';
import { ServerMessage } from '../shared/protocol.js';
import { players, getScoreboard } from './state.js';

let wss: WebSocketServer | undefined;

export function setWss(server: WebSocketServer) {
    wss = server;
}

export function safeSend(ws: WebSocket, msg: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(msg);
    } catch (err) {
        console.warn('ws.send failed', err);
    }
}

export function broadcast(data: ServerMessage, excludeId?: string) {
    if (!wss) return;
    const msg = JSON.stringify(data);
    const excludeWs = excludeId ? players[excludeId]?.ws : undefined;
    wss.clients.forEach((client) => {
        if (client === excludeWs) return;
        safeSend(client as WebSocket, msg);
    });
}

export function broadcastScoreboard() {
    broadcast({
        type: 'scoreboard',
        scoreboard: getScoreboard()
    });
}
