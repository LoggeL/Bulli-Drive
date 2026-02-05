import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle } from './effects/particles.js';
import { initSounds, startEngineSound, updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, animateCoins } from './world/coins.js';
import { checkPowerupCollection, animatePowerups } from './world/powerups.js';
import { updatePowerupsUI, updateSpeedometer, updateMinimap, updateHealthBar } from './ui/hud.js';
import { updateProjectiles } from './world/projectiles.js';
import { initSplashScreen, initAboutModal, initRenameUI } from './ui/screens.js';
import { animateFountain } from './world/city.js';

// Reusable vectors to avoid per-frame allocations
const _cameraTarget = new THREE.Vector3();
const _lookAtTarget = new THREE.Vector3();

let dirLight: THREE.DirectionalLight;

function init() {
    // Scene
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x87CEEB);
    state.scene.fog = new THREE.Fog(0x87CEEB, 60, 300);

    // Camera
    state.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    state.camera.position.set(0, CONFIG.cameraHeight, CONFIG.cameraDistance);

    // Renderer
    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(state.renderer.domElement);

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
            state.scene.remove(state.bulli.group);
            if (state.bulli.nametag) state.bulli.nametag.remove();

            const { Bulli } = await import('./entities/Bulli.js');
            state.bulli = new Bulli(state.myColor!, true, carType as any);
            state.bulli.createNametag(name, true);
            state.scene.add(state.bulli.group);
        }

        // Notify server of name and car type
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'rename',
                name: name
            }));
            state.ws.send(JSON.stringify({
                type: 'setCarType',
                carType: carType
            }));
        }

        // Hide splash screen
        if (splashScreen) {
            splashScreen.classList.add('hidden');
        }
    });

    // Lighting - Hemisphere light for natural outdoor sky/ground color blending
    const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x3b7d3b, 0.4);
    state.scene.add(hemiLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    state.scene.add(ambientLight);

    dirLight = new THREE.DirectionalLight(0xFFF5E0, 0.9);
    dirLight.position.set(50, 100, 50);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = CONFIG.shadowMapSize;
    dirLight.shadow.mapSize.height = CONFIG.shadowMapSize;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.camera.left = -60;
    dirLight.shadow.camera.right = 60;
    dirLight.shadow.camera.top = 60;
    dirLight.shadow.camera.bottom = -60;
    state.scene.add(dirLight);

    // Init WebSocket
    initWebSocket();

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    initKeyboard();
    setupMobileControls();

    // UI modules
    initRenameUI();
    initAboutModal();

    // Start Loop
    animate();
}

function onWindowResize() {
    if (!state.camera || !state.renderer) return;
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    const dt = state.clock.getDelta();
    const time = state.clock.elapsedTime;

    if (state.bulli) {
        state.bulli.update(dt);

        // Update engine sound based on speed and jump height
        const isAccelerating = state.inputs.w || state.inputs.s;
        const turboActive = state.bulli.powerups.speed.active;
        const jumpHeight = state.bulli.flipGroup.position.y;
        updateEngineSound(state.bulli.speed, isAccelerating, turboActive, jumpHeight);

        // Update Camera
        const carPos = state.bulli.group.position;
        const carAngle = state.bulli.angle;
        const orbitAngle = state.bulli.cameraOrbit;

        // Effects based on speed
        const speed = Math.abs(state.bulli.speed);
        const fovBoost = state.bulli.powerups.speed.active ? 10 : 0;
        state.camera.fov = 60 + (speed * 15) + fovBoost;
        state.camera.updateProjectionMatrix();

        const zoomOut = 1 + (speed * 0.15) + (state.bulli.powerups.speed.active ? 0.25 : 0);
        const heightBoost = state.bulli.powerups.speed.active ? 1.1 : 1.0;

        const camX = carPos.x - Math.sin(carAngle + orbitAngle) * CONFIG.cameraDistance * zoomOut;
        const camZ = carPos.z - Math.cos(carAngle + orbitAngle) * CONFIG.cameraDistance * zoomOut;
        const camY = carPos.y + CONFIG.cameraHeight * zoomOut * heightBoost;

        _cameraTarget.set(camX, camY, camZ);
        state.camera.position.lerp(_cameraTarget, 0.1);
        _lookAtTarget.set(carPos.x, carPos.y + CONFIG.cameraLookAtY, carPos.z);
        state.camera.lookAt(_lookAtTarget);

        // Move shadow camera to follow the player
        dirLight.position.set(carPos.x + 50, 100, carPos.z + 50);
        dirLight.target.position.set(carPos.x, carPos.y, carPos.z);
        dirLight.target.updateMatrixWorld();

        // Drift particles
        if (Math.abs(state.bulli.speed) > 0.1) {
            spawnDriftParticle();
        }

        checkCoinCollection();
        checkPowerupCollection();
        updateProjectiles(dt);
        updatePowerupsUI();
        updateSpeedometer();
        updateMinimap();
        updateHealthBar();
    }

    // Animate world objects
    animateCoins(time);
    animatePowerups(time);
    animateFountain(time);

    // Update remote players (smoothness)
    for (const id in state.remotePlayers) {
        state.remotePlayers[id].updateNametag();
    }

    updateParticles(dt);

    if (state.renderer && state.scene && state.camera) {
        state.renderer.render(state.scene, state.camera);
    }
}

// Start the game
init();
