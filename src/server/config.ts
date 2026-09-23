import { DEFAULT_TERRAIN_CONFIG } from '../shared/constants.js';
import { TerrainConfig } from '../shared/protocol.js';

export const PORT = Number(process.env.PORT) || 8000;

export const TERRAIN_CONFIG: TerrainConfig = DEFAULT_TERRAIN_CONFIG;

// Server-only tuning (gameplay constants live in src/shared/constants.ts)
export const HEARTBEAT_INTERVAL_MS = 30_000;

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
// Close code for a connection turned away because the server is full
export const CLOSE_SERVER_FULL = 4002;

// Inbound rate limits per connection
export const MIN_UPDATE_INTERVAL_MS = 1000 / 30; // drop 'update' arriving faster than 30 Hz
export const HONK_INTERVAL_MS = 300;
export const RENAME_INTERVAL_MS = 1000;
export const JOIN_ROOM_INTERVAL_MS = 2000;

// Accepted y range for position updates (clamped, not rejected)
export const Y_MIN = -5;
export const Y_MAX = 80;
