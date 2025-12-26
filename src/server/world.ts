import { Powerup, Tree } from './types.js';
import { POWERUP_TYPES } from './config.js';

export const powerups: Powerup[] = [];
export const trees: Tree[] = [];

export function initWorld() {
    // Init Powerups
    for (let i = 0; i < 15; i++) {
        const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        powerups.push({
            id: i,
            x: (Math.random() - 0.5) * 400,
            z: (Math.random() - 0.5) * 400,
            type: type.type,
            color: type.color,
            label: type.label,
            collected: false
        });
    }

    // Init Trees
    for (let i = 0; i < 120; i++) {
        const x = (Math.random() - 0.5) * 600;
        const z = (Math.random() - 0.5) * 600;
        if (Math.abs(x) < 40 && Math.abs(z) < 40) continue;
        trees.push({
            id: i,
            x: x,
            z: z,
            height: 4 + Math.random() * 5
        });
    }
}
