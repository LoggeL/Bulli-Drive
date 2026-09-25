import type { CoinData, PowerupData, ResumeState, RoomStateItems, ScoreboardEntry } from '../../shared/protocol.js';
import { CAR_RESPAWN_SHIELD, CAR_SHIELD } from '../../shared/net/codec.js';
import {
    COIN_MAGNET_PICKUP_RADIUS, COIN_PICKUP_RADIUS, COIN_RESET_TICKS, COIN_VALUE, KILL_REWARD, MAX_HEALTH,
    POWERUP_PICKUP_RADIUS, POWERUP_RESET_TICKS, POWERUP_TICKS, RAM_MIN_ATTACK_SPEED, RAM_PAIR_COOLDOWN_TICKS, RESPAWN_SHIELD_DRIVE_TICKS,
    POWERUP_TYPE_IDS, RESPAWN_SHIELD_MAX_TICKS, RESPAWN_SHIELD_MOVE_SPEED, RESPAWN_TICKS, SHOT_COOLDOWN_TICKS, SHOT_RANGE,
    isPowerupType, ramDamage, shotDamage
} from '../../shared/party/rules.js';
import { spawnVehicle } from '../../shared/sim/vehicle.js';
import type { MapData, SpawnSlot } from '../../shared/map/mapData.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import { clearPowerups, createPartyState, powerupActive, type PartyMemberState } from '../party/state.js';
import { Room, type LeaveReason, type RoomMember, type RoomMessage } from './Room.js';
import { slotSpawn, type SpawnKeepOut } from './spawn.js';

// The Party (docs/phase-1b-design.md, 2.2 and 5.5): coins, powerups,
// shooting, the Mega ram, HP and the scoreboard, the default room. Every
// rule runs in the room tick against the server's cars; each room has its
// own items.

type Msg<T extends RoomMessage['type']> = Extract<RoomMessage, { type: T }>;

// No car spawns within an item's pickup radius plus this (m): a spawn must
// not collect anything before the player drives
const SPAWN_PICKUP_MARGIN = 2;

interface Item<T> {
    data: T;
    // Tick the item comes back, -1 while it is there
    resetTick: number;
}

// Towards the other car at least RAM_MIN_ATTACK_SPEED at the start of the
// tick (the direction between the two cars after the contact)
function drivesAt(attacker: PartyMemberState, from: { x: number; z: number }, to: { x: number; z: number }): boolean {
    const dx = to.x - from.x, dz = to.z - from.z;
    const d = Math.hypot(dx, dz);
    if (!(d > 1e-6)) return false;
    return (attacker.tickStartVx * dx + attacker.tickStartVz * dz) / d >= RAM_MIN_ATTACK_SPEED;
}

export class PartyRoom extends Room {
    readonly powerups: PowerupData[];
    readonly coins: CoinData[];
    private readonly powerupItems: Item<PowerupData>[];
    private readonly coinItems: Item<CoinData>[];
    private readonly party = new Map<string, PartyMemberState>();
    private readonly keepOut: readonly SpawnKeepOut[];

    constructor(index: number, map: MapData, now: () => number = Date.now) {
        super('party', index, map, now);
        // Fresh copies: collecting in one room leaves the others untouched
        this.powerups = map.items.powerups.map(p => ({ ...p, collected: false }));
        this.coins = map.items.coins.map(c => ({ ...c, collected: false }));
        this.powerupItems = this.powerups.map(data => ({ data, resetTick: -1 }));
        this.coinItems = this.coins.map(data => ({ data, resetTick: -1 }));
        // Every item, collected or not: a car standing on the spot of a
        // collected one would take it again when it comes back
        this.keepOut = [
            ...this.coins.map(c => ({ x: c.x, z: c.z, radius: COIN_PICKUP_RADIUS + SPAWN_PICKUP_MARGIN })),
            ...this.powerups.map(p => ({ x: p.x, z: p.z, radius: POWERUP_PICKUP_RADIUS + SPAWN_PICKUP_MARGIN }))
        ];
    }

    protected spawnKeepOut(): readonly SpawnKeepOut[] {
        return this.keepOut;
    }

    // The arena behind its closed gate (docs/phase-3-design.md, 12)
    protected get world(): SimWorld {
        return this.map.partyWorld;
    }

    protected spawnSlots(): readonly SpawnSlot[] {
        return this.map.spawns.party;
    }

    partyState(id: string): PartyMemberState | undefined {
        return this.party.get(id);
    }

    roomStateItems(): RoomStateItems {
        return {
            powerups: this.powerups.map(p => ({ id: p.id, collected: p.collected })),
            coins: this.coins.map(c => ({ id: c.id, collected: c.collected }))
        };
    }

    scoreboard(): ScoreboardEntry[] {
        return this.orderedMembers
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

    scoreOf(member: RoomMember): number {
        return this.party.get(member.id)?.score ?? 0;
    }

    protected healthOf(member: RoomMember): number {
        return this.party.get(member.id)?.health ?? MAX_HEALTH;
    }

    protected carFlags(m: RoomMember): number {
        const state = this.party.get(m.id);
        let flags = super.carFlags(m) & ~CAR_SHIELD;
        if (state && powerupActive(state, 'shield', this.tick)) flags |= CAR_SHIELD;
        if (state?.respawnShield) flags |= CAR_RESPAWN_SHIELD;
        return flags;
    }

    // ---- Membership ----

    protected onJoin(member: RoomMember): void {
        const state = createPartyState();
        // A score carried over a server restart (resume ticket, 11.3)
        const carried = member.session.carryScore;
        if (carried > 0) {
            state.score = carried;
            member.session.carryScore = 0;
        }
        this.party.set(member.id, state);
    }

    protected powerupWindows(member: RoomMember): ResumeState['powerups'] {
        const state = this.party.get(member.id);
        if (!state) return [];
        return POWERUP_TYPE_IDS
            .filter(type => state.powerups[type].end > this.tick)
            .map(type => ({ type, startTick: state.powerups[type].start, endTick: state.powerups[type].end }));
    }

    protected onLeave(member: RoomMember, _reason: LeaveReason): void {
        this.party.delete(member.id);
        for (const state of this.party.values()) state.rammedBy.delete(member.id);
    }

    protected onSpawned(member: RoomMember, tick: number): void {
        const state = this.party.get(member.id);
        if (!state) return;
        this.resetForSpawn(state, tick);
    }

    private resetForSpawn(state: PartyMemberState, tick: number): void {
        state.health = MAX_HEALTH;
        state.deadUntil = -1;
        clearPowerups(state);
        state.respawnShield = true;
        state.spawnTick = tick;
        state.movedTick = -1;
    }

    // ---- The tick ----

    protected beforeStep(tick: number): void {
        for (const m of this.orderedMembers) {
            const car = m.car;
            const state = this.party.get(m.id);
            if (!car || !m.alive || !state) continue;
            const mods = car.mods;
            mods.turbo = powerupActive(state, 'speed', tick);
            mods.mega = powerupActive(state, 'size', tick);
            mods.superJump = powerupActive(state, 'jump', tick);
            mods.ghost = powerupActive(state, 'ghost', tick);
            mods.shield = powerupActive(state, 'shield', tick) || state.respawnShield;
            state.tickStartVx = car.state.vx;
            state.tickStartVz = car.state.vz;
        }
    }

    protected afterStep(tick: number): void {
        this.ramDamage(tick);
        this.pickups(tick);
        this.itemResets(tick);
        this.shieldsAndRespawns(tick);
    }

    // Mega ram (5.5): damage from the impulse the rammed car took
    private ramDamage(tick: number): void {
        for (const target of this.orderedMembers) {
            const car = target.car;
            const targetState = this.party.get(target.id);
            if (!car || !target.alive || !targetState) continue;
            const ev = car.events;
            if (ev.carImpactId === '') continue;
            const attacker = this.members.get(ev.carImpactId);
            const attackerState = attacker && this.party.get(attacker.id);
            if (!attacker || !attackerState || !attacker.alive || !attacker.car?.mods.mega || attacker.idle) continue;
            // Only a Mega car that drives into its target rams: parked, or
            // hit by a car driving into it, it deals no damage
            if (!drivesAt(attackerState, attacker.car.state, car.state)) continue;
            const damage = ramDamage(ev.carImpact, car.mods.mega);
            if (damage <= 0) continue;
            const last = targetState.rammedBy.get(attacker.id);
            if (last !== undefined && tick - last < RAM_PAIR_COOLDOWN_TICKS) continue;
            targetState.rammedBy.set(attacker.id, tick);
            if (!this.vulnerable(target, targetState, tick)) continue;
            this.damage(attacker, attackerState, target, targetState, damage, 'ram', tick);
        }
    }

    private pickups(tick: number): void {
        for (const m of this.orderedMembers) {
            const car = m.car;
            const state = this.party.get(m.id);
            // An idle ghost (background, frozen, gone) collects nothing
            if (!car || !m.alive || !state || m.idle) continue;
            const x = car.state.x, z = car.state.z;
            for (const item of this.powerupItems) {
                const p = item.data;
                if (p.collected || !isPowerupType(p.type)) continue;
                const dx = x - p.x, dz = z - p.z;
                if (dx * dx + dz * dz >= POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS) continue;
                p.collected = true;
                item.resetTick = tick + POWERUP_RESET_TICKS;
                // Effective from the next tick; again extends to now + duration
                const window = state.powerups[p.type];
                const active = window.start <= tick + 1 && tick + 1 < window.end;
                if (!active) window.start = tick + 1;
                window.end = tick + 1 + POWERUP_TICKS[p.type];
                this.emit({
                    type: 'pickup', kind: 'powerup', itemId: p.id, playerId: m.id,
                    powerupType: p.type, startTick: window.start, endTick: window.end
                });
            }
            const magnet = powerupActive(state, 'magnet', tick);
            const radius = magnet ? COIN_MAGNET_PICKUP_RADIUS : COIN_PICKUP_RADIUS;
            for (const item of this.coinItems) {
                const c = item.data;
                if (c.collected) continue;
                const dx = x - c.x, dz = z - c.z;
                if (dx * dx + dz * dz >= radius * radius) continue;
                c.collected = true;
                item.resetTick = tick + COIN_RESET_TICKS;
                state.score += COIN_VALUE;
                this.markScoreboardDirty();
                this.emit({ type: 'pickup', kind: 'coin', itemId: c.id, playerId: m.id });
            }
        }
    }

    private itemResets(tick: number): void {
        for (const item of this.powerupItems) {
            if (item.resetTick >= 0 && item.resetTick <= tick) {
                item.resetTick = -1;
                item.data.collected = false;
                this.emit({ type: 'itemReset', kind: 'powerup', itemId: item.data.id });
            }
        }
        for (const item of this.coinItems) {
            if (item.resetTick >= 0 && item.resetTick <= tick) {
                item.resetTick = -1;
                item.data.collected = false;
                this.emit({ type: 'itemReset', kind: 'coin', itemId: item.data.id });
            }
        }
    }

    private shieldsAndRespawns(tick: number): void {
        for (const m of this.orderedMembers) {
            const state = this.party.get(m.id);
            if (!state || !m.car) continue;
            if (!m.alive) {
                if (state.deadUntil >= 0 && tick >= state.deadUntil) this.respawn(m, state, tick);
                continue;
            }
            if (!state.respawnShield) continue;
            const s = m.car.state;
            if (state.movedTick < 0 && Math.hypot(s.vx, s.vz) > RESPAWN_SHIELD_MOVE_SPEED) state.movedTick = tick;
            if ((state.movedTick >= 0 && tick - state.movedTick >= RESPAWN_SHIELD_DRIVE_TICKS)
                || tick - state.spawnTick >= RESPAWN_SHIELD_MAX_TICKS) {
                state.respawnShield = false;
            }
        }
    }

    // Back at a free spot of this room, whole and without powerups
    private respawn(m: RoomMember, state: PartyMemberState, tick: number): void {
        const pose = slotSpawn(this.spawnSlots(), this.spawnTurn++, this.carPositions(m), this.spawnKeepOut());
        spawnVehicle(m.car!.state, this.world, pose.x, pose.z, pose.yaw);
        m.alive = true;
        m.spawnTick = tick;
        this.resetForSpawn(state, tick);
        this.emit({ type: 'respawn', id: m.id, tick, x: pose.x, z: pose.z, yaw: pose.yaw, health: state.health });
    }

    // ---- Shooting ----

    protected onGameMessage(member: RoomMember, msg: RoomMessage): void {
        if (msg.type === 'shoot') this.handleShoot(member, msg);
    }

    // Shields, ghost, idle and the respawn shield block all damage
    private vulnerable(target: RoomMember, state: PartyMemberState, tick: number): boolean {
        return target.alive && !target.idle && !state.respawnShield
            && !powerupActive(state, 'ghost', tick) && !powerupActive(state, 'shield', tick);
    }

    private handleShoot(member: RoomMember, msg: Msg<'shoot'>): void {
        const state = this.party.get(member.id);
        if (!state || !member.ready || !member.alive || !member.car || member.idle) return;
        if (msg.targetId === member.id) return;
        const tick = this.tick;
        if (tick - state.lastShotTick < SHOT_COOLDOWN_TICKS) return;

        // Only players of this room can be hit
        const target = this.members.get(msg.targetId);
        const targetState = this.party.get(msg.targetId);
        if (!target || !targetState || !target.ready || !target.alive || !target.car) return;
        const dx = member.car.state.x - target.car.state.x;
        const dz = member.car.state.z - target.car.state.z;
        if (dx * dx + dz * dz > SHOT_RANGE * SHOT_RANGE) return;

        state.lastShotTick = tick;
        if (!this.vulnerable(target, targetState, tick)) return;
        this.damage(member, state, target, targetState, shotDamage(target.car.mods.mega), 'shot', tick);
    }

    private damage(
        source: RoomMember, sourceState: PartyMemberState,
        target: RoomMember, targetState: PartyMemberState,
        damage: number, cause: 'shot' | 'ram', tick: number
    ): void {
        targetState.health = Math.max(0, targetState.health - damage);
        this.emit({ type: 'hit', target: target.id, source: source.id, damage, health: targetState.health, cause });
        if (targetState.health > 0) return;
        // The car leaves the sim until the respawn
        target.alive = false;
        targetState.deadUntil = tick + RESPAWN_TICKS;
        clearPowerups(targetState);
        targetState.respawnShield = false;
        this.emit({
            type: 'killed', target: target.id, killer: source.id,
            killerName: source.session.name, targetName: target.session.name, cause
        });
        sourceState.score += KILL_REWARD;
        this.markScoreboardDirty();
    }
}
