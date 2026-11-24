import * as THREE from 'three';
import type { RemotePlayer, Inputs } from './types.js';
import type { Bulli } from './entities/Bulli.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';
import type { PowerupData, CoinData, TerrainConfig, ScoreboardEntry, RoomInfo, MapId } from '../shared/protocol.js';
import { DEFAULT_MAP_ID } from '../shared/map/registry.js';
import type { ColliderInput } from '../shared/world/colliders.js';

export type CoinVisual = THREE.Object3D & { coinId?: number };

export interface ParticleState {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    decay: number;
    initialScale: number;
    initialOpacity: number;
    color: number;
    grows?: boolean;
    followTarget: THREE.Object3D | null;
    localX: number;
    localY: number;
    localZ: number;
}

export type LocalBulli = Bulli & {
    powerups: Bulli['powerups'] & Record<string, { active: boolean; timer: number }>;
    vehicle: LocalVehicle;
};

let localBulli: Bulli | null = null;

export const state = {
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    renderer: null as unknown as THREE.WebGLRenderer,
    get bulli(): LocalBulli {
        return localBulli as unknown as LocalBulli;
    },
    set bulli(value: Bulli | null) {
        localBulli = value;
    },
    remotePlayers: {} as Record<string, RemotePlayer>,
    inputs: {
        throttle: 0, steer: 0, e: false, f: false
    } as Inputs,
    worldPowerups: [] as PowerupData[],
    isModalOpen: false,
    audioCtx: null as AudioContext | null,
    ws: null as WebSocket | null,
    // Active map ID (bulli-bay at initial boot; live-swappable across all maps)
    mapId: DEFAULT_MAP_ID as MapId,
    // Static colliders of the world (vehicle/simWorldClient.ts)
    worldColliders: [] as readonly ColliderInput[],
    // The old city's rendered terrain (world/environment.ts) and the sandbox's ground
    terrainConfig: null as TerrainConfig | null,
    // The sim's ground once the map is loaded (world/environment.ts groundHeight)
    groundHeight: null as ((x: number, z: number) => number) | null,
    myId: null as string | null,
    // The room the server put this client in (null offline and in the sandbox)
    room: null as RoomInfo | null,
    // Where the room's server will spawn the own car (roomState.preview)
    preview: null as { x: number; z: number; yaw: number } | null,
    // The main menu is up (ui/menu/menu.ts): the drive keys stay with it
    inMenu: false,
    myColor: null as number | null,
    myName: "Player",
    myCarType: "bulli",
    // Own Party score and rank from the server's scoreboard (0 = unknown)
    score: 0,
    rank: 0,
    coins: [] as CoinVisual[],
    serverCoins: null as CoinData[] | null,
    particles: [] as ParticleState[],
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
