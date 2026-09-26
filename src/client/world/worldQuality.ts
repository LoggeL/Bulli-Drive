import type { RenderTier } from '../effects/renderQuality.js';
import type { CellDistances } from './kitCells.js';
import { TERRAIN_GRID } from './terrain.js';
import type { TerrainGridConfig } from './terrainGrid.js';

// Detail levels of the map world (docs/phase-3-design.md 10; the fourth
// level, mid, is deviation A60): high on desktops, low on phones (tier
// low), software for CPU rasterizers (the E2E runs), and mid for desktops
// whose GPU cannot hold the frame rate at the lowest pixel ratio (the
// adaptive quality steps down to it) or with ?detail=mid. The render tier
// (lighting, materials) stays what it is; mid only shortens distances and
// thins out the scatter.

export type WorldDetail = 'high' | 'mid' | 'low' | 'software';

export interface WorldQuality {
    detail: WorldDetail;
    terrain: TerrainGridConfig;
    kit: CellDistances;
    // Sight per instanced kind (m); street furniture has its full model up
    // to furnitureNear, a few boxes beyond
    sight: { trees: number; scatter: number; rocks: number; rails: number; furniture: number; furnitureNear: number };
    // Share of the client's scatter that is drawn
    scatter: number;
}

export const WORLD_QUALITY: Record<WorldDetail, WorldQuality> = {
    high: {
        detail: 'high',
        terrain: TERRAIN_GRID.high,
        kit: { lod0: 60, lod1: 180, sight: 4000, hysteresis: 8, shadowReach: 110, nearLod: 0 },
        sight: { trees: 1200, scatter: 260, rocks: 700, rails: 900, furniture: 300, furnitureNear: 70 },
        scatter: 1
    },
    mid: {
        detail: 'mid',
        terrain: TERRAIN_GRID.mid,
        kit: { lod0: 45, lod1: 140, sight: 1600, hysteresis: 8, shadowReach: 90, nearLod: 0 },
        sight: { trees: 700, scatter: 180, rocks: 450, rails: 500, furniture: 220, furnitureNear: 50 },
        scatter: 0.75
    },
    low: {
        detail: 'low',
        terrain: TERRAIN_GRID.low,
        // Phones: LOD1 up close (no cornices), LOD2 beyond (design 10); the
        // near cells are the small ones, so fewer pieces cast shadows
        kit: { lod0: 50, lod1: 110, sight: 650, hysteresis: 6, shadowReach: 60, nearLod: 1, midLod: 2 },
        sight: { trees: 500, scatter: 120, rocks: 300, rails: 320, furniture: 160, furnitureNear: 35 },
        scatter: 0.55
    },
    software: {
        detail: 'software',
        terrain: TERRAIN_GRID.software,
        // Software WebGL: boxes with the atlas everywhere (LOD2), in 125 m
        // cells up to the sight of 220 m (design 10), where a CPU
        // rasterizer pays for every vertex
        kit: { lod0: -1, lod1: 250, sight: 220, hysteresis: 6, shadowReach: 0, nearLod: 2 },
        sight: { trees: 220, scatter: 60, rocks: 160, rails: 200, furniture: 90, furnitureNear: 0 },
        scatter: 0.3
    }
};

const DETAIL_OVERRIDE = new Set<WorldDetail>(['high', 'mid', 'low', 'software']);

/** The detail level for a render tier; ?detail=high|mid|low|software overrides it. */
export function worldDetailFor(tier: RenderTier, search = ''): WorldDetail {
    const forced = new URLSearchParams(search).get('detail');
    if (forced && DETAIL_OVERRIDE.has(forced as WorldDetail)) return forced as WorldDetail;
    return tier === 'desktop' ? 'high' : tier === 'mobile' ? 'low' : 'software';
}
