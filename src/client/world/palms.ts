import * as THREE from 'three';
import type { RenderTier } from '../effects/renderQuality.js';
import { Batch, rng, tube, type RGB } from './batch.js';
import { patchWorldMaterial, type WorldMaterials } from './materials.js';
import { whenWorldTextureLoaded } from './textures.js';

// Palms of the city (graphics G1): Mexican fan palms (Washingtonia robusta)
// along the boulevard and Canary Island date palms, taken over from the world
// probe with denser, greener crowns.
//
// - Instanced: per kind one trunk and one frond mesh for all palms near the
//   camera (two draw calls per kind, whatever the number of palms).
// - Wind: every vertex carries a `wind` attribute (bend, flutter, phase); the
//   vertex shader sways the palm and flutters the leaves (materials.ts,
//   WIND_GLSL), in the shadow pass as well (customDepthMaterial).
// - Far LOD: beyond IMPOSTOR_DISTANCE a palm is a camera facing card with an
//   image of the palm baked at runtime from the same geometry and textures
//   (one draw call for all far palms). The card is lit with rounded normals,
//   so it shades like the crown it replaces. Until the bake is done (the
//   textures load in the background) and after a lost context until it is
//   baked again, every palm uses the near geometry.

export type PalmKind = 'fan' | 'date';
const KINDS: PalmKind[] = ['fan', 'date'];

export interface PalmSpot {
    kind: PalmKind;
    x: number;
    y: number;
    z: number;
    scale: number;
    yaw: number;
}

// Horizontal camera distance (m) from which a palm is drawn as impostor, and
// the hysteresis that keeps a palm at the border from flipping every frame
const IMPOSTOR_DISTANCE: Record<RenderTier, number> = { desktop: 170, mobile: 110, software: 80 };
const IMPOSTOR_HYSTERESIS = 8;

// Palm dimensions at scale 1 (meters)
const PALM = {
    fan: { height: 15, baseRadius: 0.32, topRadius: 0.2, bend: 0.9 },
    date: { height: 8.5, baseRadius: 0.55, topRadius: 0.47, bend: 0.5 }
} as const;

// --- Geometry ------------------------------------------------------------------------

type LeafBuilder = (batch: Batch, base: THREE.Vector3, azimuth: number, elevation: number, droop: number,
    length: number, param: number, color: RGB, fold: number, twist: number, phase: number) => void;

// Normals bent up and outwards: soft, rounded light on flat cards
function bendNormals(g: THREE.BufferGeometry, base: THREE.Vector3, sideWeight: number, outWeight: number, upWeight: number): void {
    const N = g.attributes.normal, P = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < N.count; i++) {
        const ox = P.getX(i) - base.x, oz = P.getZ(i) - base.z, ol = Math.hypot(ox, oz) || 1;
        v.set(Math.abs(N.getX(i)) * sideWeight + ox / ol * outWeight, Math.abs(N.getY(i)) + upWeight, Math.abs(N.getZ(i)) * sideWeight + oz / ol * outWeight).normalize();
        N.setXYZ(i, v.x, v.y, v.z);
    }
}

function stripGeometry(positions: number[], uvs: number[], colors: number[], wind: number[], segments: number): THREE.BufferGeometry {
    const index: number[] = [];
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < 2; j++) {
            const a = i * 3 + j, b = a + 1, c = a + 3, d = c + 1;
            index.push(a, b, d, a, d, c);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('wind', new THREE.Float32BufferAttribute(wind, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
}

/** Sets the wind attribute of a rigid part (trunk, crown core): bend from its height. */
function rigidWind(g: THREE.BufferGeometry, height: number): THREE.BufferGeometry {
    const P = g.attributes.position;
    const wind = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
        // The crown core above the trunk top moves with the leaves (bend 1)
        const t = Math.min(1, Math.max(0, P.getY(i)) / height);
        wind[i * 3] = t * t;
    }
    g.setAttribute('wind', new THREE.BufferAttribute(wind, 3));
    return g;
}

function makeFrond(segments: number, bend: number): LeafBuilder {
    // Date palm frond: a V-folded strip from one of 4 columns of the atlas
    return (batch, base, azimuth, elevation, droop, length, column, color, fold, twist, phase) => {
        const positions: number[] = [], uvs: number[] = [], colors: number[] = [], wind: number[] = [];
        const u0 = column * 0.25 + 0.012, u1 = (column + 1) * 0.25 - 0.012, um = (u0 + u1) / 2;
        const p = new THREE.Vector3();
        const ca = Math.cos(azimuth), sa = Math.sin(azimuth);
        const width = 1.25;
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            if (i > 0) {
                const e = elevation - droop * Math.pow(t, 1.4);
                const step = length / segments;
                p.x += Math.cos(e) * step;
                p.y += Math.sin(e) * step;
            }
            const w = width * (0.55 + 0.45 * Math.sin(Math.min(1, t * 1.25 + 0.15) * Math.PI * 0.95));
            const tw = twist * t;
            for (const [s, u] of [[-1, u0], [0, um], [1, u1]] as const) {
                const z = s * w * 0.5 * Math.cos(tw), y = -Math.abs(s) * fold * w + s * w * 0.5 * Math.sin(tw);
                positions.push(base.x + p.x * ca - z * sa, base.y + p.y + y, base.z + p.x * sa + z * ca);
                uvs.push(u, t);
                const ao = 0.5 + 0.5 * Math.min(1, t * 1.8);
                colors.push(color[0] * ao, color[1] * ao, color[2] * ao);
                wind.push(bend, t * t * 1.2, phase);
            }
        }
        const g = stripGeometry(positions, uvs, colors, wind, segments);
        bendNormals(g, base, 0.3, 0.5, 0.6);
        batch.add(g);
    };
}

function makeFanLeaf(segments: number, bend: number): LeafBuilder {
    // Washingtonia fan leaf: a square card of the 2 x 2 atlas; the stalk (the
    // lower 35 %) is straight, the blade bends down and folds into a V
    return (batch, base, azimuth, elevation, droop, length, cell, color, fold, twist, phase) => {
        const positions: number[] = [], uvs: number[] = [], colors: number[] = [], wind: number[] = [];
        const cu = (cell % 2) * 0.5, cv = cell < 2 ? 0.5 : 0.0;
        const u0 = cu + 0.004, u1 = cu + 0.496, um = (u0 + u1) / 2;
        const p = new THREE.Vector3();
        const ca = Math.cos(azimuth), sa = Math.sin(azimuth);
        const W = length * 0.98;
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            if (i > 0) {
                const tb = Math.max(0, (t - 0.35) / 0.65);
                const e = elevation - droop * Math.pow(tb, 1.3);
                const step = length / segments;
                p.x += Math.cos(e) * step;
                p.y += Math.sin(e) * step;
            }
            const blade = Math.min(1, Math.max(0, (t - 0.3) / 0.25));
            const tw = twist * t;
            for (const [s, u] of [[-1, u0], [0, um], [1, u1]] as const) {
                const z = s * W * 0.5 * Math.cos(tw), y = -Math.abs(s) * fold * W * blade + s * W * 0.5 * Math.sin(tw);
                positions.push(base.x + p.x * ca - z * sa, base.y + p.y + y, base.z + p.x * sa + z * ca);
                uvs.push(u, cv + 0.004 + t * 0.492);
                const ao = 0.48 + 0.52 * Math.min(1, t * 1.5);
                colors.push(color[0] * ao, color[1] * ao, color[2] * ao);
                wind.push(bend, Math.max(0, t - 0.25) * 1.3, phase);
            }
        }
        const g = stripGeometry(positions, uvs, colors, wind, segments);
        bendNormals(g, base, 0.3, 0.55, 0.5);
        batch.add(g);
    };
}

export interface PalmGeometry {
    trunk: THREE.BufferGeometry;
    fronds: THREE.BufferGeometry;
    // Extent for the impostor: half width around the foot and total height
    halfWidth: number;
    height: number;
}

/**
 * One palm of `kind` in object space (foot at the origin), deterministic per
 * seed. `low`: fewer segments (phones); `keepRatio`: share of the leaves kept.
 */
export function buildPalm(kind: PalmKind, seed: number, low: boolean, keepRatio = low ? 0.8 : 1): PalmGeometry {
    const R = rng(seed);
    const keep = () => R() < keepRatio;
    const segments = low ? (kind === 'fan' ? 3 : 4) : (kind === 'fan' ? 5 : 6);
    const radial = low ? 6 : 9;
    const trunk = new Batch(`palm-trunk-${kind}`);
    const fronds = new Batch(`palm-fronds-${kind}`);
    const { height, baseRadius, topRadius, bend } = PALM[kind];
    const points: THREE.Vector3[] = [], radii: number[] = [];
    const rings = kind === 'fan' ? (low ? 10 : 16) : (low ? 7 : 10);
    for (let i = 0; i <= rings; i++) {
        const t = i / rings;
        points.push(new THREE.Vector3(bend * t * t, t * height, 0));
        // Washingtonia: flared foot, then slim; the date palm is a thick,
        // almost straight column with a slight bulge
        const flare = kind === 'fan' ? 0.28 * Math.exp(-t * 18) : 0.22 * Math.exp(-t * 9) + 0.05 * Math.sin(t * Math.PI);
        radii.push(baseRadius + (topRadius - baseRadius) * t + flare);
    }
    const g = tube(points, radii, radial, 1 / 1.3);
    // Darker, dusty foot
    const colors: number[] = [];
    for (let i = 0; i <= rings; i++) {
        for (let j = 0; j <= radial; j++) {
            const d = 0.72 + 0.28 * Math.min(1, (i / rings) * 4);
            colors.push(d, d * 0.97, d * 0.93);
        }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    trunk.add(rigidWind(g, height));
    const top = points[rings].clone();
    let crownRadius: number;
    if (kind === 'fan') {
        const leaf = makeFanLeaf(segments, 1);
        // Dark crown core and a short skirt of dead, hanging leaves (street
        // palms are trimmed, so the skirt stays close under the crown)
        trunk.add(rigidWind(new THREE.SphereGeometry(0.6, low ? 6 : 9, low ? 4 : 7).scale(1, 1.3, 1).translate(top.x, top.y - 0.2, top.z), height), null, [0.24, 0.2, 0.12]);
        trunk.add(rigidWind(new THREE.CylinderGeometry(0.52, 0.3, 1.6, radial, 1, true).translate(top.x, top.y - 1.1, top.z), height), null, [0.4, 0.31, 0.2]);
        for (let i = 0; i < 12; i++) {
            const azimuth = (i / 12) * Math.PI * 2 + R() * 0.3;
            if (!keep()) continue;
            leaf(fronds, top.clone().add(new THREE.Vector3(0, -0.15 - (i % 2) * 0.25, 0)), azimuth, -1.38 - R() * 0.1, 0.05, 1.3 + R() * 0.3, 3, [0.42, 0.37, 0.3], 0.05, 0, R());
        }
        // Green crown: five rings from steep to hanging, most leaves from the
        // two green cells of the atlas, a few yellowing ones low down
        const crown: [number, number, number, number][] = [
            [1.35, 7, 2.4, 0.4], [0.98, 11, 2.7, 0.55], [0.6, 14, 2.9, 0.75], [0.2, 15, 3.0, 0.95], [-0.25, 12, 2.8, 1.1]
        ];
        crown.forEach(([elevation, count, length, droop], ring) => {
            for (let i = 0; i < count; i++) {
                const azimuth = (i / count) * Math.PI * 2 + R() * 0.4 + ring * 0.37;
                if (!keep()) continue;
                const cell = ring === 4 && R() < 0.1 ? 2 : (R() < 0.5 ? 0 : 1);
                const g2 = 0.84 + R() * 0.16;
                const color: RGB = cell === 2 ? [g2 * 0.8, g2 * 0.78, g2 * 0.62] : [g2 * 0.9, g2 * 1.02, g2 * 0.8];
                leaf(fronds, top.clone().add(new THREE.Vector3(0, 0.2 - ring * 0.16, 0)), azimuth, elevation + (R() - 0.5) * 0.2, droop,
                    length + R() * 0.4, cell, color, 0.16, (R() - 0.5) * 0.7, R());
            }
        });
        crownRadius = 3.3;
    } else {
        const frond = makeFrond(segments, 1);
        // Pineapple-shaped leaf base knob under a dense, arching crown
        trunk.add(rigidWind(new THREE.SphereGeometry(0.78, low ? 7 : 10, low ? 5 : 7).scale(1, 0.95, 1).translate(top.x, top.y - 0.15, top.z), height), null, [0.5, 0.41, 0.28]);
        const rings3: [number, number, number, number][] = [[1.15, 14, 1.1, 4.4], [0.62, 18, 1.45, 5.0], [0.12, 18, 1.35, 4.8], [-0.35, 12, 1.0, 4.2]];
        rings3.forEach(([elevation, count, droop, length], ring) => {
            for (let i = 0; i < count; i++) {
                const azimuth = (i / count) * Math.PI * 2 + R() * 0.3 + ring * 0.29;
                if (!keep()) continue;
                const g2 = 0.84 + R() * 0.16;
                const color: RGB = ring === 3 && R() < 0.3 ? [g2 * 0.95, g2 * 0.88, g2 * 0.62] : [g2 * 0.92, g2 * 1.02, g2 * 0.82];
                frond(fronds, top.clone().add(new THREE.Vector3(0, 0.3 - ring * 0.12, 0)), azimuth, elevation + (R() - 0.5) * 0.2, droop,
                    length + R() * 0.8, Math.floor(R() * 4), color, 0.22, (R() - 0.5) * 0.5, R());
            }
        });
        crownRadius = 4.8;
    }
    return {
        trunk: trunk.build()!,
        fronds: fronds.build()!,
        halfWidth: bend + crownRadius,
        height: height + 1.8
    };
}

// --- Impostor ------------------------------------------------------------------------

// Atlas: one column per kind, the palm seen from the side (object -z)
const ATLAS_SIZE: Record<RenderTier, [number, number]> = { desktop: [512, 512], mobile: [256, 256], software: [256, 256] };

// Camera facing card (rotates about the vertical axis) with rounded normals.
// The instance matrix holds position and scale only; `impostor` = (atlas u0,
// atlas width, card width, card height) per instance. Built on the lit
// material of the tier (Standard, or Lambert on the software tier).
function impostorMaterial(M: WorldMaterials, map: THREE.Texture, tier: RenderTier): THREE.Material {
    const params = { map, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: false };
    const material = tier === 'software'
        ? new THREE.MeshLambertMaterial(params)
        : new THREE.MeshStandardMaterial({ ...params, roughness: 0.8, metalness: 0, envMapIntensity: 0.6 });
    material.alphaToCoverage = tier !== 'software' && (M.fan as THREE.Material).alphaToCoverage;
    const lit = patchWorldMaterial(material, {
        translucency: tier === 'software' ? undefined : 0.25,
        alphaCoverage: true,
        vertexDecl: 'attribute vec4 impostor;',
        vertex: 'transformed = impostorRight * ( position.x * impostor.z ) + vec3( 0.0, position.y * impostor.w, 0.0 );'
    });
    const worldPatch = lit.onBeforeCompile;
    lit.onBeforeCompile = (shader, renderer) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <beginnormal_vertex>', /* glsl */`
	vec3 impostorFoot = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
	vec3 impostorView = cameraPosition - impostorFoot;
	impostorView.y = 0.0;
	impostorView = normalize( impostorView + vec3( 1e-4, 0.0, 0.0 ) );
	vec3 impostorRight = vec3( impostorView.z, 0.0, -impostorView.x );
	// Rounded normals: a crown seen from the side
	vec3 objectNormal = normalize( impostorRight * ( ( uv.x * 2.0 - 1.0 ) * 0.9 ) + vec3( 0.0, 0.35, 0.0 ) + impostorView * 0.75 );`)
            .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = vec2( impostor.x + uv.x * impostor.y, uv.y );\n#endif');
        worldPatch.call(lit, shader, renderer);
    };
    return lit;
}

interface ImpostorBake {
    target: THREE.WebGLRenderTarget;
    // Atlas columns per kind: u0, width
    cells: Record<PalmKind, [number, number]>;
}

function bakeImpostors(renderer: THREE.WebGLRenderer, geometry: Record<PalmKind, PalmGeometry | null>, M: WorldMaterials,
    target: THREE.WebGLRenderTarget): void {
    const scene = new THREE.Scene();
    const basic = (source: THREE.Material, alphaTest: number, side: THREE.Side) => new THREE.MeshBasicMaterial({
        map: (source as THREE.MeshStandardMaterial).map, vertexColors: true, alphaTest, side, fog: false
    });
    const trunk = basic(M.trunk, 0, THREE.FrontSide);
    const fan = basic(M.fan, 0.5, THREE.DoubleSide);
    const frond = basic(M.frond, 0.45, THREE.DoubleSide);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, 0, 0.1, 100);
    const previousTarget = renderer.getRenderTarget();
    const previousColor = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    const previousShadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(target);
    // Transparent texels in foliage color: the mipmaps fade to green, not black
    renderer.setClearColor(new THREE.Color().setRGB(0.13, 0.16, 0.08), 0);
    renderer.clear();
    renderer.autoClear = false;
    const width = target.width, height = target.height;
    KINDS.forEach((kind, column) => {
        const palm = geometry[kind];
        if (!palm) return;
        scene.clear();
        scene.add(new THREE.Mesh(palm.trunk, trunk), new THREE.Mesh(palm.fronds, kind === 'fan' ? fan : frond));
        camera.left = -palm.halfWidth;
        camera.right = palm.halfWidth;
        camera.top = palm.height;
        camera.bottom = 0;
        camera.position.set(0, 0, 50);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        const viewport = new THREE.Vector4(column * width / 2, 0, width / 2, height);
        target.viewport.copy(viewport);
        target.scissor.copy(viewport);
        target.scissorTest = true;
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
    });
    target.scissorTest = false;
    target.viewport.set(0, 0, width, height);
    target.scissor.set(0, 0, width, height);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.shadowMap.autoUpdate = previousShadows;
    for (const material of [trunk, fan, frond]) material.dispose();
}

// --- Instances and LOD -----------------------------------------------------------------

interface KindMeshes {
    spots: PalmSpot[];
    trunk: THREE.InstancedMesh;
    fronds: THREE.InstancedMesh;
    geometry: PalmGeometry;
}

class PalmField {
    readonly group = new THREE.Group();
    private readonly kinds: Partial<Record<PalmKind, KindMeshes>> = {};
    private readonly spots: PalmSpot[];
    private readonly near: Uint8Array;
    private impostors: THREE.InstancedMesh | null = null;
    private bake: ImpostorBake | null = null;
    private baked = false;
    private dirty = true;
    distance: number;

    constructor(private readonly M: WorldMaterials, spots: PalmSpot[], private readonly tier: RenderTier) {
        this.group.name = 'palms';
        this.spots = spots;
        this.near = new Uint8Array(spots.length).fill(1);
        this.distance = IMPOSTOR_DISTANCE[tier];
        const low = tier !== 'desktop';
        const wind = tier !== 'software';
        for (const kind of KINDS) {
            const list = spots.filter(spot => spot.kind === kind);
            if (!list.length) continue;
            // Software WebGL pays for every leaf pixel on the CPU: a sparser crown
            const geometry = buildPalm(kind, kind === 'fan' ? 3 : 5, low, tier === 'software' ? 0.6 : undefined);
            const trunk = new THREE.InstancedMesh(geometry.trunk, M.trunk, list.length);
            const fronds = new THREE.InstancedMesh(geometry.fronds, kind === 'fan' ? M.fan : M.frond, list.length);
            trunk.name = `palm-trunks-${kind}`;
            fronds.name = `palm-fronds-${kind}`;
            for (const mesh of [trunk, fronds]) {
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                // The shadows sway with the palms
                if (wind) mesh.customDepthMaterial = windDepthMaterial();
                this.group.add(mesh);
            }
            this.kinds[kind] = { spots: list, trunk, fronds, geometry };
        }
        this.writeInstances();
    }

    /** Bakes the impostor atlas once the palm textures are in (again after a lost context). */
    async prepareImpostors(renderer: THREE.WebGLRenderer): Promise<void> {
        await Promise.all(['generated/palm_trunk', 'generated/fan_fronds', 'generated/palm_fronds'].map(whenWorldTextureLoaded));
        const [width, height] = ATLAS_SIZE[this.tier];
        const target = new THREE.WebGLRenderTarget(width, height, {
            colorSpace: THREE.SRGBColorSpace,
            generateMipmaps: true,
            minFilter: THREE.LinearMipmapLinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: true
        });
        target.texture.name = 'palm-impostors';
        target.texture.anisotropy = 4;
        this.bake = { target, cells: { fan: [0, 0.5], date: [0.5, 0.5] } };
        const geometry = { fan: this.kinds.fan?.geometry ?? null, date: this.kinds.date?.geometry ?? null };
        bakeImpostors(renderer, geometry, this.M, target);

        const card = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
        const mesh = new THREE.InstancedMesh(card, impostorMaterial(this.M, target.texture, this.tier), this.spots.length);
        mesh.name = 'palm-impostors';
        mesh.geometry.setAttribute('impostor', new THREE.InstancedBufferAttribute(new Float32Array(this.spots.length * 4), 4));
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        this.impostors = mesh;
        this.group.add(mesh);
        this.baked = true;
        this.dirty = true;

        // A lost context takes the rendered atlas with it: near geometry
        // until it is baked again on the restored context
        renderer.domElement.addEventListener('webglcontextlost', () => {
            this.baked = false;
            this.dirty = true;
        });
        renderer.domElement.addEventListener('webglcontextrestored', () => {
            bakeImpostors(renderer, geometry, this.M, target);
            this.baked = true;
            this.dirty = true;
        });
    }

    /** Picks near geometry or impostor per palm for this camera position. */
    update(camera: THREE.Camera): void {
        const { x, z } = camera.position;
        const nearLimit = this.distance, farLimit = this.distance + IMPOSTOR_HYSTERESIS;
        for (let i = 0; i < this.spots.length; i++) {
            const spot = this.spots[i];
            const d = Math.hypot(spot.x - x, spot.z - z);
            const near = !this.baked ? 1 : this.near[i] ? (d < farLimit ? 1 : 0) : (d < nearLimit ? 1 : 0);
            if (near !== this.near[i]) {
                this.near[i] = near;
                this.dirty = true;
            }
        }
        if (this.dirty) this.writeInstances();
    }

    stats(): { near: number; impostors: number; baked: boolean } {
        let near = 0;
        for (const flag of this.near) near += flag;
        return { near, impostors: this.impostors ? this.spots.length - near : 0, baked: this.baked };
    }

    private writeInstances(): void {
        this.dirty = false;
        const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const noRotation = new THREE.Quaternion();
        const flags = new Map(this.spots.map((spot, i) => [spot, this.near[i]]));
        for (const kind of KINDS) {
            const meshes = this.kinds[kind];
            if (!meshes) continue;
            let count = 0;
            for (const spot of meshes.spots) {
                if (!flags.get(spot)) continue;
                q.setFromAxisAngle(up, spot.yaw);
                s.setScalar(spot.scale);
                matrix.compose(p.set(spot.x, spot.y, spot.z), q, s);
                meshes.trunk.setMatrixAt(count, matrix);
                meshes.fronds.setMatrixAt(count, matrix);
                count++;
            }
            for (const mesh of [meshes.trunk, meshes.fronds]) {
                mesh.count = count;
                mesh.visible = count > 0;
                mesh.instanceMatrix.needsUpdate = true;
                if (count) mesh.computeBoundingSphere();
            }
        }
        const impostors = this.impostors;
        if (!impostors || !this.bake) return;
        const data = impostors.geometry.getAttribute('impostor') as THREE.InstancedBufferAttribute;
        let count = 0;
        this.spots.forEach((spot, i) => {
            if (this.near[i]) return;
            const geometry = this.kinds[spot.kind]!.geometry;
            const [u0, width] = this.bake!.cells[spot.kind];
            s.setScalar(spot.scale);
            matrix.compose(p.set(spot.x, spot.y, spot.z), noRotation, s);
            impostors.setMatrixAt(count, matrix);
            data.setXYZW(count, u0, width, geometry.halfWidth * 2, geometry.height);
            count++;
        });
        impostors.count = count;
        impostors.visible = count > 0;
        impostors.instanceMatrix.needsUpdate = true;
        data.needsUpdate = true;
        if (count) {
            // Bounds of the cards (the card geometry is a unit square)
            let radius = 0;
            for (const kind of KINDS) {
                const geometry = this.kinds[kind]?.geometry;
                if (geometry) radius = Math.max(radius, Math.hypot(geometry.halfWidth, geometry.height));
            }
            const box = new THREE.Box3();
            this.spots.forEach((spot, i) => {
                if (!this.near[i]) box.expandByPoint(p.set(spot.x, spot.y, spot.z));
            });
            impostors.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
            impostors.boundingSphere.radius += radius * 1.25;
        }
    }
}

// The depth material of the shadow pass with the same sway (three copies map
// and alphaTest of the lit material onto it)
function windDepthMaterial(): THREE.MeshDepthMaterial {
    return patchWorldMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), { wind: true });
}

let field: PalmField | null = null;
let impostorsReady: Promise<void> = Promise.resolve();

/** Instanced palms with wind and far impostors (one field per city). */
export function createPalms(M: WorldMaterials, spots: PalmSpot[], tier: RenderTier, renderer: THREE.WebGLRenderer | null): THREE.Group {
    field = new PalmField(M, spots, tier);
    if (renderer) {
        impostorsReady = field.prepareImpostors(renderer).catch(error => console.warn('Palm impostors failed', error));
    }
    return field.group;
}

/** Resolves once the impostor atlas is baked (or failed). */
export function whenPalmImpostorsReady(): Promise<void> {
    return impostorsReady;
}

/** Per frame before rendering: near geometry or impostor per palm. */
export function updatePalms(camera: THREE.Camera): void {
    field?.update(camera);
}

/** Overrides the impostor distance (m), null restores the tier's (e2e hook, screenshots). */
export function setPalmImpostorDistance(meters: number | null, tier: RenderTier): void {
    if (field) field.distance = meters ?? IMPOSTOR_DISTANCE[tier];
}

/** Near and far palms of the last update (e2e hook). */
export function palmStats(): { near: number; impostors: number; baked: boolean } | null {
    return field?.stats() ?? null;
}
