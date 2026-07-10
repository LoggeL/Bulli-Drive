// Shared gameplay constants - single source of truth for client and server.
// Values mirror the original tuning; do not change without touching both sides.

export const COIN_VALUE = 10;
export const KILL_REWARD = 50;

export const BASE_SHOT_DAMAGE = 25;
export const MEGA_DAMAGE_REDUCTION = 0.4;
export const MEGA_SCALE = 2.5;
export const MAX_HEALTH = 100;

// Turbo (speed powerup) multiplier applied to acceleration AND max speed for the
// full duration of the boost (constant, not decaying with the remaining timer).
export const SPEED_BOOST_FACTOR = 1.8;

// Powerup effect durations (ms): shield/ghost last longer than the rest
export const POWERUP_DURATIONS_MS: Record<string, number> = {
    speed: 5000,
    size: 5000,
    jump: 5000,
    shield: 8000,
    magnet: 5000,
    ghost: 8000
};

export const RESPAWN_DELAY_MS = 3000;
// Server-side hard cap on the post-respawn invulnerability shield
export const RESPAWN_SHIELD_MAX_MS = 8000;

// Players with no 'update' for this long are considered AFK (invulnerable)
export const AFK_THRESHOLD_MS = 3000;
export const SHOT_COOLDOWN_MS = 400;
export const MAX_SHOT_RANGE = 150;

// Server-side acceptance radii for collect messages (2D distance player -> item)
export const COIN_ACCEPT_RADIUS = 35;
export const POWERUP_ACCEPT_RADIUS = 15;
export const MAGNET_RANGE = 25;

// Item respawn delays after collection
export const POWERUP_RESPAWN_DELAY_MS = 20000;
export const COIN_RESPAWN_DELAY_MS = 15000;

// Client sends position updates at most every 50ms (20 Hz)
export const UPDATE_SEND_INTERVAL_MS = 50;

export const MAX_NAME_LENGTH = 20;

export const VALID_CAR_TYPES = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

export const POWERUP_TYPES = [
    { type: 'speed', color: 0xFFD700, label: 'Turbo' },
    { type: 'size', color: 0xFF1493, label: 'Mega' },
    { type: 'jump', color: 0x00FF7F, label: 'Super Jump' },
    { type: 'shield', color: 0x00BFFF, label: 'Shield' },
    { type: 'magnet', color: 0xFF6600, label: 'Magnet' },
    { type: 'ghost', color: 0x9966FF, label: 'Ghost' }
];

export const CITY_LAYOUT = {
    blockSize: 40,
    roadWidth: 12,
    gridSize: 4
};

// Shared client/server collision footprint for the authored props in Sunset
// Plaza. The server uses these clearances for spawning; the client uses them
// for vehicle collisions and rendering positions.
export const PLAZA_PROP_LAYOUT = {
    planterOffset: 13,
    parasolOffset: 13 * 0.58,
    planterRadius: 1.6,
    parasolRadius: 0.9
};

export const DEFAULT_TERRAIN_CONFIG = {
    size: 1000,
    segments: 128,
    frequency1: 0.006,
    amplitude1: 6.0,
    frequency2: 0.018,
    amplitude2: 3.0,
    frequency3: 0.045,
    amplitude3: 1.2
};

// Positions beyond this on |x| or |z| are rejected by the server
export const WORLD_BOUND = DEFAULT_TERRAIN_CONFIG.size / 2 + 50;
