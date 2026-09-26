import type * as THREE from 'three';
import type { MapData } from '../../shared/map/mapData.js';
import type { RoomKind } from '../../shared/protocol.js';
import { lightingTier } from '../render/lighting.js';
import { state } from '../state.js';
import { loadKit, type KitCatalog } from './kit.js';
import { MapWorld } from './mapWorld.js';
import { worldMaterials } from './worldMaterials.js';
import { WORLD_QUALITY, worldDetailFor, type WorldDetail } from './worldQuality.js';

// The page's one map world (world/mapWorld.ts): the kit starts loading with
// the renderer (while the splash screen is up, like the car models), the
// world is built when the first room arrives (network/websocket.ts) and
// updated every frame (main.ts).

let world: MapWorld | null = null;
let kit: Promise<KitCatalog | null> = Promise.resolve(null);
let kitStarted = false;
let kitFailed = false;
let detail: WorldDetail = 'high';

/** Starts loading the building kit (idempotent). A failed kit leaves the map without buildings, not broken. */
export function startKitPreload(renderer: THREE.WebGLRenderer): void {
    if (kitStarted) return;
    kitStarted = true;
    kit = loadKit(renderer, lightingTier()).catch(error => {
        kitFailed = true;
        console.warn('Building kit failed to load, the map stays without buildings', error);
        return null;
    });
}

/** Resolves once the kit has loaded (or failed). */
export function whenKitReady(): Promise<void> {
    return kit.then(() => undefined);
}

export function kitStatus(): 'none' | 'loading' | 'ready' | 'failed' {
    if (!kitStarted) return 'none';
    if (kitFailed) return 'failed';
    return world?.hasKit() ? 'ready' : 'loading';
}

/** Builds the map's world into the scene (once per page). */
export function createMapScene(map: MapData): MapWorld {
    if (world) return world;
    const tier = lightingTier();
    detail = worldDetailFor(tier, typeof window === 'undefined' ? '' : window.location.search);
    world = new MapWorld(map, tier, worldMaterials(), WORLD_QUALITY[detail], state.renderer ?? null);
    state.scene.add(world.group);
    const built = world;
    kit.then(catalog => { if (catalog) built.attachKit(catalog); });
    return world;
}

/** Per frame before rendering. */
export function updateMapScene(camera: THREE.Camera): void {
    world?.update(camera);
}

export function setMapSceneRoom(kind: RoomKind | null): void {
    world?.setRoom(kind);
}

/** A desktop whose GPU cannot keep up even at the lowest resolution drops to the mid detail level. */
export function lowerMapDetail(): boolean {
    if (!world || detail !== 'high') return false;
    detail = 'mid';
    world.setQuality(WORLD_QUALITY.mid);
    console.info('[world] detail lowered to mid');
    return true;
}

export function mapScene(): MapWorld | null {
    return world;
}

export function mapDetail(): WorldDetail {
    return detail;
}
