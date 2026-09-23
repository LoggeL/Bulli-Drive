import { DEFAULT_TERRAIN_CONFIG } from '../../shared/constants.js';
import type { Bulli } from '../entities/Bulli.js';
import { playCollisionSound, playJumpSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { gameHooks } from '../game/hooks.js';
import { createPadState, findStandardPad, readPad } from '../input/gamepad.js';
import { inputManager } from '../input/InputManager.js';
import { state } from '../state.js';
import { isWebGLContextLost } from '../ui/contextLoss.js';
import { showInteractionPrompt } from '../ui/hud.js';
import { LocalVehicle } from './LocalVehicle.js';
import { simWorldFor } from './simWorldClient.js';

// The frame of the local car on the v2 physics (docs/phase-1a-design.md,
// 12.3): gamepad poll, fixed-step ticks, pose, sounds and particles from
// the sim events, then the unchanged position update to the server.

// Wall hits louder than these play a sound / throw sparks (legacy 0.125 and
// 0.2 units per tick, section 7.3)
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
    const world = gameHooks.world ?? simWorldFor(state.terrainConfig ?? DEFAULT_TERRAIN_CONFIG, state.obstacles);
    if (!car.vehicle) car.vehicle = LocalVehicle.forHost(car, world);
    const vehicle = car.vehicle;
    vehicle.world = world;

    // Frozen like the legacy car while a modal is open, while dead and
    // while the GL context is gone; the powerup timers keep running
    if (state.isModalOpen || state.dead || isWebGLContextLost()) {
        vehicle.loop.reset();
        vehicle.countPowerups(car, dt);
        return;
    }

    inputManager.touchUi = touchUiActive();
    pollGamepad();
    vehicle.update(dt, car, performance.now());

    // Mirror of the drive axes for the engine sound, the HUD and the e2e hook
    const axes = inputManager.lastAxes;
    state.inputs.throttle = axes.throttle - axes.brake;
    state.inputs.steer = axes.steer;

    car.handleActions();
    playEventEffects(vehicle);
    car.sendMovementSnapshot(performance.now(), vehicle.moving);
}

function playEventEffects(vehicle: LocalVehicle): void {
    const ev = vehicle.events;
    const s = vehicle.car.state;
    if (ev.jumped) playJumpSound();
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
        showInteractionPrompt(inputManager.touchUi ? 'HOLD JUMP TO RESET' : 'HOLD R TO RESET');
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
