import * as THREE from 'three';

// Instanced props of the whole map with culling per 250 m chunk
// (docs/phase-3-design.md 9, "Global instanziert"): one InstancedMesh per
// kind for the whole map; its instances are kept sorted by chunk, and only
// those of the visible chunks within the kind's sight distance are packed
// into the instance buffer, again whenever the visible set or the camera's
// cell changes. The chunks are the same 8 × 8 grid as the kit's LOD2 cells.

export const CHUNK_SIZE = 250;
export const CHUNK_ORIGIN = -1000;
export const CHUNKS = 8;

export interface ChunkGrid {
    originX: number;
    originZ: number;
    chunkSize: number;
}

export const DEFAULT_CHUNK_GRID: ChunkGrid = {
    originX: CHUNK_ORIGIN,
    originZ: CHUNK_ORIGIN,
    chunkSize: CHUNK_SIZE
};

export function chunkGridFor(spec: { originX: number; originZ: number; cols: number; cellSize: number }): ChunkGrid {
    const extent = Math.max(1, (spec.cols - 1) * spec.cellSize);
    return { originX: spec.originX, originZ: spec.originZ, chunkSize: extent / CHUNKS };
}

export function chunkOf(x: number, z: number, grid: ChunkGrid = DEFAULT_CHUNK_GRID): number {
    const i = Math.min(CHUNKS - 1, Math.max(0, Math.floor((x - grid.originX) / grid.chunkSize)));
    const j = Math.min(CHUNKS - 1, Math.max(0, Math.floor((z - grid.originZ) / grid.chunkSize)));
    return j * CHUNKS + i;
}

export interface InstanceSpec {
    matrix: THREE.Matrix4;
    color?: THREE.Color;
}

/** Visibility of the 64 chunks for a camera (frustum and distance). */
export class ChunkView {
    readonly boxes: THREE.Box3[] = [];
    readonly distance = new Float32Array(CHUNKS * CHUNKS);
    readonly inFrustum = new Uint8Array(CHUNKS * CHUNKS);
    private readonly frustum = new THREE.Frustum();
    private readonly matrix = new THREE.Matrix4();
    private readonly grown = new THREE.Box3();

    constructor(minY: number, maxY: number, grid: ChunkGrid = DEFAULT_CHUNK_GRID) {
        for (let j = 0; j < CHUNKS; j++) {
            for (let i = 0; i < CHUNKS; i++) {
                const x = grid.originX + i * grid.chunkSize, z = grid.originZ + j * grid.chunkSize;
                this.boxes.push(new THREE.Box3(new THREE.Vector3(x, minY, z), new THREE.Vector3(x + grid.chunkSize, maxY, z + grid.chunkSize)));
            }
        }
    }

    /** Updates frustum flags and distances; returns a key that changes with the result. */
    update(camera: THREE.Camera): string {
        camera.updateMatrixWorld();
        this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.matrix);
        const p = camera.position;
        let key = '';
        for (let c = 0; c < this.boxes.length; c++) {
            const box = this.boxes[c];
            // A margin, so a fast turn of the camera does not show gaps
            // before the next packing
            this.grown.copy(box).expandByScalar(40);
            this.inFrustum[c] = this.frustum.intersectsBox(this.grown) ? 1 : 0;
            const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
            const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
            this.distance[c] = Math.sqrt(dx * dx + dz * dz);
            key += this.inFrustum[c] ? '1' : '0';
        }
        return key;
    }
}

export class ChunkedInstances {
    readonly mesh: THREE.InstancedMesh;
    private readonly matrices: Float32Array;
    private readonly colors: Float32Array | null;
    private readonly positions: Float32Array;
    // Instances of chunk c: [start[c], start[c + 1])
    private readonly start = new Int32Array(CHUNKS * CHUNKS + 1);
    private lastKey = '';
    sight: number;
    // Instances nearer than this are left out (a near and a far model of
    // one kind: two ChunkedInstances with adjoining ranges)
    from: number;

    constructor(
        geometry: THREE.BufferGeometry,
        material: THREE.Material,
        specs: readonly InstanceSpec[],
        sight: number,
        name: string,
        from = 0,
        grid: ChunkGrid = DEFAULT_CHUNK_GRID
    ) {
        const order = specs.map((spec, i) => ({ spec, i, chunk: chunkOf(spec.matrix.elements[12], spec.matrix.elements[14], grid) }))
            .sort((a, b) => a.chunk - b.chunk || a.i - b.i);
        this.matrices = new Float32Array(specs.length * 16);
        this.colors = specs.some(spec => spec.color) ? new Float32Array(specs.length * 3) : null;
        this.positions = new Float32Array(specs.length * 2);
        order.forEach(({ spec, chunk }, k) => {
            spec.matrix.toArray(this.matrices, k * 16);
            if (this.colors) (spec.color ?? new THREE.Color(1, 1, 1)).toArray(this.colors, k * 3);
            this.positions[k * 2] = spec.matrix.elements[12];
            this.positions[k * 2 + 1] = spec.matrix.elements[14];
            this.start[chunk + 1]++;
        });
        for (let c = 0; c < CHUNKS * CHUNKS; c++) this.start[c + 1] += this.start[c];
        this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, specs.length));
        this.mesh.name = name;
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (this.colors) {
            this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, specs.length) * 3), 3);
            this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        this.sight = sight;
        this.from = from;
    }

    get total(): number {
        return this.matrices.length / 16;
    }

    /** Packs the instances of the visible chunks from `from` to `sight` m around (x, z). */
    update(view: ChunkView, viewKey: string, x: number, z: number): void {
        // Repack when the visible chunks change or the camera enters another 8 m cell
        const key = `${viewKey}:${Math.floor(x / 8)}:${Math.floor(z / 8)}:${this.sight}:${this.from}`;
        if (key === this.lastKey) return;
        this.lastKey = key;
        const target = this.mesh.instanceMatrix.array as Float32Array;
        const colors = this.mesh.instanceColor?.array as Float32Array | undefined;
        const sight2 = this.sight * this.sight, from2 = this.from * this.from;
        let count = 0;
        for (let c = 0; c < CHUNKS * CHUNKS; c++) {
            if (!view.inFrustum[c] || view.distance[c] > this.sight) continue;
            for (let k = this.start[c]; k < this.start[c + 1]; k++) {
                const dx = this.positions[k * 2] - x, dz = this.positions[k * 2 + 1] - z;
                const d2 = dx * dx + dz * dz;
                if (d2 > sight2 || d2 < from2) continue;
                target.set(this.matrices.subarray(k * 16, k * 16 + 16), count * 16);
                if (colors && this.colors) colors.set(this.colors.subarray(k * 3, k * 3 + 3), count * 3);
                count++;
            }
        }
        this.mesh.count = count;
        this.mesh.visible = count > 0;
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    /** Disposes owned geometry and instanced GPU buffers (shared materials stay managed by caller). */
    dispose(): void {
        this.mesh.geometry.dispose();
        this.mesh.dispose();
    }
}
