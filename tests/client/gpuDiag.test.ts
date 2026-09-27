import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { isGpuDiag, planSteps } from '../../src/client/debug/gpuDiag.js';

// The GPU bisect (src/client/debug/gpuDiag.ts): everything goes dark first,
// then the map's parts, the other scene objects, shadows and the
// environment map come back one step at a time, so the last reported step
// before a lost context names the culprit.

function mesh(name: string): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    m.name = name;
    return m;
}

function fakeRenderer(): THREE.WebGLRenderer {
    return { shadowMap: { enabled: true } } as unknown as THREE.WebGLRenderer;
}

function world() {
    const scene = new THREE.Scene();
    const map = new THREE.Group();
    map.name = 'map';
    const parts = ['terrain', 'roads', 'buildings', 'palms', 'props', 'water'].map(mesh);
    map.add(...parts);
    const sky = mesh('sky');
    const car = mesh('car');
    const hidden = mesh('hidden');
    hidden.visible = false;
    scene.add(map, sky, car, hidden);
    scene.environment = new THREE.Texture();
    return { scene, parts, sky, car, hidden };
}

describe('GPU bisect', () => {
    it('is on only with ?gpudiag=1', () => {
        expect(isGpuDiag('?gpudiag=1')).toBe(true);
        expect(isGpuDiag('?gpudiag=0')).toBe(false);
        expect(isGpuDiag('')).toBe(false);
    });

    it('splits the map into its parts, keeps other objects whole, then shadows and environment last', () => {
        const { scene } = world();
        const steps = planSteps(scene, fakeRenderer());
        expect(steps.map(s => s.label.split(' ')[0])).toEqual(
            ['terrain', 'roads', 'buildings', 'palms', 'props', 'water', 'sky', 'car', 'shadows', 'environment']
        );
    });

    it('turns everything off first and each step turns exactly its own part back on', () => {
        const { scene, parts, sky, hidden } = world();
        const renderer = fakeRenderer();
        const environment = scene.environment;
        const steps = planSteps(scene, renderer);

        expect([...parts, sky].every(p => !p.visible)).toBe(true);
        expect(renderer.shadowMap.enabled).toBe(false);
        expect(scene.environment).toBeNull();

        steps[2].enable();
        expect(parts.map(p => p.visible)).toEqual([false, false, true, false, false, false]);
        steps[steps.length - 2].enable();
        expect(renderer.shadowMap.enabled).toBe(true);
        steps[steps.length - 1].enable();
        expect(scene.environment).toBe(environment);
        // Objects that were hidden before stay out of the test
        expect(hidden.visible).toBe(false);
    });

    it('names the material kinds and draw count of a part', () => {
        const { scene } = world();
        const steps = planSteps(scene, fakeRenderer());
        expect(steps[0].label).toBe('terrain (1 draws: MeshStandardMaterial)');
    });
});
