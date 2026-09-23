import { state } from '../state.js';
import { CONFIG } from '../config.js';
import {
    PROTOCOL_VERSION,
    type GameEvent,
    type MemberInfo,
    type ServerMessage
} from '../../shared/protocol.js';
import { decodeSnapshot } from '../../shared/net/codec.js';
import { CLOCK_BURST_INTERVAL_MS, CLOCK_BURST_PINGS, CLOCK_INTERVAL_MS, CLOSE_VERSION } from '../../shared/net/constants.js';
import { isPowerupType } from '../../shared/party/rules.js';
import { resetTuning, tuningIsDefault } from '../../shared/sim/tuning.js';
import { createMapData, type MapData } from '../../shared/world/mapData.js';
import { Bulli, type CarType } from '../entities/Bulli.js';
import { createEnvironment } from '../world/environment.js';
import { createCity } from '../world/city.js';
import { clearPowerupMarkers, createPowerupMarker, applyPowerupEffect, setPowerupCollectedVisual } from '../world/powerups.js';
import { clearProjectiles } from '../world/projectiles.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../shared/constants.js';
import { clearCoins, confirmCoinPickup, createCoinsFromServer, removeCoinById, resetCoinById } from '../world/coins.js';
import { updateScoreboardUI } from '../ui/playerList.js';
import { getTerrainHeight } from '../world/environment.js';
import { playCollisionSound, playHitSound } from '../effects/sounds.js';
import { spawnExplosion, spawnParticles } from '../effects/particles.js';
import { addKillfeedEntry, showHitmarker } from '../ui/hud.js';
import { initMinimap } from '../ui/minimap.js';
import { releaseKeyboardInputs } from '../controls/keyboard.js';
import { resetMobileControls } from '../controls/mobile.js';
import { sendToServer } from './socket.js';
import { setWorldColliders, simWorldFor } from '../vehicle/simWorldClient.js';
import { assistProfileForDevice } from '../vehicle/LocalVehicle.js';
import { startNetPump } from '../vehicle/v2Driver.js';
import { preferredRoomKind, setCurrentRoom } from '../ui/roomMenu.js';
import { netDriver, placeholderCar } from '../net/netDriver.js';
import { clearRemoteViews, forgetRemote, noteSnapshotCars, setRemoteDead } from '../net/remotes.js';

// The connection to the game server on protocol v2 (docs/phase-1b-design.md,
// 3): the handshake, the world from the seed, the room state, the events
// and the binary snapshots, which go to the prediction (net/netDriver.ts)
// and the remote cars (net/remotes.ts).

let environmentInitialized = false;
let map: MapData | null = null;
let connected = false;
let clockTimer = 0;
let snapshotWarned = false;
// Random per page load, only in memory (duplicated tabs, 11.1)
const connId = Math.random().toString(36).slice(2) + Date.now().toString(36);

const VERSION_RELOAD_KEY = 'bulli-protocol-reload';
const BUILD_RELOAD_KEY = 'bulli-build-version-reload';
const WORLD_RELOAD_KEY = 'bulli-world-reload';

function pageBuild(): string | null {
    return document.querySelector<HTMLMetaElement>('meta[name="bulli-build-version"]')?.content || null;
}

/** Reloads once per key value (sessionStorage guard); false when the guard holds. */
function reloadOnce(key: string, value: string): boolean {
    try {
        if (sessionStorage.getItem(key) === value) return false;
        sessionStorage.setItem(key, value);
    } catch {
        return false;
    }
    window.location.reload();
    return true;
}

export function initWebSocket() {
    // Online the server drives every car with the default tuning (7)
    if (!tuningIsDefault()) resetTuning();

    const ws = new WebSocket(CONFIG.serverUrl);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
        connected = true;
        const savedName = localStorage.getItem('bulli-player-name') || '';
        sendToServer({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            build: pageBuild(),
            connId,
            name: savedName,
            carType: localStorage.getItem('bulli-car-type') || 'bulli',
            profile: assistProfileForDevice(),
            room: preferredRoomKind()
        });
    };

    ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
            onSnapshotFrame(event.data as ArrayBuffer);
            return;
        }
        let data: ServerMessage;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            console.warn('Dropping malformed server message', err);
            return;
        }
        if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
            console.warn('Dropping server message without type');
            return;
        }
        handleServerMessage(data);
    };

    // Background tabs get throttled: the server treats the car as idle, and
    // back in front the client jumps to a fresh tick estimate (5.4, 8.3)
    document.addEventListener('visibilitychange', () => {
        sendToServer({ type: 'visibility', hidden: document.hidden });
        if (!document.hidden) netDriver.resync(performance.now());
    });

    ws.onerror = (e) => {
        console.warn('WebSocket error, offline mode?', e);
        if (!state.bulli && !connected) startOffline();
    };

    ws.onclose = (event) => {
        window.clearTimeout(clockTimer);
        if (event.code === CLOSE_VERSION) return;
        if (!state.bulli && !connected) return;
        console.warn(`Connection closed (${event.code} ${event.reason})`);
        showConnectionNotice(event.code === 4003 ? 'Disconnected by the server' : event.code === 4004
            ? 'Disconnected after a long break' : 'Connection lost');
    };
}

// No server: the local car drives on the terrain with the rocks only
function startOffline() {
    state.terrainConfig = { ...DEFAULT_TERRAIN_CONFIG };
    if (!environmentInitialized) {
        createEnvironment([]);
        environmentInitialized = true;
        setWorldColliders({ trees: [], city: null });
    }
    const savedName = localStorage.getItem('bulli-player-name');
    createLocalPlayer(0xD32F2F, savedName || 'Offline');
    removeLoader();
}

function showConnectionNotice(text: string) {
    let notice = document.getElementById('net-notice');
    if (!notice) {
        notice = document.createElement('div');
        notice.id = 'net-notice';
        notice.setAttribute('role', 'alert');
        const label = document.createElement('span');
        label.className = 'net-notice-text';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'net-notice-reload';
        button.textContent = 'Reload';
        button.addEventListener('click', () => window.location.reload());
        notice.append(label, button);
        document.body.appendChild(notice);
    }
    notice.querySelector('.net-notice-text')!.textContent = text;
    notice.hidden = false;
}

// ---- Clock ----

function startClockSync() {
    window.clearTimeout(clockTimer);
    netDriver.clock.reset();
    let sent = 0;
    const ping = () => {
        if (!sendToServer({ type: 'ping', t: performance.now() })) return;
        sent++;
        clockTimer = window.setTimeout(ping, sent < CLOCK_BURST_PINGS ? CLOCK_BURST_INTERVAL_MS : CLOCK_INTERVAL_MS);
    };
    ping();
}

// ---- Messages ----

function handleServerMessage(data: ServerMessage) {
    switch (data.type) {
        case 'reject':
            if (data.reason === 'version' && data.reload && reloadOnce(VERSION_RELOAD_KEY, String(data.serverProtocol))) return;
            showConnectionNotice(data.reason === 'full' ? 'The server is full'
                : data.reason === 'version' ? 'A new version is out' : 'Could not join the game');
            return;
        case 'welcome': {
            // A new deploy with the same protocol: load the new client once
            const build = pageBuild();
            if (build && data.serverBuild && build !== data.serverBuild && reloadOnce(BUILD_RELOAD_KEY, data.serverBuild)) return;
            state.myId = data.playerId;
            state.myColor = data.color;
            state.myName = data.name;
            try { sessionStorage.setItem('bulli-session', data.sessionToken); } catch { /* private mode */ }
            return;
        }
        case 'roomState':
            enterRoom(data);
            return;
        case 'playerJoined':
            netDriver.setMember(data.member);
            if (data.member.id !== state.myId) addRemotePlayer(data.member);
            updateScoreboardUI();
            return;
        case 'playerLeft':
            removeRemotePlayer(data.id);
            netDriver.removeMember(data.id);
            return;
        case 'playerUpdated':
            updateMember(data);
            return;
        case 'pong':
            netDriver.clock.addSample(data.t, performance.now(), data.tick, data.sub);
            return;
        case 'events':
            for (const event of data.list) handleEvent(event);
            return;
        case 'scoreboard':
            state.scoreboard = data.scoreboard;
            updateScoreboardUI();
            return;
        case 'kicked':
            showConnectionNotice(data.reason === 'idle' ? 'Disconnected after a long break' : 'Disconnected by the server');
            return;
        case 'shutdown':
            // Reconnect with the resume ticket comes with phase 1b step 9
            return;
    }
}

function onSnapshotFrame(buffer: ArrayBuffer) {
    const snap = decodeSnapshot(new Uint8Array(buffer));
    if (!snap) {
        if (!snapshotWarned) console.warn('Dropping a malformed snapshot');
        snapshotWarned = true;
        return;
    }
    noteSnapshotCars(snap);
    netDriver.onSnapshot(snap, state.bulli?.vehicle ?? null, performance.now());
}

// The world comes from the seed; the hash proves it is the server's
function buildWorld(seed: number, worldHash: string): MapData {
    const built = createMapData(seed, DEFAULT_TERRAIN_CONFIG);
    if (built.worldHash !== worldHash) {
        console.warn(`World ${built.worldHash} differs from the server's ${worldHash}`);
        reloadOnce(WORLD_RELOAD_KEY, worldHash);
    }
    return built;
}

// A room: the first after joining or another after a switch
// (docs/phase-1b-design.md, 9): same map, so the scene stays; players,
// items and the car start over.
function enterRoom(data: Extract<ServerMessage, { type: 'roomState' }>) {
    if (!map || map.seed !== data.world.seed) {
        map = buildWorld(data.world.seed, data.world.worldHash);
        state.terrainConfig = map.terrain;
        if (!environmentInitialized) {
            createEnvironment(map.world.trees);
            createCity(map.world.city);
            initMinimap(map.world.city);
            environmentInitialized = true;
        }
        setWorldColliders(map.world);
    }

    for (const id of Object.keys(state.remotePlayers)) removeRemotePlayer(id);
    clearRemoteViews();
    clearProjectiles();
    clearCoins();
    clearPowerupMarkers();

    setCurrentRoom(data.room);
    const party = data.room.kind === 'party';
    if (data.items) {
        const collectedPowerups = new Set(data.items.powerups.filter(p => p.collected).map(p => p.id));
        const collectedCoins = new Set(data.items.coins.filter(c => c.collected).map(c => c.id));
        state.worldPowerups = map.world.powerups.map(p => ({ ...p, collected: collectedPowerups.has(p.id) }));
        state.worldPowerups.forEach(p => createPowerupMarker(p));
        state.serverCoins = map.world.coins.map(c => ({ ...c, collected: collectedCoins.has(c.id) }));
        createCoinsFromServer(state.serverCoins);
    } else {
        state.worldPowerups = [];
        state.serverCoins = [];
    }
    state.scoreboard = data.scoreboard;
    state.health = data.health[state.myId ?? ''] ?? 100;
    state.dead = false;

    const world = simWorldFor(state.terrainConfig ?? DEFAULT_TERRAIN_CONFIG, state.worldColliders);
    const car = state.bulli?.vehicle?.car ?? placeholderCar(state.myId ?? 'local', state.myCarType);
    netDriver.enterRoom(world, party, data.members, car, state.myId ?? '');

    const firstJoin = !state.bulli;
    if (firstJoin) {
        createLocalPlayer(state.myColor ?? 0xD32F2F, state.myName, data.preview);
        removeLoader();
    } else {
        // Until the spawn the car waits at the preview spot
        placeLocalCarVisual(data.preview.x, data.preview.z, data.preview.yaw);
    }
    // Nothing carries over from the old room
    resetLocalPowerups();

    for (const member of data.members) {
        if (member.id !== state.myId && member.ready) addRemotePlayer(member);
        const remote = state.remotePlayers[member.id] as unknown as Bulli | undefined;
        if (remote) {
            remote.health = data.health[member.id] ?? 100;
            remote.updateHealthBar();
        }
    }
    updateScoreboardUI();
    startClockSync();
    startNetPump();
}

function updateMember(data: Extract<ServerMessage, { type: 'playerUpdated' }>) {
    const member = netDriver.members.get(data.id);
    if (!member) return;
    const next: MemberInfo = {
        ...member,
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.carType !== undefined ? { carType: data.carType } : {}),
        ...(data.profile !== undefined ? { profile: data.profile } : {})
    };
    netDriver.setMember(next);
    const remote = state.remotePlayers[data.id] as unknown as Bulli | undefined;
    if (remote && data.name !== undefined) {
        remote.name = data.name;
        const nameEl = remote.nametag?.querySelector('.nametag-name');
        if (nameEl) nameEl.textContent = data.name;
    }
    if (remote && data.carType !== undefined && data.carType !== remote.carType) {
        // A new body: rebuild the model where the old one stood
        removeRemotePlayer(data.id);
        addRemotePlayer(next);
    }
    updateScoreboardUI();
}

// ---- Events (3.6) ----

function handleEvent(event: GameEvent) {
    const me = state.myId;
    switch (event.type) {
        case 'spawn':
        case 'respawn': {
            if (event.id === me) {
                netDriver.spawnOwn(event.tick, event.x, event.z, event.yaw);
                const vehicle = state.bulli?.vehicle;
                if (vehicle && netDriver.prediction) vehicle.syncPrevFrom(netDriver.prediction.prev);
                respawnLocalCar(event.type === 'respawn' ? event.health : 100);
            } else {
                setRemoteDead(event.id, false);
                const remote = state.remotePlayers[event.id] as unknown as Bulli | undefined;
                if (remote && event.type === 'respawn') {
                    remote.health = event.health;
                    remote.updateHealthBar();
                }
            }
            return;
        }
        case 'contact': {
            // Own bumps sound from the prediction already
            if (event.a === me || event.b === me) return;
            const y = getTerrainHeight(event.x, event.z) + 1.2;
            spawnParticles(event.x, y, event.z, 0xFFB347, Math.min(12, Math.floor(event.dv)), 0.3, 2.0, 0.5);
            return;
        }
        case 'pickup':
            if (event.kind === 'coin') {
                if (event.playerId === me) confirmCoinPickup(event.itemId);
                else removeCoinById(event.itemId);
                return;
            }
            {
                const p = state.worldPowerups.find(pu => pu.id === event.itemId);
                if (p) p.collected = true;
                setPowerupCollectedVisual(event.itemId, true);
                if (event.playerId === me && p && isPowerupType(event.powerupType)
                    && event.startTick !== undefined && event.endTick !== undefined) {
                    netDriver.setWindow(event.powerupType, event.startTick, event.endTick);
                    applyPowerupEffect(p);
                }
            }
            return;
        case 'itemReset':
            if (event.kind === 'coin') {
                resetCoinById(event.itemId);
            } else {
                const p = state.worldPowerups.find(pu => pu.id === event.itemId);
                if (p) p.collected = false;
                setPowerupCollectedVisual(event.itemId, false);
            }
            return;
        case 'hit':
            if (event.target === me) {
                state.health = event.health;
                playHitSound();
                flashScreenRed();
            } else {
                const remote = state.remotePlayers[event.target] as unknown as Bulli | undefined;
                if (remote) {
                    remote.health = event.health;
                    remote.updateHealthBar();
                }
                if (event.source === me && event.cause === 'ram') {
                    playCollisionSound(0.5);
                    showHitmarker();
                }
            }
            return;
        case 'killed':
            addKillfeedEntry(event.killerName || 'Unknown', event.targetName || 'Unknown');
            if (event.target === me) {
                killLocalCar();
            } else {
                const remote = state.remotePlayers[event.target] as unknown as Bulli | undefined;
                if (remote) {
                    remote.health = 0;
                    remote.updateHealthBar();
                    spawnExplosion(remote.group.position.x, remote.group.position.y, remote.group.position.z, remote.colorCode);
                }
                setRemoteDead(event.target, true);
            }
            return;
        case 'carChanged': {
            const member = netDriver.members.get(event.id);
            if (member) netDriver.setMember({ ...member, carType: event.carType, profile: event.profile });
            return;
        }
        case 'honk': {
            const remote = state.remotePlayers[event.id];
            if (remote) remote.honk();
            return;
        }
    }
}

function resetLocalPowerups() {
    if (!state.bulli) return;
    for (const key of ['speed', 'size', 'jump', 'shield', 'magnet', 'ghost'] as const) {
        state.bulli.powerups[key].active = false;
        state.bulli.powerups[key].timer = 0;
    }
}

function killLocalCar() {
    state.dead = true;
    state.health = 0;
    netDriver.despawnOwn();
    releaseKeyboardInputs();
    resetMobileControls();
    if (state.bulli) {
        spawnExplosion(
            state.bulli.group.position.x,
            state.bulli.group.position.y,
            state.bulli.group.position.z,
            state.bulli.colorCode
        );
        state.bulli.flipGroup.visible = false;
    }
    resetLocalPowerups();
    showRespawnOverlay();
}

// The car is back (spawn or respawn): whole, visible, the camera jumps
function respawnLocalCar(health: number) {
    state.dead = false;
    state.health = health;
    releaseKeyboardInputs();
    resetMobileControls();
    resetLocalPowerups();
    if (state.bulli) {
        state.bulli.flipGroup.visible = true;
        state.bulli.health = health;
        state.bulli.speed = 0;
    }
    state.cameraSnapPending = true;
    hideRespawnOverlay();
}

// Before the spawn: the car stands at the preview spot of the room
function placeLocalCarVisual(x: number, z: number, yaw: number) {
    const car = state.bulli;
    if (!car) return;
    car.group.position.set(x, getTerrainHeight(x, z), z);
    car.angle = yaw;
    car.group.rotation.y = yaw;
    if (car.vehicle && !netDriver.prediction?.spawned) car.vehicle.place(x, z, yaw);
    state.cameraSnapPending = true;
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

let respawnInterval: number = 0;

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

    // Countdown - clear any prior interval to avoid stacking on rapid re-deaths
    if (respawnInterval) {
        clearInterval(respawnInterval);
        respawnInterval = 0;
    }
    let count = 3;
    const timerEl = document.getElementById('respawn-timer');
    if (timerEl) timerEl.textContent = 'Respawning in 3...';
    respawnInterval = window.setInterval(() => {
        count--;
        if (count <= 0) {
            clearInterval(respawnInterval);
            respawnInterval = 0;
            if (timerEl) timerEl.textContent = 'Respawning...';
        } else if (timerEl) {
            timerEl.textContent = `Respawning in ${count}...`;
        }
    }, 1000);
}

function hideRespawnOverlay() {
    if (respawnInterval) {
        clearInterval(respawnInterval);
        respawnInterval = 0;
    }
    const overlay = document.getElementById('respawn-overlay');
    if (overlay) overlay.style.display = 'none';
}

export function createLocalPlayer(color: number, name: string, spawn: { x: number; z: number; yaw?: number } = { x: 0, z: 0 }) {
    state.myColor = color;
    state.myName = name;
    const savedCarType = localStorage.getItem('bulli-car-type') || 'bulli';
    state.myCarType = savedCarType;
    state.bulli = new Bulli(color, true, savedCarType as CarType);
    state.bulli.group.position.set(spawn.x, getTerrainHeight(spawn.x, spawn.z), spawn.z);
    state.bulli.angle = spawn.yaw ?? 0;
    state.bulli.group.rotation.y = spawn.yaw ?? 0;
    state.cameraSnapPending = true;
    state.bulli.createNametag(name, true);
    state.scene.add(state.bulli.group);
    updateScoreboardUI();
}

export function addRemotePlayer(member: MemberInfo) {
    if (state.remotePlayers[member.id]) return;

    const remote = new Bulli(member.color, false, (member.carType as CarType) || undefined);
    remote.name = member.name;
    remote.health = 100;
    // Hidden until its first snapshot places it
    remote.flipGroup.visible = false;
    remote.createNametag(member.name, false);
    remote.updateHealthBar();

    state.scene.add(remote.group);
    state.remotePlayers[member.id] = remote as any;
    updateScoreboardUI();
}

export function removeRemotePlayer(id: string) {
    const remote = state.remotePlayers[id];
    if (remote) {
        state.scene.remove(remote.group);
        remote.dispose();
        delete state.remotePlayers[id];
        forgetRemote(id);
        updateScoreboardUI();
    }
}

export function removeLoader() {
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
