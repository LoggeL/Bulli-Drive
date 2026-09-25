import { describe, expect, it } from 'vitest';
import { mapFor } from '../../src/server/maps.js';
import { DECOR_RULES, scatterDecor } from '../../src/client/world/scatter.js';
import { pointInPolygon } from '../../src/shared/map/geometry.js';
import { heightAt, surfaceAt, zoneAt } from '../../src/shared/map/heightfield.js';
import { insideCorridor } from '../../src/shared/map/roadNetwork.js';
import { BoxIndex, placementBox } from '../../src/shared/map/structures.js';
import { SURFACE } from '../../src/shared/map/types.js';

// The client's plants and props without a collider on Bulli Bay
// (src/client/world/scatter.ts, docs/phase-3-design.md 11.1 and 11.2)

describe('the scatter on Bulli Bay', () => {
    const map = mapFor();
    const all = scatterDecor(map);

    it('is the same on every device', () => {
        expect(scatterDecor(map)).toEqual(all);
        expect(all.length).toBeGreaterThan(3000);
    });

    it('keeps off the roads and sidewalks, the lots, the buildings and landmarks', () => {
        const walls = new BoxIndex();
        for (const placed of [...map.buildings, ...map.structures]) walls.add(placementBox(placed));
        for (const spot of all) {
            expect(insideCorridor(map.net, spot.x, spot.z, 0), `${spot.kind} at ${spot.x}, ${spot.z}`).toBe(false);
            expect(map.net.areas.some(area => pointInPolygon(area.polygon, spot.x, spot.z))).toBe(false);
            expect(walls.contains(spot.x, spot.z, 0.5)).toBe(false);
        }
    });

    it('keeps its distance from the plants that have a collider', () => {
        for (const spot of all) {
            for (const plant of map.plants) {
                if (Math.abs(plant.x - spot.x) > 6 || Math.abs(plant.z - spot.z) > 6) continue;
                expect(Math.hypot(plant.x - spot.x, plant.z - spot.z)).toBeGreaterThan(1.5);
            }
        }
    });

    it('stands in the zones of its rules, on its surfaces, on the ground', () => {
        const zones = new Map<string, Set<number>>();
        for (const rule of DECOR_RULES) zones.set(rule.kind, new Set([...(zones.get(rule.kind) ?? []), rule.zone]));
        for (const spot of all) {
            expect(zones.get(spot.kind)!.has(zoneAt(map.hf, spot.x, spot.z))).toBe(true);
            expect(spot.y).toBe(heightAt(map.hf, spot.x, spot.z));
            expect(surfaceAt(map.hf, spot.x, spot.z)).not.toBe(SURFACE.water);
            // Sunshades on dry sand above the water line
            if (spot.kind === 'sunshade') {
                expect(surfaceAt(map.hf, spot.x, spot.z)).toBe(SURFACE.sand);
                expect(spot.y).toBeGreaterThanOrEqual(1);
            }
        }
        const kinds = new Set(all.map(spot => spot.kind));
        expect([...kinds].sort()).toEqual(['chaparral', 'duneGrass', 'flowers', 'shrub', 'sunshade']);
    });

    it('thins out to a subset with a lower density', () => {
        const half = scatterDecor(map, 0.5);
        const key = (s: { x: number; z: number; kind: string }) => `${s.kind}:${s.x}:${s.z}`;
        const full = new Set(all.map(key));
        expect(half.length).toBeGreaterThan(all.length * 0.35);
        expect(half.length).toBeLessThan(all.length * 0.65);
        for (const spot of half) expect(full.has(key(spot))).toBe(true);
    });
});
