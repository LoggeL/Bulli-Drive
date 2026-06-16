import { DEFAULT_TERRAIN_CONFIG } from '../shared/constants.js';
import { TerrainConfig } from '../shared/protocol.js';

export const PORT = Number(process.env.PORT) || 8000;

export const TERRAIN_CONFIG: TerrainConfig = DEFAULT_TERRAIN_CONFIG;

// Server-only tuning (gameplay constants live in src/shared/constants.ts)
export const HEARTBEAT_INTERVAL_MS = 30_000;

// Inbound rate limits per connection
export const MIN_UPDATE_INTERVAL_MS = 1000 / 30; // drop 'update' arriving faster than 30 Hz
export const HONK_INTERVAL_MS = 300;
export const RENAME_INTERVAL_MS = 1000;

// Accepted y range for position updates (clamped, not rejected)
export const Y_MIN = -5;
export const Y_MAX = 80;
