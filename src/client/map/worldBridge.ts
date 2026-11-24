import * as THREE from 'three';
import type { DiscoveryAlloy } from '../../shared/map/discoverySchema.js';
import type { MapData } from '../../shared/map/mapData.js';
import { isMapId, mapDescriptor } from '../../shared/map/registry.js';
import { buildMapWorld, mapScene } from '../world/mapScene.js';
import { applyMapAtmosphere } from '../render/lighting.js';
import { playDiscoveryChime } from '../effects/sounds.js';
import type { ShowroomCamera } from '../camera/ShowroomCamera.js';
import type { MapWorld } from '../world/mapWorld.js';

// Typed integration facade connecting server-ui (websocket/menu/codex/main)
// with client-engine (MapScene, MapWorld, lighting, ShowroomCamera, sounds).

let activeShowroom: ShowroomCamera | null = null;

/** Registers the active ShowroomCamera so map swaps can move its spot cleanly. */
export function registerShowroomCamera(camera: ShowroomCamera | null): void {
    activeShowroom = camera;
}

/** Returns the active MapWorld instance (null before the first map mounts). */
export function activeMapWorld(): MapWorld | null {
    return mapScene();
}

/** Builds or live-replaces the rendered MapWorld in state.scene without a page reload. */
export function mountMapWorld(map: MapData): MapWorld {
    return buildMapWorld(map);
}

/** Applies the map's atmospheric lighting, sky, fog, and exposure preset live. */
export function applyAtmosphereForMap(map: MapData): void {
    applyMapAtmosphere(map.atmosphere);
}

/** Moves the menu showroom camera to the target map's scenic spot. */
export function applyShowroomSpotForMap(map: MapData): void {
    if (!activeShowroom) return;
    if (isMapId(map.mapId)) {
        const desc = mapDescriptor(map.mapId);
        activeShowroom.setSpot(desc.showroomSpot, map);
    }
    activeShowroom.invalidate();
}

const ORIGIN_FOCUS = new THREE.Vector3();

/** Per-frame dynamic world animations (beacons, boost pads, monuments, props). */
export function updateWorldDynamic(dt: number, elapsedSec: number, focusPos?: THREE.Vector3): void {
    activeMapWorld()?.updateDynamic(dt, elapsedSec, focusPos ?? ORIGIN_FOCUS);
}

/** Updates 3D discovery beacon & highlight states in MapWorld. */
export function syncWorldDiscoveries(foundIds: ReadonlySet<string>, pinnedId: string | null): void {
    activeMapWorld()?.setDiscoveredIds(foundIds, pinnedId);
}

/**
 * Triggers celebratory 3D visual FX & audio chime for a newly found discovery.
 * MapWorld.triggerDiscoveryFx already fires the alloy-matched chime + particles
 * + monument reaction; fall back to a standalone chime only if no world is mounted.
 */
export function triggerWorldDiscoveryFx(discoveryId: string, alloy?: DiscoveryAlloy): void {
    const world = activeMapWorld();
    if (world) {
        world.triggerDiscoveryFx(discoveryId);
        return;
    }
    playDiscoveryChime(alloy);
}

/** Rebuilds #race-lobby .race-tracks buttons so every map exposes its own tracks. */
export function syncRaceLobbyTracks(map: MapData): void {
    const container = document.querySelector<HTMLElement>('#race-lobby .race-tracks');
    if (!container) return;
    const routes = map.sources.tracks.tracks;
    if (!routes.length) return;

    container.replaceChildren(...routes.map(route => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'race-segment';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.dataset.track = route.id;
        const nameNode = document.createTextNode(route.name.toUpperCase());
        const detail = document.createElement('small');
        const kindLabel = route.kind === 'circuit' ? `${route.laps ?? 3} laps` : 'sprint';
        detail.textContent = `${kindLabel} · ${map.name.toLowerCase()}`;
        button.append(nameNode, detail);
        return button;
    }));
}
