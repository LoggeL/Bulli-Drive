import * as THREE from 'three';
import { state } from '../state.js';
import { playHonkSound, playShootSound } from '../effects/sounds.js';
import { createProjectile } from '../world/projectiles.js';
import { LEGACY_CAR_MAX_SPEED, UPDATE_SEND_INTERVAL_MS } from '../../shared/constants.js';
import { sendToServer } from '../network/socket.js';
import { CarModel, randomCarType, type CarType } from '../vehicle/CarModel.js';
import { Nametag } from '../vehicle/Nametag.js';
import { createLegacyPhysicsState, updateLegacyMovement, type LegacyPhysicsState } from '../vehicle/legacyPhysics.js';
import type { LocalVehicle } from '../vehicle/LocalVehicle.js';
import { driveLocalCar } from '../vehicle/v2Driver.js';
import { PHYSICS_V2 } from '../flags.js';

// Muzzle distance for mega shots - just past the enlarged nose.
const MEGA_PROJECTILE_FRONT_OFFSET = 6.5;
const STATIONARY_UPDATE_INTERVAL_MS = 1000;
const POWERUP_KEYS = ['speed', 'size', 'jump', 'shield', 'magnet', 'ghost'] as const;


export { randomCarType, type CarType };

export class Bulli {
    // The three.js model; group, flipGroup, wheels and shieldMesh are its
    // objects, kept here for the code that reaches into the car
    readonly model: CarModel;
    group: THREE.Group;
    flipGroup: THREE.Group;
    isLocal: boolean;
    colorCode: number;
    carType: CarType;
    name: string = "Unknown";
    pitchOffset: number;
    speed: number = 0;
    angle: number = 0;
    acceleration: number = 0.015;
    maxSpeed: number = LEGACY_CAR_MAX_SPEED;
    friction: number = 0.96;
    isFlipping: boolean = false;
    canRecover: boolean = false;
    flipVelocity: number = 0;
    nextHonkTime: number = 0;
    lastShootTime: number = 0;
    powerups = {
        speed: { active: false, timer: 0 },
        size: { active: false, timer: 0 },
        jump: { active: false, timer: 0 },
        shield: { active: false, timer: 0 },
        magnet: { active: false, timer: 0 },
        ghost: { active: false, timer: 0 }
    };
    health: number = 100;
    // State of the legacy physics (vehicle/legacyPhysics.ts)
    readonly legacy: LegacyPhysicsState = createLegacyPhysicsState();
    // The v2 sim car; only the local car gets one (none with ?physics=legacy)
    vehicle?: LocalVehicle;
    wheels: THREE.Group[];
    // Remote cars only. nametag/healthBarFill are the tag's elements, kept
    // for the code that restyles them (AFK badge, rename)
    private tag?: Nametag;
    nametag?: HTMLDivElement;
    healthBarFill?: HTMLDivElement;
    private _disposed = false;
    private _hasSentUpdate = false;
    private _lastUpdateSentAt = -Infinity;
    private _lastSentMoving = false;
    private _lastSentIsFlipping = false;
    private _lastSentGhostActive = false;
    private _lastSentShieldActive = false;
    private _lastSentMegaActive = false;


    constructor(colorCode = 0xD32F2F, isLocal = false, carType?: CarType) {
        this.isLocal = isLocal;
        this.colorCode = colorCode;
        this.carType = carType || randomCarType();
        this.pitchOffset = 0.8 + Math.random() * 0.7;

        this.model = new CarModel(colorCode, this.carType);
        this.group = this.model.group;
        this.flipGroup = this.model.flipGroup;
        this.wheels = this.model.wheels;
    }

    // The model swaps its procedural body (and shield) for the GLB once the
    // models are loaded, so this always asks the model
    get shieldMesh(): THREE.Mesh | undefined {
        return this.model.shieldMesh;
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
        // Fire from the front of the car (account for jump height)
        const frontOffset = megaActive ? MEGA_PROJECTILE_FRONT_OFFSET : 3.5;
        const startX = this.group.position.x + Math.sin(this.angle) * frontOffset;
        const startZ = this.group.position.z + Math.cos(this.angle) * frontOffset;
        const startY = this.group.position.y + this.flipGroup.position.y;

        createProjectile(startX, startY, startZ, this.angle, this.colorCode, state.myId || '', megaActive);
    }

    // Honk (F) and shoot (E) pulses from keyboard, touch and gamepad
    handleActions() {
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
            this.shoot();
            state.inputs.e = false;
        }
    }

    update(dt: number) {
        this.updateNametag();
        // The v2 sim counts the powerup timers per tick instead (LocalVehicle)
        const v2 = PHYSICS_V2 && this.isLocal;

        for (const key of v2 ? [] : POWERUP_KEYS) {
            const p = this.powerups[key];
            if (p.active) {
                p.timer -= dt;
                if (p.timer <= 0) {
                    p.active = false;
                    if (key === 'size') this.group.scale.set(1, 1, 1);
                    // ghost visuals are restored centrally by the ghost visual sync below
                }
            }
        }

        // Update shield visual
        if (this.shieldMesh) {
            if (this.powerups.shield.active) {
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

        if (!this.isLocal) return;
        if (v2) {
            driveLocalCar(this, dt);
            return;
        }
        if (state.isModalOpen) return;
        if (state.dead) return;

        updateLegacyMovement(this, dt);
    }

    sendMovementSnapshot(now: number, moving: boolean) {
        const ghostActive = this.powerups.ghost.active;
        const shieldActive = this.powerups.shield.active;
        const megaActive = this.powerups.size.active;
        const stateChanged =
            !this._hasSentUpdate ||
            moving !== this._lastSentMoving ||
            this.isFlipping !== this._lastSentIsFlipping ||
            ghostActive !== this._lastSentGhostActive ||
            shieldActive !== this._lastSentShieldActive ||
            megaActive !== this._lastSentMegaActive;
        const interval = moving ? UPDATE_SEND_INTERVAL_MS : STATIONARY_UPDATE_INTERVAL_MS;
        if (!stateChanged && now - this._lastUpdateSentAt < interval) return;

        if (!sendToServer({
            type: 'update',
            x: this.group.position.x,
            z: this.group.position.z,
            y: this.flipGroup.position.y,
            angle: this.angle,
            flipAngle: this.flipGroup.rotation.x,
            isFlipping: this.isFlipping,
            scale: this.group.scale.x,
            ghostActive,
            shieldActive,
            megaActive
        })) return;

        this._hasSentUpdate = true;
        this._lastUpdateSentAt = now;
        this._lastSentMoving = moving;
        this._lastSentIsFlipping = this.isFlipping;
        this._lastSentGhostActive = ghostActive;
        this._lastSentShieldActive = shieldActive;
        this._lastSentMegaActive = megaActive;
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
