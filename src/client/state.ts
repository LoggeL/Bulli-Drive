import * as THREE from 'three';
import { RemotePlayer, Inputs, PowerupData, CoinData, TerrainConfig, ScoreboardEntry, Obstacle } from './types.js';

export const state = {
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    renderer: null as unknown as THREE.WebGLRenderer,
    bulli: null as any, // Local car instance
    remotePlayers: {} as Record<string, RemotePlayer>,
    inputs: {
        throttle: 0, steer: 0, e: false, f: false, space: false
    } as Inputs,
    worldPowerups: [] as PowerupData[],
    isModalOpen: false,
    audioCtx: null as AudioContext | null,
    ws: null as WebSocket | null,
    obstacles: [] as Obstacle[],
    terrainConfig: null as TerrainConfig | null,
    myId: null as string | null,
    myColor: null as number | null,
    myName: "Player",
    myCarType: "bulli",
    score: 0,
    coins: [] as any[],
    serverCoins: null as CoinData[] | null,
    particles: [] as any[],
    clock: new THREE.Clock(),
    // Set whenever the local car is spawned or teleported so the chase camera
    // can snap into place instead of flying across the map.
    cameraSnapPending: true,
    health: 100,
    dead: false,
    respawnTimer: 0,
    scoreboard: [] as ScoreboardEntry[],
    killfeed: [] as { killer: string; victim: string; time: number }[],
    respawnShield: false as boolean,
    respawnMoveStart: 0 as number
};
