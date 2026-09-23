import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { playJumpSound, playCollisionSound, playHonkSound, playShootSound } from '../effects/sounds.js';
import { createProjectile } from '../world/projectiles.js';
import { spawnParticles } from '../effects/particles.js';
import { getTerrainHeight } from '../world/environment.js';
import { LEGACY_CAR_MAX_SPEED, MEGA_SCALE, SPEED_BOOST_FACTOR, UPDATE_SEND_INTERVAL_MS } from '../../shared/constants.js';
import { sendToServer } from '../network/socket.js';
import { CarModel, randomCarType, type CarType } from '../vehicle/CarModel.js';
import { Nametag } from '../vehicle/Nametag.js';

// Reusable vectors to avoid per-frame allocations
const _scaleBig = new THREE.Vector3(MEGA_SCALE, MEGA_SCALE, MEGA_SCALE);
const _scaleNormal = new THREE.Vector3(1, 1, 1);
// Half-extent (XZ) of the car's collision footprint at normal scale.
const CAR_HALF = 1.5;
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
    private _recoveryTimer: number = 0;
    private _jumpHeightFactor: number = 8;
    shieldMesh?: THREE.Mesh;
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
        this.shieldMesh = this.model.shieldMesh;
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
        this.tag.update(this.group.position, state.camera);
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

    update(dt: number) {
        this.updateNametag();

        for (const key of POWERUP_KEYS) {
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
        if (state.isModalOpen) return;
        if (state.dead) return;

        // Clamp the timestep so a frame hitch (tab refocus, GC pause) can't let
        // the car move far enough in one step to tunnel/fling through an
        // obstacle's push-out resolution. Max displacement stays below the
        // smallest building's collision half-extent.
        const frame = Math.min(dt, 1 / 30) * 60;

        let currentAccel = this.acceleration;
        let currentMaxSpeed = this.maxSpeed;
        if (this.powerups.speed.active) {
            // Constant boost for the whole duration (used to decay with the timer).
            currentAccel *= SPEED_BOOST_FACTOR;
            currentMaxSpeed *= SPEED_BOOST_FACTOR;
        }

        if (this.powerups.size.active) {
            this.group.scale.lerp(_scaleBig, 0.1);
        } else {
            this.group.scale.lerp(_scaleNormal, 0.1);
        }

        const throttle = Math.max(-1, Math.min(1, state.inputs.throttle));
        if (Math.abs(throttle) > 0.001) {
            // Analog input controls the requested road speed, not just how long
            // it takes to eventually reach full speed. This makes half-stick a
            // stable, useful cruising speed while preserving full-speed WASD.
            const targetSpeed = throttle >= 0
                ? throttle * currentMaxSpeed
                : throttle * currentMaxSpeed * 0.5;
            const changingDirection = Math.sign(targetSpeed) !== Math.sign(this.speed) && Math.abs(this.speed) > 0.01;
            const slowingDown = Math.abs(targetSpeed) < Math.abs(this.speed);
            const response = changingDirection ? 2.5 : (slowingDown ? 1.8 : 1);
            const maxDelta = currentAccel * response * frame;
            const delta = Math.max(-maxDelta, Math.min(maxDelta, targetSpeed - this.speed));
            this.speed += delta;
        } else {
            this.speed *= Math.pow(this.friction, frame);
        }

        const jumpRequested = state.inputs.space;
        state.inputs.space = false;
        if (jumpRequested && !this.isFlipping) {
            const superJumpActive = this.powerups.jump.active;
            this.isFlipping = true;
            this.flipVelocity = superJumpActive ? 0.12 : 0.25;
            // Snapshot the trajectory so a powerup expiring mid-air cannot
            // abruptly change the vehicle's height before it lands.
            this._jumpHeightFactor = superJumpActive ? 24 : 8;
            this.canRecover = false;
            this._recoveryTimer = 0;
            playJumpSound();
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
            this.shoot();
            state.inputs.e = false;
        }

        if (this.isFlipping) {
            this.flipGroup.rotation.x += this.flipVelocity * frame;
            if (this.flipGroup.rotation.x >= Math.PI * 2) {
                this.flipGroup.rotation.x = 0;
                this.isFlipping = false;
                this._jumpHeightFactor = 8;
            }
        }

        this.speed = Math.max(Math.min(this.speed, currentMaxSpeed), -currentMaxSpeed / 2);
        if (Math.abs(this.speed) < 0.001) this.speed = 0;

        if (!this.isFlipping) {
            // Keep a little steering authority at a standstill, peak around
            // city speed, then taper it at top speed so touch steering is calm.
            const turnDir = this.speed < -0.01 ? -1 : 1;
            const steer = Math.max(-1, Math.min(1, state.inputs.steer));
            const speedRatio = Math.min(1, Math.abs(this.speed) / Math.max(0.001, currentMaxSpeed));
            const lowSpeedAuthority = 0.28 + 0.72 * Math.min(1, Math.abs(this.speed) / 0.35);
            const highSpeedTaper = 1 - speedRatio * 0.35;
            this.angle += CONFIG.carTurnSpeed * steer * turnDir * lowSpeedAuthority * highSpeedTaper * frame;
        }

        let nextX = this.group.position.x + Math.sin(this.angle) * this.speed * frame;
        let nextZ = this.group.position.z + Math.cos(this.angle) * this.speed * frame;

        // Collision is skipped only when ghosting or genuinely airborne (a flip
        // or super-jump lifts the car above ground obstacles). The car is treated
        // as a circle of radius carR; buildings are AABBs, everything else is a
        // circle. On contact we push the car back out so it can never get stuck.
        const airborne = this.flipGroup.position.y > 1.0;
        let collided = false;
        let hitX = 0, hitZ = 0;
        if (!this.powerups.ghost.active && !airborne) {
            const carR = CAR_HALF * (this.powerups.size.active ? MEGA_SCALE : (this.group.scale.x || 1));
            for (const obs of state.obstacles) {
                let hit = false;
                if (obs.type === 'rect') {
                    const minX = obs.x - obs.halfWidth - carR;
                    const maxX = obs.x + obs.halfWidth + carR;
                    const minZ = obs.z - obs.halfDepth - carR;
                    const maxZ = obs.z + obs.halfDepth + carR;
                    if (nextX > minX && nextX < maxX && nextZ > minZ && nextZ < maxZ) {
                        // Push out along the axis of least penetration.
                        const penL = nextX - minX, penR = maxX - nextX;
                        const penN = nextZ - minZ, penF = maxZ - nextZ;
                        const minPen = Math.min(penL, penR, penN, penF);
                        if (minPen === penL) nextX = minX;
                        else if (minPen === penR) nextX = maxX;
                        else if (minPen === penN) nextZ = minZ;
                        else nextZ = maxZ;
                        hit = true;
                    }
                } else {
                    const dx = nextX - obs.x, dz = nextZ - obs.z;
                    const minDist = obs.radius + carR;
                    if (dx * dx + dz * dz < minDist * minDist) {
                        const dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
                        nextX = obs.x + (dx / dist) * minDist;
                        nextZ = obs.z + (dz / dist) * minDist;
                        hit = true;
                    }
                }
                if (hit && !collided) {
                    collided = true;
                    hitX = obs.x;
                    hitZ = obs.z;
                }
            }
        }

        // Move to the (possibly pushed-out) position, then keep it on the terrain plane.
        this.group.position.x = nextX;
        this.group.position.z = nextZ;
        const bound = (state.terrainConfig?.size ?? 1000) / 2 - 2;
        this.group.position.x = Math.max(-bound, Math.min(bound, this.group.position.x));
        this.group.position.z = Math.max(-bound, Math.min(bound, this.group.position.z));

        if (collided) {
            if (this.powerups.shield.active) {
                // Shielded: plough to a near-stop instead of bouncing.
                this.speed *= 0.1;
            } else {
                this.speed *= -0.5;
                if (Math.abs(this.speed) > 0.125) {
                    playCollisionSound(Math.abs(this.speed) * 2);
                    const fxHeight = getTerrainHeight(hitX, hitZ) + 4;
                    const particleCount = Math.min(16, Math.floor(Math.abs(this.speed) * 30));
                    spawnParticles(hitX, fxHeight, hitZ, 0x228B22, particleCount, 0.5, 2.5, 0.4);
                    if (Math.abs(this.speed) > 0.2) {
                        spawnParticles(hitX, fxHeight - 2, hitZ, 0x8B4513, 4, 0.3, 1.5, 0.3);
                    }
                }
            }
        }

        const isOverturned = Math.abs(this.group.rotation.x) > 1.15 || Math.abs(this.group.rotation.z) > 1.15;
        const pushingIntoObstacle = Math.abs(throttle) > 0.55 && collided && !this.isFlipping;
        if (isOverturned || pushingIntoObstacle) {
            this._recoveryTimer += Math.min(dt, 0.1);
        } else {
            this._recoveryTimer = Math.max(0, this._recoveryTimer - Math.min(dt, 0.1) * 2);
        }
        this.canRecover = !this.isFlipping && (isOverturned || this._recoveryTimer >= 0.85);

        // Ease the car up/down to the terrain height (no per-frame snapping) and
        // tilt it to follow the slope while preserving steering yaw.
        const targetY = getTerrainHeight(this.group.position.x, this.group.position.z);
        this.group.position.y += (targetY - this.group.position.y) * Math.min(1, 0.15 * frame);

        this.group.rotation.order = 'YXZ';
        this.group.rotation.y = this.angle;
        const slopeStep = 2.0;
        const fwdX = Math.sin(this.angle), fwdZ = Math.cos(this.angle);
        const hFwd = getTerrainHeight(this.group.position.x + fwdX * slopeStep, this.group.position.z + fwdZ * slopeStep);
        const hBack = getTerrainHeight(this.group.position.x - fwdX * slopeStep, this.group.position.z - fwdZ * slopeStep);
        const hRight = getTerrainHeight(this.group.position.x + fwdZ * slopeStep, this.group.position.z - fwdX * slopeStep);
        const hLeft = getTerrainHeight(this.group.position.x - fwdZ * slopeStep, this.group.position.z + fwdX * slopeStep);
        const targetPitch = Math.atan2(hBack - hFwd, slopeStep * 2);
        const targetRoll = Math.atan2(hRight - hLeft, slopeStep * 2);
        const tiltLerp = Math.min(1, 0.1 * frame);
        this.group.rotation.x += (targetPitch - this.group.rotation.x) * tiltLerp;
        this.group.rotation.z += (targetRoll - this.group.rotation.z) * tiltLerp;

        this.wheels.forEach(w => {
            w.rotation.x -= this.speed * 0.5 * frame;
        });

        if (Math.abs(this.speed) > 0.1 && !this.isFlipping) {
            this.flipGroup.position.y = Math.sin(Date.now() * 0.01) * 0.05;
        } else if (!this.isFlipping) {
            this.flipGroup.position.y = 0;
        } else {
            const normRot = this.flipGroup.rotation.x;
            const lift = Math.sin(normRot / 2);
            this.flipGroup.position.y = lift * this._jumpHeightFactor;
        }

        const targetScale = this.powerups.size.active ? MEGA_SCALE : 1;
        const moving =
            Math.abs(this.speed) > 0.001 ||
            Math.abs(state.inputs.steer) > 0.001 ||
            this.isFlipping ||
            Math.abs(this.flipGroup.position.y) > 0.001 ||
            Math.abs(this.group.scale.x - targetScale) > 0.001;
        this.sendMovementSnapshot(performance.now(), moving);
    }

    private sendMovementSnapshot(now: number, moving: boolean) {
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
