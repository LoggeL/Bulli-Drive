import * as THREE from 'three';
import type { DiscoveryAlloy, DiscoveryDef, RewardEffect } from '../../shared/map/discoverySchema.js';
import { heightAt } from '../../shared/map/heightfield.js';
import type { MapData } from '../../shared/map/mapData.js';
import { spawnDiscoveryBurst } from '../effects/particles.js';
import type { RenderTier } from '../effects/renderQuality.js';
import { playDiscoveryChime } from '../effects/sounds.js';

// Discovery POI beacon & celebratory unlock renderer:
// - Uses TWO InstancedMeshes total (ground rings + hovering diamonds) across all POIs
//   on the active map, plus ONE toggleable vertical beacon pillar for `pinnedId` (≤ 3 draw calls).
// - Casts zero shadows so phone tier stays well under the 150 draw-call budget.
// - Secret POIs stay hidden beyond 65 m until found or pinned.

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

    private readonly entries: PoiEntry[] = [];
    private readonly byId = new Map<string, PoiEntry>();

    private readonly ringMesh: THREE.InstancedMesh | null = null;
    private readonly diamondMesh: THREE.InstancedMesh | null = null;
    private readonly pinBeam: THREE.Mesh | null = null;
    private readonly pinBeamMat: THREE.ShaderMaterial | null = null;

    private readonly foundIds = new Set<string>();
    private pinnedId: string | null = null;
    private disposed = false;

    constructor(map: MapData, private readonly tier: RenderTier) {
        this.group.name = 'discoveries';
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
                flashTimer: 0
            };
            this.entries.push(entry);
            this.byId.set(def.id, entry);
        }

        const count = this.entries.length;

        // 1. Single InstancedMesh for pulsing ground beacon rings
        const ringGeom = new THREE.RingGeometry(0.76, 1.0, 24);
        ringGeom.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.72,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2
        });
        this.ringMesh = new THREE.InstancedMesh(ringGeom, ringMat, count);
        this.ringMesh.name = 'discovery-rings';
        this.ringMesh.castShadow = false;
        this.ringMesh.receiveShadow = false;
        this.ringMesh.frustumCulled = false;
        this.ringMesh.renderOrder = 3;
        this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
        if (!this.ringMesh || !this.diamondMesh) return;
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
            this.ringMesh.setColorAt(i, _color);
            this.diamondMesh.setColorAt(i, _color);
        }
        if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
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

    /** Updates pulsing beacon rings, floating diamonds, pin pillar, and secret/distance culling. */
    update(dt: number, elapsedSec: number, focusPos: { x: number; y: number; z: number }): void {
        if (this.disposed || !this.ringMesh || !this.diamondMesh) return;

        const maxDist = this.tier === 'desktop' ? 560 : this.tier === 'mobile' ? 320 : 220;
        const maxDistSq = maxDist * maxDist;
        const secretSq = SECRET_REVEAL_DIST * SECRET_REVEAL_DIST;

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
                _scale.set(0, 0, 0);
                _mat.compose(_pos.set(entry.x, entry.y - 10, entry.z), _quat.identity(), _scale);
                this.ringMesh.setMatrixAt(i, _mat);
                this.diamondMesh.setMatrixAt(i, _mat);
                continue;
            }

            const flashBoost = entry.flashTimer > 0 ? Math.sin((entry.flashTimer / 1.6) * Math.PI) : 0;
            const pulse = 1 + Math.sin(elapsedSec * 2.6 + i * 0.9) * (found ? 0.04 : 0.14);
            const ringScale = entry.ringRadius * (pinned ? 1.25 : found ? 0.58 : 1.0) * pulse * (1 + flashBoost * 0.65);

            _quat.identity();
            _mat.compose(_pos.set(entry.x, entry.y + 0.15, entry.z), _quat, _scale.set(ringScale, 1, ringScale));
            this.ringMesh.setMatrixAt(i, _mat);

            const hover = Math.sin(elapsedSec * 2.2 + i * 1.1) * 0.45;
            const jewelScale = (pinned ? 1.35 : found ? 0.42 : 1.0) * (1 + flashBoost * 0.9);
            _quat.setFromAxisAngle(_up, elapsedSec * (pinned ? 1.8 : 1.1) + i * 0.7);
            _mat.compose(_pos.set(entry.x, entry.y + (found ? 2.4 : 3.4) + hover + flashBoost * 1.8, entry.z), _quat, _scale.setScalar(jewelScale));
            this.diamondMesh.setMatrixAt(i, _mat);
        }

        this.ringMesh.instanceMatrix.needsUpdate = true;
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
            this.ringMesh.dispose();
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
