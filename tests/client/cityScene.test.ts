import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { state } from '../../src/client/state.js';
import { createCity } from '../../src/client/world/city.js';
import { createEnvironment } from '../../src/client/world/environment.js';
import { listTaggedColliders, type TaggedCollider } from '../../src/client/world/colliderTags.js';
import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { createMapData } from '../../src/shared/world/mapData.js';

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

// Look and collision agree (docs/phase-1b-design.md, 6): the client builds
// the city and the scenery from the server's world exactly as the page does
// (network/websocket.ts), and every rendered prop that collides stands on
// one of the shared colliders - one prop per collider, of a matching kind.
// The collider list itself is golden-locked in tests/shared/colliderGen.test.ts.
// The scene is built in Node without a renderer (as for the software tier).

// A tagged object stands on a collider of this kind
const TAG_KIND: Record<TaggedCollider['tag'], ColliderInput['kind']> = {
    building: 'box', tree: 'circle', rock: 'circle', bench: 'circle', parkTree: 'circle',
    pond: 'circle', planter: 'circle', parasol: 'circle', fountain: 'circle', lamp: 'circle',
    palm: 'circle', signPost: 'circle'
};

describe('rendered props and colliders', () => {
    const map = createMapData();
    let props: TaggedCollider[] = [];

    beforeAll(() => {
        // The district signs paint a 2D canvas; Node has none (the texture stays blank)
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
        state.scene = new THREE.Scene();
        state.terrainConfig = map.terrain;
        createEnvironment(map.world.trees);
        createCity(map.world.city);
        props = listTaggedColliders(state.scene);
        vi.unstubAllGlobals();
    });

    it('draws one prop of the right kind on every collider, and none elsewhere', () => {
        const colliders = map.colliders;
        expect(colliders.length).toBeGreaterThan(100);
        expect(props).toHaveLength(colliders.length);
        const unmatched = colliders.map((collider, index) => ({ collider, index }));
        for (const prop of props) {
            const hit = unmatched.findIndex(({ collider }) => collider.kind === TAG_KIND[prop.tag] &&
                Math.abs(collider.x - prop.x) < 1e-6 && Math.abs(collider.z - prop.z) < 1e-6);
            expect(hit, `${prop.tag} at ${prop.x.toFixed(2)}, ${prop.z.toFixed(2)} stands on a collider`).toBeGreaterThanOrEqual(0);
            unmatched.splice(hit, 1);
        }
        expect(unmatched).toEqual([]);
    });

    it('instances the street furniture of the city', () => {
        // Regression lock of the counts the e2e world test had checked in
        // the browser (graphics G1): 32 posts = 12 lamps + 20 signal masts
        // of the five fully lit crossings (tests/client/streetLayout.test.ts)
        const furniture = state.scene.getObjectByName('furniture');
        expect(furniture).toBeDefined();
        const counts = Object.fromEntries(furniture!.children
            .map(mesh => [mesh.name.replace('furniture-', ''), (mesh as THREE.InstancedMesh).count]));
        expect(counts).toEqual({ lamp: 12, signal: 20, hydrant: 6, trashCan: 7, bench: 4 });
    });

    it('covers every kind of prop the city has', () => {
        const tags = new Set(props.map(prop => prop.tag));
        expect([...tags].sort()).toEqual(Object.keys(TAG_KIND).sort());
    });
});
