import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { ServerMessage, PlayerData, CityData } from '../types.js';
import { Bulli } from '../entities/Bulli.js';
import { createEnvironment } from '../world/environment.js';
import { createCity } from '../world/city.js';
import { createPowerupMarker, applyPowerupEffect } from '../world/powerups.js';
import { createCoinsFromServer, removeCoinById, resetCoinById } from '../world/coins.js';
import { updateScoreboardUI } from '../ui/playerList.js';
import { getTerrainHeight } from '../world/environment.js';
import { playHitSound } from '../effects/sounds.js';
import { spawnExplosion } from '../effects/particles.js';
import { addKillfeedEntry } from '../ui/hud.js';

export function initWebSocket() {
    state.ws = new WebSocket(CONFIG.serverUrl);

    state.ws.onopen = () => {
        console.log('Connected to server');
    };

    state.ws.onmessage = (event) => {
        const data: ServerMessage = JSON.parse(event.data);
        handleServerMessage(data);
    };

    state.ws.onerror = (e) => {
        console.warn('WebSocket error, offline mode?', e);
        if (!state.bulli) {
            state.terrainConfig = {
                size: 1000,
                segments: 128,
                frequency1: 0.006,
                amplitude1: 6.0,
                frequency2: 0.018,
                amplitude2: 3.0,
                frequency3: 0.045,
                amplitude3: 1.2
            };
            createEnvironment([]); 
            
            const savedName = localStorage.getItem('bulli-player-name');
            createLocalPlayer(0xD32F2F, savedName || "Offline");
            removeLoader();
        }
    };
}

function handleServerMessage(data: ServerMessage) {
    switch (data.type) {
        case 'init':
            state.myId = data.id;
            state.myColor = data.color;
            
            const savedName = localStorage.getItem('bulli-player-name');
            if (savedName) {
                state.myName = savedName;
                state.ws?.send(JSON.stringify({
                    type: 'rename',
                    name: state.myName
                }));
            } else {
                state.myName = data.name;
            }

            if (data.terrain) {
                state.terrainConfig = data.terrain;
                createEnvironment(data.trees);
            }
            
            if (data.city) {
                createCity(data.city);
            }
            
            if (data.scoreboard) {
                state.scoreboard = data.scoreboard;
            }

            createLocalPlayer(state.myColor!, state.myName);
            removeLoader();

            for (const pid in data.players) {
                if (pid !== state.myId) {
                    addRemotePlayer(data.players[pid]);
                }
            }

            if (data.powerups) {
                state.worldPowerups = data.powerups;
                state.worldPowerups.forEach(p => {
                    createPowerupMarker(p);
                });
            }

            if (data.coins) {
                state.serverCoins = data.coins;
                createCoinsFromServer(data.coins);
            }
            break;

        case 'newPlayer':
            if (data.player.id !== state.myId) {
                addRemotePlayer(data.player);
            }
            break;

        case 'update':
            if (data.id !== state.myId) {
                updateRemotePlayer(data);
            }
            break;

        case 'removePlayer':
            removeRemotePlayer(data.id);
            break;

        case 'powerupCollected':
            const p = state.worldPowerups.find(pu => pu.id === data.powerupId);
            if (p) {
                p.collected = true;
                if ((p as any).mesh) {
                    (p as any).mesh.material.opacity = 0.2;
                }
                if ((p as any).iconMat) {
                    (p as any).iconMat.opacity = 0.2;
                }
                if (data.playerId === state.myId) {
                    applyPowerupEffect(p);
                }
            }
            break;

        case 'powerupReset':
            const pr = state.worldPowerups.find(pu => pu.id === data.powerupId);
            if (pr) {
                pr.collected = false;
                if ((pr as any).mesh) {
                    (pr as any).mesh.material.opacity = 0.8;
                }
                if ((pr as any).iconMat) {
                    (pr as any).iconMat.opacity = 0.8;
                }
            }
            break;

        case 'coinCollected':
            // Another player collected a coin - remove it visually
            if (data.playerId !== state.myId) {
                removeCoinById(data.coinId);
            }
            break;

        case 'coinReset':
            resetCoinById(data.coinId);
            break;

        case 'honk':
            const remote = state.remotePlayers[data.id];
            if (remote) remote.honk();
            break;

        case 'shieldBreak':
            if (data.targetId === state.myId) {
                // Local player's shield was broken
                if (state.bulli) {
                    state.bulli.powerups.shield.active = false;
                    state.bulli.powerups.shield.timer = 0;
                }
                // Flash blue briefly instead of red
                flashScreenBlue();
            } else {
                // Remote player's shield was broken
                const shieldRemote = state.remotePlayers[data.targetId] as any;
                if (shieldRemote && shieldRemote.shieldMesh) {
                    const mat = shieldRemote.shieldMesh.material as any;
                    mat.opacity = 0;
                    mat.emissiveIntensity = 0;
                }
            }
            break;

        case 'playerRenamed':
            const rp = state.remotePlayers[data.id];
            if (rp) {
                rp.name = data.name;
                if (rp.nametag) {
                    const nameEl = rp.nametag.querySelector('.nametag-name');
                    if (nameEl) nameEl.textContent = data.name;
                }
            }
            updateScoreboardUI();
            break;
            
        case 'scoreboard':
            state.scoreboard = data.scoreboard;
            updateScoreboardUI();
            break;

        case 'playerHit':
            if (data.targetId === state.myId) {
                // Local player was hit
                state.health = data.newHealth;
                playHitSound();
                flashScreenRed();
            } else {
                // Remote player was hit - update their health bar
                const hitRemote = state.remotePlayers[data.targetId] as any;
                if (hitRemote) {
                    hitRemote.health = data.newHealth;
                    if (hitRemote.updateHealthBar) hitRemote.updateHealthBar();
                }
            }
            break;

        case 'playerKilled':
            // Killfeed for all kills
            addKillfeedEntry(data.killerName || 'Unknown', data.targetName || 'Unknown');

            if (data.targetId === state.myId) {
                // Local player was killed - explode and show respawn
                state.dead = true;
                state.health = 0;
                if (state.bulli) {
                    spawnExplosion(
                        state.bulli.group.position.x,
                        state.bulli.group.position.y,
                        state.bulli.group.position.z,
                        state.bulli.colorCode
                    );
                    state.bulli.flipGroup.visible = false;
                }
                showRespawnOverlay();
            } else {
                // Remote player was killed - explode their car
                const killedRemote = state.remotePlayers[data.targetId] as any;
                if (killedRemote) {
                    killedRemote.health = 0;
                    if (killedRemote.updateHealthBar) killedRemote.updateHealthBar();
                    spawnExplosion(
                        killedRemote.group.position.x,
                        killedRemote.group.position.y,
                        killedRemote.group.position.z,
                        killedRemote.colorCode
                    );
                    killedRemote.flipGroup.visible = false;
                }
            }
            break;

        case 'playerRespawn':
            if (data.playerId === state.myId) {
                // Local player respawned at new location
                state.dead = false;
                state.health = data.health;
                state.respawnShield = true;
                state.respawnMoveStart = 0;
                if (state.bulli) {
                    state.bulli.group.position.x = data.x;
                    state.bulli.group.position.z = data.z;
                    state.bulli.group.position.y = getTerrainHeight(data.x, data.z);
                    state.bulli.speed = 0;
                    state.bulli.flipGroup.visible = true;
                    state.bulli.health = data.health;
                }
                hideRespawnOverlay();
            } else {
                // Remote player respawned
                const respawnRemote = state.remotePlayers[data.playerId] as any;
                if (respawnRemote) {
                    respawnRemote.health = data.health;
                    respawnRemote.group.position.set(data.x, getTerrainHeight(data.x, data.z), data.z);
                    respawnRemote.flipGroup.visible = true;
                    respawnRemote._respawnShield = true;
                    respawnRemote._respawnMoveStart = 0;
                    if (respawnRemote.updateHealthBar) respawnRemote.updateHealthBar();
                }
            }
            break;
    }
}

function flashScreenRed() {
    let overlay = document.getElementById('damage-flash');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'damage-flash';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(255,0,0,0.3);pointer-events:none;z-index:200;transition:opacity 0.3s;';
        document.body.appendChild(overlay);
    }
    overlay.style.opacity = '1';
    setTimeout(() => { overlay!.style.opacity = '0'; }, 200);
}

function flashScreenBlue() {
    let overlay = document.getElementById('shield-flash');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'shield-flash';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,191,255,0.3);pointer-events:none;z-index:200;transition:opacity 0.3s;';
        document.body.appendChild(overlay);
    }
    overlay.style.opacity = '1';
    setTimeout(() => { overlay!.style.opacity = '0'; }, 300);
}

function showRespawnOverlay() {
    let overlay = document.getElementById('respawn-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'respawn-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:300;pointer-events:none;';

        const title = document.createElement('div');
        title.style.cssText = 'font-family:Righteous,cursive;font-size:2.5rem;color:#E84545;text-shadow:0 0 20px rgba(232,69,69,0.5);';
        title.textContent = 'ELIMINATED';

        const timer = document.createElement('div');
        timer.id = 'respawn-timer';
        timer.style.cssText = 'font-family:Quicksand,sans-serif;font-size:1.2rem;color:rgba(255,255,255,0.7);margin-top:0.5rem;';
        timer.textContent = 'Respawning in 3...';

        overlay.appendChild(title);
        overlay.appendChild(timer);
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';

    // Countdown
    let count = 3;
    const timerEl = document.getElementById('respawn-timer');
    if (timerEl) timerEl.textContent = 'Respawning in 3...';
    const interval = setInterval(() => {
        count--;
        if (count <= 0) {
            clearInterval(interval);
            if (timerEl) timerEl.textContent = 'Respawning...';
        } else if (timerEl) {
            timerEl.textContent = `Respawning in ${count}...`;
        }
    }, 1000);
}

function hideRespawnOverlay() {
    const overlay = document.getElementById('respawn-overlay');
    if (overlay) overlay.style.display = 'none';
}

export function createLocalPlayer(color: number, name: string) {
    state.myColor = color;
    state.myName = name;
    const savedCarType = localStorage.getItem('bulli-car-type') || 'bulli';
    state.myCarType = savedCarType;
    state.bulli = new Bulli(color, true, savedCarType as any);
    state.bulli.createNametag(name, true);
    state.scene.add(state.bulli.group);
    updateScoreboardUI();
}

export function addRemotePlayer(p: PlayerData) {
    if (state.remotePlayers[p.id]) return;

    const remote = new Bulli(p.color, false, (p.carType as any) || undefined);
    remote.name = p.name;
    remote.health = p.health ?? 100;
    const px = p.x || 0;
    const pz = p.z || 0;
    remote.group.position.set(px, getTerrainHeight(px, pz), pz);
    remote.group.rotation.y = p.angle || 0;
    remote.createNametag(p.name, false);
    remote.updateHealthBar();

    state.scene.add(remote.group);
    state.remotePlayers[p.id] = remote as any;
    updateScoreboardUI();
}

export function removeRemotePlayer(id: string) {
    if (state.remotePlayers[id]) {
        state.scene.remove(state.remotePlayers[id].group);
        if (state.remotePlayers[id].nametag) state.remotePlayers[id].nametag!.remove();
        delete state.remotePlayers[id];
        updateScoreboardUI();
    }
}

function updateRemotePlayer(data: { id: string; x: number; z: number; y?: number; angle: number; flipAngle: number; isFlipping: boolean; scale?: number; ghostActive?: boolean; shieldActive?: boolean }) {
    const remote = state.remotePlayers[data.id] as any;
    if (remote) {
        remote.group.position.set(data.x, getTerrainHeight(data.x, data.z), data.z);
        remote.group.rotation.y = data.angle;
        remote.flipGroup.rotation.x = data.flipAngle;
        if (data.scale) remote.group.scale.set(data.scale, data.scale, data.scale);

        if (data.y !== undefined) {
            remote.flipGroup.position.y = data.y;
        } else if (data.isFlipping) {
            const normRot = data.flipAngle;
            const lift = Math.sin(normRot / 2);
            remote.flipGroup.position.y = lift * 8;
        } else {
            remote.flipGroup.position.y = 0;
        }

        // Ghost visual on remote player
        if (data.ghostActive !== undefined && remote.setGhostVisual) {
            const wasGhost = remote.powerups?.ghost?.active ?? false;
            if (data.ghostActive !== wasGhost) {
                remote.setGhostVisual(data.ghostActive);
                if (remote.powerups) remote.powerups.ghost.active = data.ghostActive;
            }
        }

        // Shield visual on remote player
        if (data.shieldActive !== undefined && remote.shieldMesh) {
            const mat = remote.shieldMesh.material;
            if (data.shieldActive) {
                mat.opacity = 0.25 + Math.sin(Date.now() * 0.005) * 0.1;
                mat.emissiveIntensity = 0.4;
            } else {
                mat.opacity = 0;
                mat.emissiveIntensity = 0;
            }
        }
    }
}

function removeLoader() {
    const loader = document.getElementById('loading-screen');
    const splash = document.getElementById('splash-screen');
    
    // Setup splash input with saved name
    const savedName = localStorage.getItem('bulli-player-name');
    const splashInput = document.getElementById('splash-name-input') as HTMLInputElement;
    if (splashInput && savedName) {
        splashInput.value = savedName;
    }
    
    // Show splash screen immediately behind loader
    if (splash) {
        splash.classList.remove('hidden');
        if (splashInput) splashInput.focus();
    }

    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => {
            loader.remove();
        }, 500);
    }
}
