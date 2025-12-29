import * as THREE from 'three';
import { RemotePlayer, Inputs, PowerupData, TerrainConfig, ScoreboardEntry } from './types.js';

export const state = {
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    renderer: null as unknown as THREE.WebGLRenderer,
    bulli: null as any, // Local car instance
    remotePlayers: {} as Record<string, RemotePlayer>,
    inputs: { 
        w: false, a: false, s: false, d: false, f: false,
        space: false, arrowleft: false, arrowright: false 
    } as Inputs,
    projects: [] as PowerupData[], // Using the same name as in original script for powerups
    activeProject: null as PowerupData | null,
    isModalOpen: false,
    audioCtx: null as AudioContext | null,
    ws: null as WebSocket | null,
    obstacles: [] as THREE.Object3D[],
    terrainConfig: null as TerrainConfig | null,
    myId: null as string | null,
    myColor: null as number | null,
    myName: "Player",
    score: 0,
    coins: [] as any[],
    particles: [] as any[],
    clock: new THREE.Clock(),
    cameraAngle: 0,
    scoreboard: [] as ScoreboardEntry[]
};
