import * as THREE from 'three';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle, spawnBoostFireParticle, spawnDamageSmoke } from './effects/particles.js';
import { updateResetControl, showInteractionPrompt, updatePowerupsUI, updateSpeedometer, updateHealthBar, updateDriveHud } from './ui/hud.js';
import { updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, animateCoins } from './world/coins.js';
import { animatePowerups } from './world/powerups.js';
import { updateProjectiles } from './world/projectiles.js';
import { initRoomMenu } from './ui/roomMenu.js';
import { initMenu, menuCarFrame, menuChoice, onMenuLayout, refreshMenuMapProgress } from './ui/menu/menu.js';
import { initCodex, setCodexProgressListener } from './ui/codex.js';
import { discoveryTracker } from './ui/discoveryTracker.js';
import {
    pollLocalHornForDiscovery, repaintLocalCar, startFromMenu, stepDiscoveriesForLocalCar,
    switchLocalCar, updateRaceCamera
} from './ui/gameSession.js';
import { ShowroomCamera } from './camera/ShowroomCamera.js';
import { spawnHintFor } from './camera/showroom.js';
import { netDriver } from './net/netDriver.js';
import { groundHeight } from './world/ground.js';
import { updatePalms } from './world/palms.js';
import { lowerMapDetail, startKitPreload, updateMapScene } from './world/mapScene.js';
import { loadGameMap } from './map/gameMap.js';
import { registerShowroomCamera, updateWorldDynamic } from './map/worldBridge.js';
import { updateMinimap } from './ui/minimap.js';
import { finishLoader, loadingScreenCovers, onLoadPoll, showLoaderNotice, startLoadingScreen } from './ui/loadingScreen.js';
import { trackLoadSteps } from './assets/loadSteps.js';
import { AdaptiveRenderQuality, detectRenderTier, wantsAntialias } from './effects/renderQuality.js';
import { updateWorldShaders } from './effects/worldShaders.js';
import { ensureCurrentBuild } from './buildVersion.js';
import { installE2EHook } from './e2eHook.js';
import { watchWebGLContext, isWebGLContextLost, showGraphicsUnavailable } from './ui/contextLoss.js';
import { isSafeMode, safeModeReason } from './render/safeMode.js';
import { rememberGpu } from './net/clientReport.js';
import { installPerfMonitor, type PerfMonitor } from './debug/perfMonitor.js';
import { lightingTier, setupLighting, updateLighting } from './render/lighting.js';
import { renderFrame } from './render/frameStats.js';
import { startModelPreload } from './assets/gameModels.js';
import { updateCarModels } from './vehicle/CarModel.js';
import { ChaseCamera, RACE_CAMERA } from './camera/ChaseCamera.js';
import { E2E_DRAW_INTERVAL_MS, LOAD_DEBUG, SANDBOX, TUNE_PANEL, TUNE_REQUESTED } from './flags.js';
import { gameHooks } from './game/hooks.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';
import { updateRemoteCars } from './net/remotes.js';
import { raceClient } from './race/RaceClient.js';
import { isGpuDiag, startGpuDiag } from './debug/gpuDiag.js';

const chaseCamera = new ChaseCamera(RACE_CAMERA);
// While the menu's showroom has the game camera, the chase camera follows
// the car on this one (its damping starts from where it left the camera)
const chaseView = new THREE.PerspectiveCamera();
let showroom: ShowroomCamera | null = null;
let renderQuality: AdaptiveRenderQuality;
// Only set with ?debug=perf (FPS/draw call/bandwidth overlay)
let perfMonitor: PerfMonitor | null = null;
// Last frame drawn under ?e2e=1&drawfps (flags.ts)
let lastDrawAt = -Infinity;

function init(): void {
    // Scene & Camera
    state.scene = new THREE.Scene();
    chaseCamera.refreshEnvelope();
    state.camera = new THREE.PerspectiveCamera(
        chaseCamera.baseFov,
        window.innerWidth / window.innerHeight,
        0.1,
        2600
    );
    state.camera.position.set(0, RACE_CAMERA.height, RACE_CAMERA.distance);

    // WebGL Renderer
    try {
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
    setupLighting(state.scene, state.renderer);
    state.renderer.domElement.setAttribute('aria-hidden', 'true');
    document.body.appendChild(state.renderer.domElement);
    watchWebGLContext(state.renderer.domElement);
    if (isGpuDiag()) startGpuDiag(state.scene, state.renderer);

    startModelPreload(state.renderer, state.camera, state.scene)
        .catch(error => console.warn('Model preload failed', error));
    if (!SANDBOX) startKitPreload(state.renderer);

    // Loading screen & progress steps
    const progress = startLoadingScreen(lightingTier(), { debug: LOAD_DEBUG });
    const liteReason = safeModeReason();
    if (liteReason) {
        showLoaderNotice(liteReason === 'link' ? 'Lite graphics' : liteReason === 'setting' ? 'Lite graphics (settings)'
            : 'Lite graphics after graphics trouble on this device');
    }
    if (!SANDBOX) {
        let carType = 'bulli';
        try {
            carType = localStorage.getItem('bulli-car-type') || carType;
        } catch { /* storage blocked */ }
        trackLoadSteps(progress, { tier: lightingTier(), renderer: state.renderer, scene: state.scene, camera: state.camera, carType });
        void progress.whenPhase('loader').then(finishLoader);
    }

    // Menu showroom camera
    const lite = isSafeMode();
    let lastLoaded = -1;
    if (!SANDBOX) {
        const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        showroom = new ShowroomCamera({
            groundHeight: (x, z) => groundHeight(x, z),
            carFree: () => !netDriver.prediction?.spawned,
            spawned: () => !netDriver.prediction || netDriver.prediction.spawned,
            frame: menuCarFrame,
            spawnHint: () => spawnHintFor(state.room?.kind, menuChoice().mode, state.preview),
            reducedMotion: () => !!reducedMotion?.matches,
            lite,
            maxFps: lightingTier() === 'desktop' ? 0 : 30
        });
        registerShowroomCamera(showroom);
        onMenuLayout(() => showroom?.invalidate());
        onLoadPoll(() => {
            const loaded = progress.overall('all');
            if (loaded !== lastLoaded) showroom?.invalidate();
            lastLoaded = loaded;
        });
    }
    document.body.classList.add('in-menu');
    state.inMenu = true;

    // Audio Context
    try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        state.audioCtx = new AudioCtx();
    } catch { /* ignore */ }

    // Main Menu, Codex & Room Switcher
    initMenu({
        onCar: car => {
            showroom?.swapCar();
            window.setTimeout(() => switchLocalCar(car), showroom ? 120 : 0);
        },
        onPaint: paint => repaintLocalCar(paint, showroom),
        onMap: mapId => {
            // Warm the chosen map's JSON + terrain in the background for instant DRIVE switching
            void loadGameMap(mapId).catch(() => undefined);
        },
        onStart: choice => startFromMenu(choice, showroom)
    });
    initCodex(discoveryTracker);
    setCodexProgressListener(refreshMenuMapProgress);

    if (SANDBOX) {
        import('./sandbox/sandbox.js')
            .then(sandbox => sandbox.startSandbox())
            .catch(error => console.error('Sandbox failed to load', error));
    } else {
        initWebSocket();
    }

    window.addEventListener('resize', onWindowResize, false);
    initKeyboard();
    setupMobileControls();
    initRoomMenu();
    raceClient.setCarSwitcher(switchLocalCar);

    installE2EHook();
    perfMonitor = installPerfMonitor();
    if (TUNE_PANEL) {
        import('./debug/tuningPanel.js')
            .then(panel => panel.installTuningPanel())
            .catch(error => console.error('Tuning panel failed to load', error));
    } else if (TUNE_REQUESTED) {
        showInteractionPrompt('TUNING ONLY IN THE SANDBOX (?sandbox=1&tune=1)');
    }

    state.clock.reset();
    requestAnimationFrame(animate);
}

function onWindowResize(): void {
    if (!state.camera || !state.renderer) return;
    chaseCamera.refreshEnvelope();
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    chaseView.aspect = state.camera.aspect;
    chaseView.updateProjectionMatrix();
    showroom?.invalidate();
    renderQuality.resize(window.innerWidth, window.innerHeight);
}

function animate(frameTime: number): void {
    requestAnimationFrame(animate);
    perfMonitor?.beginFrame();
    state.frameAt = performance.now();
    const dt = state.clock.update(state.frameAt).getDelta();
    const time = state.clock.getElapsed();

    if (state.bulli) {
        // Check horn pulse before Bulli.update consumes state.inputs.f
        pollLocalHornForDiscovery();
        state.bulli.update(dt);

        const isAccelerating = Math.abs(state.inputs.throttle) > 0.02;
        const turboActive = state.bulli.powerups.speed.active;
        const vehicle: LocalVehicle | undefined = state.bulli.vehicle;
        const airborne = (vehicle?.airHeight ?? 0) > 0.3;
        const boostActive = (turboActive || !!vehicle?.car.state.boosting) && !airborne;
        updateEngineSound(state.bulli.speed, isAccelerating, boostActive, vehicle?.airHeight ?? 0);

        const carPos = state.bulli.group.position;
        if (vehicle) updateRaceCamera(chaseCamera, dt, carPos, vehicle, showroom?.busy ? chaseView : state.camera);

        stepDiscoveriesForLocalCar(dt, vehicle);

        const speed = Math.abs(state.bulli.speed);
        if (speed > 0.1 && !airborne) spawnDriftParticle();
        checkCoinCollection();
        updateProjectiles(dt);
        if (boostActive && speed > 0.05) spawnBoostFireParticle();

        updatePowerupsUI();
        updateSpeedometer();
        if (vehicle) updateDriveHud(vehicle);
        updateHealthBar();
        updateResetControl(!state.dead);

        if (state.health < 100 && !state.dead) {
            const damagePercent = 1 - state.health / 100;
            if (Math.random() < damagePercent * 0.3) {
                spawnDamageSmoke(carPos.x, carPos.y, carPos.z, state.health);
            }
        }
    }

    if (showroom?.busy && state.camera) {
        showroom.update(state.camera, state.bulli, chaseView);
        if (!showroom.active && showroom.remaining() <= 0.3) document.body.classList.remove('in-menu');
    }

    for (const hook of gameHooks.frame) hook(dt);

    animateCoins(time);
    animatePowerups(time);

    updateRemoteCars(dt, performance.now(), state.bulli?.vehicle?.alpha ?? 0);
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id] as unknown as {
            update(dt: number): void;
            health: number;
            bodyGroup: THREE.Group;
            group: THREE.Group;
        };
        remote.update(dt);
        if (remote.health < 100 && remote.bodyGroup.visible) {
            const damagePercent = 1 - remote.health / 100;
            if (Math.random() < damagePercent * 0.15) {
                spawnDamageSmoke(remote.group.position.x, remote.group.position.y, remote.group.position.z, remote.health);
            }
        }
    }

    raceClient.frame(dt, performance.now(), time);
    updateParticles(dt);
    updateMinimap(frameTime);

    const drawNow = (E2E_DRAW_INTERVAL_MS === 0 || frameTime - lastDrawAt >= E2E_DRAW_INTERVAL_MS)
        && !loadingScreenCovers()
        && (!showroom || showroom.shouldDraw(frameTime));
    if (drawNow && state.renderer && state.scene && state.camera && !isWebGLContextLost()) {
        lastDrawAt = frameTime;
        updateWorldShaders(state.clock.getElapsed());
        updateLighting();
        updateMapScene(state.camera);
        updateWorldDynamic(dt, time, state.bulli?.group.position);
        updatePalms(state.camera);
        updateCarModels(state.camera, dt);
        if (showroom?.paced) renderQuality.pause();
        else renderQuality.update(frameTime);
        if (renderQuality.struggling) lowerMapDetail();
        renderFrame(state.renderer, state.scene, state.camera);
        showroom?.afterRender(state.renderer.domElement);
    }

    perfMonitor?.endFrame(frameTime);
}

// Start the game (unless this page is a stale build that is about to reload)
ensureCurrentBuild().then(init);
