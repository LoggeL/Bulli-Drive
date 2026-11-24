import * as THREE from 'three';
import type { MapData } from '../../shared/map/mapData.js';
import { isMapId, mapDescriptor, type MapAtmosphereSpec } from '../../shared/map/registry.js';
import { state } from '../state.js';
import * as mapSceneMod from '../world/mapScene.js';
import * as lookMod from '../render/look.js';
import * as lightingMod from '../render/lighting.js';
import * as soundsMod from '../effects/sounds.js';
import type { ShowroomCamera } from '../camera/ShowroomCamera.js';
import type { MapWorld } from '../world/mapWorld.js';

// Safe typed bridge between @server-ui and @client-engine's Wave 2B methods.
// All new methods agreed across branches are invoked cleanly through optional
// checks so feat/server-ui compiles standalone with zero errors AND lights up
// all new rendering/audio/showroom features automatically once merged.

interface ExtendedMapWorld extends MapWorld {
    dispose?: () => void;
    updateDynamic?: (dt: number, elapsedSec: number, focusPos?: THREE.Vector3) => void;
    setDiscoveredIds?: (foundIds: ReadonlySet<string>, pinnedId?: string | null) => void;
    triggerDiscoveryFx?: (discoveryId: string) => void;
}

interface ExtendedMapSceneModule {
    createMapScene: typeof mapSceneMod.createMapScene;
    mapScene: typeof mapSceneMod.mapScene;
    buildMapWorld?: (map: MapData) => MapWorld;
    disposeMapScene?: () => void;
    replaceMapScene?: (map: MapData) => MapWorld;
}

interface ExtendedLookModule {
    applyMapAtmosphere?: (
        spec: MapAtmosphereSpec,
        ctx?: { scene?: THREE.Scene; renderer?: THREE.WebGLRenderer }
    ) => void;
}

interface ExtendedLightingModule {
    applyMapAtmosphere?: (spec: MapAtmosphereSpec) => void;
}

interface ExtendedShowroomCamera extends ShowroomCamera {
    setSpot?: (spot: { x: number; z: number; yaw: number }, map?: MapData) => void;
}

interface ExtendedSoundsModule {
    playDiscoveryChime?: (effect?: string) => void;
    playCollectSound?: () => void;
}

let activeShowroom: ExtendedShowroomCamera | null = null;
let fallbackWorld: ExtendedMapWorld | null = null;

/** Registers the active ShowroomCamera so map swaps can move its spot cleanly. */
export function registerShowroomCamera(camera: ShowroomCamera | null): void {
    activeShowroom = camera as ExtendedShowroomCamera | null;
}

/** Returns the active MapWorld instance (from mapScene or fallback swap). */
export function activeMapWorld(): ExtendedMapWorld | null {
    return (fallbackWorld ?? mapSceneMod.mapScene()) as ExtendedMapWorld | null;
}

/**
 * Builds or live-replaces the rendered MapWorld in state.scene without a page
 * reload. Uses @client-engine's replaceMapScene/disposeMapScene when present,
 * and falls back gracefully if mapScene.ts has not yet been merged.
 */
export function mountMapWorld(map: MapData): MapWorld {
    const mod = mapSceneMod as unknown as ExtendedMapSceneModule;
    if (typeof mod.buildMapWorld === 'function') {
        fallbackWorld = null;
        return mod.buildMapWorld(map);
    }
    if (typeof mod.replaceMapScene === 'function') {
        fallbackWorld = null;
        return mod.replaceMapScene(map);
    }

    const existing = activeMapWorld();
    if (!existing) {
        return mod.createMapScene(map);
    }

    if (typeof mod.disposeMapScene === 'function') {
        mod.disposeMapScene();
        fallbackWorld = null;
        return mod.createMapScene(map);
    }

    // Fallback path before Wave 2B merge: dispose old world group cleanly
    existing.dispose?.();
    if (existing.group.parent) existing.group.parent.remove(existing.group);
    return mod.createMapScene(map);
}

/** Applies the map's atmospheric lighting/fog/exposure preset safely. */
export function applyAtmosphereForMap(map: MapData): void {
    const spec = map.atmosphere;
    const lighting = lightingMod as unknown as ExtendedLightingModule;
    const look = lookMod as unknown as ExtendedLookModule;
    if (typeof lighting.applyMapAtmosphere === 'function') {
        lighting.applyMapAtmosphere(spec);
        return;
    }
    if (typeof look.applyMapAtmosphere === 'function') {
        look.applyMapAtmosphere(spec, { scene: state.scene, renderer: state.renderer });
        return;
    }
    // Lightweight fallback so biome fog & exposure still visibly shift pre-merge
    if (state.scene?.fog instanceof THREE.Fog) {
        state.scene.fog.color.setHex(spec.fogColor);
        state.scene.fog.near = spec.fogNear;
        state.scene.fog.far = spec.fogFar;
    }
    if (state.renderer) {
        state.renderer.toneMappingExposure = spec.exposure;
    }
}

/** Moves the menu showroom camera to the target map's scenic spot if supported. */
export function applyShowroomSpotForMap(map: MapData): void {
    if (!activeShowroom) return;
    if (isMapId(map.mapId)) {
        const desc = mapDescriptor(map.mapId);
        activeShowroom.setSpot?.(desc.showroomSpot, map);
    }
    activeShowroom.invalidate();
}

const ORIGIN_FOCUS = new THREE.Vector3();

/** Per-frame dynamic world animations (beacons, boost pads, wind, snow, props). */
export function updateWorldDynamic(dt: number, elapsedSec: number, focusPos?: THREE.Vector3): void {
    activeMapWorld()?.updateDynamic?.(dt, elapsedSec, focusPos ?? ORIGIN_FOCUS);
}

/** Updates 3D discovery beacon & highlight states in MapWorld. */
export function syncWorldDiscoveries(foundIds: ReadonlySet<string>, pinnedId: string | null): void {
    activeMapWorld()?.setDiscoveredIds?.(foundIds, pinnedId);
}

/** Triggers celebratory 3D visual FX & audio chime for a newly found discovery. */
export function triggerWorldDiscoveryFx(discoveryId: string, effect?: string): void {
    activeMapWorld()?.triggerDiscoveryFx?.(discoveryId);
    const sounds = soundsMod as unknown as ExtendedSoundsModule;
    if (typeof sounds.playDiscoveryChime === 'function') {
        sounds.playDiscoveryChime(effect);
    } else if (typeof sounds.playCollectSound === 'function') {
        sounds.playCollectSound();
    }
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
