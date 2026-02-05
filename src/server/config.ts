export const PORT = Number(process.env.PORT) || 8000;

export const TERRAIN_CONFIG = {
    size: 1000,
    segments: 128,
    frequency1: 0.008,
    amplitude1: 3.5,
    frequency2: 0.025,
    amplitude2: 1.5,
    frequency3: 0.06,
    amplitude3: 0.6
};

export const POWERUP_TYPES = [
    { type: 'speed', color: 0xFFD700, label: 'Turbo' },
    { type: 'size', color: 0xFF1493, label: 'Mega' },
    { type: 'jump', color: 0x00FF7F, label: 'Super Jump' },
    { type: 'shield', color: 0x00BFFF, label: 'Shield' },
    { type: 'magnet', color: 0xFF6600, label: 'Magnet' },
    { type: 'ghost', color: 0x9966FF, label: 'Ghost' }
];
