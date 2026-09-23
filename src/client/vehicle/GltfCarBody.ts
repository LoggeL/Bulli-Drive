import * as THREE from 'three';
import { models } from '../assets/gameModels.js';
import { carPaintColor, cloneCarMaterial, lampUniformsOf, type LampUniforms } from '../assets/carMaterials.js';

// The body of a car from the packed GLB models (tools/models, loaded by
// assets/ModelCache.ts): one instance per loaded LOD, of which one is shown
// by camera distance, per-car clones of the materials (paint colour, lamps,
// ghost and AFK looks never touch the shared templates), wheel pivots that
// spin and steer, and the lamp uniforms.

/**
 * Uniform scale of a model in the game. The sim hulls (shared/sim/vehicleClasses.ts:
 * two circles of radius r, c off centre, so 2r wide and 2(c + r) long) come
 * from the old cartoon box cars and stay unchanged; the real cars are scaled
 * uniformly so their proportions survive (docs/cars.md):
 * - bulli: T1 1.80 x 4.28 m -> 2.07 x 4.92 x 2.23 m in the 2.6 x 4.0 m hull
 *   (bumpers 0.46 m past the hull ends like the old box's, sides 0.27 m inside)
 * - pickup: T1 Pritsche, same factor as the Samba -> 2.01 x 4.93 x 2.21 m (hull 2.8 x 5.0)
 * - sport: Porsche 356 1.67 x 4.01 m -> 1.92 x 4.61 x 1.51 m (hull 2.4 x 4.5)
 * - jeep: Typ 181 1.64 x 3.78 m -> 1.89 x 4.35 x 1.73 m (hull 2.8 x 4.2)
 * - beetle: Kaefer 1.54 x 4.08 m at 1.10 -> 1.69 x 4.49 x 1.65 m (hull 2.2 x 3.5); at
 *   1.15 its bumpers would reach 0.6 m past the short hull, 1.10 keeps them at 0.5 m
 */
export const MODEL_SCALE: Record<string, number> = { bulli: 1.15, pickup: 1.15, sport: 1.15, jeep: 1.15, beetle: 1.1 };

/** Camera distance (m) from which LOD1 and LOD2 are used, with a hysteresis. */
export const LOD_DISTANCES: readonly number[] = [25, 70];
const LOD_HYSTERESIS = 2;
const WHEEL_NAMES = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'] as const;

interface LodInstance {
    lod: number;
    root: THREE.Object3D;
    pivots: THREE.Object3D[];
    baseRotations: THREE.Quaternion[];
    surfboard: THREE.Object3D | null;
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _spin = new THREE.Quaternion();
const _left = new THREE.Vector3();
const _origin = new THREE.Vector3();

export class GltfCarBody {
    readonly root = new THREE.Group();
    readonly id: string;
    readonly scale: number;
    /** Scaled size of the car (m): width, height, length */
    readonly size: THREE.Vector3;
    readonly wheelRadius: number;
    /** Scaled wheelbase (m), for the steering estimate of remote cars */
    readonly wheelbase: number;
    /** Height of the nametag socket above the ground (scaled) */
    readonly nametagHeight: number;
    /** Every material clone of this car (all LODs) */
    readonly materials: THREE.Material[] = [];
    private readonly instances: LodInstance[] = [];
    private readonly lampSets: LampUniforms[] = [];
    private readonly paints: THREE.MeshStandardMaterial[] = [];
    private active: LodInstance | null = null;
    private spin = 0;
    private steer = 0;

    /** True when at least one LOD of the model is loaded. */
    static available(id: string): boolean {
        return models.bestLod(id, 0) !== null;
    }

    constructor(id: string, colorCode: number) {
        this.id = id;
        this.scale = MODEL_SCALE[id] ?? 1;
        this.root.name = `car_body_${id}`;
        this.root.scale.setScalar(this.scale);
        const clones = new Map<THREE.Material, THREE.Material>();
        const cloneOf = (material: THREE.Material): THREE.Material => {
            let clone = clones.get(material);
            if (!clone) {
                clone = cloneCarMaterial(material);
                clones.set(material, clone);
                this.materials.push(clone);
                const lamps = lampUniformsOf(clone);
                if (lamps) this.lampSets.push(lamps);
                if (clone.name === 'paint_primary') {
                    carPaintColor(colorCode, (clone as THREE.MeshStandardMaterial).color);
                    this.paints.push(clone as THREE.MeshStandardMaterial);
                }
            }
            return clone;
        };

        let nametag = 0;
        for (const lod of [0, 1, 2]) {
            const root = models.has(id, lod) ? models.instantiate(id, lod) : null;
            if (!root) continue;
            root.traverse(child => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneOf) : cloneOf(mesh.material);
            });
            const pivots = WHEEL_NAMES.map(name => root.getObjectByName(name) ?? new THREE.Object3D());
            root.visible = false;
            this.root.add(root);
            this.instances.push({
                lod,
                root,
                pivots,
                baseRotations: pivots.map(pivot => pivot.quaternion.clone()),
                surfboard: root.getObjectByName('accessory_surfboard') ?? null
            });
            nametag = Math.max(nametag, root.getObjectByName('socket_nametag')?.position.y ?? 0);
        }

        const entry = models.entry(id);
        const dims = entry?.dimensions;
        this.size = new THREE.Vector3(dims?.width ?? 1.8, dims?.height ?? 1.9, dims?.length ?? 4.3).multiplyScalar(this.scale);
        this.wheelRadius = (entry?.wheelRadius ?? 0.33) * this.scale;
        this.wheelbase = (dims?.wheelbase ?? 2.4) * this.scale;
        this.nametagHeight = (nametag || this.size.y / this.scale + 0.5) * this.scale;
        this.showLod(this.instances[0]?.lod ?? 0);
    }

    get lod(): number {
        return this.active?.lod ?? -1;
    }

    get lods(): number[] {
        return this.instances.map(instance => instance.lod);
    }

    private showLod(lod: number): void {
        // The loaded LOD closest to the wanted one (ties: the more detailed)
        let best: LodInstance | null = null;
        for (const instance of this.instances) {
            if (!best || Math.abs(instance.lod - lod) < Math.abs(best.lod - lod)) best = instance;
        }
        if (best === this.active) return;
        if (this.active) this.active.root.visible = false;
        this.active = best;
        if (best) best.root.visible = true;
    }

    /** Picks the LOD for a camera `distance` m away (per unit of the car's own scale). */
    selectLod(distance: number): void {
        const current = this.active?.lod ?? 0;
        let wanted = 0;
        for (let i = 0; i < LOD_DISTANCES.length; i++) {
            // Switching back to the more detailed LOD needs a little more closeness
            const edge = LOD_DISTANCES[i] + (current > i ? -LOD_HYSTERESIS : LOD_HYSTERESIS);
            if (distance > edge) wanted = i + 1;
        }
        this.showLod(wanted);
    }

    /** Spins the wheels by the distance rolled (m) and sets the steering angle (rad, + = left). */
    roll(distance: number, steerAngle: number): void {
        this.spin = (this.spin + distance / this.wheelRadius) % (Math.PI * 2);
        this.steer = steerAngle;
    }

    /** Writes spin and steering onto the pivots of the shown LOD. */
    applyWheels(): void {
        const instance = this.active;
        if (!instance) return;
        for (let i = 0; i < instance.pivots.length; i++) {
            _euler.set(this.spin, i < 2 ? this.steer : 0, 0, 'YXZ');
            _spin.setFromEuler(_euler);
            instance.pivots[i].quaternion.copy(instance.baseRotations[i]).multiply(_spin);
        }
    }

    /**
     * Lamps: brake 0..1, blinkers 0..1 per side. `frame` is the object the
     * body hangs in (its world matrix gives the car's left axis).
     */
    setLamps(brake: number, blinkLeft: number, blinkRight: number, frame: THREE.Object3D): void {
        _left.setFromMatrixColumn(frame.matrixWorld, 0).normalize();
        _origin.setFromMatrixPosition(frame.matrixWorld);
        const w = -_left.dot(_origin);
        for (const lamps of this.lampSets) {
            lamps.lamps.value.set(brake, blinkLeft, blinkRight);
            lamps.carLeft.value.set(_left.x, _left.y, _left.z, w);
        }
    }

    setPaint(colorCode: number): void {
        for (const paint of this.paints) carPaintColor(colorCode, paint.color);
    }

    /** The optional surfboard accessory (hidden by default, user decision). */
    setSurfboard(visible: boolean): void {
        for (const instance of this.instances) if (instance.surfboard) instance.surfboard.visible = visible;
    }

    /** Frees the material clones only; geometry and textures belong to the model cache. */
    dispose(): void {
        for (const material of this.materials) material.dispose();
        this.materials.length = 0;
        this.lampSets.length = 0;
        this.paints.length = 0;
        this.instances.length = 0;
        this.active = null;
        this.root.clear();
    }
}
