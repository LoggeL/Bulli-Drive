import { MAX_HEALTH } from '../../shared/constants.js';

// What a player has in the Party and loses when leaving it
// (docs/phase-1b-design.md, 2.1): HP, score, powerup effects, the respawn
// shield and the timers behind them. Until the server ticks (phase 1b,
// step 8c) the timers are still setTimeout handles.

type Timer = ReturnType<typeof setTimeout>;

export type PowerupEffectFlag = 'shieldActive' | 'ghostActive' | 'megaActive';

export interface PartyMemberState {
    score: number;
    health: number;
    shieldActive: boolean;
    ghostActive: boolean;
    megaActive: boolean;
    // Invulnerable after (re)spawning until the car drives off (client
    // hint) or RESPAWN_SHIELD_MAX_MS passed
    respawnShield: boolean;
    lastShotAt: number;
    effectTimers: Partial<Record<PowerupEffectFlag, Timer>>;
    respawnShieldTimer?: Timer;
    respawnTimer?: Timer;
}

export function createPartyState(): PartyMemberState {
    return {
        score: 0,
        health: MAX_HEALTH,
        shieldActive: false,
        ghostActive: false,
        megaActive: false,
        respawnShield: false,
        lastShotAt: 0,
        effectTimers: {}
    };
}

export function clearEffectTimers(state: PartyMemberState): void {
    for (const flag of Object.keys(state.effectTimers) as PowerupEffectFlag[]) {
        clearTimeout(state.effectTimers[flag]);
        delete state.effectTimers[flag];
    }
}

// Every timer of the membership; must run when the player leaves the Party
export function clearPartyTimers(state: PartyMemberState): void {
    clearEffectTimers(state);
    if (state.respawnShieldTimer) {
        clearTimeout(state.respawnShieldTimer);
        state.respawnShieldTimer = undefined;
    }
    if (state.respawnTimer) {
        clearTimeout(state.respawnTimer);
        state.respawnTimer = undefined;
    }
}
