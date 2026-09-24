import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RenderTier } from '../../src/client/effects/renderQuality.js';
import { VEHICLE_CLASSES } from '../../src/shared/sim/vehicleClasses.js';

// The game cars as GLB bodies (vehicle/GltfCarBody.ts through CarModel):
// every type scaled uniformly into its unchanged sim hull (docs/cars.md),
// own material clones per car, the LOD by camera distance with its
// hysteresis, the nametag on the model's socket, and the cheap remote cars
// of the phone tier (LOD1 or LOD2 only, no shadow casting). The model cache
// gets the committed manifest (real dimensions) and small stand-in GLB
// scenes; the real GLBs are checked in tests/client/modelBudgets.test.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'public/models/manifest.json'), 'utf8'));
const SOCKET_Y = 2.3;

const tier = vi.hoisted(() => ({ current: 'desktop' as RenderTier }));
vi.mock('../../src/client/render/lighting.js', () => ({ lightingTier: () => tier.current }));

// A GLB scene as the model tools export it: paint, glass, atlas, four wheel
// pivots, the nametag socket and the hidden surfboard
function standInGlb(): THREE.Object3D {
    const root = new THREE.Group();
    const add = (name: string, material: THREE.Material) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
        mesh.name = name;
        root.add(mesh);
        return mesh;
    };
    add('body', new THREE.MeshStandardMaterial({ name: 'paint_primary' }));
    add('trim', new THREE.MeshStandardMaterial({ name: 'paint_secondary' }));
    add('windows', new THREE.MeshStandardMaterial({ name: 'glass', transparent: true }));
    add('details', new THREE.MeshStandardMaterial({ name: 'bulli_atlas' }));
    for (const name of ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) {
        const pivot = new THREE.Group();
        pivot.name = name;
        root.add(pivot);
    }
    const socket = new THREE.Group();
    socket.name = 'socket_nametag';
    socket.position.y = SOCKET_Y;
    const board = new THREE.Group();
    board.name = 'accessory_surfboard';
    board.userData.default_visible = false;
    root.add(socket, board);
    return root;
}

vi.mock('../../src/client/assets/gameModels.js', async () => {
    const { ModelCache } = await import('../../src/client/assets/ModelCache.js');
    const models = new ModelCache({
        createLoader: async () => ({ load: async () => standInGlb() }),
        fetchManifest: async () => MANIFEST
    });
    return { models, whenModelsReady: () => models.whenLoaded() };
});

const { models } = await import('../../src/client/assets/gameModels.js');
const { CarModel } = await import('../../src/client/vehicle/CarModel.js');
const { MODEL_SCALE } = await import('../../src/client/vehicle/GltfCarBody.js');
type Car = InstanceType<typeof CarModel>;

// Shows the LOD for a camera `distance` m in front of the car
function lodAt(car: Car, distance: number): number {
    car.selectLod(new THREE.Vector3(car.group.position.x + distance, 0, car.group.position.z));
    return car.gltf!.lod;
}

function meshes(car: Car): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    car.gltf!.root.traverse(child => { if ((child as THREE.Mesh).isMesh) out.push(child as THREE.Mesh); });
    return out;
}

describe('the GLB car bodies', () => {
    beforeAll(async () => {
        await models.preload([0, 1, 2]);
        expect(models.status).toBe('ready');
    });

    it('scales every type uniformly to the size of docs/cars.md, inside its sim hull', () => {
        tier.current = 'desktop';
        // docs/cars.md: scaled width x length (m)
        const docs: Record<string, [number, number]> = {
            bulli: [2.07, 4.92], pickup: [2.01, 4.92], sport: [1.92, 4.61], jeep: [1.89, 4.35], beetle: [1.69, 4.49]
        };
        for (const [type, [width, length]] of Object.entries(docs)) {
            const car = new CarModel(0x3366aa, type as never);
            const body = car.gltf!;
            expect(body, type).not.toBeNull();
            expect(body.size.x, type).toBeCloseTo(width, 1);
            expect(body.size.z, type).toBeCloseTo(length, 1);
            // Uniform: the height grows by the same factor as the width
            expect(body.size.y / body.size.x, type).toBeCloseTo(MANIFEST.models[type].dimensions.height / MANIFEST.models[type].dimensions.width, 9);
            // The hull: two circles of radius r, c off centre (2r x 2(c + r)).
            // The body stays within its width, the bumpers at most 0.5 m past its ends
            const hull = VEHICLE_CLASSES[type as keyof typeof VEHICLE_CLASSES];
            expect(body.size.x, type).toBeLessThanOrEqual(2 * hull.colliderRadius);
            expect((body.size.z - 2 * (hull.colliderOffset + hull.colliderRadius)) / 2, type).toBeLessThanOrEqual(0.505);
            // The nametag sits on the model's socket
            expect(body.nametagHeight, type).toBeCloseTo(SOCKET_Y * MODEL_SCALE[type], 9);
            car.dispose?.();
        }
    });

    it('gives every car its own materials, never the shared templates', () => {
        tier.current = 'desktop';
        const a = new CarModel(0xaa3333, 'bulli');
        const b = new CarModel(0x3333aa, 'bulli');
        const template = new Set<THREE.Material>();
        models.instantiate('bulli', 0)!.traverse(child => {
            if ((child as THREE.Mesh).isMesh) template.add((child as THREE.Mesh).material as THREE.Material);
        });
        const own = (car: Car) => new Set(meshes(car).map(mesh => mesh.material as THREE.Material));
        const ofA = own(a), ofB = own(b);
        for (const material of ofA) {
            expect(ofB.has(material)).toBe(false);
            expect(template.has(material)).toBe(false);
        }
        // Paint in each car's own colour
        const paint = (car: Car) => meshes(car).map(mesh => mesh.material as THREE.MeshStandardMaterial).find(m => m.name === 'paint_primary')!;
        expect(paint(a).color.equals(paint(b).color)).toBe(false);
    });

    it('switches LODs by camera distance, with a hysteresis against flicker', () => {
        tier.current = 'desktop';
        const car = new CarModel(0x3366aa, 'bulli', { local: true });
        expect(car.gltf!.lods).toEqual([0, 1, 2]);
        // 25 m and 70 m, ±2 m
        expect(lodAt(car, 12)).toBe(0);
        expect(lodAt(car, 26)).toBe(0);
        expect(lodAt(car, 28)).toBe(1);
        expect(lodAt(car, 24)).toBe(1);
        expect(lodAt(car, 22)).toBe(0);
        expect(lodAt(car, 100)).toBe(2);
        expect(lodAt(car, 69)).toBe(2);
        expect(lodAt(car, 3)).toBe(0);
    });

    it('keeps the other players\' cars cheap on the phone tier', () => {
        tier.current = 'mobile';
        const remote = new CarModel(0x3366aa, 'sport');
        const local = new CarModel(0x3366aa, 'sport', { local: true });
        // Never LOD0, LOD2 from 14 m, no shadow casting
        expect(remote.gltf!.lods).toEqual([1, 2]);
        expect(lodAt(remote, 3)).toBe(1);
        expect(lodAt(remote, 17)).toBe(2);
        expect(meshes(remote).every(mesh => !mesh.castShadow)).toBe(true);
        // The own car on the phone keeps its detail and its shadow
        expect(local.gltf!.lods).toEqual([0, 1, 2]);
        expect(lodAt(local, 12)).toBe(0);
        expect(meshes(local).some(mesh => mesh.castShadow)).toBe(true);
        tier.current = 'desktop';
    });
});
