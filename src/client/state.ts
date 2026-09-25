import * as THREE from 'three';
import { RemotePlayer, Inputs } from './types.js';
import type { PowerupData, CoinData, TerrainConfig, ScoreboardEntry, RoomInfo } from '../shared/protocol.js';
import type { ColliderInput } from '../shared/world/colliders.js';

export const state = {
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    renderer: null as unknown as THREE.WebGLRenderer,
    bulli: null as any, // Local car instance
    remotePlayers: {} as Record<string, RemotePlayer>,
    inputs: {
        throttle: 0, steer: 0, e: false, f: false
    } as Inputs,
    worldPowerups: [] as PowerupData[],
    isModalOpen: false,
    audioCtx: null as AudioContext | null,
    ws: null as WebSocket | null,
    // Static colliders of the world (vehicle/simWorldClient.ts)
    worldColliders: [] as readonly ColliderInput[],
    // The old city's rendered terrain (world/environment.ts) and the sandbox's ground
    terrainConfig: null as TerrainConfig | null,
    // The sim's ground once the map is loaded (world/environment.ts groundHeight)
    groundHeight: null as ((x: number, z: number) => number) | null,
    myId: null as string | null,
    // The room the server put this client in (null offline and in the sandbox)
    room: null as RoomInfo | null,
    myColor: null as number | null,
    myName: "Player",
    myCarType: "bulli",
    // Own Party score and rank from the server's scoreboard (0 = unknown)
    score: 0,
    rank: 0,
    coins: [] as any[],
    serverCoins: null as CoinData[] | null,
    particles: [] as any[],
    // Frame timer of the game loop (main.ts animate); THREE.Clock is
    // deprecated since r183
    clock: new THREE.Timer(),
    // performance.now() of the last clock update (ms)
    frameAt: 0,
    // Set whenever the local car is spawned or teleported so the chase camera
    // can snap into place instead of flying across the map.
    cameraSnapPending: true,
    health: 100,
    dead: false,
    scoreboard: [] as ScoreboardEntry[],
    killfeed: [] as { killer: string; victim: string; time: number }[],
    respawnShield: false as boolean
};
