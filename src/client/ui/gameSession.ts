import * as THREE from 'three';
import { paintById, type PaintId } from '../../shared/paints.js';
import type { ProfileId } from '../../shared/protocol.js';
import { state } from '../state.js';
import { Bulli, type CarType } from '../entities/Bulli.js';
import { sendToServer } from '../network/socket.js';
import { markPlayerReady } from '../network/websocket.js';
import { initSounds, startEngineSound } from '../effects/sounds.js';
import { assistProfileForDevice, type LocalVehicle } from '../vehicle/LocalVehicle.js';
import { ChaseCamera, RACE_CAMERA_SLIP_BLEND, type ChaseTarget } from '../camera/ChaseCamera.js';
import type { ShowroomCamera } from '../camera/ShowroomCamera.js';
import { raceClient } from '../race/RaceClient.js';
import { waitForGameAssets } from './assetGate.js';
import { closeMenu } from './menu/menu.js';
import type { MenuChoice } from './menu/menuState.js';
import { applyMenuMode } from './roomMenu.js';
import { discoveryTracker } from './discoveryTracker.js';

// Extracted local session, vehicle swap, chase-camera target, and discovery
// trigger helpers so src/client/main.ts stays compact and easy to navigate.

const _chaseTarget: ChaseTarget = { position: new THREE.Vector3(), yaw: 0, speedRatio: 0, boost: false };

/** Replaces the local vehicle body mesh & informs the server. */
export function switchLocalCar(carType: string): void {
    localStorage.setItem('bulli-car-type', carType);
    state.myCarType = carType;
    if (state.bulli && state.bulli.carType !== carType) {
        const previousPosition = state.bulli.group.position.clone();
        const previousAngle = state.bulli.angle;
        const visible = state.bulli.bodyGroup.visible;
        state.scene.remove(state.bulli.group);
        state.bulli.dispose();

        state.bulli = new Bulli(state.myColor ?? 0xD32F2F, true, carType as CarType);
        state.bulli.group.position.copy(previousPosition);
        state.bulli.angle = previousAngle;
        state.bulli.group.rotation.y = previousAngle;
        state.bulli.bodyGroup.visible = visible;
        state.bulli.createNametag(state.myName, true);
        state.scene.add(state.bulli.group);
    }
    sendToServer({ type: 'setCar', carType, profile: assistProfileForDevice() as ProfileId });
}

/** Repaints the local car in-place and tells the server. */
export function repaintLocalCar(paint: PaintId, showroom: ShowroomCamera | null): void {
    const hex = paintById(paint).hex;
    state.myColor = hex;
    state.bulli?.setPaint(hex);
    showroom?.invalidate();
    sendToServer({ type: 'setPaint', paint });
}

/** Handles DRIVE from the Main Menu: sounds, assets, map+mode switch, ready, camera transition. */
export async function startFromMenu(choice: MenuChoice, showroom: ShowroomCamera | null): Promise<void> {
    if (state.audioCtx?.state === 'suspended') await state.audioCtx.resume();
    // Sounds decode while the last textures and car models finish streaming
    await Promise.all([initSounds(), waitForGameAssets()]);
    startEngineSound();

    state.myName = choice.name;
    sendToServer({ type: 'rename', name: choice.name });
    switchLocalCar(choice.car);
    applyMenuMode(choice.mode, choice.map);
    sendToServer({ type: 'ready' });
    markPlayerReady();
    state.inMenu = false;
    closeMenu();

    if (!showroom) {
        document.body.classList.remove('in-menu');
        return;
    }
    void showroom.startTransition(state.camera).then(() => document.body.classList.remove('in-menu'));
}

/** Updates chase camera framing for either a spectated racer or the local car. */
export function updateRaceCamera(
    chaseCamera: ChaseCamera,
    dt: number,
    carPos: THREE.Vector3,
    vehicle: LocalVehicle,
    camera: THREE.PerspectiveCamera
): void {
    const spectate = raceClient.spectateTarget();
    if (spectate) {
        _chaseTarget.position.copy(spectate.position);
        _chaseTarget.position.y += spectate.airHeight;
        _chaseTarget.yaw = spectate.yaw;
        _chaseTarget.speedRatio = 0.5;
        _chaseTarget.boost = false;
        if (chaseCamera.update(dt, camera, _chaseTarget, state.cameraSnapPending)) state.cameraSnapPending = false;
        return;
    }
    const s = vehicle.car.state;
    const u = vehicle.forwardSpeed;
    _chaseTarget.position.copy(carPos);
    _chaseTarget.position.y += vehicle.airHeight;
    _chaseTarget.yaw = vehicle.pose.yaw
        + RACE_CAMERA_SLIP_BLEND * vehicle.slipAngle * Math.max(0, Math.min(1, u / 10));
    _chaseTarget.speedRatio = Math.min(1, Math.abs(u) / Math.max(1, vehicle.car.params.topSpeed));
    _chaseTarget.boost = s.boosting || vehicle.car.mods.turbo;
    if (chaseCamera.update(dt, camera, _chaseTarget, state.cameraSnapPending)) {
        state.cameraSnapPending = false;
    }
}

/** Evaluates horn & per-frame movement triggers against the active map's discoveries. */
export function pollLocalHornForDiscovery(): void {
    if (!state.bulli || !state.inputs.f || state.dead || state.isModalOpen || state.inMenu) return;
    const pos = state.bulli.group.position;
    discoveryTracker.onHorn(pos.x, pos.z);
}

export function stepDiscoveriesForLocalCar(dt: number, vehicle: LocalVehicle | undefined): void {
    if (!state.bulli || state.inMenu || state.dead) return;
    const pos = state.bulli.group.position;
    // LocalVehicle exposes true sim velocity in m/s; fallback converts bulli.speed (m/tick)
    const speedMs = vehicle
        ? Math.hypot(vehicle.car.state.vx, vehicle.car.state.vz)
        : Math.abs(state.bulli.speed) * 60;
    const airborne = (vehicle?.airHeight ?? 0) > 0.35;
    discoveryTracker.update({ x: pos.x, z: pos.z, speedMs, airborne, dt });
}
