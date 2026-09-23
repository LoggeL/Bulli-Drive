import { test, expect, joinGame } from './fixtures.js';
import type { Obstacle } from '../../src/client/types.js';
import { cityColliders, treeColliders } from '../../src/shared/world/colliderGen.js';
import { insideCitySceneryExclusion, PROP_RADII } from '../../src/shared/world/props.js';
import { COLLIDER_TOPS, type ColliderInput } from '../../src/shared/world/colliders.js';
import { generateWorld } from '../../src/shared/world/worldGen.js';

// Step 1 of the collider port (docs/phase-1b-design.md, 6): the shared
// collider list must equal the obstacles the client still pushes while it
// builds the city, index for index. Rocks draw from their own stream now
// and are only checked for shape and range.

function asCollider(obstacle: Obstacle): ColliderInput {
    const top = obstacle.top ?? Infinity;
    return obstacle.type === 'rect'
        ? { kind: 'box', x: obstacle.x, z: obstacle.z, hw: obstacle.halfWidth, hd: obstacle.halfDepth, top }
        : { kind: 'circle', x: obstacle.x, z: obstacle.z, r: obstacle.radius, top };
}

function expectSame(actual: ColliderInput, expected: ColliderInput, label: string) {
    expect(actual.kind, label).toBe(expected.kind);
    expect(actual.top, label).toBe(expected.top);
    for (const key of ['x', 'z', 'r', 'hw', 'hd'] as const) {
        const a = (actual as unknown as Record<string, number>)[key];
        const e = (expected as unknown as Record<string, number>)[key];
        if (e === undefined) continue;
        expect(Math.abs(a - e), `${label} ${key}`).toBeLessThanOrEqual(1e-9);
    }
}

test('the shared colliders match the client obstacles index for index', async ({ openPlayer }) => {
    const player = await openPlayer('parity');
    await joinGame(player, 'E2E Parity');
    const obstacles = (await player.page.evaluate(() => (window as unknown as {
        __bulliDebug: { obstacles(): Obstacle[] };
    }).__bulliDebug.obstacles())).map(asCollider);

    const world = generateWorld();
    const trees = treeColliders(world.trees);
    const city = cityColliders(world.city);
    const rockCount = obstacles.length - trees.length - city.length;
    test.info().annotations.push({ type: 'colliders', description: `${obstacles.length} obstacles, ${trees.length} trees, ${rockCount} rocks, ${city.length} city` });
    expect(rockCount).toBeGreaterThan(0);

    trees.forEach((expected, i) => expectSame(obstacles[i], expected, `tree ${i}`));
    const cityStart = trees.length + rockCount;
    city.forEach((expected, i) => expectSame(obstacles[cityStart + i], expected, `city ${i}`));
    for (let i = trees.length; i < cityStart; i++) {
        const rock = obstacles[i];
        expect(rock.kind).toBe('circle');
        if (rock.kind !== 'circle') continue;
        const size = rock.r / PROP_RADII.rockPerSize;
        expect(size).toBeGreaterThan(1.2);
        expect(size).toBeLessThan(2.8 + 1e-9);
        expect(Math.abs(rock.top - COLLIDER_TOPS.rockPerSize * size)).toBeLessThan(1e-9);
        expect(Math.abs(rock.x)).toBeLessThanOrEqual(350);
        expect(Math.abs(rock.z)).toBeLessThanOrEqual(350);
        expect(insideCitySceneryExclusion(rock.x, rock.z)).toBe(false);
    }
});
