import * as THREE from 'three';
import { state } from '../state.js';
import { playHonkSound, playShootSound } from '../effects/sounds.js';
import { createProjectile } from '../world/projectiles.js';
import { sendToServer } from '../network/socket.js';
import { CarModel, randomCarType, type CarType } from '../vehicle/CarModel.js';
import { Nametag } from '../vehicle/Nametag.js';
import type { BodyMotion } from '../vehicle/bodyMotion.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';
import { driveLocalCar } from '../vehicle/v2Driver.js';
import { partyRulesActive } from '../ui/roomMenu.js';

// Muzzle distance for mega shots - just past the enlarged nose.
const MEGA_PROJECTILE_FRONT_OFFSET = 6.5;


export { randomCarType, type CarType };

export class Bulli {
    // The three.js model; group, bodyGroup, wheels and shieldMesh are its
    // objects, kept here for the code that reaches into the car
    readonly model: CarModel;
    group: THREE.Group;
    bodyGroup: THREE.Group;
    isLocal: boolean;
    colorCode: number;
    carType: CarType;
    name: string = "Unknown";
    pitchOffset: number;
    // Adapter fields for HUD, sound and particles (LocalVehicle writes them):
    // speeds in m per 1/60 s tick, like before the v2 physics
    speed: number = 0;
    angle: number = 0;
    maxSpeed: number = 50 / 60;
    canRecover: boolean = false;
    nextHonkTime: number = 0;
    lastShootTime: number = 0;
    powerups = {
        speed: { active: false, timer: 0 },
        size: { active: false, timer: 0 },
        shield: { active: false, timer: 0 },
        magnet: { active: false, timer: 0 },
        ghost: { active: false, timer: 0 }
    };
    health: number = 100;
    // The sim car; only the local car gets one
    vehicle?: LocalVehicle;
    wheels: THREE.Group[];
    // Remote cars only. nametag/healthBarFill are the tag's elements, kept
    // for the code that restyles them (AFK badge, rename)
    private tag?: Nametag;
    nametag?: HTMLDivElement;
    healthBarFill?: HTMLDivElement;
    private _disposed = false;


    constructor(colorCode = 0xD32F2F, isLocal = false, carType?: CarType) {
        this.isLocal = isLocal;
        this.colorCode = colorCode;
        this.carType = carType || randomCarType();
        this.pitchOffset = 0.8 + Math.random() * 0.7;

        this.model = new CarModel(colorCode, this.carType, { local: isLocal });
        this.group = this.model.group;
        this.bodyGroup = this.model.bodyGroup;
        this.wheels = this.model.wheels;
    }

    // The model swaps its procedural body (and shield) for the GLB once the
    // models are loaded, so this always asks the model
    get shieldMesh(): THREE.Mesh | undefined {
        return this.model.shieldMesh;
    }

    /** Ground tilt, body height, pitch, roll and wheels of this frame (vehicle/bodyMotion.ts). */
    setBodyPose(motion: BodyMotion, scale: number): void {
        this.model.setBodyPose(motion, scale);
    }

    /** Height of the wheels over the ground on screen (m): the contact shadow fades. */
    get airHeight(): number {
        return this.model.airHeight;
    }

    /** Drive look of this frame from the v2 sim (wheels, brake lights, blinkers). */
    setDriveState(speed: number, steerAngle: number, braking: boolean): void {
        this.model.setDriveState(speed, steerAngle, braking);
    }

    /** AFK players are shown greyed out. */
    setAfkVisual(active: boolean): void {
        this.model.setAfkVisual(active);
    }

    /** Contact shadow size (render/lighting.ts) */
    get footprint(): [number, number] {
        return this.model.footprint;
    }

    createNametag(name: string, isLocal: boolean) {
        this.name = name;
        // The local player is already anchored by the chase camera and HUD;
        // hiding its duplicate label keeps the road and vehicle unobstructed.
        if (isLocal) return;

        this.tag = new Nametag(name);
        this.nametag = this.tag.element;
        this.healthBarFill = this.tag.healthBarFill;
    }

    updateHealthBar() {
        this.tag?.updateHealth(this.health);
    }

    setGhostVisual(active: boolean) {
        if (active === this.model.ghostVisualOn) return;
        this.model.setGhostVisual(active);
        if (active) this.tag?.hide();
        // nametag display restored by updateNametag
    }

    updateNametag() {
        if (!this.tag || !state.camera) return;
        if (this.powerups.ghost.active) {
            this.tag.hide();
            return;
        }
        this.tag.update(this.group.position, state.camera, this.model.nametagHeight * this.group.scale.y);
    }

    honk(): number {
        return playHonkSound(this.pitchOffset);
    }

    shoot() {
        const now = Date.now();
        if (now - this.lastShootTime < 500) return;
        this.lastShootTime = now;

        playShootSound();

        const megaActive = this.powerups.size.active;
        // Fire from the front of the car, at the body's height (also in the air)
        const frontOffset = megaActive ? MEGA_PROJECTILE_FRONT_OFFSET : 3.5;
        const startX = this.group.position.x + Math.sin(this.angle) * frontOffset;
        const startZ = this.group.position.z + Math.cos(this.angle) * frontOffset;
        const startY = this.group.position.y + this.bodyGroup.position.y;

        createProjectile(startX, startY, startZ, this.angle, this.colorCode, state.myId || '', megaActive);
    }

    // Honk (F) and shoot (E) pulses from keyboard, touch and gamepad
    handleActions() {
        if (state.dead || state.isModalOpen) {
            state.inputs.e = state.inputs.f = false;
            return;
        }
        if (state.inputs.f) {
            const now = Date.now();
            if (now >= this.nextHonkTime) {
                const duration = this.honk();
                this.nextHonkTime = now + (duration * 1000) + 500;

                sendToServer({ type: 'honk' });
            }
            state.inputs.f = false;
        }

        if (state.inputs.e) {
            // No shooting in Free Roam
            if (partyRulesActive()) this.shoot();
            state.inputs.e = false;
        }
    }

    // Once per frame. The powerup flags come from the local car's sim
    // (offline), the server's windows (online, own car) or the snapshot
    // flags (remote cars); this only shows them.
    update(dt: number) {
        this.updateNametag();

        // Shield bubble: the powerup, and for the local car the respawn shield
        if (this.shieldMesh) {
            const respawnShield = this.isLocal && state.respawnShield;
            if (this.powerups.shield.active || respawnShield) {
                this.shieldMesh.visible = true;
                const shieldMat = this.shieldMesh.material as THREE.MeshStandardMaterial;
                shieldMat.opacity = 0.25 + Math.sin(Date.now() * 0.005) * 0.1;
                shieldMat.emissiveIntensity = 0.4 + Math.sin(Date.now() * 0.008) * 0.2;
                this.shieldMesh.rotation.y += dt * 2;
            } else {
                this.shieldMesh.visible = false;
            }
        }

        // Ghost transparency: apply/remove exactly once on state change instead
        // of re-traversing every frame (setGhostVisual is idempotent).
        if (this.powerups.ghost.active !== this.model.ghostVisualOn) {
            this.setGhostVisual(this.powerups.ghost.active);
        }

        if (this.isLocal) driveLocalCar(this, dt);
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;

        this.tag?.remove();
        this.tag = undefined;
        this.nametag = undefined;
        this.healthBarFill = undefined;
        this.model.dispose();
    }
}
