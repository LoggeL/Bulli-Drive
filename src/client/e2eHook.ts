import * as THREE from 'three';
import { state } from './state.js';
import { focusLightingOn, lightingTier, whenSkyReady } from './render/lighting.js';
import { textureStats, whenWorldTexturesLoaded } from './world/textures.js';
import { frameStats } from './render/frameStats.js';
import { models } from './assets/gameModels.js';
import { groundHeight } from './world/ground.js';
import { kitStatus, mapDetail, mapScene } from './world/mapScene.js';
import { palmStats, setPalmImpostorDistance, updatePalms, whenPalmImpostorsReady } from './world/palms.js';
import { getKTX2Loader } from './assets/gltfLoader.js';
import type { ModelCacheSnapshot } from './assets/ModelCache.js';
import { CarModel, liveCarModels, refreshCarLods, type CarType } from './vehicle/CarModel.js';
import { gameHooks } from './game/hooks.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';
import type { VehicleInput } from '../shared/sim/types.js';
import type { RoomInfo } from '../shared/protocol.js';
import type { ColliderInput } from '../shared/world/colliders.js';
import { listTaggedColliders, type TaggedCollider } from './world/colliderTags.js';
import { sendToServer } from './network/socket.js';
import { netDriver } from './net/netDriver.js';
import type { NetStats } from '../shared/net/client.js';
import { remoteFlags } from './net/remotes.js';
import { connectionInfo, holdReconnect } from './network/websocket.js';
import { connectionOverlayText } from './ui/connectionOverlay.js';
import { NETSIM } from './net/netsim.js';
import { isE2EEnabled } from './flags.js';
import type { NetsimOptions } from '../shared/net/netsim.js';
import { raceClient } from './race/RaceClient.js';
import type { RacePhase, RacerStatus, TrackId } from '../shared/race/types.js';

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
    // The car is drawn (false while dead)
    visible: boolean;
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
    // Own Party score from the scoreboard (0 when not on it)
    score: number;
    // The room the server put this page in, and its items in the scene
    room: RoomInfo | null;
    items: { coins: number; powerups: number };
    local: CarSnapshot | null;
    remotes: Record<string, CarSnapshot & { name: string }>;
    // Combined keyboard/touch drive axes
    inputs: { throttle: number; steer: number };
    // performance.now() at which the game loop took its last frame's dt
    // (state.clock.update), in ms; the dt the physics really got
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

export interface MapWorldStats {
    kitCells: number;
    kitBuilt: number;
    instances: Record<string, number>;
    terrainTriangles: number;
    detail: string;
    kit: string;
    groups: Record<string, { meshes: number; triangles: number }>;
}

// State of the realistic world look (render/look.ts, world/textures.ts)
export interface WorldInfo {
    tier: string;
    textures: { requested: number; loaded: number; failed: number };
    // uuid of scene.environment (the PMREM of the sky), null without one
    environment: string | null;
    // Named top level scene objects of the world
    groups: string[];
    // Palms drawn as geometry and as impostors at the last frame, and
    // whether the impostor atlas is baked (null before the map's world exists)
    palms: { near: number; impostors: number; baked: boolean } | null;
}

function worldInfo(): WorldInfo {
    return {
        tier: lightingTier(),
        textures: { ...textureStats },
        environment: state.scene?.environment?.uuid ?? null,
        groups: (state.scene?.children ?? []).map(child => child.name).filter(Boolean),
        palms: palmStats()
    };
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
    root.position.set(x, groundHeight(x, z), z);
    root.rotation.y = yaw;
    state.scene.add(root);
    spawnedModels.push(root);
    return true;
}

// Game car models (CarModel, like a remote player's car) placed for the
// showroom screenshots; brake/steer hold their drive look every frame
interface SpawnedCar {
    model: CarModel;
    brake: boolean;
    steer: number;
}
const spawnedCars: SpawnedCar[] = [];
let spawnedCarsHooked = false;

export interface SpawnCarOptions {
    brake?: boolean;
    steer?: number;
    surfboard?: boolean;
}

function spawnCar(carType: CarType, color: number, x: number, z: number, yaw = 0, options: SpawnCarOptions = {}): CarInfo | null {
    if (!state.scene) return null;
    const model = new CarModel(color, carType);
    model.group.position.set(x, groundHeight(x, z), z);
    model.group.rotation.y = yaw;
    model.gltf?.setSurfboard(options.surfboard ?? false);
    state.scene.add(model.group);
    spawnedCars.push({ model, brake: options.brake ?? false, steer: options.steer ?? 0 });
    gameHooks.extraModels.push(model);
    if (!spawnedCarsHooked) {
        spawnedCarsHooked = true;
        gameHooks.frame.push(() => {
            for (const car of spawnedCars) car.model.setDriveState(0, car.steer, car.brake);
        });
    }
    return carInfo(model);
}

function clearModels(): void {
    for (const root of spawnedModels.splice(0)) root.removeFromParent();
    for (const car of spawnedCars.splice(0)) {
        car.model.group.removeFromParent();
        const index = gameHooks.extraModels.indexOf(car.model);
        if (index >= 0) gameHooks.extraModels.splice(index, 1);
        car.model.dispose();
    }
}

// How a car is drawn: GLB body (which LOD) or procedural
export interface CarInfo {
    carType: string;
    gltf: boolean;
    lod: number;
    lods: number[];
    scale: number;
    // Scaled body size (m) and the contact shadow footprint
    size: [number, number, number] | null;
    footprint: [number, number];
    nametagHeight: number;
    // Material objects of this car, and how many of them are the model
    // cache's shared template materials (must be 0)
    materials: number;
    sharedMaterials: number;
    meshes: number;
    // The player's own car (the others are drawn cheaper on the phone tier)
    local: boolean;
    shadowCasters: number;
}

function templateMaterials(): Set<THREE.Material> {
    const shared = new Set<THREE.Material>();
    for (const key of models.snapshot().loaded) {
        const [id, lod] = key.split(':');
        const root = models.instantiate(id, Number(lod));
        root?.traverse(child => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) shared.add(material);
        });
    }
    return shared;
}

function carInfo(model: CarModel): CarInfo {
    const shared = templateMaterials();
    const materials = new Set<THREE.Material>();
    let meshes = 0;
    let shadowCasters = 0;
    model.flipGroup.traverseVisible(child => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.castShadow) shadowCasters++;
    });
    model.flipGroup.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshes++;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
    const gltf = model.gltf;
    return {
        carType: model.carType,
        gltf: !!gltf,
        lod: gltf?.lod ?? -1,
        lods: gltf?.lods ?? [],
        scale: gltf?.scale ?? 1,
        size: gltf ? [gltf.size.x, gltf.size.y, gltf.size.z] : null,
        footprint: model.footprint,
        nametagHeight: model.nametagHeight,
        materials: materials.size,
        sharedMaterials: [...materials].filter(material => shared.has(material)).length,
        meshes,
        local: model.local,
        // Visible meshes that cast a shadow
        shadowCasters
    };
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
    car.flipGroup.traverseVisible((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || mesh === car.shieldMesh) return;
        if (!Array.isArray(mesh.material) && mesh.material.name === 'glass') return;
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
            // Palm LOD (near geometry or impostor) for the fixed view as well
            updatePalms(state.camera);
            // Car LODs too
            refreshCarLods(state.camera);
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
        speed: car.speed ?? 0,
        visible: !!car.flipGroup?.visible
    };
}

// Netcode numbers for tests (docs/phase-1b-design.md, 12)
export interface NetDebugSnapshot {
    tick: number;
    serverTick: number;
    lead: number;
    rate: number;
    leadTicks: number;
    leadError: number;
    rtt: number;
    jitter: number;
    bufferTarget: number;
    selfFlags: number;
    spawned: boolean;
    contactSet: number;
    offset: number;
    // Car flags of the other players from their latest snapshot
    remoteFlags: Record<string, number>;
    stats: NetStats;
    // The connection (11.1): reconnects so far, whether the last welcome
    // resumed the session, the last close code, what the banner says
    // (null while hidden), the prediction held for a lost connection
    reconnects: number;
    resumed: boolean;
    lastCloseCode: number;
    overlay: string | null;
    suspended: boolean;
    netsim: NetsimOptions | null;
}

// The race as the client knows it (docs/phase-2-design.md, 17)
export interface RaceDebugSnapshot {
    mode: 'race' | 'timetrial';
    phase: RacePhase;
    trackId: TrackId;
    startTick: number | null;
    racers: { id: string; grid: number; bot: boolean }[];
    ready: string[];
    passed: number;
    finish: { pos: number; time: number } | null;
    launch: string | null;
    results: { id: string; name: string; pos: number; status: RacerStatus; finishTicks: number | null }[] | null;
    // The prediction's tick C
    tick: number;
}

function raceSnapshot(): RaceDebugSnapshot | null {
    const m = raceClient.model;
    const s = m.state;
    if (!raceClient.active || !s) return null;
    return {
        mode: s.mode,
        phase: s.phase,
        trackId: s.trackId,
        startTick: s.startTick,
        racers: s.racers.map(r => ({ ...r })),
        ready: [...s.ready],
        passed: m.progress.passed,
        finish: m.finish ? { ...m.finish } : null,
        launch: m.launchEvent,
        results: m.results?.entries.map(e => ({ id: e.id, name: e.name, pos: e.pos, status: e.status, finishTicks: e.finishTicks })) ?? null,
        tick: netDriver.prediction?.tick ?? -1
    };
}

function netSnapshot(): NetDebugSnapshot {
    const p = netDriver.prediction;
    const o = netDriver.offset;
    return {
        tick: p?.tick ?? -1,
        serverTick: p?.lastSnapshotTick ?? -1,
        lead: p?.lead ?? 0,
        rate: netDriver.lead.rate,
        leadTicks: netDriver.lead.lead,
        leadError: netDriver.lead.lastError,
        rtt: netDriver.clock.rtt,
        jitter: netDriver.clock.jitter,
        bufferTarget: netDriver.bufferTarget,
        selfFlags: netDriver.selfFlags,
        spawned: p?.spawned ?? false,
        contactSet: p?.remotes.size ?? 0,
        offset: Math.hypot(o.x, o.y, o.z),
        remoteFlags: Object.fromEntries(Object.keys(state.remotePlayers).map(id => [id, remoteFlags(id)])),
        stats: { ...netDriver.stats },
        reconnects: connectionInfo.reconnects,
        resumed: connectionInfo.resumed,
        lastCloseCode: connectionInfo.lastCloseCode,
        overlay: connectionOverlayText(),
        suspended: netDriver.suspended,
        netsim: NETSIM
    };
}

export function installE2EHook(): void {
    if (!isE2EEnabled(window.location.search)) return;
    (window as unknown as { __bulliNet: { snapshot(): NetDebugSnapshot } }).__bulliNet = { snapshot: netSnapshot };

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
                score: state.scoreboard.find(entry => entry.id === state.myId)?.score ?? 0,
                room: state.room ? { ...state.room } : null,
                items: { coins: state.coins.length, powerups: state.worldPowerups.length },
                local: state.bulli ? carSnapshot(state.bulli) : null,
                remotes,
                inputs: { throttle: state.inputs.throttle, steer: state.inputs.steer },
                frameTime: state.frameAt,
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
        // The race or time trial of the room (null elsewhere)
        race: raceSnapshot,
        // Meshes and triangles of the track dressing and the map features
        // (docs/phase-2-design.md, 17.4: at most +20 draw calls, +30 k triangles)
        raceDressing(): { meshes: number; triangles: number } {
            let meshes = 0, triangles = 0;
            for (const name of ['race-track', 'race-map-features']) {
                state.scene?.getObjectByName(name)?.traverse(object => {
                    const mesh = object as THREE.Mesh;
                    if (!mesh.isMesh) return;
                    meshes++;
                    const index = mesh.geometry.index;
                    const perInstance = (index ? index.count : mesh.geometry.attributes.position.count) / 3;
                    triangles += perInstance * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
                });
            }
            return { meshes, triangles };
        },
        // The same as the sim's collider list (shared/map/mapData.ts)
        colliders(): ColliderInput[] {
            return state.worldColliders.map(collider => ({ ...collider }));
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
        worldInfo,
        // Resolves once the world textures and the sky HDRIs are in and the
        // environment map is final
        async worldSettled(): Promise<WorldInfo> {
            await whenWorldTexturesLoaded();
            await whenSkyReady();
            await whenPalmImpostorsReady();
            return worldInfo();
        },
        // Palms farther than `meters` from the camera become impostors (null:
        // the tier's distance), to look at the impostors up close
        setPalmImpostorDistance(meters: number | null): void {
            setPalmImpostorDistance(meters, lightingTier());
        },
        // Puts an instance of a cached model on the ground at (x, z) (screenshots
        // of the models before the game uses them); false if it is not loaded
        spawnModel,
        clearModels,
        // A game car (CarModel) at (x, z) like a remote player's, for the
        // showroom screenshots; cleared with clearModels
        spawnCar,
        // How the local car / every live car is drawn (GLB LOD or procedural)
        localCarInfo(): CarInfo | null {
            return state.bulli ? carInfo(state.bulli.model) : null;
        },
        carModels(): CarInfo[] {
            return [...liveCarModels()].map(carInfo);
        },
        // Visible meshes (draw call sources) per top level scene object,
        // named by the object's name or type, for draw call budgets
        sceneMeshes(): Record<string, number> {
            const counts: Record<string, number> = {};
            for (const child of state.scene?.children ?? []) {
                if (!child.visible) continue;
                let meshes = 0;
                child.traverseVisible(object => {
                    if ((object as THREE.Mesh).isMesh || (object as THREE.Points).isPoints || (object as THREE.Line).isLine) meshes++;
                });
                if (!meshes) continue;
                const key = child.name || child.type;
                counts[key] = (counts[key] ?? 0) + meshes;
            }
            return counts;
        },
        // The map world: kit cells drawn and built, instances packed per
        // kind, terrain triangles, and visible meshes and triangles per
        // group of the map (draw call and triangle budgets)
        mapWorldStats(): MapWorldStats | null {
            const world = mapScene();
            if (!world) return null;
            const groups: Record<string, { meshes: number; triangles: number }> = {};
            for (const group of world.group.children) {
                let meshes = 0, triangles = 0;
                group.traverseVisible(object => {
                    const mesh = object as THREE.Mesh;
                    if (!mesh.isMesh) return;
                    meshes++;
                    const index = mesh.geometry.index;
                    const count = mesh.geometry.drawRange.count !== Infinity ? mesh.geometry.drawRange.count : (index ? index.count : mesh.geometry.attributes.position.count);
                    triangles += count / 3 * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
                });
                groups[group.name || group.type] = { meshes, triangles: Math.round(triangles) };
            }
            return { ...world.stats(), detail: mapDetail(), kit: kitStatus(), groups };
        },
        // Rendered objects that stand on a collider (world/colliderTags.ts)
        colliderProps(): TaggedCollider[] {
            return listTaggedColliders();
        },
        // Puts the local car at rest at (x, z), facing angle. Online the
        // server places it (debugPlace, only with E2E=1) and the next
        // snapshot brings it there; offline and in the sandbox right away.
        placeLocalCar(x: number, z: number, angle: number): void {
            const car = state.bulli;
            if (!car) throw new Error('No local car yet');
            if (netDriver.prediction && state.ws) {
                sendToServer({ type: 'debugPlace', x, z, yaw: angle });
                return;
            }
            car.group.position.x = x;
            car.group.position.z = z;
            car.angle = angle;
            car.group.rotation.y = angle;
            car.speed = 0;
            // v2 physics: the sim car is the source of the pose
            car.vehicle?.place(x, z, angle);
        },
        // Closes the socket as if the connection broke: the client
        // reconnects like after a lost connection, not before holdMs
        dropConnection(holdMs = 0): void {
            if (holdMs > 0) holdReconnect(holdMs);
            state.ws?.close(4999, 'e2e drop');
        },
        // The Party's coins of the room (positions from the seed)
        coins(): { id: number; x: number; z: number; collected: boolean }[] {
            return (state.serverCoins ?? []).map(c => ({ id: c.id, x: c.x, z: c.z, collected: c.collected }));
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
