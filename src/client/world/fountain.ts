import * as THREE from 'three';
import type { RenderTier } from '../effects/renderQuality.js';
import { Batch, rgb } from './batch.js';
import { FOUNTAIN_UNIFORMS, type WorldMaterials } from './materials.js';

// The plaza fountain (graphics G1): a stone basin with a moulded coping, a
// pedestal with two bowls and a finial, and the water: still surfaces with
// rings of ripples and foam where the water lands (M.fountainWater), sheets
// falling from both bowl lips and a water bell over the finial (M.falls).
// Only uTime animates it, nothing runs on the CPU.
//
// Size and collider are unchanged: the basin is 4.6 m in radius inside the
// 5 m fountain collider.

const STONE = rgb(0xd6ccb9);

const lathe = (profile: readonly (readonly [number, number])[], segments: number, x: number, y: number, z: number) =>
    new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), segments).translate(x, y, z);

// Basin: plinth, wall, coping with a drip edge, inner wall, floor
const BASIN: [number, number][] = [
    [4.56, 0], [4.6, 0.1], [4.46, 0.14], [4.43, 0.58], [4.57, 0.62], [4.6, 0.72], [4.52, 0.8], [4.12, 0.82], [3.99, 0.78], [3.95, 0.7], [3.95, 0.3], [0, 0.3]
];
// Pedestal, lower bowl (outside, lip, inside), column, top bowl, finial
const PEDESTAL: [number, number][] = [
    [1.0, 0.3], [1.0, 0.5], [0.8, 0.58], [0.55, 0.7], [0.42, 0.9], [0.36, 1.3], [0.4, 1.5], [0.5, 1.58], [0.42, 1.66], [0.32, 1.8], [0.3, 1.9],
    [0.5, 1.95], [1.0, 2.05], [1.5, 2.18], [1.85, 2.3], [2.0, 2.4], [2.03, 2.48], [1.96, 2.52], [1.86, 2.47], [0.6, 2.36],
    [0.26, 2.4], [0.22, 2.6], [0.2, 2.85], [0.26, 2.95],
    [0.4, 2.98], [0.7, 3.06], [0.88, 3.14], [0.93, 3.2], [0.88, 3.24], [0.79, 3.2], [0.3, 3.14],
    [0.12, 3.2], [0.14, 3.35], [0.09, 3.45], [0.04, 3.5]
];
const BASIN_WATER = { r: 3.97, y: 0.64 };
const BOWL_WATER = { r: 1.9, y: 2.45 };
const TOP_WATER = { r: 0.85, y: 3.19 };

// A sheet falling from a lip at (r0, y0) to the water at y1, curving out
function sheet(r0: number, y0: number, y1: number, spread: number): [number, number][] {
    const points: [number, number][] = [];
    for (let i = 0; i <= 7; i++) {
        const t = i / 7;
        points.push([r0 + spread * Math.sqrt(t), y0 + (y1 - y0) * t]);
    }
    return points;
}

// Water bell over the finial: up from the nozzle, then outwards and down
const JET: [number, number][] = [[0.03, 3.5], [0.035, 3.75], [0.06, 3.93], [0.16, 3.99], [0.3, 3.92], [0.46, 3.74], [0.6, 3.49], [0.7, TOP_WATER.y]];

/**
 * Adds the stone parts to `stone` (the plaster material, box mapped) and
 * returns the water meshes, for a fountain whose foot is at (x, y, z).
 */
export function buildFountain(stone: Batch, M: WorldMaterials, x: number, y: number, z: number, tier: RenderTier): THREE.Mesh[] {
    const segments = tier === 'desktop' ? 48 : 28;
    FOUNTAIN_UNIFORMS.uFountain.value.set(x, z, y);
    stone.add(lathe(BASIN, segments, x, y, z), null, STONE, { box: 1.5 });
    stone.add(lathe(PEDESTAL, Math.round(segments * 0.75), x, y, z), null, STONE, { box: 1.2 });

    const water = new Batch('fountain-water');
    for (const { r, y: h } of [BASIN_WATER, BOWL_WATER, TOP_WATER]) {
        water.add(new THREE.CircleGeometry(r, segments).rotateX(-Math.PI / 2).translate(x, y + h, z));
    }
    const waterMesh = water.mesh(M.fountainWater, { cast: false, receive: true })!;

    const falls = new Batch('fountain-falls');
    const fallSegments = Math.round(segments * 0.75);
    falls.add(lathe(sheet(2.04, 2.49, BASIN_WATER.y, 0.34), fallSegments, x, y, z));
    falls.add(lathe(sheet(0.94, 3.21, BOWL_WATER.y, 0.16), fallSegments, x, y, z));
    falls.add(lathe(JET, Math.round(segments / 2), x, y, z));
    const fallsMesh = falls.mesh(M.falls, { cast: false, receive: false })!;
    // Drawn after the water surfaces it lands on
    fallsMesh.renderOrder = 1;
    return [waterMesh, fallsMesh];
}
