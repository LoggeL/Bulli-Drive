import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChunkedInstances, chunkOf, ChunkView, CHUNKS } from '../../src/client/world/chunkedInstances.js';

// Instanced props culled per 250 m chunk (src/client/world/chunkedInstances.ts,
// docs/phase-3-design.md 9)

const at = (x: number, z: number) => ({ matrix: new THREE.Matrix4().makeTranslation(x, 0, z) });

describe('chunks', () => {
    it('are an 8 × 8 grid of 250 m from -1000 m, clamped at the border', () => {
        expect(chunkOf(-1000, -1000)).toBe(0);
        expect(chunkOf(-751, -1000)).toBe(0);
        expect(chunkOf(-750, -1000)).toBe(1);
        expect(chunkOf(0, 0)).toBe(4 * CHUNKS + 4);
        expect(chunkOf(5000, 5000)).toBe(CHUNKS * CHUNKS - 1);
    });

    it('see a camera\'s frustum and measure the distance to each chunk', () => {
        const view = new ChunkView(-20, 200);
        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
        camera.position.set(125, 10, 125);
        camera.lookAt(1000, 10, 125);
        camera.updateMatrixWorld();
        view.update(camera);
        // Its own chunk, and the chunk ahead; not the one far behind it
        expect(view.inFrustum[chunkOf(125, 125)]).toBe(1);
        expect(view.inFrustum[chunkOf(600, 125)]).toBe(1);
        expect(view.inFrustum[chunkOf(-600, 125)]).toBe(0);
        expect(view.distance[chunkOf(125, 125)]).toBe(0);
        // Chunk from 250 to 500 m: 125 m away
        expect(view.distance[chunkOf(300, 125)]).toBe(125);
    });
});

describe('chunked instances', () => {
    it('pack only the instances of visible chunks within sight', () => {
        const specs = [at(10, 10), at(20, 20), at(-600, 10), at(900, 10), at(300, 10)];
        const instances = new ChunkedInstances(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), specs, 350, 'test');
        const view = new ChunkView(-20, 200);
        // Every chunk in view except the one of (-600, 10)
        view.inFrustum.fill(1);
        view.inFrustum[chunkOf(-600, 10)] = 0;
        view.distance.fill(0);
        instances.update(view, 'all-but-one', 0, 0);
        // (900, 10) is beyond the 350 m sight, (-600, 10) out of view
        expect(instances.mesh.count).toBe(3);
        const positions = [];
        for (let i = 0; i < instances.mesh.count; i++) {
            const m = new THREE.Matrix4();
            instances.mesh.getMatrixAt(i, m);
            positions.push([m.elements[12], m.elements[14]]);
        }
        expect(positions.sort((a, b) => a[0] - b[0])).toEqual([[10, 10], [20, 20], [300, 10]]);
        // Farther sight: the far one too
        instances.sight = 1000;
        instances.update(view, 'all-but-one', 0, 0);
        expect(instances.mesh.count).toBe(4);
    });

    it('leave out the instances nearer than `from` (the far model of a near and far pair)', () => {
        // Distances from (0, 0): 14.1, 28.3, 300 m
        const specs = [at(10, 10), at(20, 20), at(300, 0)];
        const far = new ChunkedInstances(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), specs, 350, 'far', 20);
        const near = new ChunkedInstances(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), specs, 20, 'near');
        const view = new ChunkView(-20, 200);
        view.inFrustum.fill(1);
        view.distance.fill(0);
        far.update(view, 'all', 0, 0);
        near.update(view, 'all', 0, 0);
        // Each instance in exactly one of the two
        expect([near.mesh.count, far.mesh.count]).toEqual([1, 2]);
        far.from = 0;
        far.update(view, 'all', 0, 0);
        expect(far.mesh.count).toBe(3);
    });
});
