import { MAX_HEALTH, POWERUP_TYPE_IDS, type PowerupType } from '../../shared/party/rules.js';

// What a player has in the Party and loses when leaving it
// (docs/phase-1b-design.md, 2.1 and 5.5): HP, score, the powerup windows,
// the respawn shield and the cooldowns. Everything counts in room ticks.

export interface PowerupWindow {
    // Active for start <= tick < end
    start: number;
    end: number;
}

export interface PartyMemberState {
    score: number;
    health: number;
    powerups: Record<PowerupType, PowerupWindow>;
    // Invulnerable after (re)spawning until a while after driving off
    respawnShield: boolean;
    spawnTick: number;
    // First tick the car drove faster than the shield's move speed, -1 = not yet
    movedTick: number;
    // Dead until this tick (respawn), -1 = alive
    deadUntil: number;
    lastShotTick: number;
    // Last tick each attacker's Mega rammed this player
    readonly rammedBy: Map<string, number>;
}

export function createPartyState(): PartyMemberState {
    const powerups = {} as Record<PowerupType, PowerupWindow>;
    for (const type of POWERUP_TYPE_IDS) powerups[type] = { start: 0, end: 0 };
    return {
        score: 0,
        health: MAX_HEALTH,
        powerups,
        respawnShield: false,
        spawnTick: 0,
        movedTick: -1,
        deadUntil: -1,
        lastShotTick: -Infinity,
        rammedBy: new Map()
    };
}

export function powerupActive(state: PartyMemberState, type: PowerupType, tick: number): boolean {
    const window = state.powerups[type];
    return window.start <= tick && tick < window.end;
}

export function clearPowerups(state: PartyMemberState): void {
    for (const type of POWERUP_TYPE_IDS) {
        state.powerups[type].start = 0;
        state.powerups[type].end = 0;
    }
}
