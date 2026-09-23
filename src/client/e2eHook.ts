import * as THREE from 'three';
import { state } from './state.js';
import { focusLightingOn } from './render/lighting.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';
import type { VehicleInput } from '../shared/sim/types.js';
import type { RoomInfo } from '../shared/protocol.js';
import type { ColliderInput } from '../shared/world/colliders.js';
import { listTaggedColliders, type TaggedCollider } from './world/colliderTags.js';

// Hook for the Playwright smoke tests (tests/e2e) and the screenshot script
// (scripts/screenshots.ts). It is only installed when the page is opened with
// ?e2e=1, so regular players never get it and the game behaves exactly the
// same without the flag. Apart from placeLocalCar (which lets a test start
// from a known free stretch of road instead of the server's random spawn) and
// setCameraOverride (fixed views for screenshots) it only reads state.

interface CarSnapshot {
    x: number;
    // Ground height under the car (the model's origin)
    y: number;
    z: number;
    angle: number;
    speed: number;
}

// State of the local sim car, null before the car's first frame
export interface V2Snapshot {
    // Sim pose: y is the height above the ground under the car
    x: number;
    z: number;
    y: number;
    yaw: number;
    // Forward speed (m/s), slip angle (rad, + = sliding to the left), yaw rate
    u: number;
    beta: number;
    yawRate: number;
    steerAngle: number;
    grounded: boolean;
    flipAngle: number;
    boostMeter: number;
    boosting: boolean;
    drifting: boolean;
    ghostTicks: number;
    scale: number;
    classId: string;
    profile: 'standard' | 'touch';
    // Effective top speed of the sim params (m/s), tuning and Turbo included
    topSpeed: number;
    input: VehicleInput;
    // Counters since the car was created
    ticks: number;
    jumps: number;
    resets: number;
    resetHint: boolean;
    autoGas: boolean;
    // Remote players in the last tick's contact set
    proxies: number;
}

export interface BulliDebugSnapshot {
    myId: string | null;
    connected: boolean;
    // The room the server put this page in, and its items in the scene
    room: RoomInfo | null;
    items: { coins: number; powerups: number };
    local: CarSnapshot | null;
    remotes: Record<string, CarSnapshot & { name: string }>;
    // Combined keyboard/touch drive axes
    inputs: { throttle: number; steer: number };
    // performance.now() at which the game loop took its last frame's dt
    // (THREE.Clock.getDelta), in ms; the dt the physics really got
    frameTime: number;
    // three.js counters of the last rendered frame
    render: { frame: number; calls: number; triangles: number };
    camera: { x: number; y: number; z: number; fov: number };
    v2: V2Snapshot | null;
}

function v2Snapshot(vehicle: LocalVehicle | undefined): V2Snapshot | null {
    if (!vehicle) return null;
    const s = vehicle.car.state;
    const ground = vehicle.world.groundHeight(s.x, s.z);
    return {
        x: s.x,
        z: s.z,
        y: s.y - ground,
        yaw: s.yaw,
        u: vehicle.forwardSpeed,
        beta: vehicle.slipAngle,
        yawRate: s.yawRate,
        steerAngle: s.steerAngle,
        grounded: s.grounded,
        flipAngle: s.flipAngle,
        boostMeter: s.boostMeter,
        boosting: s.boosting,
        drifting: s.driftTicks > 0,
        ghostTicks: s.ghostTicks,
        scale: s.scale,
        classId: vehicle.classId,
        profile: vehicle.profile,
        topSpeed: vehicle.car.params.topSpeed,
        input: { ...vehicle.car.input },
        ticks: vehicle.ticks,
        jumps: vehicle.jumps,
        resets: vehicle.resets,
        resetHint: vehicle.resetHint,
        autoGas: vehicle.autoGas,
        proxies: vehicle.proxyCount
    };
}

// Screen box of the local car's body (flip group, without shield and
// nametag) as fractions of the canvas, from the current camera
export interface ScreenBox {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
}

const _meshBox = new THREE.Box3();
const _corner = new THREE.Vector3();

function localCarScreenBox(): ScreenBox | null {
    const car = state.bulli;
    const camera = state.camera;
    if (!car || !camera) return null;
    car.group.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    car.flipGroup.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible || mesh === car.shieldMesh) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        _meshBox.copy(mesh.geometry.boundingBox!);
        for (let i = 0; i < 8; i++) {
            _corner.set(
                i & 1 ? _meshBox.max.x : _meshBox.min.x,
                i & 2 ? _meshBox.max.y : _meshBox.min.y,
                i & 4 ? _meshBox.max.z : _meshBox.min.z
            ).applyMatrix4(mesh.matrixWorld).project(camera);
            left = Math.min(left, _corner.x);
            right = Math.max(right, _corner.x);
            top = Math.min(top, -_corner.y);
            bottom = Math.max(bottom, -_corner.y);
        }
    });
    if (!Number.isFinite(left)) return null;
    // NDC (-1..1) to fractions of the canvas (0..1, top left origin)
    const box = { left: (left + 1) / 2, right: (right + 1) / 2, top: (top + 1) / 2, bottom: (bottom + 1) / 2 };
    return { ...box, width: box.right - box.left, height: box.bottom - box.top };
}

// Fixed camera pose for screenshots, in world coordinates
export interface CameraPose {
    position: [number, number, number];
    lookAt: [number, number, number];
    fov?: number;
}

let cameraOverride: CameraPose | null = null;
const _overrideFocus = new THREE.Vector3();
let renderPatched = false;

// Applies the override right before each render, after the chase camera ran,
// so the game loop itself stays untouched.
function patchRenderForCameraOverride(): void {
    if (renderPatched || !state.renderer) return;
    renderPatched = true;
    const renderer = state.renderer;
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
        const pose = cameraOverride;
        if (pose && camera === state.camera) {
            state.camera.position.set(...pose.position);
            state.camera.lookAt(...pose.lookAt);
            if (pose.fov) state.camera.fov = pose.fov;
            state.camera.updateProjectionMatrix();
            state.camera.updateMatrixWorld();
            // Sky dome and shadows followed the chase camera; move them to
            // the fixed view so the sky and shadows look like in the game
            focusLightingOn(state.camera, _overrideFocus.set(...pose.lookAt));
        }
        render(scene, camera);
    };
}

function carSnapshot(car: any): CarSnapshot {
    return {
        x: car.group.position.x,
        y: car.group.position.y,
        z: car.group.position.z,
        angle: car.group.rotation.y,
        speed: car.speed ?? 0
    };
}

export function installE2EHook(): void {
    if (new URLSearchParams(window.location.search).get('e2e') !== '1') return;

    (window as unknown as { __bulliDebug: unknown }).__bulliDebug = {
        snapshot(): BulliDebugSnapshot {
            const remotes: BulliDebugSnapshot['remotes'] = {};
            for (const id in state.remotePlayers) {
                const remote = state.remotePlayers[id] as any;
                remotes[id] = { ...carSnapshot(remote), name: remote.name };
            }
            return {
                myId: state.myId,
                connected: state.ws?.readyState === WebSocket.OPEN,
                room: state.room ? { ...state.room } : null,
                items: { coins: state.coins.length, powerups: state.worldPowerups.length },
                local: state.bulli ? carSnapshot(state.bulli) : null,
                remotes,
                inputs: { throttle: state.inputs.throttle, steer: state.inputs.steer },
                frameTime: state.clock.oldTime,
                render: {
                    frame: state.renderer?.info.render.frame ?? 0,
                    calls: state.renderer?.info.render.calls ?? 0,
                    triangles: state.renderer?.info.render.triangles ?? 0
                },
                camera: {
                    x: state.camera?.position.x ?? 0,
                    y: state.camera?.position.y ?? 0,
                    z: state.camera?.position.z ?? 0,
                    fov: state.camera?.fov ?? 0
                },
                v2: v2Snapshot(state.bulli?.vehicle)
            };
        },
        // The same as the sim's collider list (shared/world/colliderGen.ts)
        colliders(): ColliderInput[] {
            return state.worldColliders.map(collider => ({ ...collider }));
        },
        // Rendered objects that stand on a collider (world/colliderTags.ts)
        colliderProps(): TaggedCollider[] {
            return state.scene ? listTaggedColliders(state.scene) : [];
        },
        // Puts the local car at rest at (x, z), facing angle. Like any move it
        // reaches the server with the car's next position update.
        placeLocalCar(x: number, z: number, angle: number): void {
            const car = state.bulli;
            if (!car) throw new Error('No local car yet');
            car.group.position.x = x;
            car.group.position.z = z;
            car.angle = angle;
            car.group.rotation.y = angle;
            car.speed = 0;
            // v2 physics: the sim car is the source of the pose
            car.vehicle?.place(x, z, angle);
        },
        // Where the local car is on screen (screenshot script: car size)
        localCarScreenBox,
        // Renders from a fixed pose instead of the chase camera (null restores
        // the chase camera, which snaps back on the next frame).
        setCameraOverride(pose: CameraPose | null): void {
            patchRenderForCameraOverride();
            cameraOverride = pose;
            if (!pose) state.cameraSnapPending = true;
        }
    };
}
