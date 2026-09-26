import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mapFor } from '../../src/server/maps.js';
import { heightAt } from '../../src/shared/map/heightfield.js';
import { createWorldMaterials } from '../../src/client/world/materials.js';
import { listTaggedColliders, type TaggedCollider } from '../../src/client/world/colliderTags.js';
import { MapWorld } from '../../src/client/world/mapWorld.js';
import { WORLD_QUALITY } from '../../src/client/world/worldQuality.js';

// The world textures load through the KTX2 transcoder of the client build
// (here: blank placeholders)
vi.mock('../../src/client/world/textures.js', async () => {
    const { Texture } = await import('three');
    return {
        worldTexture: () => new Texture(),
        cloneWorldTexture: (source: InstanceType<typeof Texture>) => source.clone(),
        whenWorldTextureLoaded: () => Promise.resolve()
    };
});

// Look and collision agree (docs/phase-1b-design.md, 6; phase 3 M4): the
// client builds Bulli Bay's world as the page does (world/mapWorld.ts), and
// every drawn thing that has a collider in the map's sim world stands on
// it: one per building, landmark, container, tree, palm, rock and piece of
// street furniture, and the fountain. Built in Node without a renderer and without the kit's GLBs
// (the kit's pieces are placed from the same placements).

describe('Bulli Bay as the client draws it', () => {
    const map = mapFor();
    let world: MapWorld;
    let props: TaggedCollider[] = [];

    beforeAll(() => {
        world = new MapWorld(map, 'desktop', createWorldMaterials('desktop'), WORLD_QUALITY.high, null);
        props = listTaggedColliders();
    });

    it('draws something on every collider of a building, landmark, plant, street furniture and the fountain, and nothing more', () => {
        const expected = [
            ...map.buildings.map(lot => ({ tag: 'building', x: lot.x, z: lot.z })),
            ...map.structures.map(s => ({ tag: s.kind === 'container' ? 'container' : 'landmark', x: s.x, z: s.z })),
            ...map.plants.map(p => ({ tag: p.kind === 'palm' ? 'palm' : p.kind === 'boulder' || p.kind === 'rock' ? 'rock' : 'tree', x: p.x, z: p.z })),
            ...map.furniture.map(p => ({ tag: 'furniture', x: p.x, z: p.z }))
        ];
        const fountain = map.colliders.find((collider): collider is Extract<typeof collider, { kind: 'circle' }> => collider.kind === 'circle' && collider.top === 1.5)!;
        expected.push({ tag: 'fountain', x: fountain.x, z: fountain.z });
        const key = (p: { tag: string; x: number; z: number }) => `${p.tag}:${p.x}:${p.z}`;
        expect(props.map(key).sort()).toEqual(expected.map(key).sort());
        // 549 buildings, 1 898 plants (A47) and the rest
        expect(props.length).toBeGreaterThan(2400);
    });

    it('draws every building\'s kit piece at its collider\'s placement, on the ground at its front', () => {
        // The piece's origin and heading are the collider's placement
        // (structures.ts: the box is the piece's footprint round them); the
        // front stands on the sidewalk's height, the walls reach below it
        const instances = (world as unknown as { kitInstances: { piece: string; x: number; y: number; z: number; ux: number; uz: number }[] }).kitInstances;
        const byPlace = new Map(instances.map(i => [`${i.piece}:${i.x}:${i.z}`, i]));
        for (const lot of map.buildings) {
            const instance = byPlace.get(`${lot.piece}:${lot.x}:${lot.z}`);
            expect(instance, `${lot.piece} at ${lot.x}, ${lot.z}`).toBeDefined();
            expect(instance!.y).toBe(heightAt(map.hf, lot.x, lot.z));
            expect([instance!.ux, instance!.uz]).toEqual([lot.ux, lot.uz]);
        }
    });

    it('lays the pier\'s deck from the land out to the sea, 10 m a segment, a lamp every third, the end last', () => {
        const pier = map.net.areas.find(area => area.id === 'pier')!;
        const instances = (world as unknown as { kitInstances: { piece: string; x: number; y: number; z: number }[] }).kitInstances
            .filter(i => i.piece.startsWith('pier_'));
        // From x = -596 (the land) to -805: 209 m, 21 segments (the last
        // reaches a metre past the deck's outline)
        expect(instances).toHaveLength(21);
        expect(instances[0]).toMatchObject({ piece: 'pier_segment', x: -596, z: -20, y: pier.y });
        expect(instances[1].piece).toBe('pier_segment_lamp');
        expect(instances[20]).toMatchObject({ piece: 'pier_end', x: -796 });
    });

    it('has the ground, the sea, the roads, the kit, the plants and the props', () => {
        expect(world.group.children.map(child => child.name)).toEqual(['terrain', 'sea', 'roads', 'kit', 'plants', 'props']);
        // The Party's fence only in the Party
        const fence = world.group.getObjectByName('fence-party')!;
        expect(fence.visible).toBe(false);
        world.setRoom('party');
        expect(fence.visible).toBe(true);
        world.setRoom('freeroam');
        expect(fence.visible).toBe(false);
    });
});
