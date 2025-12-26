import { WebSocket } from 'ws';

export interface Player {
    id: string;
    ws: WebSocket;
    color: number;
    name: string;
    x: number;
    z: number;
    angle: number;
    flipAngle: number;
    isFlipping: boolean;
    scale?: number;
}

export interface Powerup {
    id: number;
    x: number;
    z: number;
    type: string;
    color: number;
    label: string;
    collected: boolean;
}

export interface Tree {
    id: number;
    x: number;
    z: number;
    height: number;
}

export interface TerrainConfig {
    size: number;
    segments: number;
    frequency1: number;
    amplitude1: number;
    frequency2: number;
    amplitude2: number;
}
