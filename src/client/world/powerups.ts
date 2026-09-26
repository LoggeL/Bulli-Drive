import * as THREE from 'three';
import { state } from '../state.js';
import type { PowerupData } from '../../shared/protocol.js';
import { groundHeight } from './ground.js';
import { showInteractionPrompt } from '../ui/hud.js';
import { POWERUP_DURATIONS_MS } from '../../shared/constants.js';

// The power-up markers (a ring with a floating icon per power-up) are
// drawn by a few instanced meshes: the rings, and one per icon shape, each
// once for the markers still there and once, faded, for the collected
// ones (docs/phase-3-design.md 10: the Party zone has 33 power-ups, which
// cost two draw calls each as single meshes). The colour of an instance is
// the power-up's colour, for its surface and its glow alike.

type IconShape = 'sphere' | 'torus' | 'cone' | 'octahedron';

const SHAPE_OF: Record<string, IconShape> = { shield: 'sphere', magnet: 'torus', ghost: 'cone' };
const ACTIVE_OPACITY = 0.8;
const COLLECTED_OPACITY = 0.2;

interface Marker {
    data: PowerupData;
    ring: THREE.Object3D;
    icon: THREE.Object3D;
    baseY: number;
    collected: boolean;
}

// Marker transforms keyed by server powerup id
const markers = new Map<PowerupData['id'], Marker>();
// Instanced meshes by part (ring or icon shape) and state
const parts = new Map<string, THREE.InstancedMesh>();
let group: THREE.Group | null = null;

function geometryOf(part: 'ring' | IconShape): THREE.BufferGeometry {
    switch (part) {
        case 'ring': return new THREE.TorusGeometry(1.5, 0.2, 16, 32).rotateX(Math.PI / 2);
        case 'sphere': return new THREE.SphereGeometry(0.7, 8, 6);
        case 'torus': return new THREE.TorusGeometry(0.5, 0.2, 8, 12);
        case 'cone': return new THREE.ConeGeometry(0.6, 1.2, 6);
        case 'octahedron': return new THREE.OctahedronGeometry(0.8);
    }
}

// White surface and glow, both tinted by the instance colour
function markerMaterial(opacity: number, glow: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity, emissive: 0xffffff, emissiveIntensity: glow });
    material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
    };
    material.customProgramCacheKey = () => 'bulli-powerup-marker';
    return material;
}

function partMesh(part: 'ring' | IconShape, collected: boolean, count: number): THREE.InstancedMesh {
    const key = `${part}:${collected ? 'collected' : 'active'}`;
    let mesh = parts.get(key);
    if (mesh && mesh.instanceMatrix.count >= count) return mesh;
    if (mesh) {
        mesh.removeFromParent();
        mesh.dispose();
        (mesh.material as THREE.Material).dispose();
    }
    const geometry = mesh?.geometry ?? geometryOf(part);
    mesh = new THREE.InstancedMesh(geometry, markerMaterial(collected ? COLLECTED_OPACITY : ACTIVE_OPACITY, part === 'ring' ? 0.5 : 0.8), Math.max(8, count));
    mesh.name = `powerups-${key}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    parts.set(key, mesh);
    if (!group || group.parent !== state.scene) {
        group = new THREE.Group();
        group.name = 'powerups';
        state.scene.add(group);
        for (const other of parts.values()) group.add(other);
    }
    group.add(mesh);
    return mesh;
}

export function createPowerupMarker(p: PowerupData) {
    const baseY = groundHeight(p.x, p.z) + 1.5;
    const ring = new THREE.Object3D();
    ring.position.set(p.x, baseY, p.z);
    const icon = new THREE.Object3D();
    icon.position.y = 1.5;
    ring.add(icon);
    markers.set(p.id, { data: p, ring, icon, baseY, collected: p.collected });
}

// Removes every marker (a room switch brings the new room's powerups)
export function clearPowerupMarkers() {
    markers.clear();
    for (const mesh of parts.values()) mesh.count = 0;
    state.worldPowerups = [];
}

// Dim/restore the marker visuals when a powerup is collected/reset (called from websocket.ts)
export function setPowerupCollectedVisual(id: PowerupData['id'], collected: boolean): void {
    const marker = markers.get(id);
    if (marker) marker.collected = collected;
}

const color = new THREE.Color();

export function animatePowerups(time: number) {
    const buckets = new Map<string, Marker[]>();
    for (const p of state.worldPowerups) {
        const marker = markers.get(p.id);
        if (!marker) continue;
        marker.ring.position.y = marker.baseY + Math.sin(time * 2.0 + p.id) * 0.5;
        // Spin the ring, and the icon inside it
        marker.ring.rotation.z = time * 1.5;
        marker.icon.rotation.y = time * 3.0;
        marker.ring.updateMatrixWorld(true);
        const phase = marker.collected ? 'collected' : 'active';
        for (const part of ['ring', SHAPE_OF[p.type] ?? 'octahedron']) {
            const key = `${part}:${phase}`;
            const list = buckets.get(key);
            if (list) list.push(marker);
            else buckets.set(key, [marker]);
        }
    }
    for (const [key, mesh] of parts) if (!buckets.has(key)) mesh.count = 0;
    for (const [key, list] of buckets) {
        const [part, phase] = key.split(':') as ['ring' | IconShape, string];
        const mesh = partMesh(part, phase === 'collected', list.length);
        list.forEach((marker, i) => {
            mesh.setMatrixAt(i, (part === 'ring' ? marker.ring : marker.icon).matrixWorld);
            mesh.setColorAt(i, color.setHex(marker.data.color));
        });
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
}

// The server gave the local car this powerup (its window drives the sim
// and the HUD, net/netDriver.ts); offline the car counts the timer itself
export function applyPowerupEffect(p: PowerupData) {
    if (!state.bulli) return;
    // Guard against unknown/unsupported powerup types from the server
    if (!(p.type in state.bulli.powerups)) return;
    if (!state.ws) {
        const key = p.type as keyof typeof state.bulli.powerups;
        state.bulli.powerups[key].active = true;
        state.bulli.powerups[key].timer = (POWERUP_DURATIONS_MS[p.type] ?? 5000) / 1000;
    }
    showInteractionPrompt(`${p.label.toUpperCase()} ACTIVATED!`);
}
