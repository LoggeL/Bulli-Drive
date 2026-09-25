import * as THREE from 'three';
import type { RoadNetwork } from '../../shared/map/roadNetwork.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { patchWorldMaterial } from './materials.js';
import { buildRoadGeometry, ROAD_LAYERS, splitByChunk, type HeightFn, type MeshArrays, type RoadLayer } from './roadGeometry.js';
import { worldTexture } from './textures.js';

// The road meshes of a curated map (docs/phase-3-design.md 5.4, 5.5 and 9):
// one mesh per surface and 500 m block (ribbons, junctions and lots, the
// sidewalks with their curbs, the plaza's pavers), so the blocks out of view
// are culled: the whole map is some 45 k triangles, which a CPU rasterizer
// (the software tier) would otherwise transform every frame. Blocks of
// four chunks, since each surface of a block costs a draw call. The markings come from the road shader (roadGeometry.ts lists the
// attributes): centre lines, lane lines, edge lines, parking, stop lines and
// crosswalks at the junctions, stalls on the lots, worn where the wheels
// run.

// Far away the terrain rings are coarser than the ground under a road; the
// road rises a little with the distance so the ground never pokes through
// (m per m beyond LIFT_FROM)
const DISTANCE_LIFT = 0.0025;
const LIFT_FROM = 40;

// World-space texture coordinates of the tiling maps (uRoadTexScale: repeats
// per metre, a uniform so the layers can share their shader program)
function worldUvVertex(): string {
    const s = 'uRoadTexScale';
    return /* glsl */`
	vRoad = uv;
	vRoadA = roadA;
	vRoadB = roadB;
	{
		vec3 roadW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
		transformed.y += max( 0.0, length( roadW - cameraPosition ) - ${LIFT_FROM.toFixed(1)} ) * ${DISTANCE_LIFT};
		// Horizontal faces map the ground plane, curb faces run along it
		vec2 roadTex = abs( objectNormal.y ) > 0.5 ? roadW.xz * ${s} : vec2( roadW.x + roadW.z, roadW.y ) * ${s};
		#ifdef USE_MAP
		vMapUv = roadTex;
		#endif
		#ifdef USE_NORMALMAP
		vNormalMapUv = roadTex;
		#endif
		#ifdef USE_AOMAP
		vAoMapUv = roadTex;
		#endif
		#ifdef USE_ROUGHNESSMAP
		vRoughnessMapUv = roadTex;
		#endif
	}`;
}

const VERTEX_DECL = 'attribute vec4 roadA;\nattribute vec4 roadB;\nuniform float uRoadTexScale;\nvarying vec2 vRoad;\nvarying vec4 vRoadA;\nvarying vec4 vRoadB;';

const FRAGMENT_DECL = /* glsl */`
varying vec2 vRoad;
varying vec4 vRoadA;
varying vec4 vRoadB;
float paintMask = 0.0;
float wearMask = 0.0;
float roadLine( float d, float w ) {
	float fw = fwidth( d ) * 0.75 + 1e-4;
	return 1.0 - smoothstep( w * 0.5 - fw, w * 0.5 + fw, abs( d ) );
}
float roadDash( float s, float on, float period ) {
	float m = mod( s, period );
	float fw = fwidth( s ) + 1e-4;
	return smoothstep( 0.0, fw, m ) * ( 1.0 - smoothstep( on - fw, on + fw, m ) );
}
// Paint of the road markings: 0 none, else the mask; yellow in paintYellow
float paintYellow = 0.0;
void roadMarkings() {
	float across = vRoad.x, along = vRoad.y, a = abs( across );
	float hw = vRoadB.x;
	if ( vRoadA.w >= 7.5 ) {
		// A lot: stalls along both long sides (u along, v inwards)
		float u = vRoad.x, v = vRoad.y, depth = vRoadB.x, len = vRoadB.w;
		float row = min( v, depth - v );
		float inside = step( 2.5, u ) * step( u, len - 2.5 );
		float stall = roadLine( mod( u + 1.35, 2.7 ) - 1.35, 0.12 ) * step( 0.8, row ) * step( row, 5.6 );
		paintMask = max( paintMask, inside * max( stall, roadLine( row - 5.6, 0.12 ) ) );
		return;
	}
	if ( vRoadA.x < -0.5 || a > 50.0 ) return;
	float fromStart = along - vRoadB.z, toEnd = vRoadB.w - along;
	float startCode = mod( vRoadB.y, 4.0 ), endCode = floor( vRoadB.y / 4.0 + 0.01 );
	// Near an end: crosswalk (1 to 4 m) and stop line behind it
	float zoneStart = startCode >= 2.0 ? 5.2 : ( startCode >= 1.0 ? 1.8 : 0.0 );
	float zoneEnd = endCode >= 2.0 ? 5.2 : ( endCode >= 1.0 ? 1.8 : 0.0 );
	float lines = step( zoneStart, fromStart ) * step( zoneEnd, toEnd );
	float inRoad = step( a, hw - 0.15 );
	for ( int e = 0; e < 2; e++ ) {
		float code = e == 0 ? startCode : endCode;
		float d = e == 0 ? fromStart : toEnd;
		// Traffic arriving at this end drives on the right: at the end on the
		// right of the edge (across < 0), at the start on its left
		float approach = e == 0 ? step( 0.0, across ) : step( across, 0.0 );
		if ( code >= 2.0 ) {
			float bars = roadLine( mod( across + hw, 1.1 ) - 0.55, 0.55 );
			paintMask = max( paintMask, bars * step( 1.0, d ) * step( d, 4.0 ) * inRoad );
			paintMask = max( paintMask, roadLine( d - 4.8, 0.4 ) * approach * inRoad );
		} else if ( code >= 1.0 ) {
			paintMask = max( paintMask, roadLine( d - 1.2, 0.4 ) * approach * inRoad );
		}
	}
	float centre = vRoadA.x;
	float mask = 0.0, yellow = 0.0;
	if ( centre > 0.5 && centre < 1.5 ) mask = roadLine( across, 0.12 ) * roadDash( along, 3.0, 9.0 );
	else if ( centre > 1.5 && centre < 2.5 ) { mask = roadLine( across, 0.12 ) * roadDash( along, 3.0, 9.0 ); yellow = mask; }
	else if ( centre > 2.5 && centre < 3.5 ) { mask = roadLine( across, 0.12 ); yellow = mask; }
	else if ( centre > 3.5 ) { mask = max( roadLine( across - 0.14, 0.1 ), roadLine( across + 0.14, 0.1 ) ); yellow = mask; }
	// Lane lines: lanes forward on the right half, backward on the left
	float lanes = across < 0.0 ? vRoadA.y : vRoadA.z;
	if ( lanes > 1.5 ) {
		float w = hw / lanes;
		float k = floor( a / w + 0.5 );
		if ( k >= 1.0 && k < lanes ) mask = max( mask, roadLine( a - k * w, 0.12 ) * roadDash( along, 3.0, 9.0 ) );
	}
	float flags = vRoadA.w;
	if ( mod( flags, 2.0 ) >= 1.0 ) mask = max( mask, roadLine( a - ( hw - 0.3 ), 0.12 ) );
	if ( mod( flags, 4.0 ) >= 2.0 ) {
		// Parallel parking: a line 2.2 m from the curb, ticks every 6.7 m
		mask = max( mask, roadLine( a - ( hw - 2.2 ), 0.1 ) );
		mask = max( mask, roadLine( mod( along, 6.7 ) - 3.35, 0.1 ) * step( hw - 2.2, a ) * step( a, hw - 0.3 ) );
	}
	if ( mod( flags, 8.0 ) >= 4.0 ) {
		// Angled parking: stalls at 60 degrees against the curb
		float slanted = mod( along + ( hw - a ) * 0.58, 3.2 ) - 1.6;
		mask = max( mask, roadLine( slanted, 0.1 ) * step( hw - 2.6, a ) * step( a, hw - 0.3 ) );
	}
	paintMask = max( paintMask, mask * lines * inRoad );
	paintYellow = yellow * lines;
}`;

// Paint on top of the surface: worn in the wheel tracks and in patches
const PAINT_COLOR = /* glsl */`
	{
		roadMarkings();
		vec4 m = texture2D( uNoise, vWPos.xz / 17.0 + 0.5 );
		vec4 nz = texture2D( uNoise, vWPos.xz / 1.1 );
		float wear = wearMask * 0.5 + ( 1.0 - m.g ) * 0.42 + ( nz.b - 0.5 ) * 0.18;
		paintMask *= 1.0 - smoothstep( 0.5, 0.78, wear );
		vec3 paint = mix( vec3( 0.74, 0.73, 0.7 ), vec3( 0.78, 0.52, 0.1 ), paintYellow );
		diffuseColor.rgb = mix( diffuseColor.rgb, paint, paintMask * 0.92 );
	}`;

// Asphalt: wheel tracks per lane, oil in the lane centres, dirt along the
// edges, darker patches of fresh tar
const ASPHALT_COLOR = /* glsl */`
	{
		float a = abs( vRoad.x );
		float hw = vRoadB.x;
		vec4 n1 = texture2D( uNoise, vWPos.xz / 9.0 );
		if ( vRoadA.x > -0.5 && a < 50.0 ) {
			float lanes = max( 1.0, vRoad.x < 0.0 ? vRoadA.y : vRoadA.z );
			float w = hw / lanes;
			float c = ( floor( a / w ) + 0.5 ) * w;
			float t = abs( a - c ) - 0.8;
			float tracks = exp( -( t * t ) / 0.12 ) * ( 0.6 + 0.4 * n1.g );
			wearMask = tracks;
			diffuseColor.rgb *= 1.0 - 0.10 * tracks;
			float oil = exp( -pow( ( a - c ) / 0.28, 2.0 ) ) * smoothstep( 0.45, 0.8, n1.b );
			diffuseColor.rgb *= 1.0 - 0.2 * oil;
			float gutter = smoothstep( hw - 0.7, hw, a );
			diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.08, 1.0, 0.9 ) * 0.82, gutter * 0.7 );
		}
		vec4 n2 = texture2D( uNoise, vWPos.xz / 38.0 + 0.21 );
		float patchMask = smoothstep( 0.58, 0.63, n2.a );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.72, patchMask * 0.85 );
		wearMask += patchMask * 0.6;
	}`;

// Concrete (harbour, lots): slab joints every 5 m along and in the middle
const CONCRETE_COLOR = /* glsl */`
	{
		if ( vRoadA.w < 7.5 && vRoadA.x > -0.5 ) {
			float joint = max( roadLine( mod( vRoad.y, 5.0 ) - 2.5, 0.03 ), roadLine( vRoad.x, 0.03 ) );
			diffuseColor.rgb *= 1.0 - 0.35 * joint;
		}
		vec4 n = texture2D( uNoise, vWPos.xz / 13.0 );
		diffuseColor.rgb *= mix( 0.86, 1.06, n.r );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.8, 0.76, 0.7 ), smoothstep( 0.62, 0.7, n.a ) * 0.6 );
	}`;

// Dirt, gravel and sand tracks: ruts in the wheel tracks, a ragged edge
// that lets the ground show through
const TRACK_COLOR = /* glsl */`
	{
		float a = abs( vRoad.x );
		float hw = vRoadB.x;
		vec4 n1 = texture2D( uNoise, vWPos.xz / 6.0 );
		float edge = hw - 0.3 - 1.1 * n1.r;
		if ( a > edge ) discard;
		float t = abs( a - hw * 0.5 ) - 0.2;
		float ruts = exp( -( t * t ) / 0.18 );
		diffuseColor.rgb *= 1.0 - 0.16 * ruts * ( 0.6 + 0.4 * n1.g );
		diffuseColor.rgb *= mix( 0.9, 1.08, texture2D( uNoise, vWPos.xz / 21.0 ).b );
	}`;

// Sidewalks: broom finished concrete, joints every 1.5 m along and a line
// along the curb stone
const WALK_COLOR = /* glsl */`
	{
		float along = vRoad.y, across = vRoad.x;
		float joint = max( roadLine( mod( along, 1.52 ) - 0.76, 0.02 ), roadLine( across - 0.35, 0.02 ) );
		diffuseColor.rgb *= mix( 1.0, 0.64, joint );
		vec4 n = texture2D( uNoise, vWPos.xz / 11.0 );
		diffuseColor.rgb *= 1.0 - 0.12 * n.a;
	}`;

// The plaza: Saltillo style terracotta pavers, 60 cm, per tile tint, mortar
const PAVER_COLOR = /* glsl */`
	{
		vec2 q = vWPos.xz / 0.61;
		vec2 id = floor( q );
		vec4 h = textureLod( uNoise, ( id + 0.5 ) / 256.0, 0.0 );
		vec3 tile = mix( vec3( 0.66, 0.4, 0.26 ), vec3( 0.78, 0.55, 0.38 ), h.r );
		tile = mix( tile, vec3( 0.56, 0.31, 0.18 ), smoothstep( 0.75, 0.95, h.g ) * 0.7 );
		tile = mix( tile, vec3( 0.84, 0.68, 0.52 ), smoothstep( 0.8, 0.97, h.b ) * 0.6 );
		vec2 fw = fwidth( q ) * 1.2;
		vec2 gd = abs( fract( q ) - 0.5 );
		float paverJoint = 1.0 - smoothstep( 0.5 - 0.022 - fw.x, 0.5 - 0.006, max( gd.x, gd.y ) );
		tile *= 1.0 - 0.12 * smoothstep( 0.3, 0.48, max( gd.x, gd.y ) );
		diffuseColor.rgb = mix( diffuseColor.rgb * vec3( 0.93, 0.88, 0.8 ) * 0.85, diffuseColor.rgb * tile * 1.6, paverJoint );
	}`;

interface PbrMaps {
    map: THREE.Texture;
    // Desktop only (phones skip the download)
    normalMap: () => THREE.Texture;
    arm: THREE.Texture;
}

// Mean albedo (sRGB) of the sets: the placeholder until the map is in
const MEAN_ALBEDO = { asphalt: 0x55524e, sidewalk: 0xb9b2a8, sand: 0xc9b596, roof_gravel: 0x8f887d } as const;

// A tiling PBR set of public/textures (albedo, normal, ARM)
function pbr(name: keyof typeof MEAN_ALBEDO): PbrMaps {
    return {
        map: worldTexture(`pbr/${name}_albedo`, { fallback: MEAN_ALBEDO[name] }),
        normalMap: () => worldTexture(`pbr/${name}_normal`),
        arm: worldTexture(`pbr/${name}_arm`)
    };
}

interface LayerLook {
    // The texture set (null: flat colour)
    maps: (() => PbrMaps) | null;
    // Metres per texture repeat
    period: number;
    // sRGB mean albedo (placeholder, and the colour on the software tier)
    albedo: number;
    tint?: [number, number, number];
    color: string;
    rough?: string;
    envMapIntensity: number;
    // Polygon offset units (drawn over the terrain, curbs over the roads)
    offset: number;
    paint: boolean;
}

const LOOKS: Record<RoadLayer, LayerLook> = {
    asphalt: {
        maps: () => pbr('asphalt'), period: 4, albedo: 0x55524e, color: ASPHALT_COLOR, envMapIntensity: 0.55, offset: -2, paint: true,
        rough: 'roughnessFactor = clamp( roughnessFactor * 0.9 - 0.12 * wearMask - 0.2 * paintMask, 0.42, 1.0 );'
    },
    concrete: { maps: () => pbr('sidewalk'), period: 3, albedo: 0xa9a39a, color: CONCRETE_COLOR, envMapIntensity: 0.6, offset: -2, paint: true },
    dirt: { maps: () => pbr('sand'), period: 3, albedo: 0x8a7458, tint: [0.72, 0.58, 0.45], color: TRACK_COLOR, envMapIntensity: 0.4, offset: -2, paint: false },
    gravel: { maps: () => pbr('roof_gravel'), period: 2.5, albedo: 0x8f887d, tint: [0.92, 0.88, 0.82], color: TRACK_COLOR, envMapIntensity: 0.4, offset: -2, paint: false },
    sand: { maps: () => pbr('sand'), period: 3, albedo: 0xc9b596, tint: [0.95, 0.93, 0.9], color: TRACK_COLOR, envMapIntensity: 0.45, offset: -2, paint: false },
    walk: { maps: () => pbr('sidewalk'), period: 2, albedo: 0xb9b2a8, color: WALK_COLOR, envMapIntensity: 0.6, offset: -1, paint: false },
    pavers: { maps: () => pbr('sidewalk'), period: 2, albedo: 0xb9b2a8, color: PAVER_COLOR, envMapIntensity: 0.6, offset: -1, paint: false }
};

export function createRoadMaterial(layer: RoadLayer, tier: RenderTier): THREE.Material {
    const look = LOOKS[layer];
    const software = tier === 'software';
    // The albedo maps carry the colour; a tint only where a texture stands in
    // for another material (sand for earth, gravel)
    const color = new THREE.Color(1, 1, 1);
    if (look.tint) color.setRGB(...look.tint, THREE.SRGBColorSpace);
    const common = {
        polygonOffset: true,
        polygonOffsetFactor: look.offset,
        polygonOffsetUnits: look.offset
    };
    let material: THREE.Material;
    if (software || !look.maps) {
        material = new THREE.MeshLambertMaterial({ color: new THREE.Color(look.albedo), ...common });
    } else {
        const maps = look.maps();
        material = new THREE.MeshStandardMaterial({
            map: maps.map,
            ...(tier === 'desktop' ? { normalMap: maps.normalMap(), normalScale: new THREE.Vector2(0.8, 0.8) } : {}),
            aoMap: maps.arm,
            roughnessMap: maps.arm,
            aoMapIntensity: 0.7,
            color,
            roughness: 1,
            metalness: 0,
            envMapIntensity: look.envMapIntensity,
            ...common
        });
    }
    // Software WebGL keeps the markings and the ragged track edges (cheap
    // arithmetic), not the texture fetches of the wear; all its layers share
    // one shader program (the markings behind a uniform), since a CPU
    // rasterizer takes a good part of a second to compile each
    const colorCode = software
        ? '{ if ( uRoadPaint > 0.5 ) { roadMarkings(); diffuseColor.rgb = mix( diffuseColor.rgb, mix( vec3( 0.74, 0.73, 0.7 ), vec3( 0.78, 0.52, 0.1 ), paintYellow ), paintMask * 0.9 ); } }'
        : look.color + (look.paint ? PAINT_COLOR : '');
    return patchWorldMaterial(material, {
        ...(software ? {} : { macro: 0.14, macroScale: 45 }),
        uniforms: {
            uRoadTexScale: { value: 1 / look.period },
            ...(software ? { uRoadPaint: { value: look.paint ? 1 : 0 } } : {})
        },
        vertexDecl: VERTEX_DECL,
        vertex: worldUvVertex(),
        decl: software ? FRAGMENT_DECL + '\nuniform float uRoadPaint;' : FRAGMENT_DECL,
        color: colorCode,
        rough: software ? undefined : look.rough
    });
}

function toGeometry(arrays: MeshArrays): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
    geometry.setAttribute('roadA', new THREE.Float32BufferAttribute(arrays.roadA, 4));
    geometry.setAttribute('roadB', new THREE.Float32BufferAttribute(arrays.roadB, 4));
    geometry.setIndex(arrays.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(arrays.index, 1) : new THREE.Uint16BufferAttribute(arrays.index, 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
}

// The 4 × 4 blocks of 500 m over the map's data square (-1000 to 1000 m)
const BLOCK_SIZE = 500;
function roadBlock(x: number, z: number): number {
    const i = Math.min(3, Math.max(0, Math.floor((x + 1000) / BLOCK_SIZE)));
    const j = Math.min(3, Math.max(0, Math.floor((z + 1000) / BLOCK_SIZE)));
    return j * 4 + i;
}

/** The roads, lots and sidewalks of the map: one mesh per layer and 500 m block. */
export function createRoads(net: RoadNetwork, height: HeightFn, tier: RenderTier): THREE.Group {
    const group = new THREE.Group();
    group.name = 'roads';
    const layers = buildRoadGeometry(net, height);
    for (const layer of ROAD_LAYERS) {
        if (!layers[layer].index.length) continue;
        const material = createRoadMaterial(layer, tier);
        for (const [block, arrays] of splitByChunk(layers[layer], roadBlock)) {
            const mesh = new THREE.Mesh(toGeometry(arrays), material);
            mesh.name = `road-${layer}-${block}`;
            mesh.receiveShadow = true;
            // Only the curbs would cast, and only a sliver: not worth the pass
            mesh.castShadow = false;
            mesh.matrixAutoUpdate = false;
            group.add(mesh);
        }
    }
    return group;
}
