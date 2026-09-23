import * as THREE from 'three';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle, spawnBoostFireParticle, spawnDamageSmoke } from './effects/particles.js';
import { updateJumpControl, showInteractionPrompt } from './ui/hud.js';
import { initSounds, startEngineSound, updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, animateCoins } from './world/coins.js';
import { animatePowerups } from './world/powerups.js';
import { updatePowerupsUI, updateSpeedometer, updateHealthBar, updateDriveHud } from './ui/hud.js';
import { updateProjectiles } from './world/projectiles.js';
import { initSplashScreen, initAboutModal } from './ui/screens.js';
import { applySplashChoice, initModeSelector, initRoomMenu } from './ui/roomMenu.js';
import { animateFountain } from './world/city.js';
import { updateMinimap } from './ui/minimap.js';
import { Bulli, type CarType } from './entities/Bulli.js';
import { sendToServer } from './network/socket.js';
import { AdaptiveRenderQuality } from './effects/renderQuality.js';
import { updateWorldShaders } from './effects/worldShaders.js';
import { ensureCurrentBuild } from './buildVersion.js';
import { installE2EHook } from './e2eHook.js';
import { watchWebGLContext, isWebGLContextLost } from './ui/contextLoss.js';
import { installPerfMonitor, type PerfMonitor } from './debug/perfMonitor.js';
import { setupLighting, updateLighting } from './render/lighting.js';
import { ChaseCamera, RACE_CAMERA, RACE_CAMERA_SLIP_BLEND, type ChaseTarget } from './camera/ChaseCamera.js';
import { SANDBOX, TUNE_PANEL, TUNE_REQUESTED } from './flags.js';
import { gameHooks } from './game/hooks.js';
import { assistProfileForDevice, type LocalVehicle } from './vehicle/LocalVehicle.js';
import { updateRemoteCars } from './net/remotes.js';
import type { ProfileId } from '../shared/protocol.js';

const chaseCamera = new ChaseCamera(RACE_CAMERA);
const _chaseTarget: ChaseTarget = { position: new THREE.Vector3(), yaw: 0, speedRatio: 0, boost: false };

let renderQuality: AdaptiveRenderQuality;
// Only set with ?debug=perf (FPS/draw call/bandwidth overlay)
let perfMonitor: PerfMonitor | null = null;

function init() {
    // Scene
    state.scene = new THREE.Scene();

    // Camera
    chaseCamera.refreshEnvelope();
    state.camera = new THREE.PerspectiveCamera(
        chaseCamera.baseFov,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    state.camera.position.set(0, RACE_CAMERA.height, RACE_CAMERA.distance);

    // Renderer
    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    renderQuality = new AdaptiveRenderQuality(state.renderer, window.innerWidth, window.innerHeight);
    // Tone mapping, sky, fog, environment, lights and shadows
    setupLighting(state.scene, state.renderer);
    document.body.appendChild(state.renderer.domElement);
    // Show a notice and pause rendering if the browser drops the GL context
    watchWebGLContext(state.renderer.domElement);

    // Audio Context
    try {
        (window as any).AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        state.audioCtx = new AudioContext();
    } catch (e) { /* ignore */ }

    // Splash Screen
    const splashScreen = document.getElementById('splash-screen');
    initSplashScreen(async (name, carType) => {
        // Resume audio
        if (state.audioCtx?.state === 'suspended') {
            await state.audioCtx.resume();
        }

        // Init and start sounds
        await initSounds();
        startEngineSound();

        // Save name and car type
        localStorage.setItem('bulli-player-name', name);
        localStorage.setItem('bulli-car-type', carType);
        state.myName = name;
        state.myCarType = carType;

        // Rebuild local car with selected type
        if (state.bulli) {
            const previousPosition = state.bulli.group.position.clone();
            const previousAngle = state.bulli.angle;
            state.scene.remove(state.bulli.group);
            state.bulli.dispose();

            state.bulli = new Bulli(state.myColor!, true, carType as CarType);
            state.bulli.group.position.copy(previousPosition);
            state.bulli.angle = previousAngle;
            state.bulli.group.rotation.y = previousAngle;
            state.bulli.createNametag(name, true);
            state.scene.add(state.bulli.group);
        }

        // Notify server of name and car type, move to the chosen mode
        // (Party or Free Roam), then the car spawns
        sendToServer({ type: 'rename', name });
        sendToServer({ type: 'setCar', carType, profile: assistProfileForDevice() as ProfileId });
        applySplashChoice();
        sendToServer({ type: 'ready' });

        // Hide splash screen
        if (splashScreen) {
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && splashScreen.contains(focused)) {
                focused.blur();
            }
            splashScreen.classList.add('hidden');
            splashScreen.inert = true;
        }
    });

    // Init WebSocket, or with ?sandbox=1 the offline test pad of the v2
    // physics instead (its own chunk, only loaded with the flag)
    if (SANDBOX) {
        import('./sandbox/sandbox.js')
            .then(sandbox => sandbox.startSandbox())
            .catch(error => console.error('Sandbox failed to load', error));
    } else {
        initWebSocket();
    }

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    initKeyboard();
    setupMobileControls();

    // UI modules
    initAboutModal();
    initModeSelector();
    initRoomMenu();

    // Test-only state probe, a no-op unless the page URL has ?e2e=1
    installE2EHook();
    // Performance overlay, a no-op unless the page URL has ?debug=perf
    perfMonitor = installPerfMonitor();
    // lil-gui tuning panel of the physics, only loaded with ?tune=1 in the
    // sandbox: online the server drives with the default tuning
    if (TUNE_PANEL) {
        import('./debug/tuningPanel.js')
            .then(panel => panel.installTuningPanel())
            .catch(error => console.error('Tuning panel failed to load', error));
    } else if (TUNE_REQUESTED) {
        showInteractionPrompt('TUNING ONLY IN THE SANDBOX (?sandbox=1&tune=1)');
    }

    // Start Loop
    requestAnimationFrame(animate);
}

function onWindowResize() {
    if (!state.camera || !state.renderer) return;
    chaseCamera.refreshEnvelope();
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    renderQuality.resize(window.innerWidth, window.innerHeight);
}

// The camera swings a little towards the travel direction in a drift
function updateRaceCamera(dt: number, carPos: THREE.Vector3, vehicle: LocalVehicle) {
    const s = vehicle.car.state;
    const u = vehicle.forwardSpeed;
    _chaseTarget.position.copy(carPos);
    _chaseTarget.yaw = vehicle.pose.yaw
        + RACE_CAMERA_SLIP_BLEND * vehicle.slipAngle * Math.max(0, Math.min(1, u / 10));
    _chaseTarget.speedRatio = Math.min(1, Math.abs(u) / Math.max(1, vehicle.car.params.topSpeed));
    _chaseTarget.boost = s.boosting || vehicle.car.mods.turbo;
    if (chaseCamera.update(dt, state.camera, _chaseTarget, state.cameraSnapPending)) {
        state.cameraSnapPending = false;
    }
}

function animate(frameTime: number) {
    requestAnimationFrame(animate);
    perfMonitor?.beginFrame();
    const dt = state.clock.getDelta();
    const time = state.clock.elapsedTime;

    if (state.bulli) {
        state.bulli.update(dt);

        // Update engine sound based on speed and jump height
        const isAccelerating = Math.abs(state.inputs.throttle) > 0.02;
        const turboActive = state.bulli.powerups.speed.active;
        // v2 only: the drift boost (Shift) sounds and burns like the Turbo
        const vehicle: LocalVehicle | undefined = state.bulli.vehicle;
        const boostActive = turboActive || !!vehicle?.car.state.boosting;
        const jumpHeight = state.bulli.flipGroup.position.y;
        updateEngineSound(state.bulli.speed, isAccelerating, boostActive, jumpHeight);

        // Update the automatic chase camera. Its yaw follows the car on the
        // shortest arc, while position, framing and FOV use independent damping
        // so a quick turn feels deliberate instead of whipping the view around.
        const carPos = state.bulli.group.position;
        if (vehicle) updateRaceCamera(dt, carPos, vehicle);

        // Effects based on speed
        const speed = Math.abs(state.bulli.speed);

        // Drift particles
        if (speed > 0.1) {
            spawnDriftParticle();
        }

        checkCoinCollection();
        updateProjectiles(dt);
        // Boost fire trails
        if (boostActive && speed > 0.05) {
            spawnBoostFireParticle();
        }

        updatePowerupsUI();
        updateSpeedometer();
        if (vehicle) updateDriveHud(vehicle);
        updateHealthBar();
        const jumpControlMode = state.bulli.canRecover
            ? 'recover'
            : (state.bulli.powerups.jump.active ? 'super-jump' : 'jump');
        updateJumpControl(jumpControlMode, !state.dead);

        // Damage smoke based on health
        if (state.health < 100 && !state.dead) {
            const damagePercent = 1 - state.health / 100;
            if (Math.random() < damagePercent * 0.3) {
                spawnDamageSmoke(
                    state.bulli.group.position.x,
                    state.bulli.group.position.y,
                    state.bulli.group.position.z,
                    state.health
                );
            }
        }
    }

    // Sandbox dummies and cones (game/hooks.ts, empty in the game)
    for (const hook of gameHooks.frame) hook(dt);

    // Animate world objects
    animateCoins(time);
    animatePowerups(time);
    animateFountain(time);

    // Remote cars: interpolated snapshots, the contact set predicted
    // (net/remotes.ts), idle ones grey
    updateRemoteCars(dt, performance.now(), state.bulli?.vehicle?.alpha ?? 0);
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id] as any;
        remote.update(dt);
        // Damage smoke for remote players
        if (remote.health < 100 && remote.flipGroup.visible) {
            const damagePercent = 1 - remote.health / 100;
            if (Math.random() < damagePercent * 0.15) {
                spawnDamageSmoke(
                    remote.group.position.x,
                    remote.group.position.y,
                    remote.group.position.z,
                    remote.health
                );
            }
        }
    }

    updateParticles(dt);
    updateMinimap(frameTime);

    // While the GL context is lost three.js skips rendering anyway; skip the
    // adaptive quality sampling too so the gap doesn't lower the resolution.
    if (state.renderer && state.scene && state.camera && !isWebGLContextLost()) {
        updateWorldShaders(state.clock.elapsedTime);
        updateLighting();
        renderQuality.update(frameTime);
        state.renderer.render(state.scene, state.camera);
    }

    perfMonitor?.endFrame(frameTime);
}

// Start the game (unless this page is a stale build that is about to reload)
ensureCurrentBuild().then(init);
