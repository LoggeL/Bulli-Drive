import * as THREE from 'three';
import { heightAt, surfaceAt, type Heightfield } from '../../shared/map/heightfield.js';
import { SURFACE } from '../../shared/map/types.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { patchWorldMaterial } from './materials.js';
import { buildTerrainSplat } from './terrainSplat.js';
import {
    createLevelArrays, fillLevelIndex, fillLevelVertices, horizonHeight, levelCentre, levelSpacing, levelSquare,
    type HeightFn, type LevelArrays, type TerrainGridConfig
} from './terrainGrid.js';
import { worldTexture } from './textures.js';

// The ground of the curated map (docs/phase-3-design.md E7, 8.1 and 9): the
// clipmap rings of terrainGrid.ts as one mesh per level, re-filled on the
// CPU when the camera has moved a few spacings, and the terrain material:
// dry golden grass with scrub, earth and rock on slopes, blended with sand,
// wet sand, earth, gravel, rock and lawns from the baked surface layer
// (terrainSplat.ts), darker under the water.

// Rings per detail level (world/quality.ts names them): level 0 spacing,
// cells from the centre to the border, levels. The outermost level reaches
// 3 to 4 km, past the camera's far plane.
export const TERRAIN_GRID: Record<'high' | 'mid' | 'low' | 'software', TerrainGridConfig> = {
    high: { base: 0.5, half: 64, levels: 8 },
    mid: { base: 0.5, half: 48, levels: 8 },
    low: { base: 0.5, half: 32, levels: 9 },
    software: { base: 1, half: 24, levels: 8 }
};

// Metres per repeat of the grass texture (the uv attribute)
const UV_PERIOD = 6;

// Linear RGB of the flat colours of the software tier (sRGB hex)
const lin = (hex: number) => new THREE.Color(hex).toArray().map(v => v.toFixed(4)).join(', ');

function splatTexture(data: Uint8Array, width: number, height: number, name: string): THREE.DataTexture {
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.name = name;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}

const SPLAT_DECL = /* glsl */`
uniform sampler2D tSplatA;
uniform sampler2D tSplatB;
uniform vec4 uSplatFrame;
float terrainWet = 0.0;
vec2 terrainSplatUv( vec3 wp ) {
	return ( ( wp.xz - uSplatFrame.xy ) * uSplatFrame.z + 0.5 ) / uSplatFrame.w;
}`;

// The full shading (desktop and phones): textures per layer
const TERRAIN_COLOR = /* glsl */`
	{
		vec2 suv = terrainSplatUv( vWPos );
		vec4 sa = texture2D( tSplatA, suv );
		vec4 sb = texture2D( tSplatB, suv );
		float covered = clamp( sa.r + sa.b + sa.a + sb.r + sb.b + sb.g, 0.0, 1.0 );
		float grass = 1.0 - covered;
		// Golden grass: olive chaparral patches, fine variation, bare earth
		float n = texture2D( uNoise, vWPos.xz / 240.0 ).r * 0.6 + texture2D( uNoise, vWPos.xz / 64.0 ).g * 0.4;
		float scrub = smoothstep( 0.37, 0.47, n ) * grass;
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.05, 0.085, 0.03 ) * ( 0.6 + 0.8 * texture2D( uNoise, vWPos.xz / 4.0 ).r ), scrub * 0.55 );
		float fine = texture2D( uNoise, vWPos.xz / 9.0 ).b;
		diffuseColor.rgb *= mix( 0.85, 1.1, fine );
		float bare = smoothstep( 0.62, 0.7, texture2D( uNoise, vWPos.xz / 140.0 + 0.3 ).a * 0.5 + texture2D( uNoise, vWPos.xz / 33.0 ).r * 0.5 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.4, 0.31, 0.21 ), bare * 0.45 * grass );
		// Lawns
		vec3 lawn = texture2D( tGrass, vWPos.xz / 5.0 ).rgb * vec3( 0.92, 1.0, 0.86 );
		lawn *= mix( 0.85, 1.1, texture2D( uNoise, vWPos.xz / 23.0 ).g );
		float lawnMask = sb.g * smoothstep( 0.25, 0.6, texture2D( uNoise, vWPos.xz / 47.0 ).r + sb.g * 0.3 );
		diffuseColor.rgb = mix( diffuseColor.rgb, lawn, lawnMask * 0.85 );
		// Earth (fire roads, trampled ground, under the roads), gravel, sand
		vec3 sandTex = texture2D( tSand, vWPos.xz / 4.0 ).rgb;
		vec3 earth = sandTex * vec3( 0.66, 0.52, 0.4 ) * mix( 0.85, 1.1, texture2D( uNoise, vWPos.xz / 7.0 ).r );
		diffuseColor.rgb = mix( diffuseColor.rgb, earth, clamp( sa.b + sb.b * 0.85, 0.0, 1.0 ) );
		vec3 gravel = texture2D( tGravel, vWPos.xz / 3.0 ).rgb * vec3( 0.9, 0.86, 0.8 );
		diffuseColor.rgb = mix( diffuseColor.rgb, gravel, sa.a );
		vec3 sand = sandTex * mix( 0.92, 1.06, texture2D( uNoise, vWPos.xz / 31.0 ).b );
		diffuseColor.rgb = mix( diffuseColor.rgb, sand, sa.r );
		// Wet sand at the water line and the sea floor: darker, a little cooler
		terrainWet = sa.g * smoothstep( -0.6, 1.2, vWPos.y + ( texture2D( uNoise, vWPos.xz / 13.0 ).r - 0.5 ) * 0.8 ) + sa.g * step( vWPos.y, 0.0 );
		terrainWet = clamp( terrainWet, 0.0, 1.0 );
		diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.6, 0.62, 0.64 ), terrainWet );
		float under = smoothstep( 0.0, -7.0, vWPos.y );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.42, 0.56, 0.55 ), under );
		// Rock on steep slopes and on the rock layer (triplanar)
		vec3 nw = normalize( cross( dFdx( vWPos ), dFdy( vWPos ) ) );
		float slope = 1.0 - abs( nw.y );
		vec3 blend = pow( abs( nw ), vec3( 4.0 ) );
		blend /= ( blend.x + blend.y + blend.z );
		vec3 rockColor = texture2D( tRock, vWPos.zy / 11.0 ).rgb * blend.x + texture2D( tRock, vWPos.xy / 11.0 ).rgb * blend.z + texture2D( tRock, vWPos.xz / 13.0 ).rgb * blend.y;
		float rockMask = smoothstep( 0.22, 0.42, slope + ( texture2D( uNoise, vWPos.xz / 60.0 ).g - 0.5 ) * 0.25 ) * ( 1.0 - sa.r * 0.7 );
		rockMask = max( rockMask, sb.r * 0.9 );
		diffuseColor.rgb = mix( diffuseColor.rgb, rockColor * vec3( 0.95, 0.9, 0.85 ), rockMask );
	}`;

// Software WebGL (a CPU rasterizer): the same layers as flat colours
function softwareColor(): string {
    return /* glsl */`
	{
		vec2 suv = terrainSplatUv( vWPos );
		vec4 sa = texture2D( tSplatA, suv );
		vec4 sb = texture2D( tSplatB, suv );
		vec3 c = vec3( ${lin(0x9c8c62)} );
		c = mix( c, vec3( ${lin(0x6f7a44)} ), sb.g );
		c = mix( c, vec3( ${lin(0x8a7458)} ), clamp( sa.b + sb.b * 0.85, 0.0, 1.0 ) );
		c = mix( c, vec3( ${lin(0x8f887d)} ), sa.a );
		c = mix( c, vec3( ${lin(0xc9b596)} ), sa.r );
		c = mix( c, c * 0.62, sa.g );
		c = mix( c, c * vec3( 0.42, 0.56, 0.55 ), smoothstep( 0.0, -7.0, vWPos.y ) );
		c = mix( c, vec3( ${lin(0x8d8478)} ), sb.r * 0.9 );
		diffuseColor.rgb = c;
	}`;
}

// The dry grass set of public/textures (the normal map on desktops only)
function pbr(name: 'grass_dry') {
    return {
        map: worldTexture(`pbr/${name}_albedo`, { fallback: 0x9c8c62 }),
        normalMap: () => worldTexture(`pbr/${name}_normal`),
        arm: worldTexture(`pbr/${name}_arm`)
    };
}

export interface TerrainTextures {
    splatA: THREE.DataTexture;
    splatB: THREE.DataTexture;
}

export function createTerrainTextures(hf: Heightfield): TerrainTextures {
    const splat = buildTerrainSplat(hf);
    return {
        splatA: splatTexture(splat.a, splat.width, splat.height, 'terrain-splat-a'),
        splatB: splatTexture(splat.b, splat.width, splat.height, 'terrain-splat-b')
    };
}

export function createTerrainMaterial(tier: RenderTier, hf: Heightfield, textures: TerrainTextures): THREE.Material {
    const spec = hf.spec;
    const uniforms: Record<string, THREE.IUniform> = {
        tSplatA: { value: textures.splatA },
        tSplatB: { value: textures.splatB },
        uSplatFrame: { value: new THREE.Vector4(spec.originX, spec.originZ, 1 / spec.cellSize, spec.cols) }
    };
    if (tier === 'software') {
        const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
        return patchWorldMaterial(material, { uniforms, decl: SPLAT_DECL, color: softwareColor() });
    }
    const normals = tier === 'desktop';
    Object.assign(uniforms, {
        tSand: { value: worldTexture('pbr/sand_albedo', { fallback: 0xc9b596 }) },
        tGrass: { value: worldTexture('pbr/grass_albedo', { fallback: 0x6f7a44 }) },
        tGravel: { value: worldTexture('pbr/roof_gravel_albedo', { fallback: 0x8f887d }) },
        tRock: { value: worldTexture('generated/rock_albedo') }
    });
    const grass = pbr('grass_dry');
    const material = new THREE.MeshStandardMaterial({
        map: grass.map,
        ...(normals ? { normalMap: grass.normalMap() } : {}),
        aoMap: grass.arm,
        roughnessMap: grass.arm,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.5
    });
    const patched = patchWorldMaterial(material, {
        macro: 0.16,
        macroScale: 80,
        uniforms,
        decl: SPLAT_DECL + '\nuniform sampler2D tSand;\nuniform sampler2D tGrass;\nuniform sampler2D tGravel;\nuniform sampler2D tRock;',
        color: TERRAIN_COLOR,
        // Wet sand is glossy
        rough: 'roughnessFactor = mix( roughnessFactor, 0.32, terrainWet );'
    });
    // Tree shadows fade on grazing slopes and in the distance (lighting.ts)
    patched.defines = { ...patched.defines, BULLI_GRAZING_SHADOW_FADE: '' };
    return patched;
}

interface Level {
    spacing: number;
    arrays: LevelArrays;
    mesh: THREE.Mesh;
    cx: number | null;
    cz: number | null;
    // Centre of the level inside at the last index fill
    innerX: number | null;
    innerZ: number | null;
}

/**
 * The terrain rings around the camera. `ground` is the sim's ground; the
 * rendered ground continues it beyond the map's data (horizonHeight).
 */
export class TerrainField {
    readonly group = new THREE.Group();
    readonly height: HeightFn;
    private readonly levels: Level[] = [];
    private readonly scratch: Float64Array;
    // Rebuilds since the start (e2e hook, tests)
    rebuilds = 0;

    constructor(private readonly hf: Heightfield, readonly config: TerrainGridConfig, material: THREE.Material) {
        this.group.name = 'terrain';
        const spec = hf.spec;
        const extentX = (spec.cols - 1) * spec.cellSize, extentZ = (spec.rows - 1) * spec.cellSize;
        this.height = horizonHeight((x, z) => heightAt(hf, x, z), {
            minX: spec.originX, maxX: spec.originX + extentX, minZ: spec.originZ, maxZ: spec.originZ + extentZ,
            landFrom: 1
        });
        const m = 2 * config.half + 3;
        this.scratch = new Float64Array(m * m);
        for (let l = 0; l < config.levels; l++) {
            const arrays = createLevelArrays(config.half);
            const geometry = new THREE.BufferGeometry();
            const position = new THREE.BufferAttribute(arrays.positions, 3).setUsage(THREE.DynamicDrawUsage);
            const normal = new THREE.BufferAttribute(arrays.normals, 3).setUsage(THREE.DynamicDrawUsage);
            const uv = new THREE.BufferAttribute(arrays.uvs, 2).setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute('position', position);
            geometry.setAttribute('normal', normal);
            geometry.setAttribute('uv', uv);
            geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1).setUsage(THREE.DynamicDrawUsage));
            geometry.setDrawRange(0, 0);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = `terrain-${l}`;
            mesh.receiveShadow = true;
            mesh.castShadow = false;
            // Always around the camera
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            this.group.add(mesh);
            this.levels.push({ spacing: levelSpacing(config, l), arrays, mesh, cx: null, cz: null, innerX: null, innerZ: null });
        }
    }

    // Holes in the ground: the pier's deck stands on its own piles
    private readonly skip = (x0: number, z0: number, x1: number, z1: number): boolean => {
        const hf = this.hf;
        return surfaceAt(hf, x0, z0) === SURFACE.wood || surfaceAt(hf, x1, z0) === SURFACE.wood
            || surfaceAt(hf, x0, z1) === SURFACE.wood || surfaceAt(hf, x1, z1) === SURFACE.wood;
    };

    /** Re-centres the levels on the camera (x, z); returns the number of levels rebuilt. */
    update(x: number, z: number): number {
        let rebuilt = 0;
        const { half } = this.config;
        for (let l = 0; l < this.levels.length; l++) {
            const level = this.levels[l];
            const cx = levelCentre(level.spacing, x, level.cx);
            const cz = levelCentre(level.spacing, z, level.cz);
            const moved = cx !== level.cx || cz !== level.cz;
            const inner = l > 0 ? this.levels[l - 1] : null;
            const innerMoved = inner !== null && (inner.cx !== level.innerX || inner.cz !== level.innerZ);
            if (!moved && !innerMoved) continue;
            const geometry = level.mesh.geometry;
            if (moved) {
                level.cx = cx;
                level.cz = cz;
                fillLevelVertices(this.height, level.spacing, half, cx, cz, level.arrays, UV_PERIOD, this.scratch);
                geometry.attributes.position.needsUpdate = true;
                geometry.attributes.normal.needsUpdate = true;
                geometry.attributes.uv.needsUpdate = true;
            }
            const hole = inner ? levelSquare(inner.spacing, half, inner.cx!, inner.cz!) : null;
            fillLevelIndex(level.spacing, half, cx, cz, hole, level.arrays, this.skip);
            level.innerX = inner?.cx ?? null;
            level.innerZ = inner?.cz ?? null;
            geometry.index!.needsUpdate = true;
            geometry.setDrawRange(0, level.arrays.indexCount);
            rebuilt++;
        }
        this.rebuilds += rebuilt;
        return rebuilt;
    }

    /** Triangles drawn by all levels. */
    triangles(): number {
        return this.levels.reduce((sum, level) => sum + level.arrays.indexCount / 3, 0);
    }
}
