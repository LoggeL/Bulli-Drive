import { GRACE_MS } from '../shared/net/constants.js';

export const PORT = Number(process.env.PORT) || 8000;

// Server-only tuning (gameplay constants live in src/shared/constants.ts,
// netcode constants in src/shared/net/constants.ts)

// WebSocket pings: every 2 s, which also measures the round trip for the
// lag ghost; a socket without a pong for 20 s is terminated
export const PING_EVERY_MS = 2_000;
export const DEAD_SOCKET_MS = 20_000;
// The first message must be a valid 'hello' within this time (3.2). The
// browser sends it from the socket's open event, which waits behind the
// world build on a slow device, so the limit leaves room for that; a page
// that still misses it reconnects on its own (reconnect.ts)
export const HELLO_TIMEOUT_MS = 15_000;

// Rooms (docs/phase-1b-design.md, 2.3): players per room instance, open
// connections of the whole process, and how long an empty extra instance
// stays open
function positiveIntEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}
export const MAX_PLAYERS_PER_ROOM = positiveIntEnv('MAX_PLAYERS_PER_ROOM', 32);
export const MAX_CONNECTIONS = positiveIntEnv('MAX_CONNECTIONS', 160);
// Sessions including those in their grace time (each keeps a car in its
// room): a little over the connections, so a reload wave fits (11.7)
export const MAX_SESSIONS = positiveIntEnv('MAX_SESSIONS', MAX_CONNECTIONS + 40);
// Per client address (access.ts): open sockets, and new sessions as a
// token bucket (a burst, then a steady rate per minute)
export const MAX_SOCKETS_PER_ADDRESS = positiveIntEnv('MAX_SOCKETS_PER_ADDRESS', 12);
export const NEW_SESSION_BURST_PER_ADDRESS = positiveIntEnv('NEW_SESSION_BURST_PER_ADDRESS', 10);
export const NEW_SESSIONS_PER_MINUTE_PER_ADDRESS = positiveIntEnv('NEW_SESSIONS_PER_MINUTE_PER_ADDRESS', 20);
export const EMPTY_ROOM_TTL_MS = 60_000;
// How long a lost connection's session waits for the player (11.1); the
// e2e server shortens it so closed test pages leave quickly
export const SESSION_GRACE_MS = positiveIntEnv('GRACE_MS', GRACE_MS);
export const ROOM_SWEEP_INTERVAL_MS = 5_000;

// Inbound rate limits per connection
export const HONK_INTERVAL_MS = 300;
export const RENAME_INTERVAL_MS = 1000;
export const JOIN_ROOM_INTERVAL_MS = 2000;
// A car change reaches the room at most this often (Room.onSessionChanged)
export const CAR_CHANGE_INTERVAL_MS = 1000;
// Clock-sync pings come every 100 ms at most (five right after joining)
export const PING_INTERVAL_MS = 50;
