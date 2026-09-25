import { describe, expect, it } from 'vitest';
import { WORLD_QUALITY, worldDetailFor } from '../../src/client/world/worldQuality.js';

// Detail levels of the map world (src/client/world/worldQuality.ts,
// docs/phase-3-design.md 10 and A60)

describe('detail levels', () => {
    it('follow the render tier, ?detail= overrides it', () => {
        expect(worldDetailFor('desktop')).toBe('high');
        expect(worldDetailFor('mobile')).toBe('low');
        expect(worldDetailFor('software')).toBe('software');
        expect(worldDetailFor('desktop', '?detail=mid')).toBe('mid');
        expect(worldDetailFor('mobile', '?e2e=1&detail=high')).toBe('high');
        expect(worldDetailFor('desktop', '?detail=ultra')).toBe('high');
    });

    it('get shorter and sparser from high to software', () => {
        const order = ['high', 'mid', 'low', 'software'] as const;
        for (let i = 1; i < order.length; i++) {
            const a = WORLD_QUALITY[order[i - 1]], b = WORLD_QUALITY[order[i]];
            expect(b.kit.sight).toBeLessThan(a.kit.sight);
            expect(b.sight.trees).toBeLessThan(a.sight.trees);
            expect(b.scatter).toBeLessThan(a.scatter);
            expect(b.kit.shadowReach).toBeLessThan(a.kit.shadowReach);
            // Terrain triangles of level 0 plus the rings
            const tris = (q: typeof a) => 8 * q.terrain.half ** 2 + (q.terrain.levels - 1) * 6 * q.terrain.half ** 2;
            expect(tris(b)).toBeLessThan(tris(a));
        }
        // Phones: no LOD0 (design 10: without cornices); software: LOD2 only
        expect(WORLD_QUALITY.low.kit.nearLod).toBe(1);
        expect(WORLD_QUALITY.software.kit.lod1).toBeLessThan(0);
    });
});
