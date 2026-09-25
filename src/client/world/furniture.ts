import * as THREE from 'three';
import { Batch, rgb, type BoxUv, type RGB } from './batch.js';

// Props built from simple parts (graphics G1): the railings, fence posts
// and sunshades of the map (world/mapWorld.ts) and the race dressing
// (race/TrackDressing.ts). Finishes come from the `surface` vertex attribute
// (roughness, metalness, emission, traffic light lens) of the shared
// furniture material (materials.ts): painted cast iron, galvanized steel,
// powder coated sheet metal, wood, glass.

export interface Finish {
    color: RGB;
    rough: number;
    metal?: number;
    // Emission as a multiple of the color (HDR)
    emit?: number;
    // Traffic light lens: 1 red, 2 yellow, 3 green (materials.ts adds the
    // axis from the instance rotation)
    signal?: number;
}

export const FINISH = {
    castIron: { color: rgb(0x1c2521), rough: 0.42 },
    galvanized: { color: rgb(0x9a9e9b), rough: 0.38, metal: 0.85 },
    luminaire: { color: rgb(0x8d918c), rough: 0.45, metal: 0.4 },
    signalBody: { color: rgb(0xb58c24), rough: 0.48 },
    blackPlastic: { color: rgb(0x141617), rough: 0.55 },
    globe: { color: rgb(0xf1e8d6), rough: 0.18, emit: 0.18 },
    lampCore: { color: rgb(0xffd49a), rough: 0.3, emit: 0.6 },
    lensRed: { color: [1.0, 0.045, 0.02], rough: 0.12, emit: 7, signal: 1 },
    lensYellow: { color: [1.0, 0.42, 0.03], rough: 0.12, emit: 6, signal: 2 },
    lensGreen: { color: [0.05, 1.0, 0.45], rough: 0.12, emit: 6, signal: 3 },
    hydrant: { color: rgb(0xc99d2a), rough: 0.36 },
    hydrantCap: { color: rgb(0xb3b5b0), rough: 0.3, metal: 0.75 },
    can: { color: rgb(0x2b4133), rough: 0.46 },
    canLiner: { color: rgb(0x111311), rough: 0.7 },
    wood: { color: rgb(0x8a5b37), rough: 0.72 },
    concrete: { color: rgb(0xb9b3a7), rough: 0.9 },
    terracotta: { color: rgb(0xa9593a), rough: 0.78 },
    soil: { color: rgb(0x3a2c22), rough: 1 },
    canvasPole: { color: rgb(0xd8d2c4), rough: 0.5 }
} satisfies Record<string, Finish>;

/** Batch whose parts carry a finish (the `surface` attribute). */
export class PropBatch {
    private readonly batch: Batch;

    constructor(name: string) {
        this.batch = new Batch(name);
    }

    get size(): number {
        return this.batch.size;
    }

    add(geometry: THREE.BufferGeometry, finish: Finish, matrix: THREE.Matrix4 | null = null, uv: BoxUv | null = null): void {
        const part = this.batch.add(geometry, matrix, finish.color, uv);
        const count = part.attributes.position.count;
        const surface = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
            surface[i * 4] = finish.rough;
            surface[i * 4 + 1] = finish.metal ?? 0;
            surface[i * 4 + 2] = finish.emit ?? 0;
            surface[i * 4 + 3] = finish.signal ?? 0;
        }
        part.setAttribute('surface', new THREE.BufferAttribute(surface, 4));
    }

    box(w: number, h: number, d: number, x: number, y: number, z: number, finish: Finish, matrix: THREE.Matrix4 | null = null): void {
        const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
        this.add(matrix ? g.applyMatrix4(matrix) : g, finish);
    }

    build(): THREE.BufferGeometry | null {
        return this.batch.build();
    }

    mesh(material: THREE.Material, options: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh | null {
        return this.batch.mesh(material, options);
    }
}
