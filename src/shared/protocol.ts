// Shared wire protocol - single source of truth for client and server.
// Field shapes must match what is actually serialized on each side.

import * as v from 'valibot';

// Bumped on every incompatible wire change. Not negotiated yet: a later
// phase makes the client send it in a handshake and the server reject
// mismatches instead of silently dropping unknown messages.
export const PROTOCOL_VERSION = 1;

// ---------- DTOs ----------

export interface TerrainConfig {
    size: number;
    segments: number;
    frequency1: number;
    amplitude1: number;
    frequency2: number;
    amplitude2: number;
    frequency3: number;
    amplitude3: number;
}

export interface PowerupData {
    id: number;
    x: number;
    z: number;
    type: string;
    color: number;
    label: string;
    collected: boolean;
}

export interface CoinData {
    id: number;
    x: number;
    z: number;
    collected: boolean;
}

export interface TreeData {
    id: number;
    x: number;
    z: number;
    height: number;
}

export interface BuildingData {
    x: number;
    z: number;
    width: number;
    depth: number;
    height: number;
    color: number;
}

export interface RoadData {
    x: number;
    z: number;
    width: number;
    length: number;
    rotation: number;
}

export interface CityData {
    buildings: BuildingData[];
    roads: RoadData[];
}

export interface PlayerData {
    id: string;
    color: number;
    name: string;
    carType?: string;
    x: number;
    z: number;
    angle: number;
    flipAngle: number;
    isFlipping: boolean;
    scale?: number;
    score?: number;
    health?: number;
}

export interface ScoreboardEntry {
    id: string;
    name: string;
    score: number;
    color: number;
}

// ---------- Client -> Server ----------
// Runtime schemas: the server validates every inbound frame against these
// and drops anything that does not match. The TypeScript types are derived
// from them, so sender and validator cannot drift apart.
// Note: no 'scoreUpdate' (server is sole score authority) and 'shoot' carries no damage.

const finiteNumber = v.pipe(v.number(), v.finite());

export const ClientMessageSchema = v.variant('type', [
    v.object({
        type: v.literal('update'),
        x: finiteNumber,
        z: finiteNumber,
        // Visual bob/jump offset; the server falls back to 0 when it is missing
        // (JSON turns a NaN into null).
        y: v.optional(v.nullable(v.number())),
        angle: finiteNumber,
        flipAngle: finiteNumber,
        isFlipping: v.boolean(),
        // Client-side hints only; the server tracks these effects itself.
        scale: v.optional(v.number()),
        ghostActive: v.optional(v.boolean()),
        shieldActive: v.optional(v.boolean()),
        megaActive: v.optional(v.boolean())
    }),
    v.object({ type: v.literal('collectPowerup'), powerupId: v.number() }),
    v.object({ type: v.literal('collectCoin'), coinId: v.number() }),
    v.object({ type: v.literal('honk') }),
    // Length and control characters are cleaned up by the server.
    v.object({ type: v.literal('rename'), name: v.string() }),
    // Unknown car types are ignored by the server (VALID_CAR_TYPES).
    v.object({ type: v.literal('setCarType'), carType: v.string() }),
    v.object({ type: v.literal('playerReady') }),
    v.object({ type: v.literal('respawnShieldExpired') }),
    v.object({ type: v.literal('shoot'), targetId: v.string() })
]);

export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

// Returns the validated message (unknown keys stripped), or null if the
// value is not a well-formed client message.
export function parseClientMessage(value: unknown): ClientMessage | null {
    const result = v.safeParse(ClientMessageSchema, value);
    return result.success ? result.output : null;
}

// ---------- Server -> Client ----------

export type ServerMessage =
    | { type: 'init', id: string, color: number, name: string, spawn: { x: number; z: number }, players: Record<string, PlayerData>, powerups: PowerupData[], coins: CoinData[], terrain: TerrainConfig, trees: TreeData[], city: CityData, scoreboard: ScoreboardEntry[] }
    | { type: 'newPlayer', player: PlayerData }
    | { type: 'update', id: string, x: number, z: number, y?: number, angle: number, flipAngle: number, isFlipping: boolean, scale?: number, ghostActive?: boolean, shieldActive?: boolean }
    | { type: 'removePlayer', id: string }
    | { type: 'powerupCollected', powerupId: number, playerId: string }
    | { type: 'powerupReset', powerupId: number }
    | { type: 'coinCollected', coinId: number, playerId: string }
    | { type: 'coinReset', coinId: number }
    | { type: 'honk', id: string }
    | { type: 'playerRenamed', id: string, name: string }
    | { type: 'scoreboard', scoreboard: ScoreboardEntry[] }
    | { type: 'playerHit', targetId: string, shooterId: string, newHealth: number, damage: number }
    | { type: 'playerKilled', targetId: string, killerId: string, killerName: string, targetName: string }
    | { type: 'playerRespawn', playerId: string, health: number, x: number, z: number, y?: number, angle?: number }
    | { type: 'shieldBreak', targetId: string, shooterId: string };
