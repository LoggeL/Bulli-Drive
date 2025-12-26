import * as THREE from 'three';

export interface TerrainConfig {
    size: number;
    segments: number;
    frequency1: number;
    amplitude1: number;
    frequency2: number;
    amplitude2: number;
}

export interface PlayerData {
    id: string;
    color: number;
    name: string;
    x: number;
    z: number;
    angle: number;
    flipAngle: number;
    isFlipping: boolean;
    scale?: number;
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

export interface TreeData {
    id: number;
    x: number;
    z: number;
    height: number;
}

export interface RemotePlayer {
    id: string;
    group: THREE.Group;
    flipGroup: THREE.Group;
    name: string;
    colorCode: number;
    nametag?: HTMLElement;
    updateNametag(): void;
    honk(): void;
}

export interface Inputs {
    w: boolean;
    a: boolean;
    s: boolean;
    d: boolean;
    f: boolean;
    space: boolean;
    arrowleft: boolean;
    arrowright: boolean;
}

export type ServerMessage = 
    | { type: 'init', id: string, color: number, name: string, players: Record<string, PlayerData>, powerups: PowerupData[], terrain: TerrainConfig, trees: TreeData[] }
    | { type: 'newPlayer', player: PlayerData }
    | { type: 'update', id: string, x: number, z: number, angle: number, flipAngle: number, isFlipping: boolean, scale?: number }
    | { type: 'removePlayer', id: string }
    | { type: 'powerupCollected', powerupId: number, playerId: string }
    | { type: 'powerupReset', powerupId: number }
    | { type: 'honk', id: string }
    | { type: 'playerRenamed', id: string, name: string };
