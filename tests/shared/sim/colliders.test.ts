import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../src/shared/math/rng.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../../src/shared/constants.js';
import { COLLIDER_TOPS, createSimWorld, SpatialGrid, type Collider, type ColliderInput } from '../../../src/shared/world/colliders.js';
import { getTerrainHeight } from '../../../src/shared/world/terrain.js';

// Static collision world (docs/phase-1a-design.md, 7.1 and 7.3)

const FLAT_TERRAIN = { ...DEFAULT_TERRAIN_CONFIG, amplitude1: 0, amplitude2: 0, amplitude3: 0 };

function randomColliders(count: number, seed: number): Collider[] {
    const random = mulberry32(seed);
    const colliders: Collider[] = [];
    for (let i = 0; i < count; i++) {
        const x = (random() - 0.5) * 1100, z = (random() - 0.5) * 1100;
        colliders.push(random() < 0.5
            ? { kind: 'circle', x, z, r: 0.3 + random() * 6, base: 0, top: Infinity }
            : { kind: 'box', x, z, hw: 0.25 + random() * 30, hd: 0.25 + random() * 30, base: 0, top: Infinity });
    }
    return colliders;
}

function overlapsBox(c: Collider, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    const hx = c.kind === 'circle' ? c.r : c.hw;
    const hz = c.kind === 'circle' ? c.r : c.hd;
    return c.x + hx >= minX && c.x - hx <= maxX && c.z + hz >= minZ && c.z - hz <= maxZ;
}

describe('SpatialGrid', () => {
    const colliders = randomColliders(600, 7);
    const grid = new SpatialGrid(colliders);
    const out = new Int32Array(colliders.length);

    it('finds every overlapping collider once, sorted by index', () => {
        const random = mulberry32(99);
        for (let q = 0; q < 500; q++) {
            const x = (random() - 0.5) * 1200, z = (random() - 0.5) * 1200;
            const w = random() * 40, d = random() * 40;
            const count = grid.query(x - w, z - d, x + w, z + d, out);
            const hits = Array.from(out.subarray(0, count));
            for (let i = 1; i < hits.length; i++) expect(hits[i]).toBeGreaterThan(hits[i - 1]);
            colliders.forEach((collider, index) => {
                if (overlapsBox(collider, x - w, z - d, x + w, z + d)) expect(hits).toContain(index);
            });
        }
    });

    it('returns the same order for a small and a large query around the same spot', () => {
        const small = Array.from(out.subarray(0, grid.query(10, 10, 12, 12, out)));
        const large = Array.from(out.subarray(0, grid.query(-40, -40, 60, 60, out)));
        const smallInLarge = large.filter(index => small.includes(index));
        expect(smallInLarge).toEqual(small);
    });

    it('finds colliders outside the covered 1024 m square in the border cells', () => {
        const far: Collider[] = [{ kind: 'circle', x: 700, z: -900, r: 1, base: 0, top: Infinity }];
        const farGrid = new SpatialGrid(far);
        const buffer = new Int32Array(1);
        expect(farGrid.query(695, -905, 705, -895, buffer)).toBe(1);
    });

    it('writes into the given buffer and never past its end', () => {
        const buffer = new Int32Array(3);
        expect(grid.query(-600, -600, 600, 600, buffer)).toBe(3);
    });
});

describe('createSimWorld', () => {
    it('stores the ground height under each collider as its base and keeps the order', () => {
        const inputs: ColliderInput[] = [
            { kind: 'box', x: 300, z: 200, hw: 5, hd: 8, top: COLLIDER_TOPS.building },
            { kind: 'circle', x: -350, z: 120, r: 0.7, top: COLLIDER_TOPS.lamp }
        ];
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, inputs, []);
        expect(world.colliders.map(c => c.kind)).toEqual(['box', 'circle']);
        expect(world.colliders[0].base).toBe(getTerrainHeight(DEFAULT_TERRAIN_CONFIG, 300, 200));
        expect(world.colliders[1].base).toBe(getTerrainHeight(DEFAULT_TERRAIN_CONFIG, -350, 120));
        expect(world.colliders[1].top).toBe(5.5);
        expect(world.bound).toBe(498);
        expect(world.queryBuffer.length).toBe(2);
    });

    it('raises the ground on ramps and bases colliders on them', () => {
        const world = createSimWorld(FLAT_TERRAIN, [{ kind: 'circle', x: 0, z: 4, r: 0.5, top: 1 }],
            [{ x: 0, z: 0, yaw: 0, width: 6, length: 16, height: 4 }]);
        expect(world.groundHeight(0, 8)).toBeCloseTo(4, 12);
        expect(world.groundHeight(0, -8)).toBeCloseTo(0, 12);
        expect(world.colliders[0].base).toBeCloseTo(3, 12);
        // A ramp turned by 90° rises along +x
        const turned = createSimWorld(FLAT_TERRAIN, [], [{ x: 0, z: 0, yaw: Math.PI / 2, width: 6, length: 16, height: 4 }]);
        expect(turned.groundHeight(7.9, 0)).toBeCloseTo(3.975, 6);
        expect(turned.groundHeight(0, 7.9)).toBe(0);
    });
});
