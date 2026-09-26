import { state } from '../state.js';
import { CONFIG } from '../config.js';
import {
    PROTOCOL_VERSION,
    type GameEvent,
    type MemberInfo,
    type ServerMessage
} from '../../shared/protocol.js';
import { decodeSnapshot } from '../../shared/net/codec.js';
import { CLOCK_BURST_INTERVAL_MS, CLOCK_BURST_PINGS, CLOCK_INTERVAL_MS } from '../../shared/net/constants.js';
import { closeAction, reconnectDelayMs } from '../../shared/net/reconnect.js';
import { isPowerupType } from '../../shared/party/rules.js';
import { resetTuning, tuningIsDefault } from '../../shared/sim/tuning.js';
import type { MapData } from '../../shared/map/mapData.js';
import { gameMap, loadGameMap, reloadForMap } from '../map/gameMap.js';
import { Bulli, type CarType } from '../entities/Bulli.js';
import { createMapScene, setMapSceneRoom } from '../world/mapScene.js';
import { clearPowerupMarkers, createPowerupMarker, applyPowerupEffect, setPowerupCollectedVisual } from '../world/powerups.js';
import { clearProjectiles } from '../world/projectiles.js';
import { clearCoins, confirmCoinPickup, createCoinsFromServer, removeCoinById, resetCoinById } from '../world/coins.js';
import { updateScoreboardUI } from '../ui/playerList.js';
import { groundHeight } from '../world/ground.js';
import { playCollisionSound, playHitSound } from '../effects/sounds.js';
import { spawnExplosion, spawnParticles } from '../effects/particles.js';
import { addKillfeedEntry, showHitmarker, updateScoreUI } from '../ui/hud.js';
import { initMinimap } from '../ui/minimap.js';
import { releaseKeyboardInputs } from '../controls/keyboard.js';
import { resetMobileControls } from '../controls/mobile.js';
import { sendToServer, setSocketNetsim } from './socket.js';
import { createSocketNetsim } from '../net/netsim.js';
import { hideConnectionOverlay, reconnectingText, showConnectionNotice, showReconnecting } from '../ui/connectionOverlay.js';
import { roomSimWorld, setGameMapWorld } from '../vehicle/simWorldClient.js';
import { assistProfileForDevice } from '../vehicle/LocalVehicle.js';
import { startNetPump } from '../vehicle/v2Driver.js';
import { preferredRoomKind, setCurrentRoom } from '../ui/roomMenu.js';
import { netDriver, placeholderCar } from '../net/netDriver.js';
import { reloadOnce } from './reloadOnce.js';
import { applyResumeOutcome, resumeOutcome } from './resumeOutcome.js';
import { hideRespawnOverlay, showRespawnOverlay } from '../ui/respawnOverlay.js';
import { clearRemoteViews, forgetRemote, noteSnapshotCars, setRemoteDead } from '../net/remotes.js';
import { raceClient } from '../race/RaceClient.js';
import { mapFeaturesGroup } from '../race/TrackDressing.js';

// The connection to the game server on protocol v2 (docs/phase-1b-design.md,
// 3 and 11): the handshake, the map's world, the room state, the
// events and the binary snapshots, which go to the prediction
// (net/netDriver.ts) and the remote cars (net/remotes.ts). A lost
// connection comes back on its own: the session token brings the same
// player and car back within the grace time, a resume ticket from a
// restart the colour and the Party score.

let map: MapData | null = null;
let clockTimer = 0;
let snapshotWarned = false;
// Random per page load, only in memory (duplicated tabs, 11.1)
const connId = Math.random().toString(36).slice(2) + Date.now().toString(36);

const VERSION_RELOAD_KEY = 'bulli-protocol-reload';
const BUILD_RELOAD_KEY = 'bulli-build-version-reload';
const WORLD_RELOAD_KEY = 'bulli-world-reload';
const SESSION_KEY = 'bulli-session';
const RESUME_KEY = 'bulli-resume';

// Connection state: which socket is current (older ones are ignored), whether
// this page ever had a socket open, the reconnect attempt and since when
// the connection is gone (-1 while connected)
let socketGeneration = 0;
let everOpened = false;
let reconnectAttempt = 0;
let reconnectTimer = 0;
let restartDelayMs: number | null = null;
let disconnectedAt = -1;
// Past the splash screen: after a reconnect as a new session the car
// spawns again right away
let playerReady = false;
// E2E only: no reconnect before this time (performance.now), so a test
// can look at the banner
let holdReconnectUntil = 0;

// For the e2e hook and the net overlay
export const connectionInfo = {
    reconnects: 0,
    resumed: false,
    lastCloseCode: 0,
    get disconnectedAt(): number { return disconnectedAt; }
};

function pageBuild(): string | null {
    return document.querySelector<HTMLMetaElement>('meta[name="bulli-build-version"]')?.content || null;
}

function storageGet(key: string): string | undefined {
    try {
        return sessionStorage.getItem(key) || undefined;
    } catch {
        return undefined;
    }
}

function storageSet(key: string, value: string | null): void {
    try {
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
    } catch { /* private mode */ }
}

/** E2E hook: keeps the next reconnect back for ms (the banner stays up). */
export function holdReconnect(ms: number): void {
    holdReconnectUntil = performance.now() + ms;
}

/** The splash screen is done: the player drives (main.ts). */
export function markPlayerReady(): void {
    playerReady = true;
    raceClient.markPlayerReady();
}

export function initWebSocket() {
    // Online the server drives every car with the default tuning (7)
    if (!tuningIsDefault()) resetTuning();

    // Background tabs get throttled: the server treats the car as idle, and
    // back in front the client jumps to a fresh tick estimate (5.4, 8.3)
    document.addEventListener('visibilitychange', () => {
        sendToServer({ type: 'visibility', hidden: document.hidden });
        if (!document.hidden) netDriver.resync(performance.now());
    });
    // The map first (sources and terrain), then the socket: 'roomState'
    // needs the map to check the world and to predict
    const tryLoad = (attempt: number): void => {
        loadGameMap().then(() => connect()).catch(error => {
            // A map from a newer deploy: this page cannot read it, reload
            if (reloadForMap(error)) return;
            console.error('Map failed to load', error);
            window.setTimeout(() => tryLoad(attempt + 1), Math.min(10_000, 1000 * 2 ** attempt));
        });
    };
    tryLoad(0);
}

function connect() {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    const generation = ++socketGeneration;
    const ws = new WebSocket(CONFIG.serverUrl);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    // ?netsim: both directions of this socket go through the simulated network
    const netsim = createSocketNetsim();
    setSocketNetsim(netsim);
    const current = () => generation === socketGeneration;

    ws.onopen = () => {
        if (!current()) return;
        everOpened = true;
        sendHello();
    };

    ws.onmessage = (event) => {
        if (!current()) return;
        const data = event.data as string | ArrayBuffer;
        if (netsim) netsim.down.send(() => { if (current()) onFrame(data); }, typeof data !== 'string');
        else onFrame(data);
    };

    ws.onerror = (e) => {
        if (!current()) return;
        // The close event follows and decides what to do
        console.warn('WebSocket error', e);
    };

    ws.onclose = (event) => {
        if (!current()) return;
        const { code, reason } = event;
        // The close waits behind whatever the netsim still holds
        if (netsim) netsim.down.send(() => { netsim.close(); if (current()) onClosed(code, reason); }, false, true);
        else onClosed(code, reason);
    };
}

function sendHello() {
    const savedName = localStorage.getItem('bulli-player-name') || '';
    const sessionToken = storageGet(SESSION_KEY);
    const resume = storageGet(RESUME_KEY);
    sendToServer({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        build: pageBuild(),
        connId,
        ...(sessionToken ? { sessionToken } : {}),
        ...(resume ? { resume } : {}),
        name: savedName,
        carType: localStorage.getItem('bulli-car-type') || 'bulli',
        profile: assistProfileForDevice(),
        room: state.room?.kind ?? preferredRoomKind()
    });
}

function onFrame(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
        onSnapshotFrame(data);
        return;
    }
    let msg: ServerMessage;
    try {
        msg = JSON.parse(data);
    } catch (err) {
        console.warn('Dropping malformed server message', err);
        return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
        console.warn('Dropping server message without type');
        return;
    }
    handleServerMessage(msg);
}

// The socket is gone: what happens next depends on why (11.1)
function onClosed(code: number, reason: string) {
    window.clearTimeout(clockTimer);
    connectionInfo.lastCloseCode = code;
    const now = performance.now();
    netDriver.suspend(now);
    console.warn(`Connection closed (${code}${reason ? ` ${reason}` : ''})`);
    if (disconnectedAt < 0) disconnectedAt = now;
    switch (closeAction(code, reason)) {
        case 'reload':
            // The reject handler reloads (or shows why it does not)
            return;
        case 'manual':
            showConnectionNotice(code === 4005 ? 'Playing in another tab' : code === 4001
                ? 'Could not join the game' : 'Disconnected by the server', 'Reconnect', reconnectNow);
            return;
        case 'continue':
            showConnectionNotice('Disconnected after a long break', 'Continue', reconnectNow);
            return;
        case 'reconnect': {
            // Never connected yet: the loader stays and the banner says why
            const text = reconnectingText(code, everOpened);
            const delay = Math.max(restartDelayMs ?? reconnectDelayMs(reconnectAttempt, Math.random), holdReconnectUntil - now);
            restartDelayMs = null;
            reconnectAttempt++;
            showReconnecting(disconnectedAt, text);
            reconnectTimer = window.setTimeout(connect, delay);
            return;
        }
    }
}

function reconnectNow() {
    reconnectAttempt = 0;
    if (disconnectedAt < 0) disconnectedAt = performance.now();
    showReconnecting(performance.now() - 1000, 'Reconnecting…');
    connect();
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
            // Full: the close that follows retries with backoff
            if (data.reason === 'full') return;
            if (data.reason === 'version' && data.reload && reloadOnce(VERSION_RELOAD_KEY, String(data.serverProtocol))) return;
            showConnectionNotice(data.reason === 'version' ? 'A new version is out' : 'Could not join the game');
            return;
        case 'welcome': {
            // The token first: it has to survive a reload right below
            storageSet(SESSION_KEY, data.sessionToken);
            storageSet(RESUME_KEY, null);
            if (disconnectedAt >= 0) connectionInfo.reconnects++;
            connectionInfo.resumed = data.resumed;
            reconnectAttempt = 0;
            disconnectedAt = -1;
            hideConnectionOverlay();
            // A new deploy with the same protocol: load the new client once
            const build = pageBuild();
            if (build && data.serverBuild && build !== data.serverBuild && reloadOnce(BUILD_RELOAD_KEY, data.serverBuild)) return;
            state.myId = data.playerId;
            state.myColor = data.color;
            state.myName = data.name;
            // The own car carries the player id in the sim (contacts, order)
            if (state.bulli?.vehicle) state.bulli.vehicle.car.id = data.playerId;
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
            if (data.own) {
                state.score = data.own.score;
                state.rank = data.own.rank;
            } else {
                takeOwnScoreFromBoard();
            }
            updateScoreUI();
            updateScoreboardUI();
            return;
        case 'kicked':
            // The close that follows (4003 / 4004) shows what to do
            return;
        case 'shutdown':
            // A restart: come back after reconnectInMs with the ticket (11.2, 11.3)
            restartDelayMs = Math.max(0, Math.min(10_000, data.reconnectInMs));
            if (data.resume) storageSet(RESUME_KEY, data.resume);
            return;
        case 'raceState':
        case 'raceStatus':
        case 'raceResults':
        case 'ghostData':
            raceClient.onMessage(data);
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

// The map was built from the same sources and terrain before the socket
// opened (map/gameMap.ts); the hash proves it is the server's
function checkWorld(built: MapData, world: Extract<ServerMessage, { type: 'roomState' }>['world']): void {
    if (built.mapId !== world.mapId || built.worldHash !== world.worldHash) {
        console.warn(`World ${built.mapId} ${built.worldHash} differs from the server's ${world.mapId} ${world.worldHash}`);
        reloadOnce(WORLD_RELOAD_KEY, world.worldHash);
    }
}

// A room: the first after joining or another after a switch
// (docs/phase-1b-design.md, 9): same map, so the scene stays; players,
// items and the car start over.
function enterRoom(data: Extract<ServerMessage, { type: 'roomState' }>) {
    if (!map) {
        map = gameMap();
        if (!map) throw new Error('roomState before the map was loaded');
        checkWorld(map, data.world);
        setGameMapWorld(map);
        const ramps = mapFeaturesGroup(map);
        if (ramps) state.scene.add(ramps);
        // The map's world: terrain, sea, roads, buildings, plants (once per page)
        createMapScene(map);
        initMinimap(map);
    } else {
        checkWorld(map, data.world);
    }

    for (const id of Object.keys(state.remotePlayers)) removeRemotePlayer(id);
    clearRemoteViews();
    clearProjectiles();
    clearCoins();
    clearPowerupMarkers();

    setCurrentRoom(data.room);
    setMapSceneRoom(data.room.kind);
    const party = data.room.kind === 'party';
    if (data.items) {
        const collectedPowerups = new Set(data.items.powerups.filter(p => p.collected).map(p => p.id));
        const collectedCoins = new Set(data.items.coins.filter(c => c.collected).map(c => c.id));
        state.worldPowerups = map.items.powerups.map(p => ({ ...p, collected: collectedPowerups.has(p.id) }));
        state.worldPowerups.forEach(p => createPowerupMarker(p));
        state.serverCoins = map.items.coins.map(c => ({ ...c, collected: collectedCoins.has(c.id) }));
        createCoinsFromServer(state.serverCoins);
    } else {
        state.worldPowerups = [];
        state.serverCoins = [];
    }
    state.scoreboard = data.scoreboard;
    // Until the next scoreboard brings the exact numbers
    state.score = 0;
    state.rank = 0;
    takeOwnScoreFromBoard();
    updateScoreUI();
    state.health = data.health[state.myId ?? ''] ?? 100;
    state.dead = false;

    // A race room brings its race world (map + track) along
    raceClient.enterRoom(data.room, data.race, map, state.myId ?? '');
    const world = roomSimWorld(data.room.kind);
    const car = state.bulli?.vehicle?.car ?? placeholderCar(state.myId ?? 'local', state.myCarType);
    netDriver.enterRoom(world, party, data.members, car, state.myId ?? '');
    raceClient.bindPrediction();
    // Back after a lost connection with the car still on the server: the
    // next snapshot brings it (11.1)
    const outcome = resumeOutcome(data, { playerReady, myId: state.myId });
    const resumedCar = outcome === 'resumedCar';
    if (data.resume) netDriver.resumeOwn(data.resume);

    const firstJoin = !state.bulli;
    if (firstJoin) {
        createLocalPlayer(state.myColor ?? 0xD32F2F, state.myName, data.preview);
        removeLoader();
    } else if (!resumedCar) {
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
    applyResumeOutcome(outcome, state, () => sendToServer({ type: 'ready' }));
}

// The own score and rank as far as the top 10 tell
function takeOwnScoreFromBoard() {
    const index = state.scoreboard.findIndex(entry => entry.id === state.myId);
    if (index < 0) return;
    state.score = state.scoreboard[index].score;
    state.rank = index + 1;
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
    raceClient.onEvent(event);
    switch (event.type) {
        case 'despawn':
            // A race without this car (not ready at the countdown): it leaves the sim
            if (event.id === me) {
                netDriver.despawnOwn();
                if (state.bulli) state.bulli.flipGroup.visible = false;
            } else {
                setRemoteDead(event.id, true);
            }
            return;
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
            const y = groundHeight(event.x, event.z) + 1.2;
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
    for (const key of ['speed', 'size', 'shield', 'magnet', 'ghost'] as const) {
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
    car.group.position.set(x, groundHeight(x, z), z);
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

export function createLocalPlayer(color: number, name: string, spawn: { x: number; z: number; yaw?: number } = { x: 0, z: 0 }) {
    state.myColor = color;
    state.myName = name;
    const savedCarType = localStorage.getItem('bulli-car-type') || 'bulli';
    state.myCarType = savedCarType;
    state.bulli = new Bulli(color, true, savedCarType as CarType);
    state.bulli.group.position.set(spawn.x, groundHeight(spawn.x, spawn.z), spawn.z);
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
    // Race bots carry the tag BOT (docs/phase-2-design.md, 6.3)
    if (member.bot) {
        const badge = document.createElement('span');
        badge.className = 'bot-badge';
        badge.textContent = ' BOT';
        remote.nametag?.querySelector('.nametag-name')?.appendChild(badge);
    }
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
