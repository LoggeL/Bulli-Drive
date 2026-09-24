import { WORLD_UNIFORMS } from '../render/look.js';

// Time of the animated world shaders (water normals), in seconds
export function updateWorldShaders(timeSeconds: number): void {
    WORLD_UNIFORMS.uTime.value = timeSeconds;
}
