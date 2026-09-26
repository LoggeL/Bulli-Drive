import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { models, whenModelsReady } from '../assets/gameModels.js';
import { carPaintColor } from '../assets/carMaterials.js';
import { lightingTier } from '../render/lighting.js';
import type { BodyMotion } from './bodyMotion.js';
import { GltfCarBody, PHONE_REMOTE_LOD_DISTANCES, type GltfCarBodyOptions } from './GltfCarBody.js';

// Three.js model of one car: the body (the packed GLB model where one exists,
// see GltfCarBody; otherwise a procedural body), shield bubble, ghost and AFK
// looks, wheels, lamps and the GPU resources the car owns. Pure rendering -
// no physics, no DOM, no network. updateCarModels() runs once per frame for
// every live car: LOD by camera distance, rolling and steering wheels, brake
// lights and blinkers.

// Cached VW logo texture (procedural bodies)
let _vwLogoTexture: THREE.CanvasTexture | null = null;

function createVWLogoTexture(): THREE.CanvasTexture {
    if (_vwLogoTexture) return _vwLogoTexture;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.45;

    ctx.clearRect(0, 0, size, size);
    // Chrome roundel: light ring, dark field, chrome letters
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#D8D8DA';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
    ctx.fillStyle = '#2A2C30';
    ctx.fill();

    ctx.strokeStyle = '#E4E4E6';
    ctx.lineWidth = size * 0.05;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const s = r * 0.65;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.55, cy - s * 0.7);
    ctx.lineTo(cx, cy + s * 0.15);
    ctx.lineTo(cx + s * 0.55, cy - s * 0.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.7, cy - s * 0.15);
    ctx.lineTo(cx - s * 0.28, cy + s * 0.75);
    ctx.lineTo(cx, cy + s * 0.2);
    ctx.lineTo(cx + s * 0.28, cy + s * 0.75);
    ctx.lineTo(cx + s * 0.7, cy - s * 0.15);
    ctx.stroke();

    _vwLogoTexture = new THREE.CanvasTexture(canvas);
    _vwLogoTexture.colorSpace = THREE.SRGBColorSpace;
    return _vwLogoTexture;
}

// Car types with different visual profiles
export type CarType = 'bulli' | 'pickup' | 'sport' | 'beetle' | 'jeep';
const CAR_TYPES: CarType[] = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

export function randomCarType(): CarType {
    return CAR_TYPES[Math.floor(Math.random() * CAR_TYPES.length)];
}

// Car types with a GLB model (tools/models/models.json)
const GLTF_TYPES: ReadonlySet<string> = new Set(['bulli', 'pickup', 'sport', 'beetle', 'jeep']);

// Body footprint (width, length) of the procedural bodies for the contact shadow
const PROCEDURAL_FOOTPRINT: Record<CarType, [number, number]> = {
    bulli: [2.8, 4.0],
    pickup: [3.0, 5.0],
    sport: [2.6, 4.5],
    beetle: [2.4, 3.5],
    jeep: [3.0, 4.2]
};
const PROCEDURAL_WHEEL_RADIUS: Record<CarType, number> = { bulli: 0.65, pickup: 0.75, sport: 0.5, beetle: 0.6, jeep: 0.8 };
const PROCEDURAL_WHEELBASE: Record<CarType, number> = { bulli: 2.4, pickup: 3.2, sport: 2.8, beetle: 2.0, jeep: 2.8 };

// Drive look derived from the motion (remote cars): velocities come in 20 Hz
// steps, so they are estimated between position changes and smoothed
const MOTION_STALE_S = 0.3;
const MOTION_BLEND = 0.45;
const TELEPORT_M = 15;
const BRAKE_DECEL = 3.5;          // m/s² of deceleration that counts as braking
const BRAKE_HOLD_S = 0.25;
const BLINK_STEER = 0.14;         // rad of steering that sets the blinker
const BLINK_MAX_SPEED = 13;       // m/s: no blinking at speed
const BLINK_PERIOD_S = 0.7;

interface GhostMaterialState {
    opacity: number;
    transparent: boolean;
    depthWrite: boolean;
}

interface GhostMeshState {
    castShadow: boolean;
    receiveShadow: boolean;
}

interface CarMaterials {
    paint: THREE.MeshStandardMaterial;
    cream: THREE.MeshStandardMaterial;
    chrome: THREE.MeshStandardMaterial;
    glass: THREE.MeshStandardMaterial;
    rubber: THREE.MeshStandardMaterial;
    trim: THREE.MeshStandardMaterial;
    headlight: THREE.MeshStandardMaterial;
    taillight: THREE.MeshStandardMaterial;
}

/**
 * Materials of the procedural bodies in the realistic look of the GLB cars:
 * clearcoated paint, mirror chrome, dark tinted glass, near-black tyres.
 * The software tier (no GPU) gets plain standard materials.
 */
function createCarMaterials(colorCode: number): CarMaterials {
    const light = lightingTier() === 'software';
    const paint = (color: THREE.Color) => light
        ? new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.05 })
        : new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 });
    return {
        paint: paint(carPaintColor(colorCode)),
        cream: paint(new THREE.Color(0xD6CBB2)),
        chrome: new THREE.MeshStandardMaterial({ color: 0xE8E8EA, roughness: 0.08, metalness: 1 }),
        glass: new THREE.MeshStandardMaterial({
            color: 0x1C252C, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.62
        }),
        rubber: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.88 }),
        trim: new THREE.MeshStandardMaterial({ color: 0x1B1B1B, roughness: 0.7 }),
        headlight: new THREE.MeshStandardMaterial({
            color: 0xB8B6AE, emissive: 0xFFE3B6, emissiveIntensity: 0.25, roughness: 0.1, metalness: 0.6
        }),
        taillight: new THREE.MeshStandardMaterial({
            color: 0x6E0906, emissive: 0xFF2414, emissiveIntensity: 0.35, roughness: 0.1
        })
    };
}

function roundedBox(width: number, height: number, depth: number, radius: number): THREE.BufferGeometry {
    return new RoundedBoxGeometry(width, height, depth, 2, Math.min(radius, width / 2, height / 2, depth / 2) * 0.999);
}

const liveModels = new Set<CarModel>();
const _cameraPosition = new THREE.Vector3();
const _carPosition = new THREE.Vector3();

/**
 * Once per frame, before rendering: LOD by camera distance, wheels, lamps.
 * Cars whose drive state was not set this frame (remote players) derive it
 * from their motion.
 */
export function updateCarModels(camera: THREE.Camera | null, dt: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    const now = performance.now() / 1000;
    if (camera) camera.getWorldPosition(_cameraPosition);
    for (const model of liveModels) model.updateFrame(step, now, camera ? _cameraPosition : null);
}

/** LOD selection only, for another camera than the frame's (e2e camera override). */
export function refreshCarLods(camera: THREE.Camera): void {
    camera.getWorldPosition(_cameraPosition);
    for (const model of liveModels) model.selectLod(_cameraPosition);
}

/** The live car models (e2e hook). */
export function liveCarModels(): ReadonlySet<CarModel> {
    return liveModels;
}

export class CarModel {
    // group carries position (on the ground), yaw, the ground tilt and the
    // Mega scale; bodyGroup carries the body with its height over the
    // ground (flight, suspension) and its own pitch and roll (setBodyPose)
    readonly group: THREE.Group;
    readonly bodyGroup: THREE.Group;
    // Height of the wheels over the ground (m): the contact shadow fades
    airHeight = 0;
    // Wheels below their rest spot on the body (m, the suspension)
    private _wheelDrop = 0;
    readonly carType: CarType;
    readonly colorCode: number;
    readonly local: boolean;
    shieldMesh?: THREE.Mesh;
    // Wheel groups of a procedural body (empty with a GLB body, whose pivots
    // GltfCarBody drives)
    readonly wheels: THREE.Group[] = [];
    /** The GLB body, null while the car is procedural */
    gltf: GltfCarBody | null = null;
    private _ghostVisualOn: boolean = false;
    private _afkVisualOn: boolean = false;
    private _ghostMaterialStates = new Map<THREE.Material, GhostMaterialState>();
    private _ghostMeshStates = new Map<THREE.Mesh, GhostMeshState>();
    private _afkColors = new Map<THREE.MeshStandardMaterial, number>();
    private _ownedGeometries = new Set<THREE.BufferGeometry>();
    private _ownedMaterials = new Set<THREE.Material>();
    private _ownedTextures = new Set<THREE.Texture>();
    private _body: THREE.Object3D[] = [];
    private _taillight: THREE.MeshStandardMaterial | null = null;
    private _disposed = false;
    // Drive look: set per frame by the simulation (setDriveState) or derived
    private _driveSet = false;
    private _speed = 0;
    private _steer = 0;
    private _braking = false;
    private _brakeLight = 0;
    private _brakeHold = 0;
    private _blinkClock = 0;
    private _lastX = NaN;
    private _lastZ = NaN;
    private _lastYaw = 0;
    private _lastMoveAt = 0;
    private _velocity = 0;
    private _yawRate = 0;
    private _prevSpeed = 0;

    /**
     * `local`: the player's own car. The other cars are drawn cheaper on the
     * phone tier (GltfCarBody PHONE_REMOTE_LOD_DISTANCES).
     */
    constructor(colorCode: number, carType: CarType, options: { local?: boolean } = {}) {
        this.local = options.local ?? false;
        this.group = new THREE.Group();
        this.bodyGroup = new THREE.Group();
        this.group.add(this.bodyGroup);
        this.colorCode = colorCode;
        this.carType = carType;

        if (GLTF_TYPES.has(carType) && GltfCarBody.available(carType)) {
            this.buildGltf();
        } else {
            this.buildCar();
            // Models still loading (the splash screen preload): swap in the GLB body once it is there
            // (after the warm-up, so the swap does not compile shaders mid-frame)
            if (GLTF_TYPES.has(carType) && (models.status === 'loading' || models.status === 'idle')) {
                whenModelsReady().then(() => this.upgradeToGltf(), () => { /* stays procedural */ });
            }
        }
        liveModels.add(this);
    }

    // How transparent the ghost look is: the Ghost powerup nearly
    // invisible, the time trial's ghost car clearer (race/GhostCar.ts)
    ghostOpacity = { scale: 0.2, max: 0.12 };

    get ghostVisualOn(): boolean {
        return this._ghostVisualOn;
    }

    /** Width and length of the body for the contact shadow (unscaled by Mega) */
    get footprint(): [number, number] {
        if (this.gltf) return [this.gltf.size.x, this.gltf.size.z * 0.92];
        return PROCEDURAL_FOOTPRINT[this.carType] ?? [2.8, 4.2];
    }

    /** Height of the nametag above the car's origin */
    get nametagHeight(): number {
        return this.gltf ? this.gltf.nametagHeight + 0.35 : 4;
    }

    private get wheelRadius(): number {
        return this.gltf?.wheelRadius ?? PROCEDURAL_WHEEL_RADIUS[this.carType] ?? 0.6;
    }

    private get wheelbase(): number {
        return (this.gltf ? this.gltf.wheelbase : PROCEDURAL_WHEELBASE[this.carType]) ?? 2.4;
    }

    /**
     * The body's pose of this frame (vehicle/bodyMotion.ts): the ground
     * tilt on the group, height, pitch and roll on the body, the wheels on
     * the ground. scale: the Mega scale of the group.
     */
    setBodyPose(motion: BodyMotion, scale: number): void {
        const s = scale > 0 ? scale : 1;
        this.group.rotation.order = 'YXZ';
        this.group.rotation.x = motion.groundPitch;
        this.group.rotation.z = motion.groundRoll;
        this.bodyGroup.position.y = motion.bodyY / s;
        this.bodyGroup.rotation.x = motion.bodyPitch;
        this.bodyGroup.rotation.z = motion.bodyRoll;
        this._wheelDrop = motion.wheelDrop / s;
        this.airHeight = motion.airHeight;
    }

    /**
     * The drive state of this frame from the simulation: forward speed
     * (m/s), road wheel angle (rad, + = left) and whether the brake is on.
     * Cars without it (remote players) derive it from their motion.
     */
    setDriveState(speed: number, steerAngle: number, braking: boolean): void {
        this._driveSet = true;
        this._speed = speed;
        this._steer = steerAngle;
        this._braking = braking;
    }

    setGhostVisual(active: boolean) {
        if (active === this._ghostVisualOn) return;
        this._ghostVisualOn = active;
        this.applyGhost(active);
    }

    private applyGhost(active: boolean): void {
        if (active) {
            this.bodyGroup.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh || mesh === this.shieldMesh) return;

                if (!this._ghostMeshStates.has(mesh)) {
                    this._ghostMeshStates.set(mesh, {
                        castShadow: mesh.castShadow,
                        receiveShadow: mesh.receiveShadow
                    });
                }
                mesh.castShadow = false;
                mesh.receiveShadow = false;

                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach((mat) => {
                    if (!this._ghostMaterialStates.has(mat)) {
                        this._ghostMaterialStates.set(mat, {
                            opacity: mat.opacity,
                            transparent: mat.transparent,
                            depthWrite: mat.depthWrite
                        });
                        mat.transparent = true;
                        // Transparent vehicle parts must not occlude one another
                        // through the depth buffer. That was the source of the
                        // angle-dependent "half a Bulli" artifact.
                        mat.depthWrite = false;
                        mat.opacity = Math.min(this.ghostOpacity.max, mat.opacity * this.ghostOpacity.scale);
                        mat.needsUpdate = true;
                    }
                });
            });
        } else {
            this._ghostMaterialStates.forEach((original, mat) => {
                mat.opacity = original.opacity;
                mat.transparent = original.transparent;
                mat.depthWrite = original.depthWrite;
                mat.needsUpdate = true;
            });
            this._ghostMaterialStates.clear();

            this._ghostMeshStates.forEach((original, mesh) => {
                mesh.castShadow = original.castShadow;
                mesh.receiveShadow = original.receiveShadow;
            });
            this._ghostMeshStates.clear();
        }
    }

    /** AFK players: the whole car greyed out (the materials are this car's own). */
    setAfkVisual(active: boolean): void {
        if (active === this._afkVisualOn) return;
        this._afkVisualOn = active;
        this.applyAfk(active);
    }

    private applyAfk(active: boolean): void {
        if (active) {
            const shieldMaterial = this.shieldMesh?.material;
            for (const material of this.bodyMaterials()) {
                const standard = material as THREE.MeshStandardMaterial;
                if (material === shieldMaterial || !standard.color || this._afkColors.has(standard)) continue;
                this._afkColors.set(standard, standard.color.getHex());
                standard.color.setHex(0x888888);
            }
        } else {
            this._afkColors.forEach((hex, material) => material.color.setHex(hex));
            this._afkColors.clear();
        }
    }

    private bodyMaterials(): Iterable<THREE.Material> {
        return this.gltf ? this.gltf.materials : this._ownedMaterials;
    }

    /** Per frame (updateCarModels): drive look, LOD, wheels, lamps. */
    updateFrame(dt: number, now: number, cameraPosition: THREE.Vector3 | null): void {
        if (this._disposed || !this.bodyGroup.visible) {
            this._driveSet = false;
            return;
        }
        if (!this._driveSet) this.deriveDriveState(dt, now);
        this._driveSet = false;
        const speed = this._speed;
        const steer = this._steer;

        // Brake lights: on at once, off after a short hold (no flicker)
        if (this._braking) this._brakeHold = BRAKE_HOLD_S;
        else this._brakeHold = Math.max(0, this._brakeHold - dt);
        const brakeTarget = this._brakeHold > 0 ? 1 : 0;
        this._brakeLight += (brakeTarget - this._brakeLight) * Math.min(1, dt * (brakeTarget > this._brakeLight ? 40 : 12));

        // Blinkers while turning at city speed
        let blinkLeft = 0, blinkRight = 0;
        if (Math.abs(steer) > BLINK_STEER && Math.abs(speed) < BLINK_MAX_SPEED) {
            this._blinkClock += dt;
            const on = (this._blinkClock % BLINK_PERIOD_S) < BLINK_PERIOD_S * 0.5 ? 1 : 0;
            if (steer > 0) blinkLeft = on;
            else blinkRight = on;
        } else {
            this._blinkClock = 0;
        }

        const rolled = speed * dt;
        const gltf = this.gltf;
        if (gltf) {
            if (cameraPosition) this.selectLod(cameraPosition);
            gltf.roll(rolled, steer);
            gltf.setWheelDrop(this._wheelDrop);
            gltf.applyWheels();
            gltf.setLamps(this._brakeLight, blinkLeft, blinkRight, this.bodyGroup);
        } else {
            const spin = rolled / this.wheelRadius;
            for (let i = 0; i < this.wheels.length; i++) {
                const wheel = this.wheels[i];
                wheel.rotation.order = 'YXZ';
                wheel.rotation.x = (wheel.rotation.x + spin) % (Math.PI * 2);
                if (i < 2) wheel.rotation.y = steer;
                wheel.position.y = this.wheelRadius - this._wheelDrop;
            }
            if (this._taillight) this._taillight.emissiveIntensity = 0.35 + this._brakeLight * 2.6;
        }
    }

    /** Shows the GLB LOD for a camera at `cameraPosition` (Mega cars count as closer). */
    selectLod(cameraPosition: THREE.Vector3): void {
        if (!this.gltf) return;
        this.group.getWorldPosition(_carPosition);
        this.gltf.selectLod(_carPosition.distanceTo(cameraPosition) / Math.max(0.1, this.group.scale.x));
    }

    // Speed, steering and braking from the motion of the group (20 Hz updates)
    private deriveDriveState(dt: number, now: number): void {
        const x = this.group.position.x;
        const z = this.group.position.z;
        const yaw = this.group.rotation.y;
        if (Number.isNaN(this._lastX)) {
            this._lastX = x;
            this._lastZ = z;
            this._lastYaw = yaw;
            this._lastMoveAt = now;
            return;
        }
        const dx = x - this._lastX;
        const dz = z - this._lastZ;
        if (dx !== 0 || dz !== 0 || yaw !== this._lastYaw) {
            const gap = Math.max(0.03, now - this._lastMoveAt);
            if (Math.hypot(dx, dz) > TELEPORT_M) {
                this._velocity = 0;
                this._yawRate = 0;
            } else {
                const forward = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / gap;
                const turn = Math.atan2(Math.sin(yaw - this._lastYaw), Math.cos(yaw - this._lastYaw)) / gap;
                this._velocity += (forward - this._velocity) * MOTION_BLEND;
                this._yawRate += (turn - this._yawRate) * MOTION_BLEND;
            }
            this._lastX = x;
            this._lastZ = z;
            this._lastYaw = yaw;
            this._lastMoveAt = now;
        } else if (now - this._lastMoveAt > MOTION_STALE_S) {
            this._velocity *= Math.max(0, 1 - dt * 6);
            this._yawRate *= Math.max(0, 1 - dt * 6);
        }
        const speed = this._velocity;
        const steer = Math.abs(speed) > 0.5
            ? Math.atan(this.wheelbase * this._yawRate / speed)
            : 0;
        const decel = dt > 0 ? (Math.abs(this._prevSpeed) - Math.abs(speed)) / dt : 0;
        this._prevSpeed = speed;
        this._speed = speed;
        this._steer = Math.max(-0.55, Math.min(0.55, steer));
        this._braking = Math.abs(speed) > 1.5 && decel > BRAKE_DECEL;
    }

    // ---- GLB body ----
    private buildGltf(): void {
        const phoneRemote = !this.local && lightingTier() === 'mobile';
        const options: GltfCarBodyOptions = phoneRemote
            ? { minLod: 1, lodDistances: PHONE_REMOTE_LOD_DISTANCES, castShadow: false }
            : {};
        const body = new GltfCarBody(this.carType, this.colorCode, options);
        this.gltf = body;
        this.bodyGroup.add(body.root);
        this._body = [body.root];
        this.addShield(body.size);
    }

    /** Replaces the procedural body with the GLB body once the models are loaded. */
    upgradeToGltf(): boolean {
        if (this._disposed || this.gltf || !GLTF_TYPES.has(this.carType) || !GltfCarBody.available(this.carType)) return false;
        const ghost = this._ghostVisualOn;
        const afk = this._afkVisualOn;
        if (ghost) this.applyGhost(false);
        if (afk) this.applyAfk(false);
        const shieldVisible = this.shieldMesh?.visible ?? false;
        const shieldMaterial = this.shieldMesh?.material as THREE.MeshStandardMaterial | undefined;
        const shieldLook = shieldMaterial ? { opacity: shieldMaterial.opacity, emissive: shieldMaterial.emissiveIntensity } : null;
        for (const object of this._body) object.removeFromParent();
        if (this.shieldMesh) this.shieldMesh.removeFromParent();
        this.disposeOwned();
        this.wheels.length = 0;
        this._taillight = null;
        this.buildGltf();
        if (this.shieldMesh && shieldLook) {
            const material = this.shieldMesh.material as THREE.MeshStandardMaterial;
            material.opacity = shieldLook.opacity;
            material.emissiveIntensity = shieldLook.emissive;
            this.shieldMesh.visible = shieldVisible;
        }
        if (ghost) this.applyGhost(true);
        if (afk) this.applyAfk(true);
        return true;
    }

    // ---- procedural bodies ----
    buildCar() {
        const m = createCarMaterials(this.colorCode);
        this._taillight = m.taillight;
        const before = new Set(this.bodyGroup.children);

        switch (this.carType) {
            case 'pickup': this.buildPickup(m); break;
            case 'sport': this.buildSport(m); break;
            case 'beetle': this.buildBeetle(m); break;
            case 'jeep': this.buildJeep(m); break;
            default: this.buildBulli(m); break;
        }
        this._body = this.bodyGroup.children.filter(child => !before.has(child));
        for (const object of this._body) this.own(object);
        this.addShield(null);
    }

    private own(object: THREE.Object3D): void {
        object.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            this._ownedGeometries.add(mesh.geometry);
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const material of materials) {
                this._ownedMaterials.add(material);
                for (const value of Object.values(material)) {
                    const texture = value as THREE.Texture;
                    if (texture?.isTexture && texture !== _vwLogoTexture) this._ownedTextures.add(texture);
                }
            }
        });
    }

    // Shield bubble (hidden by default): a sphere over the procedural cars,
    // an ellipsoid hugging the GLB body
    private addShield(size: THREE.Vector3 | null): void {
        const shieldGeo = new THREE.SphereGeometry(size ? 1 : 3.5, 24, 16);
        const shieldMat = new THREE.MeshStandardMaterial({
            color: 0x00BFFF,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            emissive: 0x00BFFF,
            emissiveIntensity: 0,
            side: THREE.DoubleSide
        });
        this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
        if (size) {
            this.shieldMesh.scale.set(size.x / 2 + 0.7, size.y / 2 + 0.55, size.z / 2 + 0.6);
            this.shieldMesh.position.y = size.y * 0.45;
        } else {
            this.shieldMesh.position.y = 1.5;
        }
        this.shieldMesh.name = 'shield';
        // An opacity-zero mesh still writes depth unless disabled above. Keep it
        // out of the render list entirely until a shield effect needs it.
        this.shieldMesh.visible = false;
        this.bodyGroup.add(this.shieldMesh);
        this._ownedGeometries.add(shieldGeo);
        this._ownedMaterials.add(shieldMat);
    }

    private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, shadow = true): THREE.Mesh {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = shadow;
        mesh.receiveShadow = shadow;
        this.bodyGroup.add(mesh);
        return mesh;
    }

    // ---- VW BULLI (fallback while the GLB loads or when it fails) ----
    buildBulli(m: CarMaterials) {
        const width = 2.8, length = 4.0, heightLower = 1.4, heightUpper = 1.2;
        const chassisY = 0.8;

        const lowerBody = this.mesh(roundedBox(width, heightLower, length, 0.25), m.paint);
        lowerBody.position.y = chassisY + heightLower / 2;
        const upperBody = this.mesh(roundedBox(width - 0.1, heightUpper, length - 0.2, 0.3), m.cream);
        upperBody.position.y = chassisY + heightLower + heightUpper / 2;

        const windshieldW = width - 0.6, windshieldH = 0.8;
        const windshield = this.mesh(new THREE.PlaneGeometry(windshieldW, windshieldH), m.glass, false);
        windshield.position.set(0, upperBody.position.y, length / 2 - 0.08);
        windshield.rotation.x = -Math.PI / 12;

        const sideWinGeo = new THREE.PlaneGeometry(length * 0.35, windshieldH * 0.85);
        for (const s of [-1, 1]) {
            const sideWin = this.mesh(sideWinGeo, m.glass, false);
            sideWin.position.set(s * (width / 2 - 0.04), upperBody.position.y, length * 0.1);
            sideWin.rotation.y = s * Math.PI / 2;
        }
        const rearWin = this.mesh(new THREE.PlaneGeometry(windshieldW * 0.7, windshieldH * 0.7), m.glass, false);
        rearWin.position.set(0, upperBody.position.y, -(length - 0.2) / 2 - 0.02);
        rearWin.rotation.y = Math.PI;

        this.addVWLogo(lowerBody.position.y + 0.3, length / 2 + 0.03, 0.5);
        this.addLights(width, lowerBody.position.y, length, m);
        this.addBumpers(width, length, m);
        this.addWheels(width, 0.65, 0.4, 1.2, m);
    }

    // ---- PICKUP TRUCK ----
    buildPickup(m: CarMaterials) {
        const width = 3.0, length = 5.0, cabHeight = 1.8, bedHeight = 0.8;
        const chassisY = 1.0;

        const cab = this.mesh(roundedBox(width, cabHeight, length * 0.4, 0.22), m.paint);
        cab.position.set(0, chassisY + cabHeight / 2, length * 0.2);

        const bedFloor = this.mesh(new THREE.BoxGeometry(width, 0.3, length * 0.5), m.paint);
        bedFloor.position.set(0, chassisY + 0.15, -length * 0.15);

        const sideGeo = roundedBox(0.15, bedHeight, length * 0.5, 0.05);
        for (const s of [-1, 1]) {
            const side = this.mesh(sideGeo, m.paint);
            side.position.set(s * (width / 2 - 0.075), chassisY + bedHeight / 2, -length * 0.15);
        }
        const tailgate = this.mesh(roundedBox(width, bedHeight, 0.15, 0.05), m.paint);
        tailgate.position.set(0, chassisY + bedHeight / 2, -length * 0.4 - 0.075);

        const windshield = this.mesh(new THREE.PlaneGeometry(width - 0.6, 1.0), m.glass, false);
        windshield.position.set(0, cab.position.y + 0.2, length * 0.4 + 0.02);
        windshield.rotation.x = -Math.PI / 10;

        this.addLights(width, chassisY + cabHeight * 0.3, length * 0.8, m);
        this.addBumpers(width, length * 0.8, m);
        this.addWheels(width, 0.75, 0.5, 1.6, m);
    }

    // ---- SPORTS CAR ----
    buildSport(m: CarMaterials) {
        const width = 2.6, length = 4.5, bodyHeight = 0.9;
        const chassisY = 0.5;

        const body = this.mesh(roundedBox(width, bodyHeight, length, 0.3), m.paint);
        body.position.y = chassisY + bodyHeight / 2;

        const cabin = this.mesh(roundedBox(width - 0.4, 0.7, length * 0.35, 0.28), m.paint);
        cabin.position.set(0, chassisY + bodyHeight + 0.35, -length * 0.05);

        const windshield = this.mesh(new THREE.PlaneGeometry(width - 0.8, 0.8), m.glass, false);
        windshield.position.set(0, cabin.position.y + 0.1, cabin.position.z + length * 0.175 + 0.02);
        windshield.rotation.x = -Math.PI / 6;

        const rearWin = this.mesh(new THREE.PlaneGeometry(width - 1.0, 0.5), m.glass, false);
        rearWin.position.set(0, cabin.position.y, cabin.position.z - length * 0.175 - 0.02);
        rearWin.rotation.y = Math.PI;
        rearWin.rotation.x = Math.PI / 8;

        // Ducktail spoiler in body colour on two chrome posts
        const spoilerWing = this.mesh(roundedBox(width + 0.2, 0.08, 0.6, 0.03), m.paint);
        spoilerWing.position.set(0, chassisY + bodyHeight + 0.8, -length / 2 + 0.3);
        const postGeo = new THREE.BoxGeometry(0.1, 0.4, 0.1);
        for (const s of [-1, 1]) {
            const post = this.mesh(postGeo, m.chrome, false);
            post.position.set(s * (width / 2 - 0.3), chassisY + bodyHeight + 0.6, -length / 2 + 0.3);
        }

        this.addLights(width, chassisY + bodyHeight * 0.4, length, m);
        this.addBumpers(width, length, m);
        this.addWheels(width, 0.5, 0.45, 1.4, m);
    }

    // ---- VW BEETLE ----
    buildBeetle(m: CarMaterials) {
        const width = 2.4, length = 3.5, bodyHeight = 1.2;
        const chassisY = 0.7;

        const body = this.mesh(roundedBox(width, bodyHeight, length, 0.4), m.paint);
        body.position.y = chassisY + bodyHeight / 2;

        const roof = this.mesh(new THREE.SphereGeometry(1.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.paint);
        roof.position.set(0, chassisY + bodyHeight, 0);
        roof.scale.set(1, 0.7, 1.1);

        const windshield = this.mesh(new THREE.PlaneGeometry(width - 0.8, 0.9), m.glass, false);
        windshield.position.set(0, chassisY + bodyHeight + 0.3, length * 0.3);
        windshield.rotation.x = -Math.PI / 7;

        const rearWin = this.mesh(new THREE.CircleGeometry(0.7, 20), m.glass, false);
        rearWin.position.set(0, chassisY + bodyHeight + 0.2, -length * 0.3);
        rearWin.rotation.y = Math.PI;

        this.addVWLogo(chassisY + bodyHeight * 0.5, length / 2 + 0.03, 0.4);
        this.addLights(width, chassisY + bodyHeight * 0.3, length, m);
        this.addBumpers(width, length, m);
        this.addWheels(width, 0.6, 0.35, 1.0, m);
    }

    // ---- VW TYP 181 / OFF-ROAD ----
    buildJeep(m: CarMaterials) {
        const width = 3.0, length = 4.2, bodyHeight = 1.5;
        const chassisY = 1.1;

        const body = this.mesh(roundedBox(width, bodyHeight, length, 0.12), m.paint);
        body.position.y = chassisY + bodyHeight / 2;

        const roof = this.mesh(roundedBox(width + 0.2, 0.15, length + 0.2, 0.06), m.trim);
        roof.position.y = chassisY + bodyHeight + 0.075;

        const barGeo = new THREE.CylinderGeometry(0.04, 0.04, width + 0.4, 8);
        barGeo.rotateZ(Math.PI / 2);
        for (let i = -1; i <= 1; i++) {
            const bar = this.mesh(barGeo, m.chrome, false);
            bar.position.set(0, chassisY + bodyHeight + 0.25, i * length * 0.3);
        }
        const sideBarGeo = new THREE.CylinderGeometry(0.04, 0.04, length + 0.4, 8);
        sideBarGeo.rotateX(Math.PI / 2);
        for (const side of [-1, 1]) {
            const sideBar = this.mesh(sideBarGeo, m.chrome, false);
            sideBar.position.set(side * (width / 2 + 0.15), chassisY + bodyHeight + 0.25, 0);
        }

        const windshield = this.mesh(new THREE.PlaneGeometry(width - 0.4, 1.0), m.glass, false);
        windshield.position.set(0, chassisY + bodyHeight * 0.7, length / 2 + 0.02);
        windshield.rotation.x = -Math.PI / 20;

        const spareTire = this.mesh(new THREE.TorusGeometry(0.62, 0.26, 12, 24), m.rubber);
        spareTire.position.set(0, chassisY + bodyHeight * 0.5, -length / 2 - 0.3);

        this.addLights(width, chassisY + bodyHeight * 0.3, length, m);
        this.addBumpers(width, length, m);
        this.addWheels(width, 0.8, 0.55, 1.4, m);
    }

    // ---- SHARED HELPERS ----
    addVWLogo(logoY: number, logoZ: number, radius: number) {
        const logoMat = new THREE.MeshStandardMaterial({
            map: createVWLogoTexture(),
            transparent: true,
            roughness: 0.15,
            metalness: 0.7
        });
        const logo = this.mesh(new THREE.CircleGeometry(radius, 32), logoMat, false);
        logo.position.set(0, logoY, logoZ);
    }

    addLights(width: number, bodyY: number, length: number, m: CarMaterials) {
        // Flat lenses in chrome rings (no "eyes", user decision)
        const headlightGeo = new THREE.SphereGeometry(0.17, 20, 10);
        const ringGeo = new THREE.TorusGeometry(0.18, 0.03, 8, 24);
        for (const s of [-1, 1]) {
            const lamp = this.mesh(headlightGeo, m.headlight, false);
            lamp.position.set(s * (width / 2 - 0.34), bodyY - 0.2, length / 2);
            lamp.scale.z = 0.3;
            const ring = this.mesh(ringGeo, m.chrome, false);
            ring.position.set(s * (width / 2 - 0.34), bodyY - 0.2, length / 2 + 0.02);
        }
        const taillightGeo = roundedBox(0.36, 0.26, 0.1, 0.04);
        for (const s of [-1, 1]) {
            const tail = this.mesh(taillightGeo, m.taillight, false);
            tail.position.set(s * (width / 2 - 0.3), bodyY - 0.1, -length / 2 - 0.05);
        }
    }

    addBumpers(width: number, length: number, m: CarMaterials) {
        const bumperGeo = new THREE.CylinderGeometry(0.13, 0.13, width + 0.2, 16);
        bumperGeo.rotateZ(Math.PI / 2);
        for (const s of [-1, 1]) {
            const bumper = this.mesh(bumperGeo, m.chrome);
            bumper.position.set(0, 0.5, s * (length / 2 + 0.2));
        }
    }

    addWheels(width: number, wheelRadius: number, wheelWidth: number, wheelZ: number, m: CarMaterials) {
        this.wheels.length = 0;
        const tireGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 32);
        tireGeo.rotateZ(Math.PI / 2);
        const capGeo = new THREE.CylinderGeometry(wheelRadius * 0.5, wheelRadius * 0.55, wheelWidth + 0.04, 20);
        capGeo.rotateZ(Math.PI / 2);

        const wheelGroup = new THREE.Group();
        const tire = new THREE.Mesh(tireGeo, m.rubber);
        tire.castShadow = true;
        const cap = new THREE.Mesh(capGeo, m.chrome);
        wheelGroup.add(tire, cap);

        const wheelX = width / 2 - 0.2;
        const positions = [
            { x: -wheelX, z: wheelZ },
            { x: wheelX, z: wheelZ },
            { x: -wheelX, z: -wheelZ },
            { x: wheelX, z: -wheelZ }
        ];
        positions.forEach(p => {
            const w = wheelGroup.clone();
            w.position.set(p.x, wheelRadius, p.z);
            this.bodyGroup.add(w);
            this.wheels.push(w);
        });
    }

    private disposeOwned(): void {
        for (const geometry of this._ownedGeometries) geometry.dispose();
        for (const material of this._ownedMaterials) material.dispose();
        for (const texture of this._ownedTextures) texture.dispose();
        this._ownedGeometries.clear();
        this._ownedMaterials.clear();
        this._ownedTextures.clear();
        this._ghostMaterialStates.clear();
        this._ghostMeshStates.clear();
        this._afkColors.clear();
        this.gltf?.dispose();
        this.gltf = null;
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        liveModels.delete(this);
        this.disposeOwned();
        this.wheels.length = 0;
        this.group.clear();
    }
}
