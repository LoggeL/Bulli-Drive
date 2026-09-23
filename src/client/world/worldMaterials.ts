import { lightingTier } from '../render/lighting.js';
import { createWorldMaterials, type WorldMaterials } from './materials.js';

let materials: WorldMaterials | null = null;

/** The world materials for the tier the lighting was set up for (created once). */
export function worldMaterials(): WorldMaterials {
    materials ??= createWorldMaterials(lightingTier());
    return materials;
}
