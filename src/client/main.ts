import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle } from './effects/particles.js';
import { checkCoinCollection, createCoins } from './world/coins.js';
import { checkPowerupCollection } from './world/powerups.js';

function init() {
    // Scene
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x87CEEB);
    state.scene.fog = new THREE.Fog(0x87CEEB, 20, 120);

    // Camera
    state.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    state.camera.position.set(0, CONFIG.cameraHeight, CONFIG.cameraDistance);

    // Renderer
    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(state.renderer.domElement);

    // Audio Context
    try {
        (window as any).AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        state.audioCtx = new AudioContext();
    } catch (e) { /* ignore */ }

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    state.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
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
    const nameSubmit = document.getElementById('name-submit');
    const nameInput = document.getElementById('name-input') as HTMLInputElement;
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

    if (state.bulli) {
        state.bulli.update(dt);
        
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

        state.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), 0.1);
        state.camera.lookAt(carPos.x, carPos.y + CONFIG.cameraLookAtY, carPos.z);

        // Drift particles
        if (Math.abs(state.bulli.speed) > 0.1) {
            spawnDriftParticle();
        }

        checkCoinCollection();
        checkPowerupCollection();
    }

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
