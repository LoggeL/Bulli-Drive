import { test, expect, joinGame } from './fixtures.js';
import type { ColliderInput } from '../../src/shared/world/colliders.js';
import { buildWorldColliders } from '../../src/shared/world/colliderGen.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';
import type { TaggedCollider } from '../../src/client/world/colliderTags.js';

// The collider world (docs/phase-1b-design.md, 6): the browser's sim collides
// with exactly the list the server builds, and every rendered prop that
// collides stands on one of those colliders, so look and collision agree.

// A tagged object stands on a collider of this kind
const TAG_KIND: Record<TaggedCollider['tag'], ColliderInput['kind']> = {
    building: 'box', tree: 'circle', rock: 'circle', bench: 'circle', parkTree: 'circle',
    pond: 'circle', planter: 'circle', parasol: 'circle', fountain: 'circle', lamp: 'circle',
    palm: 'circle', signPost: 'circle'
};

test('the browser collides with the shared colliders and renders a prop on each', async ({ openPlayer }) => {
    const player = await openPlayer('parity');
    await joinGame(player, 'E2E Parity');
    const { colliders, props } = await player.page.evaluate(() => {
        const debug = (window as unknown as {
            __bulliDebug: { colliders(): ColliderInput[]; colliderProps(): TaggedCollider[] };
        }).__bulliDebug;
        return { colliders: debug.colliders(), props: debug.colliderProps() };
    });

    // Same count, order and dimensions as the server's list (bit for bit)
    expect(colliders).toEqual(buildWorldColliders(generateWorld()));

    // One rendered object per collider, at its position
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
