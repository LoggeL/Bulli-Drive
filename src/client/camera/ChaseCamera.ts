import * as THREE from 'three';
import { CONFIG } from '../config.js';

// Automatic chase camera behind the local car. Its yaw follows the car on
// the shortest arc, while position, framing and FOV use independent damping
// so a quick turn feels deliberate instead of whipping the view around.
// Extracted from main.ts; the numbers live in a profile.

export interface ChaseProfile {
    height: number;
    distance: number;
    lookAtY: number;
    lookAhead: number;
    speedLookAhead: number;
    // Distance/height grow with the speed ratio and while boosting
    distanceSpeedGain: number;
    heightSpeedGain: number;
    distanceBoostGain: number;
    heightBoostGain: number;
    baseFov: number;
    mobileFov: number;
    speedFov: number;
    boostFov: number;
    maxFov: number;
    mobileDistanceScale: number;
    mobileHeightScale: number;
    // Distance and height in a portrait window (narrower than high), where
    // the car would otherwise fill half the width
    portraitScale: number;
    yawDamping: number;
    positionDamping: number;
    lookDamping: number;
    fovDamping: number;
}

// Low racing camera (docs/phase-1a-design.md, 12.5). Standing on a 16:9
// screen the car is about 16 % of the image wide (the old high camera: 4 %),
// 12 % at 70 km/h; measured with npm run screenshots.
export const RACE_CAMERA: ChaseProfile = {
    height: 4.8,
    distance: 11,
    lookAtY: 1.5,
    lookAhead: 4,
    speedLookAhead: 6,
    distanceSpeedGain: 0.12,
    heightSpeedGain: 0,
    distanceBoostGain: 0.06,
    heightBoostGain: 0,
    baseFov: 60,
    mobileFov: 62,
    speedFov: 10,
    boostFov: 4,
    maxFov: 80,
    // Phones in landscape: as on the desktop, the car is already 16 % wide
    mobileDistanceScale: 1,
    mobileHeightScale: 1,
    portraitScale: 1.5,
    // Tight enough not to trail far behind at 50 m/s
    yawDamping: 7,
    positionDamping: 12,
    lookDamping: 12,
    fovDamping: 5
};

// Share of the slip angle the race camera swings towards the travel
// direction while drifting (full from 10 m/s)
export const RACE_CAMERA_SLIP_BLEND = 0.5;

export interface ChaseTarget {
    position: THREE.Vector3;
    // Heading the camera swings in behind
    yaw: number;
    // 0..1, speed relative to the current top speed
    speedRatio: number;
    boost: boolean;
}

function dampingFactor(rate: number, dt: number): number {
    return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

function dampAngle(current: number, target: number, amount: number): number {
    const shortestDelta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + shortestDelta * amount;
}

export class ChaseCamera {
    profile: ChaseProfile;
    // Phones and narrow windows get a slightly closer camera
    mobile = false;
    private readonly cameraTarget = new THREE.Vector3();
    private readonly desiredLookAt = new THREE.Vector3();
    private readonly smoothedLookAt = new THREE.Vector3();
    private readonly lastCarPosition = new THREE.Vector3();
    private cameraYaw = 0;
    private rigReady = false;

    constructor(profile: ChaseProfile) {
        this.profile = profile;
        this.refreshEnvelope();
    }

    refreshEnvelope() {
        this.mobile = typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
    }

    get baseFov(): number {
        return this.mobile ? this.profile.mobileFov : this.profile.baseFov;
    }

    /**
     * Moves the camera towards its place behind the target. With snap (spawn,
     * teleport) or a jump of more than CONFIG.cameraTeleportDistance it jumps
     * there directly. Returns whether it snapped.
     */
    update(dt: number, camera: THREE.PerspectiveCamera, target: ChaseTarget, snap: boolean): boolean {
        const p = this.profile;
        const carPos = target.position;
        const speedRatio = target.speedRatio;
        const boostActive = target.boost;
        const movedDistanceSq = this.rigReady ? this.lastCarPosition.distanceToSquared(carPos) : 0;
        const teleportThresholdSq = CONFIG.cameraTeleportDistance * CONFIG.cameraTeleportDistance;
        const shouldSnap = !this.rigReady || snap || movedDistanceSq > teleportThresholdSq;

        if (shouldSnap) {
            this.cameraYaw = target.yaw;
        } else {
            this.cameraYaw = dampAngle(this.cameraYaw, target.yaw, dampingFactor(p.yawDamping, dt));
        }

        const portraitScale = camera.aspect < 1 ? p.portraitScale : 1;
        const distanceScale = (this.mobile ? p.mobileDistanceScale : 1) * portraitScale;
        const heightScale = (this.mobile ? p.mobileHeightScale : 1) * portraitScale;
        const distance = p.distance * distanceScale
            * (1 + speedRatio * p.distanceSpeedGain + (boostActive ? p.distanceBoostGain : 0));
        const height = p.height * heightScale
            * (1 + speedRatio * p.heightSpeedGain + (boostActive ? p.heightBoostGain : 0));
        const forwardX = Math.sin(this.cameraYaw);
        const forwardZ = Math.cos(this.cameraYaw);
        const lookAhead = p.lookAhead + p.speedLookAhead * speedRatio;

        this.cameraTarget.set(
            carPos.x - forwardX * distance,
            carPos.y + height,
            carPos.z - forwardZ * distance
        );
        this.desiredLookAt.set(
            carPos.x + forwardX * lookAhead,
            carPos.y + p.lookAtY,
            carPos.z + forwardZ * lookAhead
        );

        const targetFov = Math.min(
            p.maxFov,
            this.baseFov + speedRatio * p.speedFov + (boostActive ? p.boostFov : 0)
        );

        if (shouldSnap) {
            camera.position.copy(this.cameraTarget);
            this.smoothedLookAt.copy(this.desiredLookAt);
            camera.fov = targetFov;
            this.rigReady = true;
        } else {
            camera.position.lerp(this.cameraTarget, dampingFactor(p.positionDamping, dt));
            this.smoothedLookAt.lerp(this.desiredLookAt, dampingFactor(p.lookDamping, dt));
            camera.fov += (targetFov - camera.fov) * dampingFactor(p.fovDamping, dt);
        }

        camera.lookAt(this.smoothedLookAt);
        if (shouldSnap || Math.abs(targetFov - camera.fov) > 0.01) {
            camera.updateProjectionMatrix();
        }
        this.lastCarPosition.copy(carPos);
        return shouldSnap;
    }
}
