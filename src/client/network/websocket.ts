import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { ServerMessage, PlayerData, CityData } from '../types.js';
import { Bulli } from '../entities/Bulli.js';
import { createEnvironment } from '../world/environment.js';
import { createCity } from '../world/city.js';
import { createPowerupMarker, applyPowerupEffect } from '../world/powerups.js';
import { updateScoreboardUI } from '../ui/playerList.js';

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
                segments: 64,
                frequency1: 0.02,
                amplitude1: 0,
                frequency2: 0.05,
                amplitude2: 0
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
                state.projects = data.powerups;
                state.projects.forEach(p => {
                    createPowerupMarker(p);
                });
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
            const p = state.projects.find(pu => pu.id === data.powerupId);
            if (p) {
                p.collected = true;
                if ((p as any).mesh) {
                    (p as any).mesh.material.opacity = 0.2;
                }
                if (data.playerId === state.myId) {
                    applyPowerupEffect(p);
                }
            }
            break;

        case 'powerupReset':
            const pr = state.projects.find(pu => pu.id === data.powerupId);
            if (pr) {
                pr.collected = false;
                if ((pr as any).mesh) {
                    (pr as any).mesh.material.opacity = 0.8;
                }
            }
            break;

        case 'honk':
            const remote = state.remotePlayers[data.id];
            if (remote) remote.honk();
            break;

        case 'playerRenamed':
            const rp = state.remotePlayers[data.id];
            if (rp) {
                rp.name = data.name;
                if (rp.nametag) rp.nametag.innerText = data.name;
            }
            updateScoreboardUI();
            break;
            
        case 'scoreboard':
            state.scoreboard = data.scoreboard;
            updateScoreboardUI();
            break;
    }
}

export function createLocalPlayer(color: number, name: string) {
    state.myColor = color;
    state.myName = name;
    state.bulli = new Bulli(color, true);
    state.bulli.createNametag(name, true);
    state.scene.add(state.bulli.group);
    updateScoreboardUI();
}

export function addRemotePlayer(p: PlayerData) {
    if (state.remotePlayers[p.id]) return;

    const remote = new Bulli(p.color, false);
    remote.name = p.name;
    remote.group.position.set(p.x || 0, 0, p.z || 0);
    remote.group.rotation.y = p.angle || 0;
    remote.createNametag(p.name, false);

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

function updateRemotePlayer(data: any) {
    const remote = state.remotePlayers[data.id];
    if (remote) {
        remote.group.position.set(data.x, 0, data.z);
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
