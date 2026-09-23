import { DEFAULT_TERRAIN_CONFIG } from '../shared/constants.js';
import type { TerrainConfig } from '../shared/protocol.js';

export const PORT = Number(process.env.PORT) || 8000;

export const TERRAIN_CONFIG: TerrainConfig = DEFAULT_TERRAIN_CONFIG;

// Server-only tuning (gameplay constants live in src/shared/constants.ts,
// netcode constants in src/shared/net/constants.ts)

// WebSocket pings: every 2 s, which also measures the round trip for the
// lag ghost; a socket without a pong for 20 s is terminated
export const PING_EVERY_MS = 2_000;
export const DEAD_SOCKET_MS = 20_000;
// The first message must be a valid 'hello' within this time (3.2)
export const HELLO_TIMEOUT_MS = 5_000;

// Rooms (docs/phase-1b-design.md, 2.3): players per room instance, open
// connections of the whole process, and how long an empty extra instance
// stays open
function positiveIntEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}
export const MAX_PLAYERS_PER_ROOM = positiveIntEnv('MAX_PLAYERS_PER_ROOM', 32);
export const MAX_CONNECTIONS = positiveIntEnv('MAX_CONNECTIONS', 160);
export const EMPTY_ROOM_TTL_MS = 60_000;
export const ROOM_SWEEP_INTERVAL_MS = 5_000;

// Inbound rate limits per connection
export const HONK_INTERVAL_MS = 300;
export const RENAME_INTERVAL_MS = 1000;
export const JOIN_ROOM_INTERVAL_MS = 2000;
// Clock-sync pings come every 100 ms at most (five right after joining)
export const PING_INTERVAL_MS = 50;
