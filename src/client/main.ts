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
import { updatePowerupsUI, updateSpeedometer, updateHealthBar, updateDriveHud } from './ui/hud.js';
import { updateProjectiles } from './world/projectiles.js';
import { initSplashScreen, initAboutModal } from './ui/screens.js';
import { animateFountain } from './world/city.js';
import { updateMinimap } from './ui/minimap.js';
import { SPEED_BOOST_FACTOR } from '../shared/constants.js';
import { Bulli, type CarType } from './entities/Bulli.js';
import { sendToServer } from './network/socket.js';
import { AdaptiveRenderQuality } from './effects/renderQuality.js';
import { updateWorldShaders } from './effects/worldShaders.js';
import { ensureCurrentBuild } from './buildVersion.js';
import { installE2EHook } from './e2eHook.js';
import { watchWebGLContext, isWebGLContextLost } from './ui/contextLoss.js';
import { installPerfMonitor, type PerfMonitor } from './debug/perfMonitor.js';
import { setupLighting, updateLighting } from './render/lighting.js';
import { startModelPreload } from './assets/gameModels.js';
import { ChaseCamera, LEGACY_CAMERA, RACE_CAMERA, RACE_CAMERA_SLIP_BLEND, type ChaseTarget } from './camera/ChaseCamera.js';
import { PHYSICS_V2, SANDBOX, TUNE_PANEL } from './flags.js';
import { gameHooks } from './game/hooks.js';
import type { LocalVehicle } from './vehicle/LocalVehicle.js';

const chaseCamera = new ChaseCamera(PHYSICS_V2 ? RACE_CAMERA : LEGACY_CAMERA);
gameHooks.camera = chaseCamera;
const _chaseTarget: ChaseTarget = { position: new THREE.Vector3(), yaw: 0, speedRatio: 0, boost: false };

let renderQuality: AdaptiveRenderQuality;
// Only set with ?debug=perf (FPS/draw call/bandwidth overlay)
let perfMonitor: PerfMonitor | null = null;

// Mega ram cooldown per player
const ramCooldowns: Record<string, number> = {};

function init() {
    // index.html starts with body.physics-v2 (v2 HUD and control hints,
    // style.css: .v2-only, .legacy-only); ?physics=legacy swaps them back
    document.body.classList.toggle('physics-v2', PHYSICS_V2);

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
    state.camera.position.set(0, CONFIG.cameraHeight, CONFIG.cameraDistance);

    // Renderer
    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    renderQuality = new AdaptiveRenderQuality(state.renderer, window.innerWidth, window.innerHeight);
    // Tone mapping, sky, fog, environment, lights and shadows
    setupLighting(state.scene, state.renderer);
    document.body.appendChild(state.renderer.domElement);
    // Show a notice and pause rendering if the browser drops the GL context
    watchWebGLContext(state.renderer.domElement);
    // Car models (GLB + KTX2) load and compile while the splash screen is up;
    // until they are there (or if they fail) the cars stay procedural
    startModelPreload(state.renderer, state.camera, state.scene)
        .catch(error => console.warn('Model preload failed', error));

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

        // Notify server of name and car type
        sendToServer({ type: 'rename', name });
        sendToServer({ type: 'setCarType', carType });
        sendToServer({ type: 'playerReady' });

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

    // Test-only state probe, a no-op unless the page URL has ?e2e=1
    installE2EHook();
    // Performance overlay, a no-op unless the page URL has ?debug=perf
    perfMonitor = installPerfMonitor();
    // lil-gui tuning panel of the v2 physics, only loaded with ?tune=1
    if (TUNE_PANEL) {
        import('./debug/tuningPanel.js')
            .then(panel => panel.installTuningPanel())
            .catch(error => console.error('Tuning panel failed to load', error));
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

function updateChaseCamera(
    dt: number,
    carPos: THREE.Vector3,
    carAngle: number,
    carSpeed: number,
    boostActive: boolean
) {
    const maxSpeed = Math.max(0.001, state.bulli.maxSpeed * (boostActive ? SPEED_BOOST_FACTOR : 1));
    _chaseTarget.position.copy(carPos);
    _chaseTarget.yaw = carAngle;
    _chaseTarget.speedRatio = Math.min(1, Math.abs(carSpeed) / maxSpeed);
    _chaseTarget.boost = boostActive;
    if (chaseCamera.update(dt, state.camera, _chaseTarget, state.cameraSnapPending)) {
        state.cameraSnapPending = false;
    }
}

// v2: the camera swings a little towards the travel direction in a drift
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
    const nowMs = Date.now();

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
        if (vehicle) {
            updateRaceCamera(dt, carPos, vehicle);
        } else {
            updateChaseCamera(dt, carPos, state.bulli.angle, state.bulli.speed, state.bulli.powerups.speed.active);
        }

        // Effects based on speed
        const speed = Math.abs(state.bulli.speed);

        // Drift particles
        if (speed > 0.1) {
            spawnDriftParticle();
        }

        checkCoinCollection();
        checkPowerupCollection();
        updateProjectiles(dt);
        // Boost fire trails
        if (boostActive && speed > 0.05) {
            spawnBoostFireParticle();
        }

        // Mega ram: collide with other players to damage them
        if (state.bulli.powerups.size.active && speed > 0.05 && !state.dead) {
            const myX = state.bulli.group.position.x;
            const myZ = state.bulli.group.position.z;
            const ramRadiusSquared = 36;

            for (const id in state.remotePlayers) {
                const remote = state.remotePlayers[id] as any;
                if (!remote.flipGroup.visible) continue;
                const dx = myX - remote.group.position.x;
                const dz = myZ - remote.group.position.z;
                const distanceSquared = dx * dx + dz * dz;

                if (distanceSquared < ramRadiusSquared && (!ramCooldowns[id] || nowMs - ramCooldowns[id] > 1000)) {
                    ramCooldowns[id] = nowMs;
                    sendToServer({ type: 'shoot', targetId: id });
                    playCollisionSound(0.5);
                    showHitmarker();
                }
            }
        }

        // Respawn shield decay
        if (state.respawnShield && state.bulli.shieldMesh) {
            const speed = Math.abs(state.bulli.speed);
            if (speed > 0.05 && state.respawnMoveStart === 0) {
                state.respawnMoveStart = nowMs;
            }

            const shieldMat = state.bulli.shieldMesh.material as any;
            state.bulli.shieldMesh.visible = true;

            if (state.respawnMoveStart > 0) {
                const elapsed = nowMs - state.respawnMoveStart;
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
                    sendToServer({ type: 'respawnShieldExpired' });
                }
            } else {
                shieldMat.opacity = 0.25 + Math.sin(nowMs * 0.005) * 0.1;
                shieldMat.emissiveIntensity = 0.4 + Math.sin(nowMs * 0.008) * 0.2;
                state.bulli.shieldMesh.rotation.y += dt * 2;
            }
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

    // Update remote players (smoothness)
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
    for (const id in ramCooldowns) {
        if (!state.remotePlayers[id] || nowMs - ramCooldowns[id] > 1000) {
            delete ramCooldowns[id];
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
