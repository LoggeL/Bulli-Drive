import type { CoinData, PowerupData, ScoreboardEntry, ServerMessage } from '../../shared/protocol.js';
import {
    AFK_THRESHOLD_MS,
    BASE_SHOT_DAMAGE,
    COIN_ACCEPT_RADIUS,
    COIN_RESPAWN_DELAY_MS,
    COIN_VALUE,
    KILL_REWARD,
    MAX_HEALTH,
    MAX_SHOT_RANGE,
    MEGA_DAMAGE_REDUCTION,
    MEGA_SCALE,
    POWERUP_ACCEPT_RADIUS,
    POWERUP_DURATIONS_MS,
    POWERUP_RESPAWN_DELAY_MS,
    RESPAWN_DELAY_MS,
    RESPAWN_SHIELD_MAX_MS,
    SHOT_COOLDOWN_MS
} from '../../shared/constants.js';
import type { MapData } from '../../shared/world/mapData.js';
import {
    clearEffectTimers,
    clearPartyTimers,
    createPartyState,
    type PartyMemberState,
    type PowerupEffectFlag
} from '../party/state.js';
import { Room, type LeaveReason, type RoomMember, type RoomMessage } from './Room.js';
import { randomSpawn } from './spawn.js';

// The Party (docs/phase-1b-design.md, 2.2): coins, powerups, shooting, HP
// and the scoreboard, the default room. The rules are those of the former
// server/handlers.ts, now per room instance; each room has its own items.

type Msg<T extends RoomMessage['type']> = Extract<RoomMessage, { type: T }>;
type Timer = ReturnType<typeof setTimeout>;

// Powerup types with a server-tracked effect flag (speed/jump/magnet are client-side only)
const POWERUP_EFFECTS: Record<string, PowerupEffectFlag> = {
    shield: 'shieldActive',
    ghost: 'ghostActive',
    size: 'megaActive'
};

export class PartyRoom extends Room {
    readonly powerups: PowerupData[];
    readonly coins: CoinData[];
    private readonly powerupsById = new Map<number, PowerupData>();
    private readonly coinsById = new Map<number, CoinData>();
    private readonly party = new Map<string, PartyMemberState>();
    private readonly itemTimers = new Set<Timer>();

    constructor(index: number, map: MapData, now: () => number = Date.now) {
        super('party', index, map, now);
        // Fresh copies: collecting in one room leaves the others untouched
        this.powerups = map.world.powerups.map(p => ({ ...p, collected: false }));
        this.coins = map.world.coins.map(c => ({ ...c, collected: false }));
        for (const p of this.powerups) this.powerupsById.set(p.id, p);
        for (const c of this.coins) this.coinsById.set(c.id, c);
    }

    partyState(id: string): PartyMemberState | undefined {
        return this.party.get(id);
    }

    powerupList(): PowerupData[] {
        return this.powerups;
    }

    coinList(): CoinData[] {
        return this.coins;
    }

    scoreboard(): ScoreboardEntry[] {
        return [...this.members.values()]
            .filter(m => m.ready)
            .map(m => ({
                id: m.id,
                name: m.session.name,
                score: this.party.get(m.id)?.score ?? 0,
                color: m.session.color
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
    }

    broadcastScoreboard(): void {
        this.broadcast({ type: 'scoreboard', scoreboard: this.scoreboard() });
    }

    dispose(): void {
        super.dispose();
        for (const timer of this.itemTimers) clearTimeout(timer);
        this.itemTimers.clear();
    }

    // ---- Membership ----

    protected onJoin(member: RoomMember): void {
        const state = createPartyState();
        this.party.set(member.id, state);
        this.applySpawnState(member, state, member.x, member.z);
    }

    protected onLeave(member: RoomMember, _reason: LeaveReason): void {
        const state = this.party.get(member.id);
        if (state) clearPartyTimers(state);
        this.party.delete(member.id);
    }

    protected membersChanged(): void {
        this.broadcastScoreboard();
    }

    protected stateFlags(member: RoomMember) {
        const state = this.party.get(member.id);
        return {
            scale: state?.megaActive ? MEGA_SCALE : 1,
            score: state?.score ?? 0,
            health: state?.health ?? MAX_HEALTH,
            ghostActive: state?.ghostActive ?? false,
            shieldActive: state?.shieldActive ?? false
        };
    }

    // ---- Messages ----

    protected onGameMessage(member: RoomMember, msg: RoomMessage): void {
        const state = this.party.get(member.id);
        if (!state) return;
        switch (msg.type) {
            case 'collectPowerup': return this.handleCollectPowerup(member, msg);
            case 'collectCoin': return this.handleCollectCoin(member, state, msg);
            case 'shoot': return this.handleShoot(member, state, msg);
            case 'respawnShieldExpired': return this.handleRespawnShieldExpired(state);
            default: return;
        }
    }

    private handleCollectPowerup(member: RoomMember, msg: Msg<'collectPowerup'>): void {
        if (!member.ready) return;
        const powerup = this.powerupsById.get(msg.powerupId);
        if (!powerup) return;

        const accepted = this.collectItem(member, powerup, POWERUP_ACCEPT_RADIUS, POWERUP_RESPAWN_DELAY_MS,
            itemId => ({ type: 'powerupCollected', powerupId: itemId, playerId: member.id }),
            itemId => ({ type: 'powerupReset', powerupId: itemId }));
        if (!accepted) return;

        console.log(`[${this.id}] ${member.session.name} collected powerup ${powerup.id} (${powerup.type})`);
        this.activatePowerup(member, powerup.type);
    }

    private handleCollectCoin(member: RoomMember, state: PartyMemberState, msg: Msg<'collectCoin'>): void {
        if (!member.ready) return;
        const coin = this.coinsById.get(msg.coinId);
        if (!coin) return;

        const accepted = this.collectItem(member, coin, COIN_ACCEPT_RADIUS, COIN_RESPAWN_DELAY_MS,
            itemId => ({ type: 'coinCollected', coinId: itemId, playerId: member.id }),
            itemId => ({ type: 'coinReset', coinId: itemId }));
        if (!accepted) return;

        state.score += COIN_VALUE;
        this.broadcastScoreboard();
    }

    private handleRespawnShieldExpired(state: PartyMemberState): void {
        // Client hint that the shield visual ended early; the server cap timer
        // (RESPAWN_SHIELD_MAX_MS) stays authoritative otherwise.
        state.respawnShield = false;
        if (state.respawnShieldTimer) {
            clearTimeout(state.respawnShieldTimer);
            state.respawnShieldTimer = undefined;
        }
    }

    private handleShoot(member: RoomMember, state: PartyMemberState, msg: Msg<'shoot'>): void {
        if (!member.ready) return;
        if (msg.targetId === member.id) return;

        const now = this.now();
        if (state.health <= 0) return;
        // Shooter must have sent updates recently (no shooting while AFK)
        if (now - member.lastActivity > AFK_THRESHOLD_MS) return;
        if (now - state.lastShotAt < SHOT_COOLDOWN_MS) return;

        // Only players of this room can be hit
        const target = this.members.get(msg.targetId);
        const targetState = this.party.get(msg.targetId);
        if (!target || !targetState || !target.ready || targetState.health <= 0) return;

        const dx = member.x - target.x;
        const dz = member.z - target.z;
        if (dx * dx + dz * dz > MAX_SHOT_RANGE * MAX_SHOT_RANGE) return;

        state.lastShotAt = now;

        // AFK targets (no update for 3+ seconds) are invulnerable
        if (now - target.lastActivity > AFK_THRESHOLD_MS) return;
        // Respawn shield, ghost and the shield powerup block all damage for
        // their whole duration (the shield is not consumed per hit)
        if (targetState.respawnShield || targetState.ghostActive || targetState.shieldActive) return;

        const damage = targetState.megaActive
            ? Math.round(BASE_SHOT_DAMAGE * MEGA_DAMAGE_REDUCTION)
            : BASE_SHOT_DAMAGE;
        targetState.health = Math.max(0, targetState.health - damage);

        this.broadcast({
            type: 'playerHit',
            targetId: target.id,
            shooterId: member.id,
            newHealth: targetState.health,
            damage
        });

        if (targetState.health <= 0) {
            this.broadcast({
                type: 'playerKilled',
                targetId: target.id,
                killerId: member.id,
                killerName: member.session.name,
                targetName: target.session.name
            });
            state.score += KILL_REWARD;
            this.broadcastScoreboard();
            this.scheduleRespawn(target, targetState);
        }
    }

    // ---- Rules ----

    // Proximity check, atomic check-and-set, collected broadcast and the
    // scheduled reset. Returns true if the collect was accepted.
    private collectItem(
        member: RoomMember,
        item: { id: number; x: number; z: number; collected: boolean },
        acceptRadius: number,
        respawnDelayMs: number,
        collectedMsg: (itemId: number) => ServerMessage,
        resetMsg: (itemId: number) => ServerMessage
    ): boolean {
        if (item.collected) return false;
        const dx = member.x - item.x;
        const dz = member.z - item.z;
        if (dx * dx + dz * dz > acceptRadius * acceptRadius) return false;
        item.collected = true;

        this.broadcast(collectedMsg(item.id));
        const timer = setTimeout(() => {
            this.itemTimers.delete(timer);
            item.collected = false;
            this.broadcast(resetMsg(item.id));
        }, respawnDelayMs);
        this.itemTimers.add(timer);
        return true;
    }

    private activatePowerup(member: RoomMember, powerupType: string): void {
        const flag = POWERUP_EFFECTS[powerupType];
        const durationMs = POWERUP_DURATIONS_MS[powerupType];
        const state = this.party.get(member.id);
        if (!flag || !durationMs || !state) return;

        state[flag] = true;
        clearTimeout(state.effectTimers[flag]);
        this.broadcastPlayerState(member);

        state.effectTimers[flag] = setTimeout(() => {
            // The member may have left in the meantime
            if (this.party.get(member.id) !== state) return;
            state[flag] = false;
            delete state.effectTimers[flag];
            this.broadcastPlayerState(member);
        }, durationMs);
    }

    // Arms the respawn invulnerability and its server-side hard-cap expiry timer.
    private startRespawnShield(state: PartyMemberState): void {
        state.respawnShield = true;
        clearTimeout(state.respawnShieldTimer);
        state.respawnShieldTimer = setTimeout(() => {
            state.respawnShield = false;
            state.respawnShieldTimer = undefined;
        }, RESPAWN_SHIELD_MAX_MS);
    }

    // Shared spawn-state reset for both the first spawn and a respawn
    private applySpawnState(member: RoomMember, state: PartyMemberState, x: number, z: number): void {
        member.x = x;
        member.y = 0;
        member.z = z;
        member.lastActivity = this.now();
        state.health = MAX_HEALTH;
        state.shieldActive = false;
        state.ghostActive = false;
        state.megaActive = false;
        clearEffectTimers(state);
        this.startRespawnShield(state);
    }

    private scheduleRespawn(target: RoomMember, state: PartyMemberState): void {
        clearTimeout(state.respawnTimer);
        state.respawnTimer = setTimeout(() => {
            // Not if the player left (the timers are cleared then anyway)
            if (this.party.get(target.id) !== state) return;
            state.respawnTimer = undefined;
            const others = [...this.members.values()]
                .filter(m => m !== target)
                .map(m => ({ x: m.x, z: m.z }));
            const spawn = randomSpawn(this.map.world.city, others);
            this.applySpawnState(target, state, spawn.x, spawn.z);

            this.broadcast({
                type: 'playerRespawn',
                playerId: target.id,
                health: state.health,
                x: spawn.x,
                z: spawn.z,
                y: target.y,
                angle: target.angle
            });
        }, RESPAWN_DELAY_MS);
    }
}
