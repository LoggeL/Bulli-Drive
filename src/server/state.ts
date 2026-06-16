import { Player } from './types.js';
import { PlayerData, ScoreboardEntry } from '../shared/protocol.js';
import { MEGA_SCALE } from '../shared/constants.js';

export const players: Record<string, Player> = {};

export function playerScale(p: Player): number {
    return p.megaActive ? MEGA_SCALE : 1;
}

export function randomSpawn(): { x: number; z: number } {
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 60;
    return { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
}

export function getPublicPlayer(id: string): PlayerData {
    const p = players[id];
    return {
        id: p.id,
        color: p.color,
        name: p.name,
        carType: p.carType,
        x: p.x,
        z: p.z,
        angle: p.angle,
        flipAngle: p.flipAngle,
        isFlipping: p.isFlipping,
        scale: playerScale(p),
        score: p.score,
        health: p.health
    };
}

export function getPublicPlayers(): Record<string, PlayerData> {
    const publicPlayers: Record<string, PlayerData> = {};
    for (const id in players) {
        if (!players[id].ready) continue;
        publicPlayers[id] = getPublicPlayer(id);
    }
    return publicPlayers;
}

export function getScoreboard(): ScoreboardEntry[] {
    return Object.values(players)
        .filter(p => p.ready)
        .map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            color: p.color
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
}
