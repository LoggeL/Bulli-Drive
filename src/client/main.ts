import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle } from './effects/particles.js';
import { initSounds, startEngineSound, updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, createCoins, animateCoins } from './world/coins.js';
import { checkPowerupCollection, animatePowerups } from './world/powerups.js';
import { updatePowerupsUI } from './ui/hud.js';

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

    // Splash Screen Logic
    const splashScreen = document.getElementById('splash-screen');
    const startBtn = document.getElementById('start-btn');
    const splashInput = document.getElementById('splash-name-input') as HTMLInputElement;

    if (startBtn && splashInput) {
        // Start game on button click
        startBtn.addEventListener('click', async () => {
            const name = splashInput.value.trim() || "Player";

            // Resume audio
            if (state.audioCtx?.state === 'suspended') {
                await state.audioCtx.resume();
            }

            // Init and start sounds
            await initSounds();
            startEngineSound();

            // Save name and update player
            localStorage.setItem('bulli-player-name', name);
            state.myName = name;

            // Update local nametag
            if (state.bulli && state.bulli.nametag) {
                state.bulli.nametag.innerText = name;
            }

            // Notify server
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'rename',
                    name: name
                }));
            }

            // Hide splash screen
            if (splashScreen) {
                splashScreen.classList.add('hidden');
            }
        });

        // Allow Enter key to start
        splashInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') startBtn.click();
        });
    }

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
    dirLight.shadow.camera.left = -100;
    dirLight.shadow.camera.right = 100;
    dirLight.shadow.camera.top = 100;
    dirLight.shadow.camera.bottom = -100;
    state.scene.add(dirLight);

    // Init WebSocket
    initWebSocket();

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    initKeyboard();
    setupMobileControls();

    // Rename UI
    const nameToggle = document.getElementById('name-toggle');
    const nameForm = document.getElementById('name-form');
    const nameSubmit = document.getElementById('name-submit');
    const nameInput = document.getElementById('name-input') as HTMLInputElement;

    if (nameToggle && nameForm) {
        nameToggle.addEventListener('click', () => {
            nameForm.classList.toggle('hidden');
            if (!nameForm.classList.contains('hidden') && nameInput) {
                nameInput.focus();
            }
        });
    }

    if (nameSubmit && nameInput) {
        const savedName = localStorage.getItem('bulli-player-name');
        if (savedName) {
            nameInput.placeholder = savedName;
        }

        nameSubmit.addEventListener('click', () => {
            const newName = nameInput.value.trim();
            if (newName) {
                localStorage.setItem('bulli-player-name', newName);
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'rename',
                        name: newName
                    }));
                }
                nameInput.value = '';
                nameInput.placeholder = newName;
                state.myName = newName;

                // Update local nametag
                if (state.bulli && state.bulli.nametag) {
                    state.bulli.nametag.innerText = newName;
                }

                // Collapse the form after successful rename
                if (nameForm) {
                    nameForm.classList.add('hidden');
                }
            }
        });
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') nameSubmit.click();
        });
    }

    createCoins();

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
        updatePowerupsUI();
    }

    // Animate world objects
    animateCoins(time);
    animatePowerups(time);

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
