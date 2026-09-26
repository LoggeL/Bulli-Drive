// Party rules in ticks (docs/phase-1b-design.md, 5.5). The server runs
// them in its room tick; the client uses the same numbers for its
// optimistic coin pickup and the powerup HUD.

import {
    BASE_SHOT_DAMAGE, COIN_VALUE, KILL_REWARD, MAGNET_RANGE, MAX_HEALTH, MAX_SHOT_RANGE, MEGA_DAMAGE_REDUCTION
} from '../constants.js';
import { TICK_RATE } from '../net/constants.js';

export const msToTicks = (ms: number) => Math.round(ms / 1000 * TICK_RATE);

// No Super Jump since the jump was removed (docs/phase-1a-design.md, 26)
export const POWERUP_TYPE_IDS = ['speed', 'size', 'shield', 'magnet', 'ghost'] as const;
export type PowerupType = typeof POWERUP_TYPE_IDS[number];

export function isPowerupType(value: unknown): value is PowerupType {
    return typeof value === 'string' && (POWERUP_TYPE_IDS as readonly string[]).includes(value);
}

// Effect windows: picking the same type up again extends to now + duration
export const POWERUP_TICKS: Record<PowerupType, number> = {
    speed: 300,
    size: 300,
    magnet: 300,
    shield: 480,
    ghost: 480
};

// 2D distance car to item, on the server: the client's radius + 1 m
export const POWERUP_PICKUP_RADIUS = 6;
export const COIN_PICKUP_RADIUS = 4;
// The magnet takes every coin it pulls on the client (MAGNET_RANGE, 25 m)
// as the legacy server did (it accepted 35 m): the client draws the coin
// flying in, the server has it already (docs/phase-1b-design.md, 5.5)
export const COIN_MAGNET_PICKUP_RADIUS = MAGNET_RANGE + 1;
// What the client uses for its optimistic coin pickup and the marker check
export const CLIENT_POWERUP_RADIUS = 5;
export const CLIENT_COIN_RADIUS = 3;
export const CLIENT_COIN_MAGNET_RADIUS = 6;
// A coin the client took stays hidden this long without a pickup event
export const CLIENT_COIN_CONFIRM_MS = 600;

export const POWERUP_RESET_TICKS = 1200;
export const COIN_RESET_TICKS = 900;

export const SHOT_COOLDOWN_TICKS = 24;
export const SHOT_RANGE = MAX_SHOT_RANGE;
export const SHOT_DAMAGE = BASE_SHOT_DAMAGE;
export const MEGA_DAMAGE_FACTOR = MEGA_DAMAGE_REDUCTION;

// Mega-Ram (5.5): damage from the contact impulse on the rammed car
export const RAM_MIN_DV = 4;
export const RAM_DAMAGE_PER_DV = 2.5;
export const RAM_MAX_DAMAGE = 60;
export const RAM_PAIR_COOLDOWN_TICKS = 60;
// The Mega car has to drive at its target at least this fast (m/s), like the
// legacy client's speed > 0.05 units per frame (3 m/s): a parked Mega car
// is no trap (docs/phase-1b-design.md, 5.5)
export const RAM_MIN_ATTACK_SPEED = 3;

export function ramDamage(dv: number, targetMega: boolean): number {
    if (!(dv >= RAM_MIN_DV)) return 0;
    const damage = Math.min(RAM_MAX_DAMAGE, Math.round(RAM_DAMAGE_PER_DV * dv));
    return targetMega ? Math.round(damage * MEGA_DAMAGE_FACTOR) : damage;
}

export function shotDamage(targetMega: boolean): number {
    return targetMega ? Math.round(SHOT_DAMAGE * MEGA_DAMAGE_FACTOR) : SHOT_DAMAGE;
}

// Dead cars leave the sim for this long
export const RESPAWN_TICKS = 180;
// The respawn shield ends RESPAWN_SHIELD_DRIVE_TICKS after the car first
// drives faster than RESPAWN_SHIELD_MOVE_SPEED, at the latest after
// RESPAWN_SHIELD_MAX_TICKS
export const RESPAWN_SHIELD_DRIVE_TICKS = 180;
export const RESPAWN_SHIELD_MAX_TICKS = 480;
export const RESPAWN_SHIELD_MOVE_SPEED = 1;

export { COIN_VALUE, KILL_REWARD, MAX_HEALTH };
