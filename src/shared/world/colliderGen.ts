// The static colliders of the world, built from the generated world data and
// the prop placement in props.ts (docs/phase-1b-design.md, section 6). The
// client and the server build the sim world from this one list, so both
// collide with exactly the same obstacles.
//
// The order is part of the contract, because a collider's index decides the
// order of the collision response (docs/phase-1a-design.md, 7.2): trees,
// rocks, then the city (buildings, park, plaza, street lights, palms, sign
// posts), in the order the client used to push its obstacles.

import type { CityData, TreeData } from '../protocol.js';
import { COLLIDER_TOPS, type ColliderInput } from './colliders.js';
import {
    boulevardPalms,
    districtSigns,
    parkLayout,
    plazaLayout,
    PROP_RADII,
    rockPlacements,
    streetLights,
    type RockPlacement
} from './props.js';

export interface ColliderWorld {
    trees: readonly TreeData[];
    // null = no city (the client's offline fallback): no buildings, no props
    city: CityData | null;
}

function circle(x: number, z: number, r: number, top: number): ColliderInput {
    return { kind: 'circle', x, z, r, top };
}

export function treeColliders(trees: readonly TreeData[]): ColliderInput[] {
    return trees.map(tree => circle(tree.x, tree.z, PROP_RADII.tree, COLLIDER_TOPS.tree));
}

export function rockColliders(rocks: readonly RockPlacement[] = rockPlacements()): ColliderInput[] {
    return rocks
        .filter(rock => rock.collider)
        .map(rock => circle(rock.x, rock.z, PROP_RADII.rockPerSize * rock.size, COLLIDER_TOPS.rockPerSize * rock.size));
}

export function cityColliders(city: CityData): ColliderInput[] {
    const out: ColliderInput[] = [];

    // Buildings: boxes of their footprint
    for (const building of city.buildings) {
        out.push({
            kind: 'box',
            x: building.x,
            z: building.z,
            hw: building.width / 2,
            hd: building.depth / 2,
            top: COLLIDER_TOPS.building
        });
    }

    // Palm Park: benches, trees, the pond
    const park = parkLayout();
    for (const bench of park.benches) out.push(circle(bench.x, bench.z, PROP_RADII.bench, COLLIDER_TOPS.bench));
    for (const tree of park.trees) out.push(circle(tree.x, tree.z, PROP_RADII.parkTree, COLLIDER_TOPS.parkTree));
    out.push(circle(park.pond.x, park.pond.z, PROP_RADII.pond, COLLIDER_TOPS.pond));

    // Sunset Plaza: planter and parasol corner by corner, then the fountain
    const plaza = plazaLayout();
    plaza.planters.forEach((planter, corner) => {
        out.push(circle(planter.x, planter.z, PROP_RADII.planter, COLLIDER_TOPS.planter));
        const parasol = plaza.parasols[corner];
        out.push(circle(parasol.x, parasol.z, PROP_RADII.parasol, COLLIDER_TOPS.parasol));
    });
    out.push(circle(plaza.fountain.x, plaza.fountain.z, PROP_RADII.fountain, COLLIDER_TOPS.fountain));

    for (const light of streetLights()) out.push(circle(light.x, light.z, PROP_RADII.lamp, COLLIDER_TOPS.lamp));
    for (const palm of boulevardPalms()) out.push(circle(palm.x, palm.z, PROP_RADII.palm, COLLIDER_TOPS.palm));
    for (const sign of districtSigns()) {
        for (const post of sign.posts) out.push(circle(post.x, post.z, PROP_RADII.signPost, COLLIDER_TOPS.signPost));
    }
    return out;
}

/** Every static collider of the world in the contract order (see above). */
export function buildWorldColliders(world: ColliderWorld): ColliderInput[] {
    return [
        ...treeColliders(world.trees),
        ...rockColliders(),
        ...(world.city ? cityColliders(world.city) : [])
    ];
}
