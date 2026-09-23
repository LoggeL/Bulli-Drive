import * as THREE from 'three';
import { state } from './state.js';
import { focusLightingOn } from './render/lighting.js';
import type { Obstacle } from './types.js';
import { PHYSICS_V2 } from './flags.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';
import type { VehicleInput } from '../shared/sim/types.js';

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

// State of the local v2 sim car (?physics=v2), null with the legacy physics
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
    physics: 'legacy' | 'v2';
    myId: string | null;
    connected: boolean;
    local: CarSnapshot | null;
    remotes: Record<string, CarSnapshot & { name: string }>;
    // Combined keyboard/touch drive axes
    inputs: { throttle: number; steer: number };
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
        input: { ...vehicle.car.input },
        ticks: vehicle.ticks,
        jumps: vehicle.jumps,
        resets: vehicle.resets,
        resetHint: vehicle.resetHint,
        autoGas: vehicle.autoGas,
        proxies: vehicle.proxyCount
    };
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
                physics: PHYSICS_V2 ? 'v2' : 'legacy',
                myId: state.myId,
                connected: state.ws?.readyState === WebSocket.OPEN,
                local: state.bulli ? carSnapshot(state.bulli) : null,
                remotes,
                inputs: { throttle: state.inputs.throttle, steer: state.inputs.steer },
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
        // Collision obstacles of the local car (buildings, trees, props)
        obstacles(): Obstacle[] {
            return state.obstacles.map(obstacle => ({ ...obstacle }));
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
            // ?physics=v2: the sim car is the source of the pose
            car.vehicle?.place(x, z, angle);
        },
        // Renders from a fixed pose instead of the chase camera (null restores
        // the chase camera, which snaps back on the next frame).
        setCameraOverride(pose: CameraPose | null): void {
            patchRenderForCameraOverride();
            cameraOverride = pose;
            if (!pose) state.cameraSnapPending = true;
        }
    };
}
