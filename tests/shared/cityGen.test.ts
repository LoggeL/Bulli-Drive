import { describe, expect, it } from 'vitest';
import {
    blockCenter,
    CITY_BOUNDS,
    generateCity,
    isInCityArea,
    isOnRoad,
    PARK_BLOCK,
    PLAZA_BLOCK,
    roadLineCenter
} from '../../src/shared/world/cityGen.js';
import { mulberry32 } from '../../src/shared/math/rng.js';
import { WORLD_SEED } from '../../src/shared/world/worldGen.js';

// Expected layout values were recorded from roadGridCenter/blockCenter in
// src/client/world/city.ts and plazaLayout in src/server/state.ts on main (1d39c07).

describe('city layout', () => {
    it('places the road lines on the golden grid', () => {
        expect([0, 1, 2, 3, 4].map(i => roadLineCenter(i, 'x'))).toEqual([-98, -46, 6, 58, 110]);
        expect([0, 1, 2, 3, 4].map(i => roadLineCenter(i, 'z'))).toEqual([-98, -46, 6, 58, 110]);
    });

    it('places block centers on the golden grid', () => {
        expect(blockCenter(0, 0)).toEqual({ x: -72, z: -72 });
        expect(blockCenter(1, 1)).toEqual({ x: -20, z: -20 });
        expect(blockCenter(3, 3)).toEqual({ x: 84, z: 84 });
        expect(blockCenter(2, 1)).toEqual({ x: 32, z: -20 });
    });

    it('keeps plaza and park in their blocks', () => {
        expect(PLAZA_BLOCK).toEqual({ x: 1, z: 1 });
        expect(PARK_BLOCK).toEqual({ x: 3, z: 3 });
        expect(CITY_BOUNDS).toEqual({ minX: -104, maxX: 116, minZ: -104, maxZ: 116 });
    });

    it('classifies roads and blocks', () => {
        expect(isInCityArea(0, 0)).toBe(true);
        expect(isInCityArea(116, -104)).toBe(true);
        expect(isInCityArea(116.01, 0)).toBe(false);
        expect(isInCityArea(0, -104.01)).toBe(false);
        expect(isOnRoad(roadLineCenter(1, 'x'), blockCenter(0, 0).z)).toBe(true);
        expect(isOnRoad(blockCenter(0, 0).x, roadLineCenter(3, 'z'))).toBe(true);
        expect(isOnRoad(blockCenter(2, 2).x, blockCenter(2, 2).z)).toBe(false);
    });
});

describe('generateCity', () => {
    const city = generateCity(mulberry32(WORLD_SEED));

    it('leaves plaza and park free of buildings', () => {
        for (const block of [PLAZA_BLOCK, PARK_BLOCK]) {
            const center = blockCenter(block.x, block.z);
            const inside = city.buildings.filter(b =>
                Math.abs(b.x - center.x) < 20 && Math.abs(b.z - center.z) < 20);
            expect(inside).toEqual([]);
        }
    });

    it('keeps every building off the roads', () => {
        for (const b of city.buildings) {
            expect(isInCityArea(b.x, b.z)).toBe(true);
            expect(isOnRoad(b.x, b.z)).toBe(false);
        }
    });

    it('lays out gridSize + 1 roads per axis', () => {
        expect(city.roads.filter(r => r.rotation === 0).map(r => r.x)).toEqual([-98, -46, 6, 58, 110]);
        expect(city.roads.filter(r => r.rotation !== 0).map(r => r.z)).toEqual([-98, -46, 6, 58, 110]);
        expect(city.roads.every(r => r.length === 220 && r.width === 12)).toBe(true);
    });
});
