import type * as THREE from 'three';

// Material conventions of the car GLBs (tools/models/README.md).

const GLASS_PATCHED = 'bulliFresnelGlass';

/**
 * The "glass" material of a car shares one small texture between the window
 * glass (left half, u < 0.5: dark tint, alpha ~0.34) and the soft ground blob
 * under the car (right half). Real glass gets more opaque at grazing angles
 * (Fresnel), which keeps the reflections on side windows strong; this raises
 * the alpha of the glass half accordingly and leaves the blob alone.
 * From the look-dev viewer of the graphics prototype.
 */
export function applyFresnelGlass(material: THREE.Material): void {
    if (material.userData[GLASS_PATCHED]) return;
    material.userData[GLASS_PATCHED] = true;
    material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
            #ifdef USE_MAP
            if ( vMapUv.x < 0.5 ) {
                float fresnelGlass = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );
                gl_FragColor.a = mix( gl_FragColor.a, 1.0, fresnelGlass * 0.8 );
            }
            #endif`);
    };
    material.customProgramCacheKey = () => GLASS_PATCHED;
}
