import * as THREE from 'three';
import { state } from '../state.js';
import type { TreeData } from '../../shared/protocol.js';
import { mulberry32 } from '../../shared/math/rng.js';
import { CITY_TERRAIN_AREA, getTerrainHeight as getSharedTerrainHeight } from '../../shared/world/terrain.js';
import {
    insideCitySceneryExclusion,
    rockPlacements,
    ROCK_VISUAL_SEED,
    SCENERY_SEED
} from '../../shared/world/props.js';
import { markColliderAt } from './colliderTags.js';
import { WORLD_BOUND } from '../../shared/constants.js';
import { lightingTier } from '../render/lighting.js';
import { SUN_DIRECTION } from '../render/look.js';
import { Batch, rng } from './batch.js';
import { worldMaterials } from './worldMaterials.js';
import { addShrub, createTreeCards, type TreeSpot } from './vegetation.js';

// The land around the city in the realistic look (graphics G1): golden dry
// grass with olive chaparral patches and bare earth, oaks and cypresses as
// cards, rocks, shrubs, and a ring of hills beyond the playable area that
// rise to a ridge line against the sky (render only: inside WORLD_BOUND the
// visual ground follows the shared terrain height exactly as before).
//
// Collisions come from the map, not from here: trees from the server's
// world and rocks from shared/world/props.ts, the same data the sim's
// colliders are built from (shared/world/colliderGen.ts). Only the looks
// are drawn here.

// Visual terrain: fine grid over the playable area, growing cells beyond it
const TERRAIN_EXTENT = 1650;
const PLAYABLE = WORLD_BOUND + 10;
// Hills beyond the playable area (render only)
const HILLS = { start: WORLD_BOUND + 40, full: 1350, base: 40, relief: 170 };

// Height of the old city's rendered terrain (flat 0 before the world is
// built): the looks of this module and city.ts until the Bulli Bay renderer
// replaces them (phase 3, M4)
export function getTerrainHeight(x: number, z: number) {
    if (!state.terrainConfig) return 0;
    return getSharedTerrainHeight(state.terrainConfig, x, z);
}

/**
 * The sim's ground under (x, z): the map's heightfield once it is loaded
 * (network/websocket.ts sets state.groundHeight), else the terrain of
 * state.terrainConfig (the sandbox). For everything that stands on the
 * ground the cars drive on: pickups, markers, effects, cars before spawn.
 */
export function groundHeight(x: number, z: number) {
    return state.groundHeight ? state.groundHeight(x, z) : getTerrainHeight(x, z);
}

// --- Noise (deterministic value noise / fbm of the probe) ------------------------------

const PERM = new Uint8Array(512);
{
    const R = mulberry32(123);
    const p = [...Array(256).keys()];
    for (let i = p.length - 1; i > 0; i--) {
        const j = Math.floor(R() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t: number) => t * t * (3 - 2 * t);
function valueNoise(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const h = (a: number, b: number) => PERM[(PERM[a & 255] + (b & 255)) & 511] / 255;
    const u = fade(xf), v = fade(yf);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
}
function fbm(x: number, y: number, octaves = 5): number {
    let amplitude = 0.5, sum = 0, frequency = 1;
    for (let i = 0; i < octaves; i++) {
        sum += amplitude * valueNoise(x * frequency, y * frequency);
        frequency *= 2.03;
        amplitude *= 0.5;
    }
    return sum;
}
const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/** Height of the rendered ground: the shared terrain, plus hills outside the playable area. */
export function visualTerrainHeight(x: number, z: number): number {
    const h = getTerrainHeight(x, z);
    const r = Math.hypot(x - CITY_TERRAIN_AREA.centerX, z - CITY_TERRAIN_AREA.centerZ);
    const t = smoothstep(HILLS.start, HILLS.full, r);
    if (t <= 0) return h;
    const n = fbm(x * 0.0032 + 10, z * 0.0032 - 4, 5);
    const ridge = 1 - Math.abs(fbm(x * 0.0011 + 3, z * 0.0011 + 9, 3) * 2 - 1);
    return h + t * t * (HILLS.base + HILLS.relief * Math.pow(n, 1.4) * (0.55 + 0.9 * ridge));
}

// Grid lines: `step` apart over the playable area, then cells growing by 18 %
function gridLines(step: number): number[] {
    const inner: number[] = [];
    const n = Math.ceil(PLAYABLE / step);
    for (let i = -n; i <= n; i++) inner.push(i * step);
    const outer: number[] = [];
    let x = n * step, cell = step;
    while (x < TERRAIN_EXTENT) {
        cell = Math.min(cell * 1.18, 110);
        x = Math.min(TERRAIN_EXTENT, x + cell);
        outer.push(x);
    }
    return [...outer.map(v => -v).reverse(), ...inner, ...outer];
}

/**
 * Height of the rendered terrain mesh at (x, z): the triangle of the grid
 * cell interpolated like the GPU does. Away from the playable area the cells
 * grow to 110 m, and on crests the exact height stands meters above the mesh,
 * so everything placed on the visible ground takes this height.
 */
export type GroundSampler = (x: number, z: number) => number;

function cellOf(lines: number[], v: number): number {
    let lo = 0, hi = lines.length - 2;
    if (v <= lines[0]) return 0;
    if (v >= lines[hi + 1]) return hi;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid] <= v) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

function meshSampler(xs: number[], heights: Float32Array): GroundSampler {
    const n = xs.length;
    return (x, z) => {
        const i = cellOf(xs, x), j = cellOf(xs, z);
        const fx = Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i])));
        const fz = Math.min(1, Math.max(0, (z - xs[j]) / (xs[j + 1] - xs[j])));
        const a = heights[j * n + i], b = heights[j * n + i + 1];
        const c = heights[(j + 1) * n + i], d = heights[(j + 1) * n + i + 1];
        // Triangles (a, c, b) and (b, c, d): the diagonal runs from b to c
        return fx + fz <= 1
            ? a + fx * (b - a) + fz * (c - a)
            : d + (1 - fx) * (c - d) + (1 - fz) * (b - d);
    };
}

function createTerrain(step: number): { mesh: THREE.Mesh; ground: GroundSampler } {
    const xs = gridLines(step);
    const nx = xs.length, nz = xs.length;
    const positions = new Float32Array(nx * nz * 3);
    const uvs = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            const x = xs[i], z = xs[j], k = j * nx + i;
            positions[k * 3] = x;
            positions[k * 3 + 1] = visualTerrainHeight(x, z);
            positions[k * 3 + 2] = z;
            uvs[k * 2] = x / 6;
            uvs[k * 2 + 1] = -z / 6;
        }
    }
    const index: number[] = [];
    for (let j = 0; j < nz - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
            index.push(a, c, b, b, c, d);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();

    // Large scale splat in vertex colors: golden grass, olive chaparral,
    // lighter dry patches
    const normals = geometry.attributes.normal;
    const colors = new Float32Array(nx * nz * 3);
    for (let k = 0; k < nx * nz; k++) {
        const x = positions[k * 3], z = positions[k * 3 + 2];
        const slope = 1 - normals.getY(k);
        const n = fbm(x * 0.009, z * 0.009, 3), n2 = fbm(x * 0.004 + 7, z * 0.004, 3);
        const hills = smoothstep(HILLS.start, HILLS.full * 0.8, Math.hypot(x - CITY_TERRAIN_AREA.centerX, z - CITY_TERRAIN_AREA.centerZ));
        let c = [0.8, 0.76, 0.58];
        const scrub = smoothstep(0.42 - hills * 0.22, 0.56 - hills * 0.18, n) * 0.85;
        c = c.map((v, i) => v * (1 - scrub) + [0.24, 0.28, 0.16][i] * scrub);
        const rock = smoothstep(0.14, 0.32, slope);
        c = c.map((v, i) => v * (1 - rock) + [0.6, 0.52, 0.45][i] * rock);
        const dry = smoothstep(0.4, 0.7, n2) * 0.3;
        c = c.map(v => v * (1 + dry * 0.15));
        colors[k * 3] = c[0];
        colors[k * 3 + 1] = c[1];
        colors[k * 3 + 2] = c[2];
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, worldMaterials().terrain);
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    const heights = new Float32Array(nx * nz);
    for (let k = 0; k < nx * nz; k++) heights[k] = positions[k * 3 + 1];
    return { mesh, ground: meshSampler(xs, heights) };
}

// The rendered terrain mesh, once built (things laid on the visible ground)
let renderedGround: GroundSampler | null = null;

/** Height of the rendered terrain mesh at (x, z) (the exact terrain before it is built). */
export function renderedGroundHeight(x: number, z: number): number {
    return renderedGround ? renderedGround(x, z) : visualTerrainHeight(x, z);
}

/** 1 when the sun reaches (x, y, z) over the rendered ground, 0 behind a hill (soft over a few meters). */
function sunOver(ground: GroundSampler, x: number, y: number, z: number): number {
    const d = SUN_DIRECTION;
    const horizontal = Math.hypot(d.x, d.z);
    let lit = 1;
    for (let t = 8; t < 900; t *= 1.25) {
        const clearance = y + t * d.y - ground(x + d.x * t, z + d.z * t);
        // Terrain within ~4 m of the ray (scaled by the distance) is penumbra
        lit = Math.min(lit, smoothstep(-2, 4 + t * 0.01 * horizontal, clearance));
        if (lit <= 0) return 0;
    }
    return lit;
}

// A rough rock: a subdivided icosahedron with deterministic bumps
function rockGeometry(seed: number): THREE.BufferGeometry {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const R = rng(seed);
    const P = g.attributes.position;
    const v = new THREE.Vector3();
    const bumps = new Map<string, number>();
    for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i);
        // Same displacement for vertices at the same place (non-indexed geometry)
        const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
        let k = bumps.get(key);
        if (k === undefined) {
            k = 0.78 + R() * 0.4;
            bumps.set(key, k);
        }
        v.multiplyScalar(k);
        P.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
}

export function createEnvironment(treeData: TreeData[]) {
    if (!state.terrainConfig) return;
    const tier = lightingTier();
    const M = worldMaterials();
    // Reset on every environment build so every client and reconnect produces
    // exactly the same procedural scenery. Rocks take position and size from
    // shared/world/props.ts (their colliders) and only their looks from here.
    const rockRandom = mulberry32(ROCK_VISUAL_SEED);
    const sceneryRandom = mulberry32(SCENERY_SEED);
    const group = new THREE.Group();
    group.name = 'environment';

    // Software WebGL also pays for every vertex: a coarser grid
    const terrain = createTerrain(tier === 'desktop' ? 8 : tier === 'mobile' ? 10 : 16);
    group.add(terrain.mesh);
    // Scenery stands on the rendered mesh, not on the exact height
    const ground = terrain.ground;
    renderedGround = ground;

    const oaks: TreeSpot[] = [];
    const cypresses: TreeSpot[] = [];
    const bushes: TreeSpot[] = [];

    // Trees from the server's world (colliders: shared/world/colliderGen.ts)
    treeData.forEach(t => {
        const spot = { x: t.x, y: ground(t.x, t.z), z: t.z, scale: (t.height + 4) / 10 };
        if (t.id % 5 === 0) cypresses.push({ ...spot, scale: spot.scale * 1.1 });
        else oaks.push(spot);
        markColliderAt('tree', t.x, t.z);
    });

    // Rocks around the city. Every rock draws the same number of values from
    // its visual stream, so one rock's looks never shift another's.
    const rocks = new Batch('rocks');
    const rockShapes = [rockGeometry(1), rockGeometry(2), rockGeometry(3)];
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const euler = new THREE.Euler();
    for (const placement of rockPlacements()) {
        const { x: rx, z: rz, size: rockSize, index: i } = placement;
        const shade = rockRandom() > 0.5 ? 1 : 0.8;
        const tiltX = rockRandom() * 0.5, turnY = rockRandom() * Math.PI;
        const squash = 0.5 + rockRandom() * 0.4;
        const second = rockRandom() > 0.5;
        const smallTiltX = rockRandom() * 0.5, smallTurnY = rockRandom() * Math.PI;

        const h = ground(rx, rz);
        euler.set(tiltX, turnY, 0);
        s.set(rockSize, rockSize * squash, rockSize);
        matrix.compose(p.set(rx, h + rockSize * 0.3, rz), q.setFromEuler(euler), s);
        rocks.add(rockShapes[i % 3], matrix, [shade, shade * 0.97, shade * 0.93], { box: 3 });

        // Sometimes a second, smaller rock
        if (second) {
            const smallSize = rockSize * 0.5;
            euler.set(smallTiltX, smallTurnY, 0);
            s.set(smallSize, smallSize * 0.6, smallSize);
            matrix.compose(p.set(rx + rockSize * 0.8, h + smallSize * 0.2, rz + rockSize * 0.3), q.setFromEuler(euler), s);
            rocks.add(rockShapes[(i + 1) % 3], matrix, [0.8, 0.78, 0.74], { box: 3 });
        }

        if (placement.collider) markColliderAt('rock', rx, rz);
    }
    const rockMesh = rocks.mesh(M.rock, { cast: true });
    if (rockMesh) group.add(rockMesh);

    // Scattered bushes (no colliders, as before)
    const shrubs = new Batch('shrubs');
    const shrubRandom = rng(0x5a17);
    for (let i = 0; i < 30; i++) {
        const bx = (sceneryRandom() - 0.5) * 600;
        const bz = (sceneryRandom() - 0.5) * 600;
        if (insideCitySceneryExclusion(bx, bz)) continue;
        const bushSize = 1.0 + sceneryRandom() * 1.5;
        sceneryRandom();
        sceneryRandom();
        sceneryRandom();
        addShrub(shrubs, shrubRandom, bx, ground(bx, bz) - 0.1, bz, bushSize * 1.8, 1);
    }

    // Wildflower patches become low flowering shrubs
    for (let i = 0; i < 20; i++) {
        const fx = (sceneryRandom() - 0.5) * 500;
        const fz = (sceneryRandom() - 0.5) * 500;
        if (insideCitySceneryExclusion(fx, fz)) continue;
        const flowerCount = 5 + Math.floor(sceneryRandom() * 10);
        sceneryRandom();
        for (let j = 0; j < flowerCount; j++) {
            sceneryRandom();
            sceneryRandom();
            sceneryRandom();
            sceneryRandom();
        }
        addShrub(shrubs, shrubRandom, fx, ground(fx, fz) - 0.05, fz, 1.2 + shrubRandom() * 0.8, 0);
    }
    const shrubMesh = shrubs.mesh(M.shrub, { cast: false });
    if (shrubMesh) group.add(shrubMesh);

    // Decorative scatter with its own random sequence (no colliders): low
    // chaparral in the playable area, oak groves and cypresses on the hills
    const R = rng(314);
    const step = tier === 'desktop' ? 28 : tier === 'mobile' ? 36 : 60;
    const center = { x: CITY_TERRAIN_AREA.centerX, z: CITY_TERRAIN_AREA.centerZ };
    for (let x = -1400; x <= 1400; x += step) {
        for (let z = -1400; z <= 1400; z += step) {
            const px = x + (R() - 0.5) * step, pz = z + (R() - 0.5) * step;
            const r = Math.hypot(px - center.x, pz - center.z);
            const grove = fbm(px * 0.006 + 3, pz * 0.006 - 7, 3);
            const scrub = fbm(px * 0.0042 + 11, pz * 0.0042 + 5, 3);
            const roll = R(), roll2 = R();
            if (r < CITY_TERRAIN_AREA.halfExtent * 1.25 || r > 1450) continue;
            const y = ground(px, pz);
            if (r > HILLS.start) {
                // Hills: groves of oaks, a few cypresses
                if (grove > 0.5 && roll < (grove - 0.5) * 4.5) oaks.push({ x: px, y, z: pz, scale: 0.75 + roll2 * 0.55 });
                else if (roll < 0.03) cypresses.push({ x: px, y, z: pz, scale: 0.8 + roll2 * 0.45 });
                else if (roll < 0.03 + Math.max(0, scrub - 0.45) * 2) bushes.push({ x: px, y, z: pz, scale: 0.3 + roll2 * 0.25 });
            } else if (roll < Math.max(0.04, (scrub - 0.4) * 1.6)) {
                // Playable area: low chaparral only (drivable through, like
                // the bushes before)
                bushes.push({ x: px, y, z: pz, scale: 0.18 + roll2 * 0.14 });
            }
        }
    }
    // Trees in the shadow of a hill (the shadow map only covers the area
    // around the car): march from the crown towards the sun over the ground
    for (const spot of [...oaks, ...cypresses, ...bushes]) spot.sun = sunOver(ground, spot.x, spot.y + 5 * spot.scale, spot.z);
    for (const [kind, list, seed] of [['oak', oaks, 11], ['cypress', cypresses, 12], ['bush', bushes, 13]] as const) {
        const mesh = createTreeCards(M, kind, list, seed);
        if (mesh) group.add(mesh);
    }

    state.scene.add(group);
}
