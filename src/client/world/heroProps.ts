import * as THREE from 'three';
import type { BillboardDef, BoostPadDef, HeroPropDef } from '../../shared/map/discoverySchema.js';
import { heightAt, type Heightfield } from '../../shared/map/heightfield.js';
import type { MapData } from '../../shared/map/mapData.js';
import {
    clonePropSharingResources, getBillboardTexture, loadHeroPropTemplate, preloadMapHeroAssets
} from '../assets/HeroAssetLoader.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { WORLD_UNIFORMS } from '../render/look.js';
import { patchWorldMaterial } from './materials.js';
import { ROAD_DISTANCE_LIFT, ROAD_LIFT_FROM } from './roads.js';

// Ground overlays sit strictly above roads/areas (ROAD_LIFT=0.035, ROAD_DISTANCE_LIFT=0.0025)
// at every distance from 0 m to the horizon so roads/concrete never bury decals or boost pads.
export const DECAL_BASE_LIFT = 0.055;
export const DECAL_DISTANCE_LIFT = ROAD_DISTANCE_LIFT + 0.0002;
export const BOOST_PAD_BASE_LIFT = 0.065;
export const BOOST_PAD_DISTANCE_LIFT = ROAD_DISTANCE_LIFT + 0.0003;
// Hull draft (m) for waterborne sailboat monuments so they float cleanly at waterLevel - draft
export const SAILBOAT_DRAFT = 0.35;

/** Effective height offset (m) above terrain at camera distance `dist` (matches vertex shader). */
export function surfaceLiftAtDistance(baseLift: number, liftRate: number, dist: number, liftFrom = ROAD_LIFT_FROM): number {
    return baseLift + Math.max(0, dist - liftFrom) * liftRate;
}

/** Ground/water resting elevation (m) for a HeroPropDef on `hf`. */
export function heroPropGroundY(def: HeroPropDef, hf: Heightfield): number {
    const groundY = heightAt(hf, def.x, def.z);
    const baseY = def.model === 'lmf_sailboat_ijsselmeer'
        ? Math.max(hf.spec.waterLevel - SAILBOAT_DRAFT, groundY)
        : groundY;
    return baseY + (def.yOffset ?? 0);
}

// Hero 3D monuments, easter-egg props, custom lore billboards, terrain-conforming
// ground decals, and animated chevron boost pads.
//
// Render budget discipline:
// - Billboards, decals, and boost pads NEVER cast shadows.
// - On desktop tier only, hero props & monuments cast shadows within 140 m of focus
//   (phone/mobile and software tiers keep 0 hero-prop shadow passes).
// - All boost pads on a map merge into ONE single geometry + ShaderMaterial (1 draw call).
// - Co-located billboard defs whose coordinates match a hero prop carrying a
//   `billboard_face` node bind directly onto that prop's face (avoiding double stands).
// - Every owned geometry/material is tracked and disposed on map switch.

interface AnimNodeHandle {
    nodeName: string;
    object: THREE.Object3D;
    basePos: THREE.Vector3;
    baseRot: THREE.Euler;
    baseScale: THREE.Vector3;
    baseEmissiveIntensity: number | null;
    emissiveMat: THREE.MeshStandardMaterial | null;
}

interface PlacedHeroProp {
    def: HeroPropDef;
    root: THREE.Group;
    isMonument: boolean;
    x: number;
    z: number;
    animNodes: AnimNodeHandle[];
    reactionTimer: number;
    reactionDuration: number;
    pairedBillboard: BillboardDef | null;
    castShadowCapable: boolean;
}

interface PlacedBillboard {
    def: BillboardDef;
    root: THREE.Group;
    x: number;
    z: number;
    isDecal: boolean;
}

const CULL_DIST: Record<RenderTier, { monument: number; prop: number; billboard: number; decal: number }> = {
    desktop: { monument: 680, prop: 340, billboard: 380, decal: 240 },
    mobile: { monument: 380, prop: 210, billboard: 220, decal: 150 },
    software: { monument: 260, prop: 150, billboard: 160, decal: 110 }
};

const MONUMENT_SHADOW_DIST = 140;

const MODELS_WITH_BILLBOARD_FACE = new Set<string>([
    'prop_roadside_billboard',
    'prop_billboard_gantry',
    'prop_win98_frame'
]);

/** Matches billboards that sit directly on a hero prop's built-in `billboard_face` node. */
export function matchPairedBillboards(
    heroProps: readonly HeroPropDef[],
    billboards: readonly BillboardDef[]
): { propToBillboard: Map<string, BillboardDef>; pairedBillboardIds: Set<string>; mountedOnArchIds: Set<string> } {
    const propToBillboard = new Map<string, BillboardDef>();
    const pairedBillboardIds = new Set<string>();
    const mountedOnArchIds = new Set<string>();

    for (const b of billboards) {
        if (b.kind === 'decal') continue;
        let matchedProp: HeroPropDef | null = null;
        let bestDist = 4.0;
        for (const p of heroProps) {
            const d = Math.hypot(p.x - b.x, p.z - b.z);
            if (d < bestDist && MODELS_WITH_BILLBOARD_FACE.has(p.model) && !propToBillboard.has(p.id)) {
                bestDist = d;
                matchedProp = p;
            }
        }
        if (matchedProp) {
            propToBillboard.set(matchedProp.id, b);
            pairedBillboardIds.add(b.id);
            continue;
        }
        // Gantry sign explicitly mounted high on a non-billboard arch monument (e.g. lmf_forge_arch)
        if (b.kind === 'gantry' && (b.yOffset ?? 0) > 1.0) {
            const onMonument = heroProps.some(p => !MODELS_WITH_BILLBOARD_FACE.has(p.model) && Math.hypot(p.x - b.x, p.z - b.z) < 3.0);
            if (onMonument) mountedOnArchIds.add(b.id);
        }
    }
    return { propToBillboard, pairedBillboardIds, mountedOnArchIds };
}

function buildTerrainConformingDecal(b: BillboardDef, hf: Heightfield): THREE.BufferGeometry {
    const segs = 6;
    const geom = new THREE.PlaneGeometry(b.width, b.height, segs, segs);
    // Rotate flat onto XZ with +Z facing forward (matching yaw convention)
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    const sinY = Math.sin(b.yaw), cosY = Math.cos(b.yaw);
    const lift = DECAL_BASE_LIFT + (b.yOffset ?? 0);
    for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i);
        const lz = pos.getZ(i);
        const wx = b.x + lx * cosY + lz * sinY;
        const wz = b.z - lx * sinY + lz * cosY;
        const wy = heightAt(hf, wx, wz) + lift;
        pos.setXYZ(i, wx, wy, wz);
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    return geom;
}

function buildBoostPadsMesh(pads: readonly BoostPadDef[], hf: Heightfield): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } | null {
    if (!pads.length) return null;

    const segX = 2;
    const segZ = 6;
    const vertsPerPad = (segX + 1) * (segZ + 1);
    const quadsPerPad = segX * segZ;
    const positions = new Float32Array(pads.length * vertsPerPad * 3);
    const uvs = new Float32Array(pads.length * vertsPerPad * 2);
    const indices = new Uint32Array(pads.length * quadsPerPad * 6);

    let vOff = 0;
    let iOff = 0;

    for (const pad of pads) {
        const baseVertex = vOff;
        const fx = Math.sin(pad.yaw), fz = Math.cos(pad.yaw);
        // Right vector in Three.js Y-up when forward is (sin yaw, cos yaw)
        const rx = fz, rz = -fx;

        for (let iz = 0; iz <= segZ; iz++) {
            const v = iz / segZ; // 0 = rear entry, 1 = front exit (scrolls along +v)
            const localZ = (v - 0.5) * pad.length;
            for (let ix = 0; ix <= segX; ix++) {
                const u = ix / segX;
                const localX = (u - 0.5) * pad.width;
                const wx = pad.x + rx * localX + fx * localZ;
                const wz = pad.z + rz * localX + fz * localZ;
                const wy = heightAt(hf, wx, wz) + BOOST_PAD_BASE_LIFT;
                positions[vOff * 3] = wx;
                positions[vOff * 3 + 1] = wy;
                positions[vOff * 3 + 2] = wz;
                uvs[vOff * 2] = u;
                uvs[vOff * 2 + 1] = v;
                vOff++;
            }
        }

        for (let iz = 0; iz < segZ; iz++) {
            for (let ix = 0; ix < segX; ix++) {
                const a = baseVertex + iz * (segX + 1) + ix;
                const b = a + 1;
                const c = a + (segX + 1);
                const d = c + 1;
                // Upward-facing winding (+Y normal)
                indices[iOff++] = a;
                indices[iOff++] = c;
                indices[iOff++] = b;
                indices[iOff++] = b;
                indices[iOff++] = c;
                indices[iOff++] = d;
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    const material = new THREE.ShaderMaterial({
        uniforms: {
            uTime: WORLD_UNIFORMS.uTime
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                vec3 padW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
                vec3 lifted = position;
                lifted.y += max( 0.0, length( padW - cameraPosition ) - ${ROAD_LIFT_FROM.toFixed(1)} ) * ${BOOST_PAD_DISTANCE_LIFT};
                gl_Position = projectionMatrix * modelViewMatrix * vec4( lifted, 1.0 );
            }
        `,
        fragmentShader: /* glsl */`
            uniform float uTime;
            varying vec2 vUv;
            void main() {
                // Dark recessed pad bed with glowing cyan->ember scrolling forward chevrons
                float edgeX = min(vUv.x, 1.0 - vUv.x);
                float edgeY = min(vUv.y, 1.0 - vUv.y);
                float border = 1.0 - smoothstep(0.03, 0.075, edgeX);
                float fadeEnds = smoothstep(0.0, 0.07, edgeY);

                float centerDist = abs(vUv.x - 0.5) * 2.0;
                float chevPhase = fract(vUv.y * 4.5 - centerDist * 0.65 - uTime * 2.4);
                float chevron = smoothstep(0.18, 0.34, chevPhase) * (1.0 - smoothstep(0.56, 0.72, chevPhase));
                chevron *= (1.0 - smoothstep(0.84, 0.96, centerDist));

                float pulse = 0.8 + 0.2 * sin(uTime * 5.0 - vUv.y * 6.0);
                vec3 cyan = vec3(0.08, 0.86, 1.0);
                vec3 ember = vec3(1.0, 0.42, 0.14);
                vec3 chevColor = mix(cyan, ember, smoothstep(0.15, 0.9, vUv.y)) * (1.35 * pulse);
                vec3 baseColor = vec3(0.04, 0.07, 0.11);
                vec3 railColor = mix(cyan, ember, 0.35) * 1.1;

                vec3 col = mix(baseColor, chevColor, chevron);
                col = mix(col, railColor, border * 0.9);
                float alpha = clamp((0.62 + chevron * 0.38 + border * 0.35) * fadeEnds, 0.0, 0.98);
                if (alpha < 0.02) discard;
                gl_FragColor = vec4(col, alpha);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'boost-pads-merged';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    return { mesh, material };
}

export class HeroPropsLayer {
    readonly heroGroup = new THREE.Group();
    readonly billboardsGroup = new THREE.Group();
    readonly boostPadsGroup = new THREE.Group();

    private readonly props: PlacedHeroProp[] = [];
    private readonly propsById = new Map<string, PlacedHeroProp>();
    private readonly propsByDiscovery = new Map<string, PlacedHeroProp[]>();
    private readonly billboards: PlacedBillboard[] = [];

    private readonly ownedGeometries: THREE.BufferGeometry[] = [];
    private readonly ownedMaterials: THREE.Material[] = [];

    private disposed = false;

    constructor(
        private readonly map: MapData,
        private readonly tier: RenderTier,
        private readonly renderer: THREE.WebGLRenderer | null
    ) {
        this.heroGroup.name = 'hero-props';
        this.billboardsGroup.name = 'billboards';
        this.boostPadsGroup.name = 'boost-pads';

        const { propToBillboard, pairedBillboardIds, mountedOnArchIds } = matchPairedBillboards(map.heroProps, map.billboards);

        // Kick off lazy per-map preload right away if a WebGLRenderer is present
        if (renderer) void preloadMapHeroAssets(map, renderer);

        this.buildHeroProps(propToBillboard);
        this.buildBillboards(pairedBillboardIds, mountedOnArchIds);
        this.buildBoostPads();
    }

    private buildHeroProps(propToBillboard: Map<string, BillboardDef>): void {
        const hf = this.map.hf;
        for (const def of this.map.heroProps) {
            const root = new THREE.Group();
            root.name = `hero-${def.id}`;
            const y = heroPropGroundY(def, hf);
            root.position.set(def.x, y, def.z);
            root.rotation.y = def.yaw;
            const scale = def.scale ?? 1;
            root.scale.setScalar(scale);
            root.updateMatrix();
            this.heroGroup.add(root);

            const isMonument = def.model.startsWith('lmf_');
            const placed: PlacedHeroProp = {
                def,
                root,
                isMonument,
                x: def.x,
                z: def.z,
                animNodes: [],
                reactionTimer: 0,
                reactionDuration: 2.2,
                pairedBillboard: propToBillboard.get(def.id) ?? null,
                castShadowCapable: this.tier === 'desktop'
            };
            this.props.push(placed);
            this.propsById.set(def.id, placed);
            if (def.discoveryId) {
                const list = this.propsByDiscovery.get(def.discoveryId) ?? [];
                list.push(placed);
                this.propsByDiscovery.set(def.discoveryId, list);
            }

            void loadHeroPropTemplate(def.model, this.renderer).then(template => {
                if (this.disposed) return;
                const instance = template.isFallback ? template.scene.clone(true) : clonePropSharingResources(template.scene);
                if (template.isFallback) this.trackFallbackResources(instance);

                instance.traverse(obj => {
                    const mesh = obj as THREE.Mesh;
                    if (!mesh.isMesh) return;
                    mesh.castShadow = placed.castShadowCapable;
                    mesh.receiveShadow = this.tier !== 'software';
                });

                // Bind paired billboard texture onto the prop's billboard_face node if present
                if (placed.pairedBillboard) {
                    this.bindBillboardFace(instance, placed.pairedBillboard, template.billboardNode ?? 'billboard_face');
                }

                // Collect animated monument nodes
                for (const animName of template.animNodes) {
                    const node = instance.getObjectByName(animName);
                    if (!node) continue;
                    let emissiveMat: THREE.MeshStandardMaterial | null = null;
                    let baseEmissiveIntensity: number | null = null;
                    node.traverse(child => {
                        const m = child as THREE.Mesh;
                        if (m.isMesh && !emissiveMat && m.material && !Array.isArray(m.material)) {
                            const std = m.material as THREE.MeshStandardMaterial;
                            if ('emissiveIntensity' in std) {
                                const cloned = std.clone();
                                m.material = cloned;
                                this.ownedMaterials.push(cloned);
                                emissiveMat = cloned;
                                baseEmissiveIntensity = cloned.emissiveIntensity;
                            }
                        }
                    });
                    placed.animNodes.push({
                        nodeName: animName,
                        object: node,
                        basePos: node.position.clone(),
                        baseRot: node.rotation.clone(),
                        baseScale: node.scale.clone(),
                        baseEmissiveIntensity,
                        emissiveMat
                    });
                }

                root.add(instance);
            });
        }
    }

    private buildBillboards(pairedBillboardIds: Set<string>, mountedOnArchIds: Set<string>): void {
        const hf = this.map.hf;
        for (const b of this.map.billboards) {
            if (pairedBillboardIds.has(b.id)) continue;

            const root = new THREE.Group();
            root.name = `billboard-${b.id}`;
            this.billboardsGroup.add(root);

            const placed: PlacedBillboard = {
                def: b,
                root,
                x: b.x,
                z: b.z,
                isDecal: b.kind === 'decal'
            };
            this.billboards.push(placed);

            if (b.kind === 'decal') {
                const geom = buildTerrainConformingDecal(b, hf);
                const tex = getBillboardTexture(b.texture, this.renderer);
                const mat = this.createBillboardMaterial(tex, !!b.emissive, true);
                this.ownedGeometries.push(geom);
                this.ownedMaterials.push(mat);
                const mesh = new THREE.Mesh(geom, mat);
                mesh.name = `decal-${b.id}`;
                mesh.castShadow = false;
                mesh.receiveShadow = this.tier !== 'software';
                mesh.renderOrder = 1;
                mesh.matrixAutoUpdate = false;
                root.add(mesh);
                continue;
            }

            const groundY = heightAt(hf, b.x, b.z);
            if (b.kind === 'wall' || mountedOnArchIds.has(b.id)) {
                const y = groundY + (b.yOffset ?? b.height * 0.5 + 0.6);
                root.position.set(b.x, y, b.z);
                root.rotation.y = b.yaw;
                const tex = getBillboardTexture(b.texture, this.renderer);
                const faceGeom = new THREE.PlaneGeometry(b.width, b.height);
                const faceMat = this.createBillboardMaterial(tex, !!b.emissive, false);
                const frameGeom = new THREE.BoxGeometry(b.width + 0.35, b.height + 0.35, 0.22);
                const frameMat = new THREE.MeshStandardMaterial({ color: 0x262932, roughness: 0.6, metalness: 0.45 });
                this.ownedGeometries.push(faceGeom, frameGeom);
                this.ownedMaterials.push(faceMat, frameMat);

                const frameMesh = new THREE.Mesh(frameGeom, frameMat);
                frameMesh.position.z = -0.14;
                frameMesh.castShadow = false;
                frameMesh.receiveShadow = false;

                const faceMesh = new THREE.Mesh(faceGeom, faceMat);
                faceMesh.name = 'billboard_face';
                faceMesh.position.z = 0.02;
                faceMesh.castShadow = false;
                faceMesh.receiveShadow = false;

                root.add(frameMesh, faceMesh);
                continue;
            }

            // Standalone roadside or gantry billboard using the Blender GLB stand
            const standModel = b.kind === 'gantry' ? 'prop_billboard_gantry' : 'prop_roadside_billboard';
            const defaultWidth = b.kind === 'gantry' ? 12 : 8;
            const scale = Math.max(0.55, Math.min(1.6, b.width / defaultWidth));
            root.position.set(b.x, groundY + (b.yOffset ?? 0), b.z);
            root.rotation.y = b.yaw;
            root.scale.setScalar(scale);

            void loadHeroPropTemplate(standModel, this.renderer).then(template => {
                if (this.disposed) return;
                const instance = template.isFallback ? template.scene.clone(true) : clonePropSharingResources(template.scene);
                if (template.isFallback) this.trackFallbackResources(instance);
                instance.traverse(obj => {
                    const mesh = obj as THREE.Mesh;
                    if (!mesh.isMesh) return;
                    mesh.castShadow = false;
                    mesh.receiveShadow = this.tier !== 'software';
                });
                this.bindBillboardFace(instance, b, template.billboardNode ?? 'billboard_face');
                root.add(instance);
            });
        }
    }

    private bindBillboardFace(root: THREE.Object3D, b: BillboardDef, nodeName: string): void {
        const tex = getBillboardTexture(b.texture, this.renderer);
        const face = root.getObjectByName(nodeName);
        if (!face) return;
        const mat = this.createBillboardMaterial(tex, !!b.emissive, false);
        this.ownedMaterials.push(mat);
        face.traverse(obj => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = mat;
            mesh.castShadow = false;
        });
    }

    private createBillboardMaterial(tex: THREE.Texture, emissive: boolean, isDecal: boolean): THREE.Material {
        const decalVertex = isDecal
            ? `{ vec3 decalW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz; transformed.y += max( 0.0, length( decalW - cameraPosition ) - ${ROAD_LIFT_FROM.toFixed(1)} ) * ${DECAL_DISTANCE_LIFT}; }`
            : undefined;
        if (this.tier === 'software') {
            const mat = new THREE.MeshLambertMaterial({
                map: tex,
                emissive: emissive ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
                emissiveMap: emissive ? tex : null,
                emissiveIntensity: emissive ? 0.55 : 0,
                transparent: isDecal,
                opacity: isDecal ? 0.92 : 1,
                depthWrite: !isDecal,
                polygonOffset: isDecal,
                polygonOffsetFactor: isDecal ? -3 : 0,
                polygonOffsetUnits: isDecal ? -3 : 0
            });
            return isDecal ? patchWorldMaterial(mat, { vertex: decalVertex }) : mat;
        }
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            map: tex,
            roughness: isDecal ? 0.78 : 0.48,
            metalness: 0.04,
            envMapIntensity: isDecal ? 0.5 : 0.7,
            emissive: emissive ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
            emissiveMap: emissive ? tex : null,
            emissiveIntensity: emissive ? (isDecal ? 0.65 : 0.75) : 0,
            transparent: isDecal,
            opacity: isDecal ? 0.94 : 1,
            depthWrite: !isDecal,
            polygonOffset: isDecal,
            polygonOffsetFactor: isDecal ? -3 : 0,
            polygonOffsetUnits: isDecal ? -3 : 0
        });
        return isDecal ? patchWorldMaterial(mat, { vertex: decalVertex }) : mat;
    }

    private buildBoostPads(): void {
        const built = buildBoostPadsMesh(this.map.boostPads, this.map.hf);
        if (!built) return;
        this.ownedGeometries.push(built.mesh.geometry);
        this.ownedMaterials.push(built.material);
        this.boostPadsGroup.add(built.mesh);
    }

    private trackFallbackResources(root: THREE.Object3D): void {
        root.traverse(obj => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            this.ownedGeometries.push(mesh.geometry);
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) this.ownedMaterials.push(m);
        });
    }

    /** Triggers a dramatic celebration reaction on a hero monument by propId or discoveryId. */
    triggerReaction(id: string): boolean {
        const targets: PlacedHeroProp[] = [];
        const direct = this.propsById.get(id);
        if (direct) targets.push(direct);
        const byDiscovery = this.propsByDiscovery.get(id);
        if (byDiscovery) {
            for (const p of byDiscovery) if (!targets.includes(p)) targets.push(p);
        }
        for (const p of targets) {
            p.reactionTimer = p.reactionDuration;
        }
        return targets.length > 0;
    }

    /** Per-frame distance culling, shadow gating, and hero monument animNode updates. */
    update(dt: number, elapsedSec: number, focusPos: { x: number; y: number; z: number }): void {
        if (this.disposed) return;
        const limits = CULL_DIST[this.tier];
        const monumentSq = limits.monument * limits.monument;
        const propSq = limits.prop * limits.prop;
        const shadowSq = MONUMENT_SHADOW_DIST * MONUMENT_SHADOW_DIST;

        for (const p of this.props) {
            const dx = p.x - focusPos.x, dz = p.z - focusPos.z;
            const d2 = dx * dx + dz * dz;
            const visible = d2 <= (p.isMonument ? monumentSq : propSq);
            p.root.visible = visible;

            if (p.reactionTimer > 0) p.reactionTimer = Math.max(0, p.reactionTimer - dt);
            if (!visible) continue;

            if (p.castShadowCapable) {
                const cast = d2 <= shadowSq;
                p.root.traverse(obj => {
                    const mesh = obj as THREE.Mesh;
                    if (mesh.isMesh && mesh.name !== 'billboard_face' && mesh.castShadow !== cast) mesh.castShadow = cast;
                });
            }

            if (p.animNodes.length) {
                const reactU = p.reactionTimer > 0 ? p.reactionTimer / p.reactionDuration : 0;
                for (const anim of p.animNodes) {
                    this.animateNode(anim, elapsedSec, reactU);
                }
            }
        }

        const bbSq = limits.billboard * limits.billboard;
        const decalSq = limits.decal * limits.decal;
        for (const b of this.billboards) {
            const dx = b.x - focusPos.x, dz = b.z - focusPos.z;
            const d2 = dx * dx + dz * dz;
            b.root.visible = d2 <= (b.isDecal ? decalSq : bbSq);
        }
    }

    private animateNode(anim: AnimNodeHandle, t: number, reactU: number): void {
        const { nodeName, object, basePos, baseRot, baseScale, emissiveMat, baseEmissiveIntensity } = anim;
        const burst = Math.sin(reactU * Math.PI); // 0 -> 1 -> 0 smooth reaction envelope

        switch (nodeName) {
            case 'knopf_cap': {
                // Idle breathing pulse; on discovery press, sharply depresses then rebounds
                const idle = Math.sin(t * 2.2) * 0.03;
                const press = -0.42 * Math.sin(Math.min(1, (1 - reactU) * 2.5) * Math.PI) * (reactU > 0 ? 1 : 0);
                object.position.set(basePos.x, basePos.y + idle + press, basePos.z);
                if (emissiveMat && baseEmissiveIntensity !== null) {
                    emissiveMat.emissiveIntensity = baseEmissiveIntensity + 0.25 * (0.5 + 0.5 * Math.sin(t * 2.8)) + burst * 2.2;
                }
                break;
            }
            case 'reactor_bubbles': {
                // Continuous chemical bubble surge; 3x speed & lift on discovery trigger!
                const rate = reactU > 0 ? 3.0 : 1.0;
                const phase = t * 2.4 * rate;
                object.position.set(basePos.x, basePos.y + Math.sin(phase) * (0.45 + burst * 0.9), basePos.z);
                object.rotation.y = baseRot.y + t * (0.7 + burst * 2.1);
                const s = 1 + burst * 0.16;
                object.scale.set(baseScale.x * s, baseScale.y * s, baseScale.z * s);
                break;
            }
            case 'arcanum_key': {
                object.position.set(basePos.x, basePos.y + Math.sin(t * 1.6) * 0.35 + burst * 1.1, basePos.z);
                object.rotation.y = baseRot.y + t * 0.9 + burst * Math.PI * 2;
                if (emissiveMat && baseEmissiveIntensity !== null) {
                    emissiveMat.emissiveIntensity = baseEmissiveIntensity + burst * 1.8;
                }
                break;
            }
            case 'fader_gesang': {
                // Gentle mixer fader glide; rises triumphantly to +1.6 m on MelodAI unlock!
                const idle = Math.sin(t * 1.5) * 0.25;
                object.position.set(basePos.x, basePos.y + idle + burst * 1.6, basePos.z);
                if (emissiveMat && baseEmissiveIntensity !== null) {
                    emissiveMat.emissiveIntensity = baseEmissiveIntensity + burst * 1.6;
                }
                break;
            }
            case 'gondola_cabin': {
                const sway = Math.sin(t * 1.15) * (0.075 + burst * 0.14);
                object.rotation.set(baseRot.x, baseRot.y, baseRot.z + sway);
                object.position.set(basePos.x, basePos.y + Math.sin(t * 0.7) * 0.12, basePos.z);
                break;
            }
            case 'portal_plane': {
                const shimmer = 1 + Math.sin(t * 4.5) * 0.03 + burst * 0.12;
                object.scale.set(baseScale.x * shimmer, baseScale.y * shimmer, baseScale.z);
                if (emissiveMat && baseEmissiveIntensity !== null) {
                    emissiveMat.emissiveIntensity = baseEmissiveIntensity + 0.35 * (0.5 + 0.5 * Math.sin(t * 5.0)) + burst * 2.0;
                }
                break;
            }
            case 'embedding_core': {
                object.position.set(basePos.x, basePos.y + Math.sin(t * 1.8) * 0.3 + burst * 0.75, basePos.z);
                object.rotation.set(baseRot.x + t * 0.55 + burst * 2.5, baseRot.y + t * 0.95 + burst * 3.5, baseRot.z);
                const s = 1 + burst * 0.2;
                object.scale.set(baseScale.x * s, baseScale.y * s, baseScale.z * s);
                break;
            }
            default: {
                object.rotation.y = baseRot.y + t * 0.6 + burst * 2.0;
                break;
            }
        }
    }

    /** Disposes every per-map geometry & material owned by hero props, billboards, decals & boost pads. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const g of this.ownedGeometries) g.dispose();
        for (const m of this.ownedMaterials) m.dispose();
        this.ownedGeometries.length = 0;
        this.ownedMaterials.length = 0;
        this.props.length = 0;
        this.propsById.clear();
        this.propsByDiscovery.clear();
        this.billboards.length = 0;
        this.heroGroup.clear();
        this.billboardsGroup.clear();
        this.boostPadsGroup.clear();
    }
}
