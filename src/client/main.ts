import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle, spawnBoostFireParticle, spawnDamageSmoke } from './effects/particles.js';
import { playCollisionSound } from './effects/sounds.js';
import { showHitmarker } from './ui/hud.js';
import { initSounds, startEngineSound, updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, animateCoins } from './world/coins.js';
import { checkPowerupCollection, animatePowerups } from './world/powerups.js';
import { updatePowerupsUI, updateSpeedometer, updateHealthBar } from './ui/hud.js';
import { updateProjectiles } from './world/projectiles.js';
import { initSplashScreen, initAboutModal, initRenameUI } from './ui/screens.js';
import { animateFountain } from './world/city.js';

// Reusable vectors to avoid per-frame allocations
const _cameraTarget = new THREE.Vector3();
const _lookAtTarget = new THREE.Vector3();

let dirLight: THREE.DirectionalLight;

// FPS counter
let fpsFrames = 0;
let fpsLastTime = performance.now();
let fpsDisplay: HTMLElement | null = null;

// Mega ram cooldown per player
const ramCooldowns: Record<string, number> = {};

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
            state.ws.send(JSON.stringify({
                type: 'playerReady'
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
        // Framerate-independent lerp: equivalent to k=0.1 at 60fps, scales smoothly otherwise
        const camLerp = 1 - Math.pow(1 - 0.1, dt * 60);
        state.camera.position.lerp(_cameraTarget, camLerp);
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
        // Boost fire trails
        if (state.bulli.powerups.speed.active && Math.abs(state.bulli.speed) > 0.05) {
            spawnBoostFireParticle();
        }

        // Mega ram: collide with other players to damage them
        if (state.bulli.powerups.size.active && Math.abs(state.bulli.speed) > 0.05 && !state.dead) {
            const now = Date.now();
            const myX = state.bulli.group.position.x;
            const myZ = state.bulli.group.position.z;
            const ramRadius = 6;

            for (const id in state.remotePlayers) {
                const remote = state.remotePlayers[id] as any;
                if (!remote.flipGroup.visible) continue;
                const dx = myX - remote.group.position.x;
                const dz = myZ - remote.group.position.z;
                const dist = Math.sqrt(dx * dx + dz * dz);

                if (dist < ramRadius && (!ramCooldowns[id] || now - ramCooldowns[id] > 1000)) {
                    ramCooldowns[id] = now;
                    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                        state.ws.send(JSON.stringify({
                            type: 'shoot',
                            targetId: id
                        }));
                    }
                    playCollisionSound(0.5);
                    showHitmarker();
                }
            }
        }

        // Respawn shield decay
        if (state.respawnShield && state.bulli.shieldMesh) {
            const speed = Math.abs(state.bulli.speed);
            if (speed > 0.05 && state.respawnMoveStart === 0) {
                state.respawnMoveStart = Date.now();
            }

            const shieldMat = state.bulli.shieldMesh.material as any;
            state.bulli.shieldMesh.visible = true;

            if (state.respawnMoveStart > 0) {
                const elapsed = Date.now() - state.respawnMoveStart;
                const decay = 3000;
                const progress = Math.min(1, elapsed / decay);
                shieldMat.opacity = 0.3 * (1 - progress);
                shieldMat.emissiveIntensity = 0.4 * (1 - progress);
                state.bulli.shieldMesh.rotation.y += dt * 2;

                if (progress >= 1) {
                    state.respawnShield = false;
                    state.bulli.shieldMesh.visible = false;
                    shieldMat.opacity = 0;
                    shieldMat.emissiveIntensity = 0;
                    if (state.ws?.readyState === WebSocket.OPEN) {
                        state.ws.send(JSON.stringify({ type: 'respawnShieldExpired' }));
                    }
                }
            } else {
                shieldMat.opacity = 0.25 + Math.sin(Date.now() * 0.005) * 0.1;
                shieldMat.emissiveIntensity = 0.4 + Math.sin(Date.now() * 0.008) * 0.2;
                state.bulli.shieldMesh.rotation.y += dt * 2;
            }
        }

        updatePowerupsUI();
        updateSpeedometer();
        updateHealthBar();

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

    // Animate world objects
    animateCoins(time);
    animatePowerups(time);
    animateFountain(time);

    // Update remote players (smoothness)
    const nowMs = Date.now();
    for (const id in state.remotePlayers) {
        const remote = state.remotePlayers[id] as any;
        remote.updateNametag();

        // AFK detection: track last position change
        const px = remote.group.position.x;
        const pz = remote.group.position.z;
        if (remote._lastPx !== px || remote._lastPz !== pz) {
            remote._lastPx = px;
            remote._lastPz = pz;
            remote._lastMoveTime = nowMs;
        }
        const isAfk = remote._lastMoveTime && (nowMs - remote._lastMoveTime > 3000);

        // AFK visualization: gray out + show ZZZ
        if (isAfk && !remote._afkApplied) {
            remote._afkApplied = true;
            remote.flipGroup.traverse((child: any) => {
                if (child.isMesh) {
                    const mat = child.material;
                    if (mat) {
                        mat.userData = mat.userData || {};
                        if (mat.userData._origColor === undefined) {
                            mat.userData._origColor = mat.color.getHex();
                        }
                        mat.color.setHex(0x888888);
                    }
                }
            });
            if (remote.nametag) {
                remote.nametag.style.opacity = '0.4';
                const nameEl = remote.nametag.querySelector('.nametag-name');
                if (nameEl && !remote.nametag.querySelector('.afk-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'afk-badge';
                    badge.textContent = ' ZZZ';
                    nameEl.appendChild(badge);
                }
            }
        } else if (!isAfk && remote._afkApplied) {
            remote._afkApplied = false;
            remote.flipGroup.traverse((child: any) => {
                if (child.isMesh) {
                    const mat = child.material;
                    if (mat?.userData?._origColor !== undefined) {
                        mat.color.setHex(mat.userData._origColor);
                        delete mat.userData._origColor;
                    }
                }
            });
            if (remote.nametag) {
                remote.nametag.style.opacity = '';
                const badge = remote.nametag.querySelector('.afk-badge');
                if (badge) badge.remove();
            }
        }

        // Respawn shield decay for remote players
        if (remote._respawnShield && remote.shieldMesh) {
            const hasMoved = remote._lastPx !== undefined &&
                (remote._lastPx !== remote.group.position.x || remote._lastPz !== remote.group.position.z);

            if (hasMoved && remote._respawnMoveStart === 0) {
                remote._respawnMoveStart = nowMs;
            }

            const rsMat = remote.shieldMesh.material as any;
            remote.shieldMesh.visible = true;

            if (remote._respawnMoveStart > 0) {
                const elapsed = nowMs - remote._respawnMoveStart;
                const decay = 3000;
                const progress = Math.min(1, elapsed / decay);
                rsMat.opacity = 0.3 * (1 - progress);
                rsMat.emissiveIntensity = 0.4 * (1 - progress);
                remote.shieldMesh.rotation.y += dt * 2;

                if (progress >= 1) {
                    remote._respawnShield = false;
                    remote.shieldMesh.visible = false;
                    rsMat.opacity = 0;
                    rsMat.emissiveIntensity = 0;
                }
            } else {
                rsMat.opacity = 0.25 + Math.sin(nowMs * 0.005) * 0.1;
                rsMat.emissiveIntensity = 0.4 + Math.sin(nowMs * 0.008) * 0.2;
                remote.shieldMesh.rotation.y += dt * 2;
            }
        }

        // Damage smoke for remote players
        if (remote.health < 100 && remote.flipGroup.visible && !isAfk) {
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

    if (state.renderer && state.scene && state.camera) {
        state.renderer.render(state.scene, state.camera);
    }

    // FPS counter
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLastTime >= 1000) {
        if (!fpsDisplay) fpsDisplay = document.getElementById('fps-counter');
        if (fpsDisplay) fpsDisplay.textContent = fpsFrames + ' FPS';
        fpsFrames = 0;
        fpsLastTime = now;
    }
}

// Start the game
init();
