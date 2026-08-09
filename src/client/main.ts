import * as THREE from 'three';
import { CONFIG } from './config.js';
import { state } from './state.js';
import { initWebSocket } from './network/websocket.js';
import { initKeyboard } from './controls/keyboard.js';
import { setupMobileControls } from './controls/mobile.js';
import { updateParticles, spawnDriftParticle, spawnBoostFireParticle, spawnDamageSmoke } from './effects/particles.js';
import { playCollisionSound } from './effects/sounds.js';
import { updateJumpControl, showHitmarker } from './ui/hud.js';
import { initSounds, startEngineSound, updateEngineSound } from './effects/sounds.js';
import { checkCoinCollection, animateCoins } from './world/coins.js';
import { checkPowerupCollection, animatePowerups } from './world/powerups.js';
import { updatePowerupsUI, updateSpeedometer, updateHealthBar } from './ui/hud.js';
import { updateProjectiles } from './world/projectiles.js';
import { initSplashScreen, initAboutModal } from './ui/screens.js';
import { animateFountain } from './world/city.js';
import { updateMinimap } from './ui/minimap.js';
import { SPEED_BOOST_FACTOR } from '../shared/constants.js';

// Reusable chase-camera state/vectors to avoid per-frame allocations.
const _cameraTarget = new THREE.Vector3();
const _desiredLookAt = new THREE.Vector3();
const _smoothedLookAt = new THREE.Vector3();
const _lastCarPosition = new THREE.Vector3();
let cameraYaw = 0;
let cameraRigReady = false;
let useMobileCameraEnvelope = false;

let dirLight: THREE.DirectionalLight;

// Mega ram cooldown per player
const ramCooldowns: Record<string, number> = {};

function init() {
    // Scene
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x87CEEB);
    state.scene.fog = new THREE.Fog(0x87CEEB, 60, 300);

    // Camera
    refreshCameraEnvelope();
    state.camera = new THREE.PerspectiveCamera(
        useMobileCameraEnvelope ? CONFIG.cameraMobileFov : CONFIG.cameraBaseFov,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
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
            const previousPosition = state.bulli.group.position.clone();
            const previousAngle = state.bulli.angle;
            state.scene.remove(state.bulli.group);
            if (state.bulli.nametag) state.bulli.nametag.remove();

            const { Bulli } = await import('./entities/Bulli.js');
            state.bulli = new Bulli(state.myColor!, true, carType as any);
            state.bulli.group.position.copy(previousPosition);
            state.bulli.angle = previousAngle;
            state.bulli.group.rotation.y = previousAngle;
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
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && splashScreen.contains(focused)) {
                focused.blur();
            }
            splashScreen.classList.add('hidden');
            splashScreen.inert = true;
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
    initAboutModal();

    // Start Loop
    animate();
}

function onWindowResize() {
    if (!state.camera || !state.renderer) return;
    refreshCameraEnvelope();
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(window.innerWidth, window.innerHeight);
}

function refreshCameraEnvelope() {
    useMobileCameraEnvelope = typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
}

function dampingFactor(rate: number, dt: number): number {
    return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

function dampAngle(current: number, target: number, amount: number): number {
    const shortestDelta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + shortestDelta * amount;
}

function updateChaseCamera(
    dt: number,
    carPos: THREE.Vector3,
    carAngle: number,
    carSpeed: number,
    boostActive: boolean
) {
    const maxSpeed = Math.max(0.001, state.bulli.maxSpeed * (boostActive ? SPEED_BOOST_FACTOR : 1));
    const speedRatio = Math.min(1, Math.abs(carSpeed) / maxSpeed);
    const movedDistanceSq = cameraRigReady ? _lastCarPosition.distanceToSquared(carPos) : 0;
    const teleportThresholdSq = CONFIG.cameraTeleportDistance * CONFIG.cameraTeleportDistance;
    const shouldSnap = !cameraRigReady || state.cameraSnapPending || movedDistanceSq > teleportThresholdSq;

    if (shouldSnap) {
        cameraYaw = carAngle;
    } else {
        cameraYaw = dampAngle(cameraYaw, carAngle, dampingFactor(CONFIG.cameraYawDamping, dt));
    }

    const distanceScale = useMobileCameraEnvelope ? CONFIG.cameraMobileDistanceScale : 1;
    const heightScale = useMobileCameraEnvelope ? CONFIG.cameraMobileHeightScale : 1;
    const distance = CONFIG.cameraDistance * distanceScale
        * (1 + speedRatio * 0.12 + (boostActive ? 0.06 : 0));
    const height = CONFIG.cameraHeight * heightScale
        * (1 + speedRatio * 0.08 + (boostActive ? 0.04 : 0));
    const forwardX = Math.sin(cameraYaw);
    const forwardZ = Math.cos(cameraYaw);
    const lookAhead = CONFIG.cameraLookAhead + CONFIG.cameraSpeedLookAhead * speedRatio;

    _cameraTarget.set(
        carPos.x - forwardX * distance,
        carPos.y + height,
        carPos.z - forwardZ * distance
    );
    _desiredLookAt.set(
        carPos.x + forwardX * lookAhead,
        carPos.y + CONFIG.cameraLookAtY,
        carPos.z + forwardZ * lookAhead
    );

    const baseFov = useMobileCameraEnvelope ? CONFIG.cameraMobileFov : CONFIG.cameraBaseFov;
    const targetFov = Math.min(
        CONFIG.cameraMaxFov,
        baseFov + speedRatio * CONFIG.cameraSpeedFov + (boostActive ? CONFIG.cameraBoostFov : 0)
    );

    if (shouldSnap) {
        state.camera.position.copy(_cameraTarget);
        _smoothedLookAt.copy(_desiredLookAt);
        state.camera.fov = targetFov;
        cameraRigReady = true;
        state.cameraSnapPending = false;
    } else {
        state.camera.position.lerp(_cameraTarget, dampingFactor(CONFIG.cameraPositionDamping, dt));
        _smoothedLookAt.lerp(_desiredLookAt, dampingFactor(CONFIG.cameraLookDamping, dt));
        state.camera.fov += (targetFov - state.camera.fov) * dampingFactor(CONFIG.cameraFovDamping, dt);
    }

    state.camera.lookAt(_smoothedLookAt);
    if (shouldSnap || Math.abs(targetFov - state.camera.fov) > 0.01) {
        state.camera.updateProjectionMatrix();
    }
    _lastCarPosition.copy(carPos);
}

function animate() {
    requestAnimationFrame(animate);
    const dt = state.clock.getDelta();
    const time = state.clock.elapsedTime;

    if (state.bulli) {
        state.bulli.update(dt);

        // Update engine sound based on speed and jump height
        const isAccelerating = Math.abs(state.inputs.throttle) > 0.02;
        const turboActive = state.bulli.powerups.speed.active;
        const jumpHeight = state.bulli.flipGroup.position.y;
        updateEngineSound(state.bulli.speed, isAccelerating, turboActive, jumpHeight);

        // Update the automatic chase camera. Its yaw follows the car on the
        // shortest arc, while position, framing and FOV use independent damping
        // so a quick turn feels deliberate instead of whipping the view around.
        const carPos = state.bulli.group.position;
        updateChaseCamera(dt, carPos, state.bulli.angle, state.bulli.speed, state.bulli.powerups.speed.active);

        // Effects based on speed
        const speed = Math.abs(state.bulli.speed);

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
                    if (state.bulli.powerups.shield.active) {
                        state.bulli.shieldMesh.visible = true;
                        shieldMat.opacity = 0.25;
                        shieldMat.emissiveIntensity = 0.4;
                    } else {
                        state.bulli.shieldMesh.visible = false;
                        shieldMat.opacity = 0;
                        shieldMat.emissiveIntensity = 0;
                    }
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
                    if (remote.powerups?.shield?.active) {
                        remote.shieldMesh.visible = true;
                        rsMat.opacity = 0.25;
                        rsMat.emissiveIntensity = 0.4;
                    } else {
                        remote.shieldMesh.visible = false;
                        rsMat.opacity = 0;
                        rsMat.emissiveIntensity = 0;
                    }
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
    updateMinimap(performance.now());

    if (state.renderer && state.scene && state.camera) {
        state.renderer.render(state.scene, state.camera);
    }

}

// Start the game
init();
