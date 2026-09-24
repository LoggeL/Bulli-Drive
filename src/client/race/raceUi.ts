import type { BotLevel, TrackId } from '../../shared/race/types.js';
import { TRACKS } from '../../shared/race/tracks/index.js';
import { isTrackId } from '../../shared/race/tracks/index.js';
import type { HudView, LobbyView, ResultsView } from './raceModel.js';
import { drawTrackPreview } from './trackMap.js';

// The race HUD and the lobby and results sheets in the page (index.html,
// docs/phase-2-design.md 17.2 and 17.5): renders the views of raceModel.ts
// and turns taps into actions. Every write is skipped when nothing
// changed, so calling the renderers every frame costs next to nothing.
// Player names only ever go in as text.

export interface RaceActions {
    ready(ready: boolean): void;
    config(change: { track?: TrackId; botLevel?: BotLevel }): void;
    vote(choice: 'rematch' | 'next'): void;
    retry(): void;
    // Race lobby: to the time trial; time trial lobby: to the race
    switchMode(): void;
    // A new race room instead of watching ("START OWN RACE")
    ownRace(): void;
    car(carType: string): void;
    // The GO zone of the touch layout (auto-gas from now on)
    go(): void;
}

// The next-gate arrow: rotation (degrees) and distance, or none
export interface ArrowView {
    degrees: number;
    distance: number;
    missed: boolean;
}

const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

function setText(node: Element | null, text: string): void {
    if (node && node.textContent !== text) node.textContent = text;
}

function setHidden(node: HTMLElement | null, hidden: boolean): void {
    if (node && node.hidden !== hidden) node.hidden = hidden;
}

function toggle(node: Element | null, name: string, on: boolean): void {
    if (node && node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

function setAttr(node: Element | null, name: string, value: string): void {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

let actions: RaceActions | null = null;
let lobbyReady = false;

function onAction(event: Event): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-race-action], [data-track], [data-bot], [data-car]');
    if (!target || !actions || (target as HTMLButtonElement).disabled) return;
    // A tapped button must not keep the focus (Space drives)
    (target as HTMLButtonElement).blur?.();
    const { raceAction, track, bot, car } = target.dataset;
    if (track !== undefined) {
        if (isTrackId(track)) actions.config({ track });
        return;
    }
    if (bot !== undefined) {
        if ((BOT_LEVELS as readonly string[]).includes(bot)) actions.config({ botLevel: bot as BotLevel });
        return;
    }
    if (car !== undefined) {
        actions.car(car);
        return;
    }
    switch (raceAction) {
        case 'rematch': actions.vote('rematch'); return;
        case 'next': actions.vote('next'); return;
        case 'retry': actions.retry(); return;
        case 'switch': actions.switchMode(); return;
        case 'own': actions.ownRace(); return;
        default: return;
    }
}

/** Wires the buttons of the race HUD and sheets to the actions (once). */
export function initRaceUi(handlers: RaceActions): void {
    actions = handlers;
    for (const id of ['race-lobby', 'race-results', 'race-spectate']) el(id)?.addEventListener('click', onAction);
    el('race-ready')?.addEventListener('click', event => {
        (event.currentTarget as HTMLButtonElement).blur();
        actions?.ready(!lobbyReady);
    });
    el('race-retry')?.addEventListener('click', event => {
        (event.currentTarget as HTMLButtonElement).blur();
        actions?.retry();
    });
    // The GO zone reacts on touch down: the launch window is a third of a second
    el('race-go')?.addEventListener('pointerdown', event => {
        event.preventDefault();
        actions?.go();
    });
    el('race-go')?.addEventListener('click', event => {
        if ((event as MouseEvent).detail === 0) actions?.go();
    });
}

// ---- HUD ----

/**
 * The race HUD: position, time, lap and split, the next-gate arrow, the
 * countdown with the launch window, the banner, the GO zone (touch with
 * auto-gas, until the tap or green) and the spectator note.
 */
export function renderHud(view: HudView | null, arrow: ArrowView | null, goZone: boolean): void {
    const hud = el('race-hud');
    setHidden(hud, !view || view.spectating);
    toggle(document.body, 'race-spectating', !!view?.spectating);
    setHidden(el('race-spectate'), !view?.spectating);
    if (view && !view.spectating) {
        const pos = el('race-pos');
        setHidden(pos, view.position === null);
        setText(pos, view.position ?? '');
        setText(el('race-time'), view.time);
        setText(el('race-lap'), view.lap ?? '');
        const split = el('race-split');
        setText(split, view.split?.text ?? '');
        toggle(split, 'ahead', !!view.split?.ahead);
        toggle(split, 'behind', !!view.split && !view.split.ahead);
        setHidden(el('race-retry'), view.mode !== 'timetrial');
    }
    const next = el('race-next');
    setHidden(next, !arrow || !view || view.spectating);
    if (arrow && next) {
        const transform = `rotate(${Math.round(arrow.degrees)}deg)`;
        const svg = next.querySelector<SVGElement>('.race-arrow');
        if (svg && svg.style.transform !== transform) svg.style.transform = transform;
        setText(el('race-next-dist'), `${arrow.distance} m`);
        toggle(next, 'missed', arrow.missed);
    }

    const countdown = view?.countdown ?? null;
    const box = el('race-countdown');
    setHidden(box, !countdown);
    toggle(document.body, 'race-counting', !!countdown && !countdown.green);
    if (countdown && box) {
        box.querySelectorAll('.race-lights span').forEach((light, i) => {
            toggle(light, 'on', !countdown.green && i < countdown.lights);
            toggle(light, 'green', countdown.green);
        });
        setText(el('race-count-label'), countdown.label);
        toggle(box, 'window', countdown.windowOpen);
        toggle(box, 'go', countdown.green);
        const fill = box.querySelector<HTMLElement>('.race-launch-fill');
        const width = `${Math.round(countdown.lastSecond * 100)}%`;
        if (fill && fill.style.width !== width) fill.style.width = width;
    }
    setHidden(el('race-go'), !goZone);

    const banner = el('race-banner');
    const shown = view?.banner ?? null;
    setHidden(banner, !shown);
    if (shown && banner) {
        setText(banner, shown.text);
        setAttr(banner, 'data-kind', shown.kind);
    }
}

// ---- Lobby ----

let driversKey = '';
let previewTrack: TrackId | null = null;

function selectSegment(selector: string, key: string, value: string): void {
    document.querySelectorAll<HTMLElement>(selector).forEach(button => {
        const on = button.dataset[key] === value;
        setAttr(button, 'aria-checked', String(on));
        (button as HTMLButtonElement).tabIndex = on ? 0 : -1;
    });
}

/** The lobby sheet (null hides it); carType: the own car. */
export function renderLobby(view: LobbyView | null, carType: string): void {
    const sheet = el('race-lobby');
    setHidden(sheet, !view);
    toggle(document.body, 'race-lobby-open', !!view);
    if (!view || !sheet) return;
    lobbyReady = view.selfReady;
    const trial = view.mode === 'timetrial';
    setText(el('race-lobby-title'), trial ? 'TIME TRIAL' : 'RACE LOBBY');
    toggle(sheet, 'timetrial', trial);
    selectSegment('#race-lobby [data-track]', 'track', view.trackId);
    selectSegment('#race-lobby [data-bot]', 'bot', view.botLevel);
    document.querySelectorAll<HTMLElement>('#race-lobby [data-car]').forEach(button => {
        setAttr(button, 'aria-pressed', String(button.dataset.car === carType));
    });
    if (previewTrack !== view.trackId) {
        previewTrack = view.trackId;
        const canvas = el<HTMLCanvasElement>('race-track-preview');
        if (canvas) {
            drawTrackPreview(canvas, TRACKS[view.trackId]);
            setAttr(canvas, 'aria-label', `Map of ${view.trackName}`);
        }
    }
    const key = JSON.stringify(view.drivers);
    if (key !== driversKey) {
        driversKey = key;
        const list = el('race-drivers');
        if (list) {
            list.replaceChildren(...view.drivers.map(driver => {
                const item = document.createElement('li');
                item.className = driver.ready ? 'ready' : '';
                if (driver.self) item.classList.add('self');
                const name = document.createElement('span');
                name.className = 'race-driver-name';
                name.textContent = driver.name;
                const state = document.createElement('span');
                state.className = 'race-driver-state';
                state.textContent = driver.ready ? 'READY' : 'waiting';
                item.append(name, state);
                return item;
            }));
        }
    }
    const readyButton = el('race-ready');
    setText(readyButton, trial ? 'START' : view.selfReady ? 'READY ✓' : 'READY');
    setAttr(readyButton!, 'aria-pressed', String(view.selfReady));
    setText(el('race-lobby-switch'), trial ? 'RACE' : 'TIME TRIAL');
    const status = view.startsIn !== null
        ? `Starts in ${view.startsIn} s`
        : trial ? 'START when you are ready' : 'Waiting for READY – bots fill the grid';
    setText(el('race-lobby-status'), status);
}

// ---- Results ----

let rowsKey = '';

/** The results sheet (null hides it). */
export function renderResults(view: ResultsView | null): void {
    const sheet = el('race-results');
    setHidden(sheet, !view);
    toggle(document.body, 'race-results-open', !!view);
    if (!view || !sheet) return;
    const trial = view.mode === 'timetrial';
    toggle(sheet, 'timetrial', trial);
    setText(el('race-results-title'), `${trial ? 'TIME TRIAL' : 'RESULTS'} – ${view.trackName}`);
    const lapColumn = view.rows.some(row => row.bestLap !== null);
    toggle(sheet, 'with-laps', lapColumn);
    const key = JSON.stringify(view.rows);
    if (key !== rowsKey) {
        rowsKey = key;
        const body = document.querySelector('#race-table tbody');
        body?.replaceChildren(...view.rows.map(row => {
            const tr = document.createElement('tr');
            if (row.self) tr.className = 'self';
            const cells = [String(row.pos), row.name, row.car, row.time, row.bestLap ?? ''];
            cells.forEach((text, i) => {
                const td = document.createElement('td');
                td.textContent = text;
                if (i === 1 && row.bot) {
                    const tag = document.createElement('span');
                    tag.className = 'race-bot-tag';
                    tag.textContent = 'BOT';
                    td.append(' ', tag);
                }
                if (i === 4) td.className = 'race-col-lap';
                tr.append(td);
            });
            return tr;
        }));
    }
    const record = el('race-record');
    setHidden(record, !trial);
    if (trial) {
        const parts = [view.record ? `RECORD ${view.record}` : 'NO RECORD YET'];
        if (view.personal) parts.push(`YOUR BEST ${view.personal}${view.improved ? ' – NEW!' : ''}`);
        setText(record, parts.join(' · '));
    }
    const rematch = el<HTMLButtonElement>('race-rematch');
    const next = el<HTMLButtonElement>('race-next-track');
    if (rematch) {
        rematch.dataset.raceAction = trial ? 'retry' : 'rematch';
        setText(rematch, trial ? 'RETRY' : `REMATCH${view.votes && view.votes.rematch > 0 ? ` (${view.votes.rematch})` : ''}`);
        setAttr(rematch, 'aria-pressed', String(view.selfVote === 'rematch'));
    }
    if (next) {
        setText(next, `NEXT TRACK${!trial && view.votes && view.votes.next > 0 ? ` (${view.votes.next})` : ''}`);
        setAttr(next, 'aria-pressed', String(view.selfVote === 'next'));
    }
    setText(el('race-results-status'), view.closesIn !== null ? `Next ${trial ? 'run' : 'race'} in ${view.closesIn} s` : '');
}
