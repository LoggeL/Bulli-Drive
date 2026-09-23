// Shared gameplay constants - single source of truth for client and server.
// Values mirror the original tuning; do not change without touching both sides.

export const COIN_VALUE = 10;
export const KILL_REWARD = 50;

export const BASE_SHOT_DAMAGE = 25;
export const MEGA_DAMAGE_REDUCTION = 0.4;
export const MEGA_SCALE = 2.5;
export const MAX_HEALTH = 100;

// ---- Scale ----
// One world unit is one metre. The authored geometry fits this roughly (the
// cars are chibi-style: 3.5-5 u long, a bit wide), roads are 12 u wide and a
// city block is 40 u.
export const METERS_PER_UNIT = 1;
// Multiply a speed in m/s by this to get km/h
export const MS_TO_KMH = 3.6;

// Powerup effect durations (ms): shield/ghost last longer than the rest.
// Online the server's windows in ticks rule (shared/party/rules.ts); the
// offline car counts these down itself
export const POWERUP_DURATIONS_MS: Record<string, number> = {
    speed: 5000,
    size: 5000,
    jump: 5000,
    shield: 8000,
    magnet: 5000,
    ghost: 8000
};

// Shot reach (m) against the server's car positions
export const MAX_SHOT_RANGE = 150;
// The magnet pulls coins within this range (the look on the client)
export const MAGNET_RANGE = 25;

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
