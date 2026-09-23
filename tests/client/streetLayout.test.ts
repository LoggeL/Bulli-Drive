import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CITY_LAYOUT } from '../../src/shared/constants.js';
import { roadLineCenter } from '../../src/shared/world/cityGen.js';
import { FURNITURE_FOOT, FURNITURE_RADIUS, furnitureGeometry, type FurnitureKind } from '../../src/client/world/furniture.js';
import {
    BENCH_COLLIDER_RADIUS, LAMP_COLLIDER_RADIUS, parkBenches, parkFurniture, streetFurniture, streetPosts
} from '../../src/client/world/streetLayout.js';
import { buildPalm } from '../../src/client/world/palms.js';

// The world textures load through the KTX2 transcoder of the client build
vi.mock('../../src/client/world/textures.js', () => ({
    worldTexture: () => null,
    cloneWorldTexture: () => null,
    whenWorldTextureLoaded: () => Promise.resolve()
}));

// Street furniture and palms of the realistic city (graphics G1): the
// furniture stands inside the colliders that were there before (the car
// never drives through a hydrant), the signal mast arms reach over the lanes
// they control, and the instanced geometry stays within its budget.

const { blockSize, roadWidth, gridSize } = CITY_LAYOUT;

describe('street furniture layout', () => {
    const posts = streetPosts();
    const street = streetFurniture(posts);
    const park = parkFurniture();

    it('keeps the 32 street light posts in the collider order of the city', () => {
        expect(posts).toHaveLength(2 * gridSize * gridSize);
        // The first block (0, 0) is a "flip" block: corners (-, -) then (+, +)
        const first = roadLineCenter(0, 'x') + roadWidth / 2 + 2.1;
        expect(posts[0].x).toBeCloseTo(first, 6);
        expect(posts[0].z).toBeCloseTo(first, 6);
        expect(posts[1].x).toBeCloseTo(first + blockSize - 4.2, 6);
    });

    it('turns the posts of the five fully lit crossings into signal mast arms', () => {
        const signals = posts.filter(post => post.signalRotation !== null);
        expect(signals).toHaveLength(20);
        const crossings = new Map<string, number>();
        const step = blockSize + roadWidth;
        for (const post of signals) {
            // Crossing center: the nearest road lines on both axes
            const cx = roadLineCenter(Math.round((post.x - roadLineCenter(0, 'x')) / step), 'x');
            const cz = roadLineCenter(Math.round((post.z - roadLineCenter(0, 'z')) / step), 'z');
            const key = `${cx},${cz}`;
            crossings.set(key, (crossings.get(key) ?? 0) + 1);
            const rotation = post.signalRotation!;
            // Arm along object +x, heads face object -z
            const arm = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
            const facing = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
            // The heads face the crossing (the traffic arriving across it)
            expect(facing.x * (cx - post.x) + facing.z * (cz - post.z)).toBeGreaterThan(0);
            // Both heads (3.6 and 6.4 m out) hang over the lanes of that traffic:
            // right hand traffic, so on the side of the road the pole stands on
            for (const along of [3.6, 6.4]) {
                const hx = post.x + arm.x * along, hz = post.z + arm.z * along;
                const lateral = Math.abs(facing.x) > 0.5 ? hz - cz : hx - cx;
                const poleSide = Math.abs(facing.x) > 0.5 ? post.z - cz : post.x - cx;
                expect(Math.abs(lateral)).toBeLessThan(roadWidth / 2);
                expect(Math.sign(lateral)).toBe(Math.sign(poleSide));
            }
        }
        expect([...crossings.values()]).toEqual([4, 4, 4, 4, 4]);
    });

    it('places every piece inside an existing collider and clear of its host', () => {
        const hostFoot = (x: number, z: number): number => {
            const post = posts.find(p => p.x === x && p.z === z);
            if (post) return FURNITURE_FOOT[post.signalRotation !== null ? 'signal' : 'lamp'];
            return FURNITURE_FOOT.bench;
        };
        const pieces = [...street, ...park];
        expect(pieces.filter(p => p.kind === 'hydrant').length).toBeGreaterThan(3);
        expect(pieces.filter(p => p.kind === 'trashCan').length).toBeGreaterThan(3);
        for (const piece of pieces) {
            const d = Math.hypot(piece.x - piece.host.x, piece.z - piece.host.z);
            expect(d + FURNITURE_RADIUS[piece.kind], piece.kind).toBeLessThanOrEqual(piece.host.radius + 1e-9);
            if (d === 0) continue;
            expect(d - FURNITURE_FOOT[piece.kind], piece.kind).toBeGreaterThanOrEqual(piece.kind === 'trashCan' && piece.host.radius === BENCH_COLLIDER_RADIUS
                ? 0.89 // the iron end of the bench (0.86 m out, 3 cm thick)
                : hostFoot(piece.host.x, piece.host.z) - 1e-9);
        }
        // The hosts are the colliders city.ts pushes
        for (const piece of street) {
            expect(piece.host.radius).toBe(LAMP_COLLIDER_RADIUS);
            expect(posts.some(post => post.x === piece.host.x && post.z === piece.host.z)).toBe(true);
        }
        for (const piece of park) {
            expect(piece.host.radius).toBe(BENCH_COLLIDER_RADIUS);
            expect(parkBenches().some(bench => bench.x === piece.host.x && bench.z === piece.host.z)).toBe(true);
        }
    });

    it('turns a hydrant\'s barrel (object +z) towards its post', () => {
        for (const piece of street.filter(p => p.kind === 'hydrant')) {
            const toHost = new THREE.Vector2(piece.host.x - piece.x, piece.host.z - piece.z).normalize();
            const back = new THREE.Vector2(Math.sin(piece.rotation), Math.cos(piece.rotation));
            expect(back.dot(toHost)).toBeGreaterThan(0.999);
        }
    });

    it('seats the benches facing the pond', () => {
        for (const bench of parkBenches()) {
            const facing = new THREE.Vector2(Math.sin(bench.rotation), Math.cos(bench.rotation));
            const park = parkBenches().reduce((sum, b) => sum.add(new THREE.Vector2(b.x, b.z)), new THREE.Vector2()).divideScalar(4);
            expect(facing.dot(park.clone().sub(new THREE.Vector2(bench.x, bench.z)).normalize())).toBeGreaterThan(0.99);
        }
    });
});

describe('street furniture and palm geometry', () => {
    const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

    it('builds every kind with a finish per vertex within its triangle budget', () => {
        const budget: Record<FurnitureKind, number> = { lamp: 1200, signal: 2600, hydrant: 1400, trashCan: 800, bench: 400 };
        for (const kind of Object.keys(budget) as FurnitureKind[]) {
            for (const tier of ['desktop', 'mobile'] as const) {
                const g = furnitureGeometry(kind, tier);
                expect(g.getAttribute('surface').count, kind).toBe(g.getAttribute('position').count);
                expect(triangles(g), `${kind} ${tier}`).toBeLessThanOrEqual(budget[kind]);
                // The footprint radius covers the geometry at the ground
                const box = new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
                const reach = Math.max(Math.hypot(box.min.x, box.min.z), Math.hypot(box.max.x, box.min.z), Math.hypot(box.min.x, box.max.z), Math.hypot(box.max.x, box.max.z));
                if (kind === 'hydrant' || kind === 'trashCan' || kind === 'bench') {
                    expect(reach * (kind === 'bench' ? 1 : Math.SQRT1_2), kind).toBeLessThanOrEqual(FURNITURE_RADIUS[kind] + 1e-6);
                }
            }
        }
    });

    it('builds dense palm crowns with wind weights, lighter on phones', () => {
        for (const kind of ['fan', 'date'] as const) {
            const high = buildPalm(kind, 3, false);
            const low = buildPalm(kind, 3, true);
            for (const palm of [high, low]) {
                for (const g of [palm.trunk, palm.fronds]) {
                    const wind = g.getAttribute('wind');
                    expect(wind.count).toBe(g.getAttribute('position').count);
                    // Bend grows from the foot (0) to the crown (1)
                    let min = Infinity, max = -Infinity;
                    for (let i = 0; i < wind.count; i++) {
                        min = Math.min(min, wind.getX(i));
                        max = Math.max(max, wind.getX(i));
                    }
                    expect(min).toBeGreaterThanOrEqual(0);
                    expect(max).toBeLessThanOrEqual(1.0001);
                }
            }
            expect(triangles(high.fronds)).toBeGreaterThan(triangles(low.fronds));
            expect(triangles(high.trunk) + triangles(high.fronds)).toBeLessThanOrEqual(3500);
            // More leaves than the probe's crowns (about 480 and 350 triangles on phones)
            expect(triangles(low.fronds)).toBeGreaterThan(kind === 'fan' ? 520 : 800);
        }
    });
});
