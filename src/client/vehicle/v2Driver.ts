import { DEFAULT_TERRAIN_CONFIG } from '../../shared/constants.js';
import type { Bulli } from '../entities/Bulli.js';
import { playCollisionSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
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
    if (state.isModalOpen || state.dead) return;
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
    }
    if (ev.reset) state.cameraSnapPending = true;
    if (vehicle.hintChanged && vehicle.resetHint) {
        showInteractionPrompt(inputManager.touchUi ? 'HOLD ↻ TO RESET' : 'HOLD R TO RESET');
    }
    // Tyre smoke from both rear wheels while drifting
    if (s.driftTicks > 0 && s.grounded) {
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
        const back = s.x - fx * 1.6, backZ = s.z - fz * 1.6;
        for (const side of [-1, 1]) {
            spawnParticles(back + fz * side, s.y + 0.3, backZ - fx * side, 0xEEEEEE, 1, 0.6, 0.4, 0.15);
        }
    }
}
