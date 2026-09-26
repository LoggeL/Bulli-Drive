import * as THREE from 'three';
import { state } from './state.js';
import { initWebSocket, markPlayerReady } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle, spawnBoostFireParticle, spawnDamageSmoke } from './effects/particles.js';
import { updateResetControl, showInteractionPrompt } from './ui/hud.js';
import { initSounds, startEngineSound, updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, animateCoins } from './world/coins.js';
import { animatePowerups } from './world/powerups.js';
import { updatePowerupsUI, updateSpeedometer, updateHealthBar, updateDriveHud } from './ui/hud.js';
import { updateProjectiles } from './world/projectiles.js';
import { initSplashScreen, initAboutModal } from './ui/screens.js';
import { applySplashChoice, initModeSelector, initRoomMenu } from './ui/roomMenu.js';
import { updatePalms } from './world/palms.js';
import { lowerMapDetail, startKitPreload, updateMapScene } from './world/mapScene.js';
import { updateMinimap } from './ui/minimap.js';
import { loadingScreenCovers } from './ui/loadingScreen.js';
import { Bulli, type CarType } from './entities/Bulli.js';
import { sendToServer } from './network/socket.js';
import { AdaptiveRenderQuality, detectRenderTier, wantsAntialias } from './effects/renderQuality.js';
import { updateWorldShaders } from './effects/worldShaders.js';
import { ensureCurrentBuild } from './buildVersion.js';
import { installE2EHook } from './e2eHook.js';
import { watchWebGLContext, isWebGLContextLost, showGraphicsUnavailable } from './ui/contextLoss.js';
import { isSafeMode } from './render/safeMode.js';
import { rememberGpu } from './net/clientReport.js';
import { installPerfMonitor, type PerfMonitor } from './debug/perfMonitor.js';
import { setupLighting, updateLighting } from './render/lighting.js';
import { renderFrame } from './render/frameStats.js';
import { startModelPreload } from './assets/gameModels.js';
import { waitForGameAssets } from './ui/assetGate.js';
import { updateCarModels } from './vehicle/CarModel.js';
import { ChaseCamera, RACE_CAMERA, RACE_CAMERA_SLIP_BLEND, type ChaseTarget } from './camera/ChaseCamera.js';
import { E2E_DRAW_INTERVAL_MS, SANDBOX, TUNE_PANEL, TUNE_REQUESTED } from './flags.js';
import { gameHooks } from './game/hooks.js';
import { assistProfileForDevice, type LocalVehicle } from './vehicle/LocalVehicle.js';
import { updateRemoteCars } from './net/remotes.js';
import type { ProfileId } from '../shared/protocol.js';
import { raceClient } from './race/RaceClient.js';

const chaseCamera = new ChaseCamera(RACE_CAMERA);
const _chaseTarget: ChaseTarget = { position: new THREE.Vector3(), yaw: 0, speedRatio: 0, boost: false };

let renderQuality: AdaptiveRenderQuality;

// A new body for the local car where the old one stood (the splash, the
// race lobby), saved for the next visit and told to the server
function switchLocalCar(carType: string): void {
    localStorage.setItem('bulli-car-type', carType);
    state.myCarType = carType;
    if (state.bulli && state.bulli.carType !== carType) {
        const previousPosition = state.bulli.group.position.clone();
        const previousAngle = state.bulli.angle;
        const visible = state.bulli.bodyGroup.visible;
        state.scene.remove(state.bulli.group);
        state.bulli.dispose();

        state.bulli = new Bulli(state.myColor!, true, carType as CarType);
        state.bulli.group.position.copy(previousPosition);
        state.bulli.angle = previousAngle;
        state.bulli.group.rotation.y = previousAngle;
        state.bulli.bodyGroup.visible = visible;
        state.bulli.createNametag(state.myName, true);
        state.scene.add(state.bulli.group);
    }
    sendToServer({ type: 'setCar', carType, profile: assistProfileForDevice() as ProfileId });
}
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
        // The rendered hills beyond the playable area reach 1.6 km out
        2600
    );
    state.camera.position.set(0, RACE_CAMERA.height, RACE_CAMERA.distance);

    // Renderer
    // The browser can refuse WebGL (e.g. blocked for the site after a GPU
    // crash): show why instead of an endless loading screen
    try {
        // Lite graphics (after trouble) and CPU rasterizers skip MSAA: its
        // buffers cost the most memory, and a third of every software frame
        state.renderer = new THREE.WebGLRenderer({ antialias: !isSafeMode() && wantsAntialias() });
    } catch (error) {
        console.error('WebGL is not available', error);
        showGraphicsUnavailable(error);
        return;
    }
    rememberGpu(state.renderer.getContext());
    renderQuality = new AdaptiveRenderQuality(
        state.renderer, window.innerWidth, window.innerHeight, detectRenderTier(state.renderer)
    );
    // Tone mapping, sky, fog, environment, lights and shadows
    setupLighting(state.scene, state.renderer);
    document.body.appendChild(state.renderer.domElement);
    // Show a notice and pause rendering if the browser drops the GL context
    watchWebGLContext(state.renderer.domElement);
    // Car models (GLB + KTX2) load and compile while the splash screen is up;
    // until they are there (or if they fail) the cars stay procedural
    startModelPreload(state.renderer, state.camera, state.scene)
        .catch(error => console.warn('Model preload failed', error));
    // The map's building kit (GLB + KTX2 atlas) loads alongside
    if (!SANDBOX) startKitPreload(state.renderer);

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

        // Init the sounds while the world textures and car models finish
        // loading (the start button shows the progress)
        await Promise.all([initSounds(), waitForGameAssets(document.getElementById('start-btn'))]);
        startEngineSound();

        // Save name and car type
        localStorage.setItem('bulli-player-name', name);
        state.myName = name;

        // Notify server of name and car type (the local car is rebuilt in
        // the chosen type), move to the chosen mode, then the car spawns
        sendToServer({ type: 'rename', name });
        switchLocalCar(carType);
        applySplashChoice();
        sendToServer({ type: 'ready' });
        markPlayerReady();

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
    raceClient.setCarSwitcher(switchLocalCar);

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

    // Start Loop (the first frame's dt counts from here, as with THREE.Clock)
    state.clock.reset();
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
    // A race spectator follows another car (race/RaceClient.ts)
    const spectate = raceClient.spectateTarget();
    if (spectate) {
        _chaseTarget.position.copy(spectate.position);
        _chaseTarget.position.y += spectate.airHeight;
        _chaseTarget.yaw = spectate.yaw;
        _chaseTarget.speedRatio = 0.5;
        _chaseTarget.boost = false;
        if (chaseCamera.update(dt, state.camera, _chaseTarget, state.cameraSnapPending)) state.cameraSnapPending = false;
        return;
    }
    const s = vehicle.car.state;
    const u = vehicle.forwardSpeed;
    // The camera follows the car into the air (ChaseCamera eases it)
    _chaseTarget.position.copy(carPos);
    _chaseTarget.position.y += vehicle.airHeight;
    _chaseTarget.yaw = vehicle.pose.yaw
        + RACE_CAMERA_SLIP_BLEND * vehicle.slipAngle * Math.max(0, Math.min(1, u / 10));
    _chaseTarget.speedRatio = Math.min(1, Math.abs(u) / Math.max(1, vehicle.car.params.topSpeed));
    _chaseTarget.boost = s.boosting || vehicle.car.mods.turbo;
    if (chaseCamera.update(dt, state.camera, _chaseTarget, state.cameraSnapPending)) {
        state.cameraSnapPending = false;
    }
}

// Last frame drawn under ?e2e=1&drawfps (flags.ts)
let lastDrawAt = -Infinity;

function animate(frameTime: number) {
    requestAnimationFrame(animate);
    perfMonitor?.beginFrame();
    // performance.now() rather than the rAF timestamp: the same clock
    // THREE.Clock read, so dt keeps its meaning
    state.frameAt = performance.now();
    const dt = state.clock.update(state.frameAt).getDelta();
    const time = state.clock.getElapsed();

    if (state.bulli) {
        state.bulli.update(dt);

        // Engine sound from the speed and the height in the air
        const isAccelerating = Math.abs(state.inputs.throttle) > 0.02;
        const turboActive = state.bulli.powerups.speed.active;
        // v2 only: the drift boost (Shift) sounds and burns like the Turbo
        const vehicle: LocalVehicle | undefined = state.bulli.vehicle;
        const boostActive = turboActive || !!vehicle?.car.state.boosting;
        updateEngineSound(state.bulli.speed, isAccelerating, boostActive, vehicle?.airHeight ?? 0);

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
        updateResetControl(!state.dead);

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

    // Remote cars: interpolated snapshots, the contact set predicted
    // (net/remotes.ts), idle ones grey
    updateRemoteCars(dt, performance.now(), state.bulli?.vehicle?.alpha ?? 0);
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id] as any;
        remote.update(dt);
        // Damage smoke for remote players
        if (remote.health < 100 && remote.bodyGroup.visible) {
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

    // Race HUD, lobby and results, gate lights, the time trial ghost
    raceClient.frame(dt, performance.now(), time);

    updateParticles(dt);
    updateMinimap(frameTime);

    // While the GL context is lost three.js skips rendering anyway; skip the
    // adaptive quality sampling too so the gap doesn't lower the resolution.
    // Nothing is drawn under the opaque loading screen either.
    const drawNow = (E2E_DRAW_INTERVAL_MS === 0 || frameTime - lastDrawAt >= E2E_DRAW_INTERVAL_MS) && !loadingScreenCovers();
    if (drawNow && state.renderer && state.scene && state.camera && !isWebGLContextLost()) {
        lastDrawAt = frameTime;
        updateWorldShaders(state.clock.getElapsed());
        updateLighting();
        // Terrain rings, kit cells and instanced plants for the final camera
        updateMapScene(state.camera);
        // Near geometry or impostor per palm, for the final camera
        updatePalms(state.camera);
        // Car LODs, wheels, brake lights and blinkers
        updateCarModels(state.camera, dt);
        renderQuality.update(frameTime);
        // A desktop GPU that is slow even at the lowest resolution: the
        // map world drops to its mid detail level (once)
        if (renderQuality.struggling) lowerMapDetail();
        // Counters include the shadow pass (perf overlay, e2e snapshot)
        renderFrame(state.renderer, state.scene, state.camera);
    }

    perfMonitor?.endFrame(frameTime);
}

// Start the game (unless this page is a stale build that is about to reload)
ensureCurrentBuild().then(init);
