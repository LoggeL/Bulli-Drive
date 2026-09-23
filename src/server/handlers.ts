import { ClientMessage, ServerMessage, parseClientMessage } from '../shared/protocol.js';
import {
    AFK_THRESHOLD_MS,
    BASE_SHOT_DAMAGE,
    COIN_ACCEPT_RADIUS,
    COIN_RESPAWN_DELAY_MS,
    COIN_VALUE,
    KILL_REWARD,
    MAX_HEALTH,
    MAX_NAME_LENGTH,
    MAX_SHOT_RANGE,
    MEGA_DAMAGE_REDUCTION,
    POWERUP_ACCEPT_RADIUS,
    POWERUP_DURATIONS_MS,
    POWERUP_RESPAWN_DELAY_MS,
    RESPAWN_DELAY_MS,
    RESPAWN_SHIELD_MAX_MS,
    SHOT_COOLDOWN_MS,
    VALID_CAR_TYPES,
    WORLD_BOUND
} from '../shared/constants.js';
import { HONK_INTERVAL_MS, MIN_UPDATE_INTERVAL_MS, RENAME_INTERVAL_MS, Y_MAX, Y_MIN } from './config.js';
import { Player } from './types.js';
import { players, getPublicPlayer, playerScale, randomSpawn } from './state.js';
import { broadcast, broadcastScoreboard } from './net.js';
import { powerupsById, coinsById } from './world.js';

type Msg<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

// Entry point for every parsed inbound frame. Anything that does not match
// the shared ClientMessageSchema is dropped silently, like unknown types were
// before, so a broken or hostile client cannot crash a handler.
export function handleClientMessage(id: string, data: unknown) {
    const player = players[id];
    if (!player) return;
    const msg = parseClientMessage(data);
    if (!msg) return;

    switch (msg.type) {
        case 'update': return handleUpdate(player, msg);
        case 'collectPowerup': return handleCollectPowerup(player, msg);
        case 'collectCoin': return handleCollectCoin(player, msg);
        case 'honk': return handleHonk(player);
        case 'rename': return handleRename(player, msg);
        case 'setCarType': return handleSetCarType(player, msg);
        case 'playerReady': return handlePlayerReady(player);
        case 'respawnShieldExpired': return handleRespawnShieldExpired(player);
        case 'shoot': return handleShoot(player, msg);
        default: return;
    }
}

// ---------- per-message handlers ----------

function handleUpdate(player: Player, msg: Msg<'update'>) {
    if (!player.ready) return;
    const now = Date.now();
    if (now - player.lastUpdateAt < MIN_UPDATE_INTERVAL_MS) return;
    // x/z/angle/flipAngle are finite numbers (schema); y may be missing.
    const y = typeof msg.y === 'number' && Number.isFinite(msg.y) ? msg.y : 0;

    player.lastUpdateAt = now;
    player.x = clamp(msg.x, -WORLD_BOUND, WORLD_BOUND);
    player.y = clamp(y, Y_MIN, Y_MAX);
    player.z = clamp(msg.z, -WORLD_BOUND, WORLD_BOUND);
    player.angle = msg.angle;
    player.flipAngle = msg.flipAngle;
    player.isFlipping = msg.isFlipping;
    player.lastActivity = now;

    broadcastPlayerState(player.id, player.id);
}

function handleCollectPowerup(player: Player, msg: Msg<'collectPowerup'>) {
    if (!player.ready) return;
    const powerup = powerupsById.get(msg.powerupId);
    if (!powerup) return;

    const accepted = collectItem(player, powerup, POWERUP_ACCEPT_RADIUS, POWERUP_RESPAWN_DELAY_MS,
        itemId => ({ type: 'powerupCollected', powerupId: itemId, playerId: player.id }),
        itemId => ({ type: 'powerupReset', powerupId: itemId }));
    if (!accepted) return;

    console.log(`Player ${player.name} collected powerup ${powerup.id} (${powerup.type})`);
    activatePowerup(player.id, powerup.type);
}

function handleCollectCoin(player: Player, msg: Msg<'collectCoin'>) {
    if (!player.ready) return;
    const coin = coinsById.get(msg.coinId);
    if (!coin) return;

    const accepted = collectItem(player, coin, COIN_ACCEPT_RADIUS, COIN_RESPAWN_DELAY_MS,
        itemId => ({ type: 'coinCollected', coinId: itemId, playerId: player.id }),
        itemId => ({ type: 'coinReset', coinId: itemId }));
    if (!accepted) return;

    console.log(`Player ${player.name} collected coin ${coin.id}`);
    player.score += COIN_VALUE;
    broadcastScoreboard();
}

function handleHonk(player: Player) {
    if (!player.ready) return;
    const now = Date.now();
    if (now - player.lastHonkAt < HONK_INTERVAL_MS) return;
    player.lastHonkAt = now;
    broadcast({ type: 'honk', id: player.id }, player.id);
}

function handleRename(player: Player, msg: Msg<'rename'>) {
    const now = Date.now();
    if (now - player.lastRenameAt < RENAME_INTERVAL_MS) return;
    const cleanName = msg.name.replace(/[\x00-\x1f\x7f]/g, '').trim().substring(0, MAX_NAME_LENGTH);
    if (!cleanName) return;
    player.lastRenameAt = now;
    const oldName = player.name;
    player.name = cleanName;
    console.log(`Player ${oldName} renamed to ${player.name}`);
    if (player.ready) {
        broadcast({ type: 'playerRenamed', id: player.id, name: player.name });
        broadcastScoreboard();
    }
}

function handleSetCarType(player: Player, msg: Msg<'setCarType'>) {
    if (!VALID_CAR_TYPES.includes(msg.carType)) return;
    player.carType = msg.carType;
}

function handlePlayerReady(player: Player) {
    if (player.ready) return;
    player.ready = true;
    broadcast({ type: 'newPlayer', player: getPublicPlayer(player.id) }, player.id);
    broadcastScoreboard();
}

function handleRespawnShieldExpired(player: Player) {
    // Client hint that the shield visual ended early; the server cap timer
    // (RESPAWN_SHIELD_MAX_MS) stays authoritative otherwise.
    player.respawnShield = false;
    if (player.respawnShieldTimeout) {
        clearTimeout(player.respawnShieldTimeout);
        player.respawnShieldTimeout = undefined;
    }
}

function handleShoot(player: Player, msg: Msg<'shoot'>) {
    if (!player.ready) return;
    if (msg.targetId === player.id) return;

    const now = Date.now();
    if (player.health <= 0) return;
    // Shooter must have sent updates recently (no shooting while AFK)
    if (now - player.lastActivity > AFK_THRESHOLD_MS) return;
    if (now - player.lastShotAt < SHOT_COOLDOWN_MS) return;

    const target = players[msg.targetId];
    if (!target || !target.ready || target.health <= 0) return;

    const dx = player.x - target.x;
    const dz = player.z - target.z;
    if (dx * dx + dz * dz > MAX_SHOT_RANGE * MAX_SHOT_RANGE) return;

    player.lastShotAt = now;

    // AFK targets (no update for 3+ seconds) are invulnerable
    if (now - target.lastActivity > AFK_THRESHOLD_MS) return;
    // Respawn shield and ghost block all damage
    if (target.respawnShield || target.ghostActive) return;

    // Shield grants full immunity to incoming shots for its whole duration
    // (matches the bubble + timer bar). It is not consumed per hit; it expires
    // on its own timer in activatePowerup().
    if (target.shieldActive) {
        return;
    }

    const damage = target.megaActive
        ? Math.round(BASE_SHOT_DAMAGE * MEGA_DAMAGE_REDUCTION)
        : BASE_SHOT_DAMAGE;
    target.health = Math.max(0, target.health - damage);

    console.log(`Player ${player.name} shot ${target.name} (health: ${target.health})`);

    broadcast({
        type: 'playerHit',
        targetId: target.id,
        shooterId: player.id,
        newHealth: target.health,
        damage
    });

    if (target.health <= 0) {
        broadcast({
            type: 'playerKilled',
            targetId: target.id,
            killerId: player.id,
            killerName: player.name,
            targetName: target.name
        });

        player.score += KILL_REWARD;
        broadcastScoreboard();
        scheduleRespawn(target.id);
    }
}

// ---------- helpers ----------

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

// Generic pickup: proximity check, atomic check-and-set, collected broadcast
// and scheduled reset broadcast. Returns true if the collect was accepted.
function collectItem(
    player: Player,
    item: { id: number; x: number; z: number; collected: boolean },
    acceptRadius: number,
    respawnDelayMs: number,
    collectedMsg: (itemId: number) => ServerMessage,
    resetMsg: (itemId: number) => ServerMessage
): boolean {
    if (item.collected) return false;
    const dx = player.x - item.x;
    const dz = player.z - item.z;
    if (dx * dx + dz * dz > acceptRadius * acceptRadius) return false;
    item.collected = true;

    broadcast(collectedMsg(item.id));
    setTimeout(() => {
        item.collected = false;
        broadcast(resetMsg(item.id));
    }, respawnDelayMs);
    return true;
}

// Powerup types with a server-tracked effect flag (speed/jump/magnet are client-side only)
const POWERUP_EFFECTS: Record<string, {
    flag: 'shieldActive' | 'ghostActive' | 'megaActive';
    timeoutKey: 'shieldTimeout' | 'ghostTimeout' | 'megaTimeout';
}> = {
    shield: { flag: 'shieldActive', timeoutKey: 'shieldTimeout' },
    ghost: { flag: 'ghostActive', timeoutKey: 'ghostTimeout' },
    size: { flag: 'megaActive', timeoutKey: 'megaTimeout' }
};

function activatePowerup(id: string, powerupType: string) {
    const effect = POWERUP_EFFECTS[powerupType];
    const durationMs = POWERUP_DURATIONS_MS[powerupType];
    if (!effect || !durationMs) return;
    const player = players[id];
    if (!player) return;

    player[effect.flag] = true;
    if (player[effect.timeoutKey]) {
        clearTimeout(player[effect.timeoutKey]);
    }

    broadcastPlayerState(id);

    player[effect.timeoutKey] = setTimeout(() => {
        const current = players[id];
        if (!current) return;
        current[effect.flag] = false;
        current[effect.timeoutKey] = undefined;
        broadcastPlayerState(id);
    }, durationMs);
}

export function clearPowerupTimeouts(player: Player) {
    for (const key of ['shieldTimeout', 'ghostTimeout', 'megaTimeout'] as const) {
        if (player[key]) {
            clearTimeout(player[key]);
            player[key] = undefined;
        }
    }
}

// Arms the respawn invulnerability and its server-side hard-cap expiry timer.
function startRespawnShield(player: Player) {
    player.respawnShield = true;
    if (player.respawnShieldTimeout) {
        clearTimeout(player.respawnShieldTimeout);
    }
    player.respawnShieldTimeout = setTimeout(() => {
        player.respawnShield = false;
        player.respawnShieldTimeout = undefined;
    }, RESPAWN_SHIELD_MAX_MS);
}

// Shared spawn-state reset for both initial spawn and respawn.
export function applySpawnState(player: Player, x: number, z: number) {
    player.x = x;
    player.y = 0;
    player.z = z;
    player.health = MAX_HEALTH;
    player.shieldActive = false;
    player.ghostActive = false;
    player.megaActive = false;
    player.lastActivity = Date.now();
    clearPowerupTimeouts(player);
    startRespawnShield(player);
}

function scheduleRespawn(targetId: string) {
    const target = players[targetId];
    if (!target) return;
    if (target.respawnTimeout) clearTimeout(target.respawnTimeout);
    // Re-resolve the player inside the timeout so we don't poke a stale
    // reference if the player disconnected in the meantime.
    target.respawnTimeout = setTimeout(() => {
        const reborn = players[targetId];
        if (!reborn) return;
        reborn.respawnTimeout = undefined;
        const sp = randomSpawn();
        applySpawnState(reborn, sp.x, sp.z);

        broadcast({
            type: 'playerRespawn',
            playerId: targetId,
            health: reborn.health,
            x: sp.x,
            z: sp.z,
            y: reborn.y,
            angle: reborn.angle
        });
    }, RESPAWN_DELAY_MS);
}

// Clears every per-connection timer; must be called on disconnect.
export function cleanupPlayerTimers(player: Player) {
    clearPowerupTimeouts(player);
    if (player.respawnShieldTimeout) {
        clearTimeout(player.respawnShieldTimeout);
        player.respawnShieldTimeout = undefined;
    }
    if (player.respawnTimeout) {
        clearTimeout(player.respawnTimeout);
        player.respawnTimeout = undefined;
    }
}

function broadcastPlayerState(id: string, excludeId?: string) {
    const player = players[id];
    if (!player || !player.ready) return;

    broadcast({
        type: 'update',
        id,
        x: player.x,
        z: player.z,
        y: player.y,
        angle: player.angle,
        flipAngle: player.flipAngle,
        isFlipping: player.isFlipping,
        scale: playerScale(player),
        ghostActive: player.ghostActive,
        shieldActive: player.shieldActive
    }, excludeId);
}
