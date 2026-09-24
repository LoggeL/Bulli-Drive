import { describe, expect, it } from 'vitest';
import { buildWorldColliders, cityColliders, rockColliders, treeColliders } from '../../src/shared/world/colliderGen.js';
import { COLLIDER_TOPS, type ColliderInput } from '../../src/shared/world/colliders.js';
import { blockCenter, isInCityArea, isOnRoad, PLAZA_BLOCK } from '../../src/shared/world/cityGen.js';
import { canonicalStringify, createMapData, fnv1a, worldHash } from '../../src/shared/world/mapData.js';
import { insideCitySceneryExclusion, PROP_RADII, rockPlacements } from '../../src/shared/world/props.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';
import {
    collidersSha, GOLDEN_COLLIDER_COUNT, GOLDEN_COLLIDERS_SHA, GOLDEN_ROCK_COUNT, GOLDEN_ROCKS_SHA, GOLDEN_WORLD_HASH
} from './worldGolden.js';

// The static colliders both sides build (docs/phase-1b-design.md, 6). The
// golden hash (worldGolden.ts) pins the ordered list: count, order and
// every dimension. It only changes on purpose, together with MAP_VERSION.

describe('buildWorldColliders', () => {
    const world = generateWorld();
    const colliders = buildWorldColliders(world);

    it('matches the golden ordered collider list', () => {
        expect(colliders).toHaveLength(GOLDEN_COLLIDER_COUNT);
        expect(collidersSha(colliders)).toBe(GOLDEN_COLLIDERS_SHA);
    });

    it('orders trees, rocks, then the city', () => {
        const trees = treeColliders(world.trees);
        const rocks = rockColliders();
        const city = cityColliders(world.city);
        expect(colliders).toEqual([...trees, ...rocks, ...city]);
        expect(trees).toHaveLength(120);
        expect(rocks.length).toBeGreaterThan(10);
        // 30 buildings, park 4 benches + 4 trees + pond, plaza 4 × (planter,
        // parasol) + fountain, 32 lamps, 8 palms, 2 signs × 2 posts
        expect(city).toHaveLength(30 + 9 + 9 + 32 + 8 + 4);
        expect(city.slice(0, 30).every(c => c.kind === 'box' && c.top === Infinity)).toBe(true);
        expect(city.slice(30).every(c => c.kind === 'circle')).toBe(true);
    });

    it('puts the plaza props around the fountain', () => {
        const city = cityColliders(world.city);
        const plaza = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
        const fountain = city[30 + 9 + 8];
        expect(fountain).toEqual({ kind: 'circle', x: plaza.x, z: plaza.z, r: 5, top: COLLIDER_TOPS.fountain });
        const planters = [0, 2, 4, 6].map(i => city[30 + 9 + i]);
        for (const planter of planters) {
            expect(Math.hypot(planter.x - plaza.x, planter.z - plaza.z)).toBeCloseTo(13 * Math.SQRT2, 9);
        }
    });

    it('keeps rocks out of the city, off the roads and out of the buildings', () => {
        for (const rock of rockColliders()) {
            expect(rock.kind).toBe('circle');
            expect(insideCitySceneryExclusion(rock.x, rock.z)).toBe(false);
            expect(isInCityArea(rock.x, rock.z) && isOnRoad(rock.x, rock.z)).toBe(false);
            for (const building of world.city.buildings) {
                const inside = Math.abs(rock.x - building.x) < building.width / 2 &&
                    Math.abs(rock.z - building.z) < building.depth / 2;
                expect(inside).toBe(false);
            }
        }
    });

    it('draws every rock from its own slot of the rock stream', () => {
        const rocks = rockPlacements();
        expect(rocks).toEqual(rockPlacements());
        // Kept rocks keep their attempt index, skipped ones leave a gap
        for (let i = 1; i < rocks.length; i++) expect(rocks[i].index).toBeGreaterThan(rocks[i - 1].index);
        for (const rock of rocks) {
            expect(rock.size).toBeGreaterThanOrEqual(0.8);
            expect(rock.size).toBeLessThan(2.8);
            expect(rock.collider).toBe(rock.size > 1.2);
        }
        const colliding = rocks.filter(rock => rock.collider);
        expect(rockColliders().map(c => c.kind === 'circle' ? c.r : NaN))
            .toEqual(colliding.map(rock => PROP_RADII.rockPerSize * rock.size));
    });

    it('builds only the rocks without a city (offline)', () => {
        const offline = buildWorldColliders({ trees: [], city: null });
        expect(offline).toHaveLength(GOLDEN_ROCK_COUNT);
        expect(offline.every(c => c.kind === 'circle')).toBe(true);
        expect(collidersSha(offline)).toBe(GOLDEN_ROCKS_SHA);
    });
});

describe('createMapData', () => {
    const map = createMapData();

    it('holds the shared collider list and a sim world built from it', () => {
        expect(map.colliders).toHaveLength(GOLDEN_COLLIDER_COUNT);
        expect(collidersSha(map.colliders)).toBe(GOLDEN_COLLIDERS_SHA);
        expect(map.simWorld.colliders).toHaveLength(map.colliders.length);
        expect(map.simWorld.roads).not.toBeNull();
    });

    it('hashes world and colliders to the golden world hash', () => {
        expect(map.worldHash).toBe(GOLDEN_WORLD_HASH);
        expect(worldHash(map.world, map.colliders)).toBe(map.worldHash);
        expect(createMapData(1).worldHash).not.toBe(map.worldHash);
    });

    it('serializes canonically', () => {
        expect(canonicalStringify({ b: [1, Infinity, -0], a: 'x', c: undefined })).toBe('{"a":"x","b":[1,Infinity,0]}');
        expect(fnv1a('')).toBe('811c9dc5');
        expect(fnv1a('a')).toBe('e40c292c');
    });
});
