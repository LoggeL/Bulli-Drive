export const PORT = 8000;

export const TERRAIN_CONFIG = {
    size: 1000,
    segments: 64,
    frequency1: 0.02,
    amplitude1: 0,
    frequency2: 0.05,
    amplitude2: 0
};

export const POWERUP_TYPES = [
    { type: 'speed', color: 0xFFD700, label: 'Turbo' },
    { type: 'size', color: 0xFF1493, label: 'Mega' },
    { type: 'jump', color: 0x00FF7F, label: 'Super Jump' }
];
