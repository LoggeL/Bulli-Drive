import * as THREE from 'three';

const worldShaderUniforms = {
    time: { value: 0 }
};

export function updateWorldShaders(timeSeconds: number): void {
    worldShaderUniforms.time.value = timeSeconds;
}

export function createTerrainMaterial(
    parameters: THREE.MeshStandardMaterialParameters = {}
): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial(parameters);

    material.onBeforeCompile = shader => {
        shader.uniforms.uWorldShaderTime = worldShaderUniforms.time;
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
varying vec3 vWorldShaderPosition;`
            )
            .replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
vWorldShaderPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform float uWorldShaderTime;
varying vec3 vWorldShaderPosition;`
            )
            .replace(
                '#include <color_fragment>',
                `#include <color_fragment>
float terrainDrift = sin(
    vWorldShaderPosition.x * 0.075 + vWorldShaderPosition.z * 0.065 + uWorldShaderTime * 0.16
);
float terrainDetail = sin((vWorldShaderPosition.x - vWorldShaderPosition.z) * 0.19 - uWorldShaderTime * 0.08);
float terrainVariation = terrainDrift * 0.045 + terrainDetail * 0.018;
diffuseColor.rgb *= vec3(1.0 + terrainVariation, 1.0 + terrainVariation * 1.25, 1.0 + terrainVariation * 0.65);`
            );
    };
    material.customProgramCacheKey = () => 'bulli-terrain-shader-v1';

    return material;
}

export function createWaterMaterial(
    parameters: THREE.MeshStandardMaterialParameters = {}
): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial(parameters);

    material.onBeforeCompile = shader => {
        shader.uniforms.uWorldShaderTime = worldShaderUniforms.time;
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
uniform float uWorldShaderTime;
varying vec3 vWorldShaderPosition;`
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
float waterTop = max(objectNormal.y, 0.0);
float waterWaveA = sin(position.x * 1.35 + uWorldShaderTime * 1.7) * 0.055;
float waterWaveB = cos(position.z * 1.75 - uWorldShaderTime * 1.25) * 0.04;
transformed.y += (waterWaveA + waterWaveB) * waterTop;`
            )
            .replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
vWorldShaderPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform float uWorldShaderTime;
varying vec3 vWorldShaderPosition;`
            )
            .replace(
                '#include <normal_fragment_maps>',
                `#include <normal_fragment_maps>
float waterFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.0);
float waterRipple = sin(vWorldShaderPosition.x * 1.45 + uWorldShaderTime * 1.9)
    * cos(vWorldShaderPosition.z * 1.7 - uWorldShaderTime * 1.35);
vec3 waterDeep = vec3(0.72, 0.91, 0.96);
vec3 waterHighlight = vec3(1.08, 1.18, 1.22);
diffuseColor.rgb *= mix(waterDeep, waterHighlight, clamp(waterFresnel * 0.72 + waterRipple * 0.10 + 0.14, 0.0, 1.0));
roughnessFactor = clamp(roughnessFactor + waterRipple * 0.035 - waterFresnel * 0.05, 0.04, 1.0);`
            );
    };
    material.customProgramCacheKey = () => 'bulli-water-shader-v1';

    return material;
}
