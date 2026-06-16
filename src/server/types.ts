import { WebSocket } from 'ws';

// Wire DTOs live in src/shared/protocol.ts; re-export them under the names
// the server modules historically used.
export type {
    PowerupData as Powerup,
    CoinData as Coin,
    TreeData as Tree,
    BuildingData as Building,
    RoadData as Road,
    CityData,
    TerrainConfig,
    PlayerData,
    ScoreboardEntry
} from '../shared/protocol.js';

// Server-only per-connection state
export interface Player {
    id: string;
    ws: WebSocket;
    ready: boolean;
    color: number;
    name: string;
    carType: string;
    x: number;
    y: number;
    z: number;
    angle: number;
    flipAngle: number;
    isFlipping: boolean;
    score: number;
    health: number;
    shieldActive: boolean;
    ghostActive: boolean;
    megaActive: boolean;
    shieldTimeout?: ReturnType<typeof setTimeout>;
    ghostTimeout?: ReturnType<typeof setTimeout>;
    megaTimeout?: ReturnType<typeof setTimeout>;
    respawnShieldTimeout?: ReturnType<typeof setTimeout>;
    respawnTimeout?: ReturnType<typeof setTimeout>;
    lastActivity: number;
    // Rate-limit bookkeeping
    lastUpdateAt: number;
    lastHonkAt: number;
    lastRenameAt: number;
    lastShotAt: number;
    respawnShield: boolean;
}
