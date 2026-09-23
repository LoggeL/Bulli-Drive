import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { playJumpSound, playCollisionSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { getTerrainHeight } from '../world/environment.js';
import { MEGA_SCALE, SPEED_BOOST_FACTOR } from '../../shared/constants.js';
import type { Bulli } from '../entities/Bulli.js';

// The frame-based driving physics the game shipped with, moved out of
// entities/Bulli.ts unchanged. It runs whenever the page is opened without
// ?physics=v2 and goes away once the v2 physics has won the blind test.

// Reusable vectors to avoid per-frame allocations
const _scaleBig = new THREE.Vector3(MEGA_SCALE, MEGA_SCALE, MEGA_SCALE);
const _scaleNormal = new THREE.Vector3(1, 1, 1);
// Half-extent (XZ) of the car's collision footprint at normal scale.
const CAR_HALF = 1.5;

export interface LegacyPhysicsState {
    recoveryTimer: number;
    jumpHeightFactor: number;
}

export function createLegacyPhysicsState(): LegacyPhysicsState {
    return { recoveryTimer: 0, jumpHeightFactor: 8 };
}

// One frame of the local car: speed, jump/flip, steering, obstacle push-out,
// terrain following, then the position update to the server.
export function updateLegacyMovement(car: Bulli, dt: number) {
    // Clamp the timestep so a frame hitch (tab refocus, GC pause) can't let
    // the car move far enough in one step to tunnel/fling through an
    // obstacle's push-out resolution. Max displacement stays below the
    // smallest building's collision half-extent.
    const frame = Math.min(dt, 1 / 30) * 60;

    let currentAccel = car.acceleration;
    let currentMaxSpeed = car.maxSpeed;
    if (car.powerups.speed.active) {
        // Constant boost for the whole duration (used to decay with the timer).
        currentAccel *= SPEED_BOOST_FACTOR;
        currentMaxSpeed *= SPEED_BOOST_FACTOR;
    }

    if (car.powerups.size.active) {
        car.group.scale.lerp(_scaleBig, 0.1);
    } else {
        car.group.scale.lerp(_scaleNormal, 0.1);
    }

    const throttle = Math.max(-1, Math.min(1, state.inputs.throttle));
    if (Math.abs(throttle) > 0.001) {
        // Analog input controls the requested road speed, not just how long
        // it takes to eventually reach full speed. This makes half-stick a
        // stable, useful cruising speed while preserving full-speed WASD.
        const targetSpeed = throttle >= 0
            ? throttle * currentMaxSpeed
            : throttle * currentMaxSpeed * 0.5;
        const changingDirection = Math.sign(targetSpeed) !== Math.sign(car.speed) && Math.abs(car.speed) > 0.01;
        const slowingDown = Math.abs(targetSpeed) < Math.abs(car.speed);
        const response = changingDirection ? 2.5 : (slowingDown ? 1.8 : 1);
        const maxDelta = currentAccel * response * frame;
        const delta = Math.max(-maxDelta, Math.min(maxDelta, targetSpeed - car.speed));
        car.speed += delta;
    } else {
        car.speed *= Math.pow(car.friction, frame);
    }

    const jumpRequested = state.inputs.space;
    state.inputs.space = false;
    if (jumpRequested && !car.isFlipping) {
        const superJumpActive = car.powerups.jump.active;
        car.isFlipping = true;
        car.flipVelocity = superJumpActive ? 0.12 : 0.25;
        // Snapshot the trajectory so a powerup expiring mid-air cannot
        // abruptly change the vehicle's height before it lands.
        car.legacy.jumpHeightFactor = superJumpActive ? 24 : 8;
        car.canRecover = false;
        car.legacy.recoveryTimer = 0;
        playJumpSound();
    }

    car.handleActions();

    if (car.isFlipping) {
        car.flipGroup.rotation.x += car.flipVelocity * frame;
        if (car.flipGroup.rotation.x >= Math.PI * 2) {
            car.flipGroup.rotation.x = 0;
            car.isFlipping = false;
            car.legacy.jumpHeightFactor = 8;
        }
    }

    car.speed = Math.max(Math.min(car.speed, currentMaxSpeed), -currentMaxSpeed / 2);
    if (Math.abs(car.speed) < 0.001) car.speed = 0;

    if (!car.isFlipping) {
        // Keep a little steering authority at a standstill, peak around
        // city speed, then taper it at top speed so touch steering is calm.
        const turnDir = car.speed < -0.01 ? -1 : 1;
        const steer = Math.max(-1, Math.min(1, state.inputs.steer));
        const speedRatio = Math.min(1, Math.abs(car.speed) / Math.max(0.001, currentMaxSpeed));
        const lowSpeedAuthority = 0.28 + 0.72 * Math.min(1, Math.abs(car.speed) / 0.35);
        const highSpeedTaper = 1 - speedRatio * 0.35;
        car.angle += CONFIG.carTurnSpeed * steer * turnDir * lowSpeedAuthority * highSpeedTaper * frame;
    }

    let nextX = car.group.position.x + Math.sin(car.angle) * car.speed * frame;
    let nextZ = car.group.position.z + Math.cos(car.angle) * car.speed * frame;

    // Collision is skipped only when ghosting or genuinely airborne (a flip
    // or super-jump lifts the car above ground obstacles). The car is treated
    // as a circle of radius carR; buildings are AABBs, everything else is a
    // circle. On contact we push the car back out so it can never get stuck.
    const airborne = car.flipGroup.position.y > 1.0;
    let collided = false;
    let hitX = 0, hitZ = 0;
    if (!car.powerups.ghost.active && !airborne) {
        const carR = CAR_HALF * (car.powerups.size.active ? MEGA_SCALE : (car.group.scale.x || 1));
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
    car.group.position.x = nextX;
    car.group.position.z = nextZ;
    const bound = (state.terrainConfig?.size ?? 1000) / 2 - 2;
    car.group.position.x = Math.max(-bound, Math.min(bound, car.group.position.x));
    car.group.position.z = Math.max(-bound, Math.min(bound, car.group.position.z));

    if (collided) {
        if (car.powerups.shield.active) {
            // Shielded: plough to a near-stop instead of bouncing.
            car.speed *= 0.1;
        } else {
            car.speed *= -0.5;
            if (Math.abs(car.speed) > 0.125) {
                playCollisionSound(Math.abs(car.speed) * 2);
                const fxHeight = getTerrainHeight(hitX, hitZ) + 4;
                const particleCount = Math.min(16, Math.floor(Math.abs(car.speed) * 30));
                spawnParticles(hitX, fxHeight, hitZ, 0x228B22, particleCount, 0.5, 2.5, 0.4);
                if (Math.abs(car.speed) > 0.2) {
                    spawnParticles(hitX, fxHeight - 2, hitZ, 0x8B4513, 4, 0.3, 1.5, 0.3);
                }
            }
        }
    }

    const isOverturned = Math.abs(car.group.rotation.x) > 1.15 || Math.abs(car.group.rotation.z) > 1.15;
    const pushingIntoObstacle = Math.abs(throttle) > 0.55 && collided && !car.isFlipping;
    if (isOverturned || pushingIntoObstacle) {
        car.legacy.recoveryTimer += Math.min(dt, 0.1);
    } else {
        car.legacy.recoveryTimer = Math.max(0, car.legacy.recoveryTimer - Math.min(dt, 0.1) * 2);
    }
    car.canRecover = !car.isFlipping && (isOverturned || car.legacy.recoveryTimer >= 0.85);

    // Ease the car up/down to the terrain height (no per-frame snapping) and
    // tilt it to follow the slope while preserving steering yaw.
    const targetY = getTerrainHeight(car.group.position.x, car.group.position.z);
    car.group.position.y += (targetY - car.group.position.y) * Math.min(1, 0.15 * frame);

    car.group.rotation.order = 'YXZ';
    car.group.rotation.y = car.angle;
    const slopeStep = 2.0;
    const fwdX = Math.sin(car.angle), fwdZ = Math.cos(car.angle);
    const hFwd = getTerrainHeight(car.group.position.x + fwdX * slopeStep, car.group.position.z + fwdZ * slopeStep);
    const hBack = getTerrainHeight(car.group.position.x - fwdX * slopeStep, car.group.position.z - fwdZ * slopeStep);
    const hRight = getTerrainHeight(car.group.position.x + fwdZ * slopeStep, car.group.position.z - fwdX * slopeStep);
    const hLeft = getTerrainHeight(car.group.position.x - fwdZ * slopeStep, car.group.position.z + fwdX * slopeStep);
    const targetPitch = Math.atan2(hBack - hFwd, slopeStep * 2);
    const targetRoll = Math.atan2(hRight - hLeft, slopeStep * 2);
    const tiltLerp = Math.min(1, 0.1 * frame);
    car.group.rotation.x += (targetPitch - car.group.rotation.x) * tiltLerp;
    car.group.rotation.z += (targetRoll - car.group.rotation.z) * tiltLerp;

    car.wheels.forEach(w => {
        w.rotation.x -= car.speed * 0.5 * frame;
    });

    if (Math.abs(car.speed) > 0.1 && !car.isFlipping) {
        car.flipGroup.position.y = Math.sin(Date.now() * 0.01) * 0.05;
    } else if (!car.isFlipping) {
        car.flipGroup.position.y = 0;
    } else {
        const normRot = car.flipGroup.rotation.x;
        const lift = Math.sin(normRot / 2);
        car.flipGroup.position.y = lift * car.legacy.jumpHeightFactor;
    }

    const targetScale = car.powerups.size.active ? MEGA_SCALE : 1;
    const moving =
        Math.abs(car.speed) > 0.001 ||
        Math.abs(state.inputs.steer) > 0.001 ||
        car.isFlipping ||
        Math.abs(car.flipGroup.position.y) > 0.001 ||
        Math.abs(car.group.scale.x - targetScale) > 0.001;
    car.sendMovementSnapshot(performance.now(), moving);
}
