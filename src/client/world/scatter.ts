import { hashMix, hashUnit } from '../../shared/map/buildings.js';
import { pointInPolygon } from '../../shared/map/geometry.js';
import { heightAt, surfaceAt, zoneAt } from '../../shared/map/heightfield.js';
import type { MapData } from '../../shared/map/mapData.js';
import { insideCorridor } from '../../shared/map/roadNetwork.js';
import { BoxIndex, placementBox } from '../../shared/map/structures.js';
import { SURFACE, ZONE } from '../../shared/map/types.js';

// Plants and props without a collider (docs/phase-3-design.md 11.1 and
// 11.2: "Reine Optik ... entsteht nur im Client"): chaparral and shrubs on
// the hills, gardens in Seaview Heights and the park, dune grass, sunshades
// on the beach. A jittered grid per zone with a candidate per cell from an
// integer hash of the cell (E12), kept off the roads and sidewalks, the
// lots, the buildings and landmarks and the plants that have a collider.
// Deterministic: the same map gives the same scatter on every device (the
// density factor of the detail level thins it out, keeping a subset).

export type DecorKind = 'chaparral' | 'shrub' | 'flowers' | 'duneGrass' | 'sunshade';

export interface DecorSpot {
    kind: DecorKind;
    x: number;
    y: number;
    z: number;
    // Size factor and a number in [0, 1) for the looks (turn, tint)
    size: number;
    seed: number;
}

interface DecorRule {
    zone: number;
    kind: DecorKind;
    cell: number;
    density: number;
    // Clearance from roads and sidewalks (m)
    corridor: number;
    size: [number, number];
}

export const DECOR_RULES: readonly DecorRule[] = [
    { zone: ZONE.wild, kind: 'chaparral', cell: 9, density: 0.45, corridor: 0.5, size: [0.25, 0.5] },
    { zone: ZONE.wild, kind: 'shrub', cell: 15, density: 0.25, corridor: 0.5, size: [1.2, 2.2] },
    { zone: ZONE.hills, kind: 'chaparral', cell: 10, density: 0.4, corridor: 0.5, size: [0.22, 0.45] },
    { zone: ZONE.hills, kind: 'shrub', cell: 18, density: 0.2, corridor: 0.5, size: [1.0, 2.0] },
    { zone: ZONE.cliffs, kind: 'shrub', cell: 11, density: 0.35, corridor: 0.5, size: [0.9, 1.8] },
    { zone: ZONE.ranch, kind: 'chaparral', cell: 22, density: 0.18, corridor: 0.5, size: [0.2, 0.4] },
    { zone: ZONE.residential, kind: 'flowers', cell: 9, density: 0.3, corridor: 1, size: [1.1, 1.9] },
    { zone: ZONE.residential, kind: 'shrub', cell: 12, density: 0.2, corridor: 1, size: [1.0, 1.6] },
    { zone: ZONE.park, kind: 'flowers', cell: 7, density: 0.35, corridor: 1, size: [1.0, 1.7] },
    { zone: ZONE.dunes, kind: 'duneGrass', cell: 4.5, density: 0.55, corridor: 0.5, size: [0.8, 1.5] },
    { zone: ZONE.beach, kind: 'duneGrass', cell: 9, density: 0.15, corridor: 0.5, size: [0.7, 1.2] },
    { zone: ZONE.beach, kind: 'sunshade', cell: 22, density: 0.3, corridor: 7, size: [0.9, 1.1] },
    { zone: ZONE.industrial, kind: 'shrub', cell: 26, density: 0.12, corridor: 1, size: [0.9, 1.5] }
];

// Distance kept from plants with a collider and from buildings (m)
const PLANT_CLEARANCE = 1.5;
const BUILDING_CLEARANCE = 1;
// Sunshades only on dry sand above the water line
const SUNSHADE_MIN_HEIGHT = 1;

const SURFACE_OK: Record<DecorKind, (surface: number) => boolean> = {
    chaparral: s => s === SURFACE.grass || s === SURFACE.rock,
    shrub: s => s === SURFACE.grass || s === SURFACE.rock,
    flowers: s => s === SURFACE.grass,
    duneGrass: s => s === SURFACE.sand || s === SURFACE.grass,
    sunshade: s => s === SURFACE.sand
};

/** The client's scatter of the map; `density` (0..1] keeps that share of it. */
export function scatterDecor(map: MapData, density = 1): DecorSpot[] {
    const { hf, net } = map;
    const spec = hf.spec;
    const extent = (spec.cols - 1) * spec.cellSize;
    const walls = new BoxIndex();
    for (const lot of map.buildings) walls.add(placementBox(lot));
    for (const structure of map.structures) walls.add(placementBox(structure));
    // Plants with a collider, in 8 m buckets
    const plantCells = new Map<number, number[]>();
    const bucket = (x: number, z: number) => Math.floor((x + 1000) / 8) * 1024 + Math.floor((z + 1000) / 8);
    map.plants.forEach((plant, i) => {
        const key = bucket(plant.x, plant.z);
        const list = plantCells.get(key);
        if (list) list.push(i);
        else plantCells.set(key, [i]);
    });
    const nearPlant = (x: number, z: number, r: number) => {
        for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                for (const i of plantCells.get(bucket(x + di * 8, z + dj * 8)) ?? []) {
                    const p = map.plants[i];
                    const reach = r + PLANT_CLEARANCE + (p.kind === 'boulder' ? 2.6 : p.kind === 'rock' ? 1.4 : 0.6) * p.size;
                    if ((p.x - x) ** 2 + (p.z - z) ** 2 < reach * reach) return true;
                }
            }
        }
        return false;
    };
    const areaBoxes = net.areas.map((area, i) => ({ area, b: i * 4 }));
    const inArea = (x: number, z: number, margin: number) => areaBoxes.some(({ area, b }) =>
        x >= net.areaBounds[b] - margin && x <= net.areaBounds[b + 2] + margin
        && z >= net.areaBounds[b + 1] - margin && z <= net.areaBounds[b + 3] + margin
        && pointInPolygon(area.polygon, x, z));

    const out: DecorSpot[] = [];
    DECOR_RULES.forEach((rule, r) => {
        const cells = Math.floor(extent / rule.cell);
        for (let j = 0; j < cells; j++) {
            for (let i = 0; i < cells; i++) {
                const h = hashMix(hashMix(hashMix(0xdec0 + r, rule.zone), i), j);
                const u = hashUnit(h);
                if (u >= rule.density * density) continue;
                const x = spec.originX + (i + 0.1 + 0.8 * hashUnit(hashMix(h, 1))) * rule.cell;
                const z = spec.originZ + (j + 0.1 + 0.8 * hashUnit(hashMix(h, 2))) * rule.cell;
                if (zoneAt(hf, x, z) !== rule.zone) continue;
                if (!SURFACE_OK[rule.kind](surfaceAt(hf, x, z))) continue;
                const y = heightAt(hf, x, z);
                if (y < spec.waterLevel + (rule.kind === 'sunshade' ? SUNSHADE_MIN_HEIGHT : 0.4)) continue;
                const size = rule.size[0] + (rule.size[1] - rule.size[0]) * hashUnit(hashMix(h, 3));
                if (walls.contains(x, z, BUILDING_CLEARANCE + size)) continue;
                if (inArea(x, z, 1)) continue;
                if (nearPlant(x, z, size * 0.5)) continue;
                if (insideCorridor(net, x, z, rule.corridor + size * 0.4)) continue;
                out.push({ kind: rule.kind, x, y, z, size, seed: hashUnit(hashMix(h, 4)) });
            }
        }
    });
    return out;
}
