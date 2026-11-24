import { DEFAULT_ROOM_KIND, isRoomKind, type MapId, type RoomInfo, type RoomKind } from '../../shared/protocol.js';
import { DEFAULT_MAP_ID, isMapId, mapDescriptor } from '../../shared/map/registry.js';
import { sendToServer } from '../network/socket.js';
import { state } from '../state.js';
import { openCodex } from './codex.js';
import { STORAGE_KEYS } from './menu/menuState.js';
import { openSettings } from './menu/settingsDialog.js';

// Party, Free Roam, Race or Time Trial across all 4 playable maps: the mode &
// map picked in the menu, the room chip in the HUD with its live map+mode
// switcher (and Codex + Settings), and the body classes controlling HUD layout.

const STORAGE_KEY = 'bulli-room-kind';
// The server takes one room switch per two seconds
const SWITCH_COOLDOWN_MS = 2000;
// Give up waiting for 'roomState' after this long (the buttons unlock)
const SWITCH_TIMEOUT_MS = 5000;

const LABELS: Record<RoomKind, string> = { party: 'PARTY', freeroam: 'FREE ROAM', race: 'RACE', timetrial: 'TIME TRIAL' };
const NAMES: Record<RoomKind, string> = { party: 'Party', freeroam: 'Free Roam', race: 'Race', timetrial: 'Time Trial' };
const MAP_SHORT_LABELS: Record<MapId, string> = {
    'bulli-bay': 'BAY',
    'alpen-pass': 'ALPEN',
    'stunt-forge': 'STUNT',
    'logge-forge': 'FORGE'
};

let pendingSwitch: { kind: RoomKind; mapId?: MapId } | null = null;
let lockedUntil = 0;
let unlockTimer = 0;

/** The mode this browser played last (localStorage), Party by default. */
export function preferredRoomKind(): RoomKind {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return isRoomKind(saved) ? saved : DEFAULT_ROOM_KIND;
    } catch {
        return DEFAULT_ROOM_KIND;
    }
}

/** The map this browser played last (localStorage), Bulli Bay by default. */
export function preferredMapId(): MapId {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.map);
        return isMapId(saved) ? saved : DEFAULT_MAP_ID;
    } catch {
        return DEFAULT_MAP_ID;
    }
}

function rememberRoomKind(kind: RoomKind): void {
    try {
        localStorage.setItem(STORAGE_KEY, kind);
    } catch { /* private mode: the default stays */ }
}

function rememberMapId(mapId: MapId): void {
    try {
        localStorage.setItem(STORAGE_KEYS.map, mapId);
    } catch { /* private mode: the default stays */ }
}

/** True in the Party (offline and in the sandbox too): shooting, coins, HP. */
export function partyRulesActive(): boolean {
    return !state.room || state.room.kind === 'party';
}

/** A race or time trial room. */
export function isRaceKind(kind: RoomKind | undefined): boolean {
    return kind === 'race' || kind === 'timetrial';
}

/**
 * DRIVE in the menu (ui/menu/menu.ts): moves to the chosen mode and map first
 * if the connection joined another one (the server handles joinRoom before
 * ready). The menu shows a time trial as Race: a time trial played last
 * stays a time trial while Race stays picked.
 */
export function applyMenuMode(mode: 'party' | 'freeroam' | 'race', mapId?: MapId): void {
    const kind: RoomKind = mode === 'race' && (state.room?.kind ?? preferredRoomKind()) === 'timetrial' ? 'timetrial' : mode;
    rememberRoomKind(kind);
    if (mapId && isMapId(mapId)) rememberMapId(mapId);
    if (!state.room) return;
    const currentMap = state.room.mapId ?? DEFAULT_MAP_ID;
    const targetMap = mapId && isMapId(mapId) ? mapId : currentMap;
    if (state.room.kind !== kind || targetMap !== currentMap) {
        requestRoom(kind, targetMap !== currentMap ? { mapId: targetMap } : {});
    }
}

// ---- In the game ----

function setPanelOpen(open: boolean): void {
    const chip = document.getElementById('room-chip');
    const panel = document.getElementById('room-panel');
    if (!chip || !panel) return;
    chip.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) {
        // One panel at a time
        const scoreboardToggle = document.getElementById('scoreboard-toggle');
        if (scoreboardToggle?.getAttribute('aria-expanded') === 'true') scoreboardToggle.click();
    }
}

function renderRoomUi(): void {
    const room = state.room;
    const kind = room?.kind ?? DEFAULT_ROOM_KIND;
    const activeMap: MapId = room?.mapId && isMapId(room.mapId) ? room.mapId : state.mapId;
    document.body.classList.toggle('room-freeroam', kind === 'freeroam');
    document.body.classList.toggle('room-party', kind === 'party');
    document.body.classList.toggle('room-race', isRaceKind(kind));
    document.body.classList.toggle('room-timetrial', kind === 'timetrial');

    const mode = document.getElementById('room-chip-mode');
    const index = document.getElementById('room-chip-index');
    const chip = document.getElementById('room-chip');
    if (mode) mode.textContent = LABELS[kind];
    if (index) {
        index.textContent = !room
            ? 'OFFLINE'
            : activeMap === DEFAULT_MAP_ID
                ? `ROOM ${room.index}`
                : `${MAP_SHORT_LABELS[activeMap]} · R${room.index}`;
    }
    if (chip) {
        const mapName = mapDescriptor(activeMap).name;
        chip.setAttribute('aria-label', `Game mode: ${NAMES[kind]}${room ? `, ${mapName}, room ${room.index}` : ''}. Change mode or map`);
    }

    const locked = pendingSwitch !== null || performance.now() < lockedUntil;
    document.querySelectorAll<HTMLButtonElement>('.room-option').forEach(option => {
        const current = option.dataset.room === kind;
        option.setAttribute('aria-current', String(current));
        option.disabled = current || locked || !room;
    });
    document.querySelectorAll<HTMLButtonElement>('.room-map-option').forEach(option => {
        const current = option.dataset.map === activeMap;
        option.setAttribute('aria-current', String(current));
        option.disabled = current || locked || !room;
    });
}

export function initRoomMenu(): void {
    const shell = document.getElementById('player-list');
    const chip = document.getElementById('room-chip');
    if (!shell || !chip) return;
    chip.addEventListener('click', () => setPanelOpen(chip.getAttribute('aria-expanded') !== 'true'));
    document.querySelectorAll<HTMLButtonElement>('.room-option').forEach(option => {
        option.addEventListener('click', () => {
            if (!isRoomKind(option.dataset.room)) return;
            // The hidden button must not keep the focus (Space drives)
            option.blur();
            requestRoom(option.dataset.room);
        });
    });
    document.querySelectorAll<HTMLButtonElement>('.room-map-option').forEach(option => {
        option.addEventListener('click', () => {
            if (!isMapId(option.dataset.map)) return;
            option.blur();
            requestRoom(state.room?.kind ?? DEFAULT_ROOM_KIND, { mapId: option.dataset.map });
        });
    });
    document.getElementById('room-codex')?.addEventListener('click', () => {
        setPanelOpen(false);
        openCodex();
    });
    document.getElementById('room-settings')?.addEventListener('click', () => {
        setPanelOpen(false);
        const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        openSettings(coarse ? 'touch' : 'keyboard');
    });
    // The scoreboard closes the mode menu, and a tap elsewhere closes it
    document.getElementById('scoreboard-toggle')?.addEventListener('click', () => setPanelOpen(false));
    document.addEventListener('pointerdown', (event) => {
        if (chip.getAttribute('aria-expanded') === 'true' && !shell.contains(event.target as Node)) setPanelOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && chip.getAttribute('aria-expanded') === 'true') {
            setPanelOpen(false);
            chip.focus();
        }
    });
    renderRoomUi();
}

/**
 * Asks the server for a room of that kind and optional target map (the answer
 * is 'roomState'). fresh: a new race instance even from a race room.
 */
export function requestRoom(kind: RoomKind, options: { fresh?: boolean; mapId?: MapId } = {}): void {
    if (!state.room || pendingSwitch) return;
    const currentMap = state.room.mapId ?? DEFAULT_MAP_ID;
    const targetMap = options.mapId && isMapId(options.mapId) ? options.mapId : currentMap;
    const sameTarget = state.room.kind === kind && targetMap === currentMap;
    if (sameTarget && !options.fresh) return;
    if (performance.now() < lockedUntil) return;

    const msg: { type: 'joinRoom'; kind: RoomKind; mapId?: MapId; fresh?: boolean } = { type: 'joinRoom', kind };
    if (options.mapId && isMapId(options.mapId)) msg.mapId = options.mapId;
    if (options.fresh) msg.fresh = true;

    if (!sendToServer(msg)) return;
    pendingSwitch = { kind, mapId: options.mapId };
    rememberRoomKind(kind);
    if (options.mapId && isMapId(options.mapId)) rememberMapId(options.mapId);
    window.clearTimeout(unlockTimer);
    unlockTimer = window.setTimeout(() => {
        pendingSwitch = null;
        renderRoomUi();
    }, SWITCH_TIMEOUT_MS);
    renderRoomUi();
}

/** The server put this client into a room ('roomState'). */
export function setCurrentRoom(room: RoomInfo): void {
    state.room = room;
    if (room.mapId && isMapId(room.mapId)) {
        state.mapId = room.mapId;
    }
    if (pendingSwitch) {
        pendingSwitch = null;
        window.clearTimeout(unlockTimer);
        lockedUntil = performance.now() + SWITCH_COOLDOWN_MS;
        unlockTimer = window.setTimeout(renderRoomUi, SWITCH_COOLDOWN_MS);
    }
    setPanelOpen(false);
    renderRoomUi();
}
