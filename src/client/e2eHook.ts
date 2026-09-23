import * as THREE from 'three';
import { state } from './state.js';
import { focusLightingOn } from './render/lighting.js';
import { frameStats } from './render/frameStats.js';
import type { Obstacle } from './types.js';
import { PHYSICS_V2 } from './flags.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';
import type { VehicleInput } from '../shared/sim/types.js';
import { models } from './assets/gameModels.js';
import { getTerrainHeight } from './world/environment.js';
import { getKTX2Loader } from './assets/gltfLoader.js';
import type { ModelCacheSnapshot } from './assets/ModelCache.js';

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

// State of the local v2 sim car, null with the legacy physics (?physics=legacy)
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
    physics: 'legacy' | 'v2';
    myId: string | null;
    connected: boolean;
    local: CarSnapshot | null;
    remotes: Record<string, CarSnapshot & { name: string }>;
    // Combined keyboard/touch drive axes
    inputs: { throttle: number; steer: number };
    // performance.now() at which the game loop took its last frame's dt
    // (THREE.Clock.getDelta), in ms; the dt the physics really got
    frameTime: number;
    // three.js counters of the last rendered frame
    // calls/triangles include the shadow pass, shadowCalls is its share
    render: { frame: number; calls: number; triangles: number; shadowCalls: number; shadowTriangles: number };
    camera: { x: number; y: number; z: number; fov: number };
    v2: V2Snapshot | null;
    // Car model cache (assets/ModelCache.ts)
    models: ModelCacheSnapshot;
}

// One instantiated cached model, as the e2e tests check it
export interface ModelInfo {
    triangles: number;
    meshes: number;
    nodes: string[];
    materials: string[];
    // Textures that came in as KTX2 (CompressedTexture) / as anything else
    compressedTextures: number;
    otherTextures: number;
    hiddenNodes: string[];
    // Bounding box of the visible opaque meshes (m)
    size: [number, number, number];
}

// A standalone texture from public/textures, loaded through the game's KTX2Loader
export interface TextureProbe {
    width: number;
    height: number;
    compressed: boolean;
    mipmaps: number;
    colorSpace: string;
}

function modelInfo(id: string, lod: number): ModelInfo | null {
    const root = models.instantiate(id, lod);
    if (!root) return null;
    let triangles = 0;
    let meshes = 0;
    const nodes: string[] = [];
    const hiddenNodes: string[] = [];
    const materials = new Set<string>();
    const textures = new Set<THREE.Texture>();
    root.traverse(child => {
        if (child.name) nodes.push(child.name);
        if (!child.visible) hiddenNodes.push(child.name);
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshes++;
        const index = mesh.geometry.index;
        triangles += (index ? index.count : mesh.geometry.attributes.position.count) / 3;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            materials.add(material.name);
            for (const value of Object.values(material)) {
                if ((value as THREE.Texture)?.isTexture) textures.add(value as THREE.Texture);
            }
        }
    });
    // Size of the visible opaque parts (without the glass, which also carries the ground blob)
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverseVisible(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || (mesh.material as THREE.Material).transparent) return;
        box.union(new THREE.Box3().setFromObject(mesh));
    });
    const size = box.getSize(new THREE.Vector3());
    const compressed = [...textures].filter(t => (t as THREE.CompressedTexture).isCompressedTexture).length;
    return {
        triangles,
        meshes,
        nodes: nodes.sort(),
        materials: [...materials].sort(),
        compressedTextures: compressed,
        otherTextures: textures.size - compressed,
        hiddenNodes,
        size: [size.x, size.y, size.z]
    };
}

// Test-only instances of cached models placed in the scene (spawnModel)
const spawnedModels: THREE.Object3D[] = [];

function spawnModel(id: string, lod: number, x: number, z: number, yaw = 0): boolean {
    const root = models.instantiate(id, lod);
    if (!root || !state.scene) return false;
    root.position.set(x, getTerrainHeight(x, z), z);
    root.rotation.y = yaw;
    state.scene.add(root);
    spawnedModels.push(root);
    return true;
}

function clearModels(): void {
    for (const root of spawnedModels.splice(0)) root.removeFromParent();
}

async function loadTextureProbe(url: string): Promise<TextureProbe> {
    const loader = await getKTX2Loader(state.renderer);
    const texture = await loader.loadAsync(url);
    const probe = {
        width: texture.image.width,
        height: texture.image.height,
        compressed: !!(texture as THREE.CompressedTexture).isCompressedTexture,
        mipmaps: texture.mipmaps?.length ?? 0,
        colorSpace: texture.colorSpace
    };
    texture.dispose();
    return probe;
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
                physics: PHYSICS_V2 ? 'v2' : 'legacy',
                myId: state.myId,
                connected: state.ws?.readyState === WebSocket.OPEN,
                local: state.bulli ? carSnapshot(state.bulli) : null,
                remotes,
                inputs: { throttle: state.inputs.throttle, steer: state.inputs.steer },
                frameTime: state.clock.oldTime,
                render: {
                    frame: state.renderer?.info.render.frame ?? 0,
                    calls: state.renderer?.info.render.calls ?? 0,
                    triangles: state.renderer?.info.render.triangles ?? 0,
                    shadowCalls: frameStats.shadowCalls,
                    shadowTriangles: frameStats.shadowTriangles
                },
                camera: {
                    x: state.camera?.position.x ?? 0,
                    y: state.camera?.position.y ?? 0,
                    z: state.camera?.position.z ?? 0,
                    fov: state.camera?.fov ?? 0
                },
                v2: v2Snapshot(state.bulli?.vehicle),
                models: models.snapshot()
            };
        },
        // Resolves once the model preload (and shader warmup) has finished
        async modelsSettled(): Promise<ModelCacheSnapshot> {
            await models.whenLoaded();
            if (state.renderer && state.camera && state.scene) {
                await models.warmup(state.renderer, state.camera, state.scene);
            }
            return models.snapshot();
        },
        modelInfo,
        loadTextureProbe,
        // Puts an instance of a cached model on the ground at (x, z) (screenshots
        // of the models before the game uses them); false if it is not loaded
        spawnModel,
        clearModels,
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
