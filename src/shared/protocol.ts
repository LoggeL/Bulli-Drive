// Shared wire protocol - single source of truth for client and server.
// Field shapes must match what is actually serialized on each side.

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
// Note: no 'scoreUpdate' (server is sole score authority) and 'shoot' carries no damage.

export type ClientMessage =
    | { type: 'update', x: number, z: number, y?: number, angle: number, flipAngle: number, isFlipping: boolean, scale?: number, ghostActive?: boolean, shieldActive?: boolean, megaActive?: boolean }
    | { type: 'collectPowerup', powerupId: number }
    | { type: 'collectCoin', coinId: number }
    | { type: 'honk' }
    | { type: 'rename', name: string }
    | { type: 'setCarType', carType: string }
    | { type: 'playerReady' }
    | { type: 'respawnShieldExpired' }
    | { type: 'shoot', targetId: string };

// ---------- Server -> Client ----------

export type ServerMessage =
    | { type: 'init', id: string, color: number, name: string, players: Record<string, PlayerData>, powerups: PowerupData[], coins: CoinData[], terrain: TerrainConfig, trees: TreeData[], city: CityData, scoreboard: ScoreboardEntry[] }
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
    | { type: 'playerRespawn', playerId: string, health: number, x: number, z: number }
    | { type: 'shieldBreak', targetId: string, shooterId: string };
