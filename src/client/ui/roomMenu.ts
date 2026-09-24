import { DEFAULT_ROOM_KIND, isRoomKind, type RoomInfo, type RoomKind } from '../../shared/protocol.js';
import { sendToServer } from '../network/socket.js';
import { state } from '../state.js';

// Party, Free Roam, Race or Time Trial (docs/phase-1b-design.md, 9 and
// docs/phase-2-design.md, 17.6): the choice on the splash screen, the room
// chip in the HUD with its mode menu, and the page classes that hide the
// Party HUD outside the Party and show the race HUD in races.

const STORAGE_KEY = 'bulli-room-kind';
// The server takes one room switch per two seconds
const SWITCH_COOLDOWN_MS = 2000;
// Give up waiting for 'roomState' after this long (the buttons unlock)
const SWITCH_TIMEOUT_MS = 5000;

const LABELS: Record<RoomKind, string> = { party: 'PARTY', freeroam: 'FREE ROAM', race: 'RACE', timetrial: 'TIME TRIAL' };
const NAMES: Record<RoomKind, string> = { party: 'Party', freeroam: 'Free Roam', race: 'Race', timetrial: 'Time Trial' };

let splashChoice: RoomKind = DEFAULT_ROOM_KIND;
let pendingKind: RoomKind | null = null;
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

function rememberRoomKind(kind: RoomKind): void {
    try {
        localStorage.setItem(STORAGE_KEY, kind);
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

// The splash offers Party, Free Roam and Race; the time trial counts as Race
function splashOption(kind: RoomKind): RoomKind {
    return kind === 'timetrial' ? 'race' : kind;
}

// ---- Splash screen ----

function renderSplashChoice(): void {
    document.querySelectorAll<HTMLElement>('.mode-option').forEach(option => {
        const checked = option.dataset.room === splashOption(splashChoice);
        option.setAttribute('aria-checked', String(checked));
        option.tabIndex = checked ? 0 : -1;
    });
}

export function initModeSelector(): void {
    splashChoice = preferredRoomKind();
    const options = [...document.querySelectorAll<HTMLElement>('.mode-option')];
    options.forEach((option, index) => {
        option.addEventListener('click', () => {
            if (isRoomKind(option.dataset.room)) splashChoice = option.dataset.room;
            renderSplashChoice();
        });
        // Radio group keys: arrows move the choice
        option.addEventListener('keydown', (event) => {
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = options[(index + step + options.length) % options.length];
            next.click();
            next.focus();
        });
    });
    renderSplashChoice();
}

/**
 * START on the splash: moves to the chosen mode first if the connection
 * joined another one (the server handles joinRoom before ready). A time
 * trial played last stays a time trial unless another mode was picked.
 */
export function applySplashChoice(): void {
    rememberRoomKind(splashChoice);
    if (state.room && state.room.kind !== splashChoice) requestRoom(splashChoice);
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
    document.body.classList.toggle('room-freeroam', kind === 'freeroam');
    document.body.classList.toggle('room-party', kind === 'party');
    document.body.classList.toggle('room-race', isRaceKind(kind));
    document.body.classList.toggle('room-timetrial', kind === 'timetrial');

    const mode = document.getElementById('room-chip-mode');
    const index = document.getElementById('room-chip-index');
    const chip = document.getElementById('room-chip');
    if (mode) mode.textContent = LABELS[kind];
    if (index) index.textContent = room ? `ROOM ${room.index}` : 'OFFLINE';
    if (chip) chip.setAttribute('aria-label', `Game mode: ${NAMES[kind]}${room ? `, room ${room.index}` : ''}. Change mode`);

    const locked = pendingKind !== null || performance.now() < lockedUntil;
    document.querySelectorAll<HTMLButtonElement>('.room-option').forEach(option => {
        const current = option.dataset.room === kind;
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
 * Asks the server for a room of that kind (the answer is 'roomState').
 * fresh: a new race instance even from a race room ("START OWN RACE").
 */
export function requestRoom(kind: RoomKind, options: { fresh?: boolean } = {}): void {
    if (!state.room || (state.room.kind === kind && !options.fresh) || pendingKind) return;
    if (performance.now() < lockedUntil) return;
    if (!sendToServer(options.fresh ? { type: 'joinRoom', kind, fresh: true } : { type: 'joinRoom', kind })) return;
    pendingKind = kind;
    rememberRoomKind(kind);
    window.clearTimeout(unlockTimer);
    unlockTimer = window.setTimeout(() => {
        pendingKind = null;
        renderRoomUi();
    }, SWITCH_TIMEOUT_MS);
    renderRoomUi();
}

/** The server put this client into a room ('roomState'). */
export function setCurrentRoom(room: RoomInfo): void {
    state.room = room;
    if (pendingKind) {
        pendingKind = null;
        window.clearTimeout(unlockTimer);
        lockedUntil = performance.now() + SWITCH_COOLDOWN_MS;
        unlockTimer = window.setTimeout(renderRoomUi, SWITCH_COOLDOWN_MS);
    }
    setPanelOpen(false);
    renderRoomUi();
}
