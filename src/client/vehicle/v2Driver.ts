import { SURFACE } from '../../shared/map/types.js';
import { kickActiveChaseCamera } from '../camera/ChaseCamera.js';
import type { Bulli } from '../entities/Bulli.js';
import { playBoostPadSound, playCollisionSound, playDriftKickSound, updateSurfaceSound } from '../effects/sounds.js';
import { spawnBoostPadBurst, spawnDriftSparks, spawnParticles, spawnSurfaceTireParticle } from '../effects/particles.js';
import { gameHooks } from '../game/hooks.js';
import { createPadState, findStandardPad, readPad } from '../input/gamepad.js';
import { inputManager } from '../input/InputManager.js';
import { state } from '../state.js';
import { isWebGLContextLost } from '../ui/contextLoss.js';
import { showInteractionPrompt } from '../ui/hud.js';
import { LocalVehicle } from './LocalVehicle.js';
import { netDriver } from '../net/netDriver.js';
import { POWERUP_TYPE_IDS } from '../../shared/party/rules.js';
import { TICK_RATE } from '../../shared/net/constants.js';
import { currentSimWorld } from './simWorldClient.js';

// The frame of the local car on the v2 physics (docs/phase-1a-design.md,
// 12.3): gamepad poll, fixed-step ticks, pose, sounds and particles from
// the sim events. Online the ticks run through the prediction
// (net/netDriver.ts), which also sends the inputs.

// Wall hits louder than these play a sound / throw sparks (section 7.3)
const WALL_SOUND_FROM = 7.5;
const WALL_SPARKS_FROM = 12;
const CAR_SOUND_FROM = 3;

const pad = createPadState();
let touchUiQuery: MediaQueryList | null = null;

function touchUiActive(): boolean {
    if (!touchUiQuery && typeof window.matchMedia === 'function') {
        // The same query that shows #mobile-controls (style.css)
        touchUiQuery = window.matchMedia('(max-width: 768px), (pointer: coarse)');
    }
    return touchUiQuery?.matches ?? false;
}

function pollGamepad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;
    const found = findStandardPad(pads);
    inputManager.setPad(found ? readPad(found, pad) : null);
}

inputManager.onAction = (action) => {
    // Not in the menu: its LB/RB change the car, X nothing
    if (state.isModalOpen || state.inMenu || state.dead) return;
    if (action === 'shoot') state.inputs.e = true;
    else state.inputs.f = true;
};

export function driveLocalCar(car: Bulli, dt: number): void {
    // The sandbox brings its own world (game/hooks.ts)
    const world = gameHooks.world ?? currentSimWorld();
    const online = !gameHooks.world && netDriver.prediction !== null;
    if (!car.vehicle) {
        car.vehicle = LocalVehicle.forHost(car, world);
        if (online) {
            car.vehicle.net = netDriver;
            netDriver.bindCar(car.vehicle.car);
        }
    }
    const vehicle = car.vehicle;
    vehicle.world = world;

    if (online) {
        // Online the client keeps ticking with stop inputs while frozen
        // (docs/phase-1b-design.md, 5.4); dead, the car is just not in the sim
        inputManager.touchUi = touchUiActive();
        pollGamepad();
        vehicle.update(dt, car, performance.now());
        if (netDriver.cameraSnap) {
            netDriver.cameraSnap = false;
            state.cameraSnapPending = true;
        }
        showPowerupWindows(car);
    } else {
        // Frozen while a modal is open, while dead and
        // while the GL context is gone; the powerup timers keep running
        if (state.isModalOpen || state.dead || isWebGLContextLost()) {
            vehicle.loop.reset();
            vehicle.countPowerups(car, dt);
            return;
        }
        inputManager.touchUi = touchUiActive();
        pollGamepad();
        vehicle.update(dt, car, performance.now());
    }

    // Mirror of the drive axes for the engine sound, the HUD and the e2e hook
    const axes = inputManager.lastAxes;
    state.inputs.throttle = axes.throttle - axes.brake;
    state.inputs.steer = axes.steer;

    car.handleActions();
    playEventEffects(vehicle);
    vehicle.endFrame();
}

// Online the prediction also ticks between frames: a slow renderer (a
// weak phone, software WebGL) must not delay the inputs to the server
// (docs/phase-1b-design.md, 20.2)
let pumpTimer = 0;
export function startNetPump(): void {
    if (pumpTimer) return;
    const pump = () => {
        const car = state.bulli as Bulli | null;
        const vehicle = car?.vehicle;
        if (car && vehicle?.net) vehicle.pumpNet(car, performance.now());
        pumpTimer = window.setTimeout(pump, 4);
    };
    pumpTimer = window.setTimeout(pump, 4);
}

// The HUD's powerup bars and the shield bubble from the server's windows
function showPowerupWindows(car: Bulli): void {
    const tick = netDriver.tick;
    for (const type of POWERUP_TYPE_IDS) {
        const window = netDriver.windows[type];
        const active = tick >= 0 && window.start <= tick && tick < window.end;
        car.powerups[type].active = active;
        car.powerups[type].timer = active ? (window.end - tick) / TICK_RATE : 0;
    }
    state.respawnShield = netDriver.respawnShieldNow;
}

function playEventEffects(vehicle: LocalVehicle): void {
    const ev = vehicle.events;
    const s = vehicle.car.state;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const forwardSpeed = vehicle.forwardSpeed;

    if (ev.wallImpact > WALL_SOUND_FROM) {
        playCollisionSound(ev.wallImpact / 30);
        const y = vehicle.world.groundHeight(ev.wallX, ev.wallZ) + 1.2;
        const count = Math.min(16, Math.floor(ev.wallImpact / 2));
        spawnParticles(ev.wallX, y, ev.wallZ, 0xCFC6B8, count, 0.5, 2.5, 0.4);
        if (ev.wallImpact > WALL_SPARKS_FROM) spawnParticles(ev.wallX, y, ev.wallZ, 0xFFB347, 6, 0.3, 2.0, 0.5);
    }
    if (ev.carImpact > CAR_SOUND_FROM) {
        playCollisionSound(Math.min(1, ev.carImpact / 15));
        spawnParticles(s.x, s.y + 1.2, s.z, 0xFFB347, Math.min(12, Math.floor(ev.carImpact)), 0.3, 2.0, 0.5);
    }
    if (ev.landedImpact > 6) {
        spawnParticles(s.x, s.y + 0.2, s.z, 0xCFC6B8, Math.min(10, Math.floor(ev.landedImpact / 2)), 0.5, 3.0, 0.2);
        if (ev.landedImpact > 10) kickActiveChaseCamera(Math.min(0.14, ev.landedImpact * 0.008));
    }
    if (ev.boostStarted) {
        kickActiveChaseCamera(0.06, 2.5);
    }
    if (ev.boostPadTriggered) {
        spawnBoostPadBurst(s.x, s.y, s.z, s.yaw);
        playBoostPadSound();
        kickActiveChaseCamera(0.14, 5.5);
    }
    if (ev.driftKick > 0.1) {
        const kickTier: 1 | 2 | 3 = ev.driftKick >= 5.5 ? 3 : ev.driftKick >= 3.2 ? 2 : 1;
        playDriftKickSound(kickTier);
        kickActiveChaseCamera(0.05 + kickTier * 0.03, 1.5 + kickTier * 1.2);
        const exhaustX = s.x - fx * 2.1, exhaustZ = s.z - fz * 2.1;
        spawnParticles(exhaustX, s.y + 0.45, exhaustZ, kickTier === 3 ? 0xE879F9 : 0xFF8800, 10 + kickTier * 4, 0.45, 1.4, 0.45);
    }
    if (ev.reset) state.cameraSnapPending = true;
    if (vehicle.hintChanged && vehicle.resetHint) {
        showInteractionPrompt(inputManager.touchUi ? 'HOLD RESET BUTTON' : 'HOLD R TO RESET');
    }

    const backX = s.x - fx * 1.6, backZ = s.z - fz * 1.6;
    // Tiered drift sparks & surface-aware rear tire smoke/spray
    if (s.driftTicks > 0 && s.grounded) {
        for (const side of [-1, 1]) {
            spawnSurfaceTireParticle(backX + fz * side * 0.9, s.y, backZ - fx * side * 0.9, ev.surface, 1.15);
        }
        if (ev.driftTier !== 0) {
            spawnDriftSparks(s.x, s.y, s.z, s.yaw, ev.driftTier);
        }
    } else if (s.grounded && Math.abs(forwardSpeed) > 7) {
        // Loose / winter surface spray even while driving straight
        const loose = ev.surface === SURFACE.snow || ev.surface === SURFACE.ice
            || ev.surface === SURFACE.sand || ev.surface === SURFACE.gravel || ev.surface === SURFACE.dirt;
        if (loose && (vehicle.ticks % 2 === 0)) {
            const side = (vehicle.ticks % 4 === 0) ? 1 : -1;
            spawnSurfaceTireParticle(backX + fz * side * 0.9, s.y, backZ - fx * side * 0.9, ev.surface, Math.min(1, Math.abs(forwardSpeed) / 22));
        }
    }

    updateSurfaceSound(ev.surface, forwardSpeed, vehicle.slipAngle, s.grounded);
}
