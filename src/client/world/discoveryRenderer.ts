import * as THREE from 'three';
import type { DiscoveryAlloy, DiscoveryDef, RewardEffect } from '../../shared/map/discoverySchema.js';
import { heightAt, type Heightfield } from '../../shared/map/heightfield.js';
import type { MapData } from '../../shared/map/mapData.js';
import { spawnDiscoveryBurst } from '../effects/particles.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { playDiscoveryChime } from '../effects/sounds.js';
import { ROAD_DISTANCE_LIFT, ROAD_LIFT_FROM } from './roads.js';

// Discovery POI beacon & celebratory unlock renderer:
// - Uses ONE merged terrain-conforming Mesh for all ground rings + ONE InstancedMesh
//   for hovering diamonds across all POIs on the active map, plus ONE toggleable
//   vertical beacon pillar for `pinnedId` (<= 3 draw calls total).
// - Every ground ring vertex conforms to `heightAt(hf, wx, wz) + 0.08` so rings
//   hug sloped hills and curbs cleanly without ever slicing into terrain.
// - Casts zero shadows so phone tier stays well under the 150 draw-call budget.
// - Secret POIs stay hidden beyond 65 m until found or pinned.

export const DISCOVERY_RING_LIFT = 0.08;
export const DISCOVERY_RING_DISTANCE_LIFT = ROAD_DISTANCE_LIFT + 0.0004;
export const RING_SEGMENTS = 32;
export const RING_RADIAL_STEPS = 2;
const RADIAL_FRACS = [0.74, 0.87, 1.0] as const;
const VERTS_PER_RING = (RING_RADIAL_STEPS + 1) * RING_SEGMENTS;
const TRIS_PER_RING = RING_RADIAL_STEPS * RING_SEGMENTS * 2;
const RING_COS = Float64Array.from({ length: RING_SEGMENTS }, (_, i) => Math.cos((i / RING_SEGMENTS) * Math.PI * 2));
const RING_SIN = Float64Array.from({ length: RING_SEGMENTS }, (_, i) => Math.sin((i / RING_SEGMENTS) * Math.PI * 2));

export const ALLOY_COLORS: Record<DiscoveryAlloy, number> = {
    forge: 0xff6a24,
    web: 0x22d3ee,
    games: 0xfacc15,
    ai: 0xa855f7,
    film: 0xf43f5e,
    alpine: 0x38bdf8,
    stunt: 0xf97316,
    coastal: 0x2dd4bf
};

const FOUND_TINT = new THREE.Color(0x64748b);
const PIN_TINT = new THREE.Color(0xffffff);
const SECRET_REVEAL_DIST = 65;

interface PoiEntry {
    def: DiscoveryDef;
    x: number;
    y: number;
    z: number;
    ringRadius: number;
    baseColor: THREE.Color;
    flashTimer: number;
    hidden: boolean;
}

export interface DiscoveryTriggerInfo {
    discoveryId: string;
    heroPropId?: string;
    x: number;
    y: number;
    z: number;
    effect: RewardEffect;
    alloy: DiscoveryAlloy;
}

const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

export class DiscoveryRenderer {
    readonly group = new THREE.Group();

    private readonly hf: Heightfield;
    private readonly entries: PoiEntry[] = [];
    private readonly byId = new Map<string, PoiEntry>();

    private readonly ringMesh: THREE.Mesh | null = null;
    private readonly ringPositions: Float32Array | null = null;
    private readonly ringColors: Float32Array | null = null;
    private readonly diamondMesh: THREE.InstancedMesh | null = null;
    private readonly pinBeam: THREE.Mesh | null = null;
    private readonly pinBeamMat: THREE.ShaderMaterial | null = null;

    private readonly foundIds = new Set<string>();
    private pinnedId: string | null = null;
    private disposed = false;

    constructor(map: MapData, private readonly tier: RenderTier) {
        this.group.name = 'discoveries';
        this.hf = map.hf;
        if (!map.discoveries.length) return;

        for (const def of map.discoveries) {
            const y = heightAt(map.hf, def.x, def.z) + (def.yOffset ?? 0);
            const entry: PoiEntry = {
                def,
                x: def.x,
                y,
                z: def.z,
                ringRadius: Math.max(2.2, Math.min(4.8, def.trigger.radius * 0.16)),
                baseColor: new THREE.Color(ALLOY_COLORS[def.alloy] ?? 0xff6a24),
                flashTimer: 0,
                hidden: false
            };
            this.entries.push(entry);
            this.byId.set(def.id, entry);
        }

        const count = this.entries.length;

        // 1. Single merged terrain-conforming Mesh for pulsing ground beacon rings (1 draw call)
        const totalVerts = count * VERTS_PER_RING;
        const positions = new Float32Array(totalVerts * 3);
        const colors = new Float32Array(totalVerts * 3);
        const radialT = new Float32Array(totalVerts);
        const indices = new Uint32Array(count * TRIS_PER_RING * 3);

        let idxOff = 0;
        for (let i = 0; i < count; i++) {
            const baseV = i * VERTS_PER_RING;
            for (let ir = 0; ir <= RING_RADIAL_STEPS; ir++) {
                const rt = ir / RING_RADIAL_STEPS;
                for (let ia = 0; ia < RING_SEGMENTS; ia++) {
                    radialT[baseV + ir * RING_SEGMENTS + ia] = rt;
                }
            }
            for (let ir = 0; ir < RING_RADIAL_STEPS; ir++) {
                const row0 = baseV + ir * RING_SEGMENTS;
                const row1 = baseV + (ir + 1) * RING_SEGMENTS;
                for (let ia = 0; ia < RING_SEGMENTS; ia++) {
                    const nextA = (ia + 1) % RING_SEGMENTS;
                    const a = row0 + ia, b = row0 + nextA;
                    const c = row1 + ia, d = row1 + nextA;
                    indices[idxOff++] = a;
                    indices[idxOff++] = b;
                    indices[idxOff++] = c;
                    indices[idxOff++] = b;
                    indices[idxOff++] = d;
                    indices[idxOff++] = c;
                }
            }
        }

        const ringGeom = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
        ringGeom.setAttribute('position', posAttr);
        ringGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        ringGeom.setAttribute('radialT', new THREE.BufferAttribute(radialT, 1));
        ringGeom.setIndex(new THREE.BufferAttribute(indices, 1));

        const ringMat = new THREE.ShaderMaterial({
            vertexShader: /* glsl */`
                attribute vec3 color;
                attribute float radialT;
                varying vec3 vColor;
                varying float vRadialT;
                void main() {
                    vColor = color;
                    vRadialT = radialT;
                    vec3 ringW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
                    vec3 lifted = position;
                    lifted.y += max( 0.0, length( ringW - cameraPosition ) - ${ROAD_LIFT_FROM.toFixed(1)} ) * ${DISCOVERY_RING_DISTANCE_LIFT};
                    gl_Position = projectionMatrix * modelViewMatrix * vec4( lifted, 1.0 );
                }
            `,
            fragmentShader: /* glsl */`
                varying vec3 vColor;
                varying float vRadialT;
                void main() {
                    float band = smoothstep( 0.0, 0.22, vRadialT ) * ( 1.0 - smoothstep( 0.78, 1.0, vRadialT ) );
                    float alpha = 0.76 * ( 0.35 + 0.65 * band );
                    if ( alpha < 0.01 ) discard;
                    gl_FragColor = vec4( vColor, alpha );
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3
        });

        this.ringPositions = positions;
        this.ringColors = colors;
        this.ringMesh = new THREE.Mesh(ringGeom, ringMat);
        this.ringMesh.name = 'discovery-rings';
        this.ringMesh.castShadow = false;
        this.ringMesh.receiveShadow = false;
        this.ringMesh.frustumCulled = false;
        this.ringMesh.renderOrder = 3;
        this.group.add(this.ringMesh);

        // 2. Single InstancedMesh for hovering faceted discovery jewels
        const diamondGeom = new THREE.OctahedronGeometry(0.68, 0);
        diamondGeom.scale(0.85, 1.35, 0.85);
        const diamondMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.88,
            depthWrite: false
        });
        this.diamondMesh = new THREE.InstancedMesh(diamondGeom, diamondMat, count);
        this.diamondMesh.name = 'discovery-markers';
        this.diamondMesh.castShadow = false;
        this.diamondMesh.receiveShadow = false;
        this.diamondMesh.frustumCulled = false;
        this.diamondMesh.renderOrder = 3;
        this.diamondMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(this.diamondMesh);

        // 3. Single toggleable translucent guidance pillar for pinnedId
        const beamGeom = new THREE.CylinderGeometry(0.55, 1.55, 56, 12, 1, true);
        beamGeom.translate(0, 28, 0);
        this.pinBeamMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0xff6a24) },
                uTime: { value: 0 }
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uColor;
                uniform float uTime;
                varying vec2 vUv;
                void main() {
                    float fadeBottom = smoothstep(0.0, 0.08, vUv.y);
                    float fadeTop = pow(1.0 - vUv.y, 1.6);
                    float pulse = 0.72 + 0.28 * sin(uTime * 3.4 - vUv.y * 8.0);
                    float alpha = fadeBottom * fadeTop * pulse * 0.48;
                    if (alpha < 0.01) discard;
                    gl_FragColor = vec4(uColor * 1.25, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide
        });
        this.pinBeam = new THREE.Mesh(beamGeom, this.pinBeamMat);
        this.pinBeam.name = 'discovery-pin-beam';
        this.pinBeam.visible = false;
        this.pinBeam.castShadow = false;
        this.pinBeam.receiveShadow = false;
        this.pinBeam.renderOrder = 4;
        this.group.add(this.pinBeam);

        this.applyStateColors();
        this.update(0, 0, { x: 0, y: 0, z: 0 });
    }

    /** Updates discovered & pinned POI visualization (called on init, discovery unlock, or map pin). */
    setDiscoveredIds(foundIds: ReadonlySet<string>, pinnedId: string | null): void {
        if (this.disposed) return;
        this.foundIds.clear();
        for (const id of foundIds) this.foundIds.add(id);
        this.pinnedId = pinnedId;
        this.applyStateColors();

        if (this.pinBeam && this.pinBeamMat) {
            const pinned = pinnedId ? this.byId.get(pinnedId) ?? null : null;
            if (pinned) {
                this.pinBeam.visible = true;
                this.pinBeam.position.set(pinned.x, pinned.y + 0.1, pinned.z);
                this.pinBeamMat.uniforms.uColor.value.copy(pinned.baseColor);
            } else {
                this.pinBeam.visible = false;
            }
        }
    }

    private applyStateColors(): void {
        if (!this.ringMesh || !this.ringColors || !this.diamondMesh) return;
        const colors = this.ringColors;
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            const found = this.foundIds.has(entry.def.id);
            const pinned = this.pinnedId === entry.def.id;
            if (pinned) {
                _color.copy(entry.baseColor).lerp(PIN_TINT, 0.28);
            } else if (found) {
                _color.copy(entry.baseColor).lerp(FOUND_TINT, 0.65);
            } else {
                _color.copy(entry.baseColor);
            }
            const base = i * VERTS_PER_RING * 3;
            for (let v = 0; v < VERTS_PER_RING; v++) {
                colors[base + v * 3] = _color.r;
                colors[base + v * 3 + 1] = _color.g;
                colors[base + v * 3 + 2] = _color.b;
            }
            this.diamondMesh.setColorAt(i, _color);
        }
        (this.ringMesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
        if (this.diamondMesh.instanceColor) this.diamondMesh.instanceColor.needsUpdate = true;
    }

    /** Fires celebratory burst particles, audio chime, and local flash for a discovery unlock. */
    triggerDiscoveryFx(discoveryId: string): DiscoveryTriggerInfo | null {
        if (this.disposed) return null;
        const entry = this.byId.get(discoveryId);
        if (!entry) return null;
        entry.flashTimer = 1.6;
        spawnDiscoveryBurst(entry.x, entry.y + 1.5, entry.z, entry.def.rewardEffect);
        playDiscoveryChime(entry.def.alloy);
        return {
            discoveryId,
            heroPropId: entry.def.heroPropId,
            x: entry.x,
            y: entry.y,
            z: entry.z,
            effect: entry.def.rewardEffect,
            alloy: entry.def.alloy
        };
    }

    private writeRingPositions(index: number, entry: PoiEntry, radius: number, collapse: boolean): void {
        const pos = this.ringPositions!;
        const base = index * VERTS_PER_RING * 3;
        if (collapse) {
            const cy = entry.y - 10;
            for (let v = 0; v < VERTS_PER_RING; v++) {
                pos[base + v * 3] = entry.x;
                pos[base + v * 3 + 1] = cy;
                pos[base + v * 3 + 2] = entry.z;
            }
            return;
        }
        const yOff = DISCOVERY_RING_LIFT + (entry.def.yOffset ?? 0);
        let p = base;
        for (let ir = 0; ir <= RING_RADIAL_STEPS; ir++) {
            const rad = radius * RADIAL_FRACS[ir];
            for (let ia = 0; ia < RING_SEGMENTS; ia++) {
                const wx = entry.x + RING_COS[ia] * rad;
                const wz = entry.z + RING_SIN[ia] * rad;
                pos[p++] = wx;
                pos[p++] = heightAt(this.hf, wx, wz) + yOff;
                pos[p++] = wz;
            }
        }
    }

    /** Updates terrain-conformed beacon rings, floating diamonds, pin pillar, and secret/distance culling. */
    update(dt: number, elapsedSec: number, focusPos: { x: number; y: number; z: number }): void {
        if (this.disposed || !this.ringMesh || !this.ringPositions || !this.diamondMesh) return;

        const maxDist = this.tier === 'desktop' ? 560 : this.tier === 'mobile' ? 320 : 220;
        const maxDistSq = maxDist * maxDist;
        const secretSq = SECRET_REVEAL_DIST * SECRET_REVEAL_DIST;
        let ringPosDirty = false;

        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (entry.flashTimer > 0) entry.flashTimer = Math.max(0, entry.flashTimer - dt);

            const found = this.foundIds.has(entry.def.id);
            const pinned = this.pinnedId === entry.def.id;
            const dx = entry.x - focusPos.x, dz = entry.z - focusPos.z;
            const d2 = dx * dx + dz * dz;

            // Hide distant POIs (unless pinned) and hide unfound secrets until close
            const hiddenBySecret = !!entry.def.secret && !found && !pinned && d2 > secretSq;
            const hiddenByDist = !pinned && d2 > maxDistSq;
            if (hiddenBySecret || hiddenByDist) {
                if (!entry.hidden) {
                    this.writeRingPositions(i, entry, 0, true);
                    entry.hidden = true;
                    ringPosDirty = true;
                }
                _scale.set(0, 0, 0);
                _mat.compose(_pos.set(entry.x, entry.y - 10, entry.z), _quat.identity(), _scale);
                this.diamondMesh.setMatrixAt(i, _mat);
                continue;
            }

            const flashBoost = entry.flashTimer > 0 ? Math.sin((entry.flashTimer / 1.6) * Math.PI) : 0;
            const pulse = 1 + Math.sin(elapsedSec * 2.6 + i * 0.9) * (found ? 0.04 : 0.14);
            const ringScale = entry.ringRadius * (pinned ? 1.25 : found ? 0.58 : 1.0) * pulse * (1 + flashBoost * 0.65);

            entry.hidden = false;
            this.writeRingPositions(i, entry, ringScale, false);
            ringPosDirty = true;

            const hover = Math.sin(elapsedSec * 2.2 + i * 1.1) * 0.45;
            const jewelScale = (pinned ? 1.35 : found ? 0.42 : 1.0) * (1 + flashBoost * 0.9);
            _quat.setFromAxisAngle(_up, elapsedSec * (pinned ? 1.8 : 1.1) + i * 0.7);
            _mat.compose(_pos.set(entry.x, entry.y + (found ? 2.4 : 3.4) + hover + flashBoost * 1.8, entry.z), _quat, _scale.setScalar(jewelScale));
            this.diamondMesh.setMatrixAt(i, _mat);
        }

        if (ringPosDirty) {
            (this.ringMesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        }
        this.diamondMesh.instanceMatrix.needsUpdate = true;

        if (this.pinBeamMat && this.pinBeam?.visible) {
            this.pinBeamMat.uniforms.uTime.value = elapsedSec;
        }
    }

    get count(): number {
        return this.entries.length;
    }

    /** Disposes every GPU geometry, material, and instanced mesh cleanly. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.ringMesh) {
            this.ringMesh.geometry.dispose();
            (this.ringMesh.material as THREE.Material).dispose();
        }
        if (this.diamondMesh) {
            this.diamondMesh.geometry.dispose();
            (this.diamondMesh.material as THREE.Material).dispose();
            this.diamondMesh.dispose();
        }
        if (this.pinBeam) {
            this.pinBeam.geometry.dispose();
        }
        this.pinBeamMat?.dispose();
        this.entries.length = 0;
        this.byId.clear();
        this.foundIds.clear();
        this.group.clear();
    }
}
