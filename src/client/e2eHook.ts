import { state } from './state.js';
import type { Obstacle } from './types.js';

// Hook for the Playwright smoke tests (tests/e2e) and the screenshot script
// (scripts/screenshots.ts). It is only installed when the page is opened with
// ?e2e=1, so regular players never get it and the game behaves exactly the
// same without the flag. Apart from placeLocalCar (which lets a test start
// from a known free stretch of road instead of the server's random spawn) and
// setCameraOverride (fixed views for screenshots) it only reads state.

interface CarSnapshot {
    x: number;
    z: number;
    angle: number;
    speed: number;
}

export interface BulliDebugSnapshot {
    myId: string | null;
    connected: boolean;
    local: CarSnapshot | null;
    remotes: Record<string, CarSnapshot & { name: string }>;
    // Combined keyboard/touch drive axes
    inputs: { throttle: number; steer: number };
    // three.js counters of the last rendered frame
    render: { frame: number; calls: number; triangles: number };
}

// Fixed camera pose for screenshots, in world coordinates
export interface CameraPose {
    position: [number, number, number];
    lookAt: [number, number, number];
    fov?: number;
}

let cameraOverride: CameraPose | null = null;
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
        }
        render(scene, camera);
    };
}

function carSnapshot(car: any): CarSnapshot {
    return {
        x: car.group.position.x,
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
                local: state.bulli ? carSnapshot(state.bulli) : null,
                remotes,
                inputs: { throttle: state.inputs.throttle, steer: state.inputs.steer },
                render: {
                    frame: state.renderer?.info.render.frame ?? 0,
                    calls: state.renderer?.info.render.calls ?? 0,
                    triangles: state.renderer?.info.render.triangles ?? 0
                }
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
