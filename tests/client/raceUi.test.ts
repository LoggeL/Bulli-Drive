// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HudView, LobbyView, ResultsView } from '../../src/client/race/raceModel.js';
import { initRaceUi, renderHud, renderLobby, renderResults, type RaceActions } from '../../src/client/race/raceUi.js';
import { setGameMap } from '../../src/client/map/gameMap.js';
import { mapFor } from '../../src/server/maps.js';
import { TRACK_IDS, trackDef } from '../../src/shared/race/tracks/index.js';
import type { TrackId } from '../../src/shared/race/types.js';

// The race HUD and sheets in the page (src/client/race/raceUi.ts,
// docs/phase-2-design.md 17.2) on the real markup of index.html: what the
// views show, and which tap sends which action. The views themselves are
// tested in raceModel.test.ts.

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const calls: unknown[][] = [];
// The lobby draws the track's map: the map the game would have loaded
setGameMap(mapFor());
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const actions: RaceActions = {
    ready: ready => calls.push(['ready', ready]),
    config: change => calls.push(['config', change]),
    vote: choice => calls.push(['vote', choice]),
    retry: () => calls.push(['retry']),
    switchMode: () => calls.push(['switch']),
    ownRace: () => calls.push(['own']),
    car: carType => calls.push(['car', carType]),
    go: () => calls.push(['go'])
};

function lobby(patch: Partial<LobbyView> = {}): LobbyView {
    return {
        mode: 'race', trackId: 'downtown-loop', trackName: 'Downtown Loop', laps: 3, botLevel: 'medium',
        drivers: [{ id: 'me', name: 'Me', ready: false, self: true }, { id: 'x', name: '<b>Evil</b>', ready: true, self: false }],
        selfReady: false, startsIn: 12, ...patch
    };
}

function hud(patch: Partial<HudView> = {}): HudView {
    return {
        mode: 'race', position: 'P2/6', lap: 'LAP 1/3', time: '0:12.345', split: null, countdown: null, banner: null,
        spectating: false, ...patch
    };
}

describe('the race UI', () => {
    beforeAll(() => {
        document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(readFileSync(INDEX, 'utf8'))![1]
            .replace(/<script[\s\S]*?<\/script>/g, '');
        initRaceUi(actions);
    });

    beforeEach(() => {
        calls.length = 0;
    });

    it('lists the drivers as text with their ready state, and sends READY and its undo', () => {
        renderLobby(lobby(), 'bulli');
        expect(byId('race-lobby').hidden).toBe(false);
        const items = [...byId('race-drivers').querySelectorAll('li')];
        expect(items.map(li => li.querySelector('.race-driver-name')!.textContent)).toEqual(['Me', '<b>Evil</b>']);
        // A name is never markup
        expect(byId('race-drivers').querySelector('b')).toBeNull();
        expect(items.map(li => li.classList.contains('ready'))).toEqual([false, true]);
        expect(byId('race-lobby-status').textContent).toBe('Starts in 12 s');
        byId('race-ready').click();
        renderLobby(lobby({ selfReady: true }), 'bulli');
        expect(byId('race-ready').getAttribute('aria-pressed')).toBe('true');
        byId('race-ready').click();
        expect(calls).toEqual([['ready', true], ['ready', false]]);
    });

    it('offers every track of the map by its name, in the order of the rotation', () => {
        const buttons = [...document.querySelectorAll<HTMLElement>('#race-lobby [data-track]')];
        expect(buttons.map(b => b.dataset.track)).toEqual([...TRACK_IDS]);
        for (const button of buttons) {
            const name = trackDef(mapFor(), button.dataset.track as TrackId).name.toUpperCase();
            expect(button.firstChild!.textContent).toBe(name);
        }
    });

    it('picks the track, the bots and the car, and switches to the time trial', () => {
        renderLobby(lobby(), 'sport');
        const track = document.querySelector<HTMLElement>('#race-lobby [data-track="hill-sprint"]')!;
        expect(document.querySelector('#race-lobby [data-track="downtown-loop"]')!.getAttribute('aria-checked')).toBe('true');
        expect(track.getAttribute('aria-checked')).toBe('false');
        expect(document.querySelector('#race-lobby [data-car="sport"]')!.getAttribute('aria-pressed')).toBe('true');
        track.click();
        document.querySelector<HTMLElement>('#race-lobby [data-bot="hard"]')!.click();
        document.querySelector<HTMLElement>('#race-lobby [data-car="jeep"]')!.click();
        byId('race-lobby-switch').click();
        expect(calls).toEqual([['config', { track: 'hill-sprint' }], ['config', { botLevel: 'hard' }], ['car', 'jeep'], ['switch']]);
        // The time trial lobby: START and the way back to the race
        renderLobby(lobby({ mode: 'timetrial', startsIn: null }), 'sport');
        expect(byId('race-ready').textContent).toBe('START');
        expect(byId('race-lobby-switch').textContent).toBe('RACE');
        expect(document.body.classList.contains('race-lobby-open')).toBe(true);
        renderLobby(null, 'sport');
        expect(byId('race-lobby').hidden).toBe(true);
        // The touch controls come back with the sheet gone (style.css)
        expect(document.body.classList.contains('race-lobby-open')).toBe(false);
    });

    it('shows the results with BOT tags, and votes for a rematch or the next track', () => {
        const view: ResultsView = {
            mode: 'race', trackName: 'Hill Sprint', closesIn: 9, votes: { rematch: 1, next: 0 }, selfVote: null,
            record: null, personal: null, improved: false,
            rows: [
                { pos: 1, name: 'Kalle', bot: true, self: false, car: 'Beetle', time: '0:25.000', bestLap: null },
                { pos: 2, name: 'Me', bot: false, self: true, car: 'Bulli', time: '0:26.500', bestLap: null }
            ]
        };
        renderResults(view);
        expect(byId('race-results').hidden).toBe(false);
        const rows = [...document.querySelectorAll('#race-table tbody tr')];
        expect(rows.map(r => [...r.querySelectorAll('td')].slice(0, 4).map(td => td.textContent))).toEqual([
            ['1', 'Kalle BOT', 'Beetle', '0:25.000'],
            ['2', 'Me', 'Bulli', '0:26.500']
        ]);
        expect(rows[1].classList.contains('self')).toBe(true);
        expect(byId('race-rematch').textContent).toBe('REMATCH (1)');
        expect(byId('race-results-status').textContent).toBe('Next race in 9 s');
        byId('race-rematch').click();
        byId('race-next-track').click();
        // The time trial: RETRY instead of the rematch, and the record line
        renderResults({ ...view, mode: 'timetrial', record: '0:24.000 · Uschi', personal: '0:26.500', improved: true });
        expect(byId('race-record').textContent).toBe('RECORD 0:24.000 · Uschi · YOUR BEST 0:26.500 – NEW!');
        byId('race-rematch').click();
        expect(calls).toEqual([['vote', 'rematch'], ['vote', 'next'], ['retry']]);
        expect(document.body.classList.contains('race-results-open')).toBe(true);
        renderResults(null);
        expect(document.body.classList.contains('race-results-open')).toBe(false);
    });

    it('shows the countdown lights, the launch window, the GO zone and the banner', () => {
        renderHud(hud({ countdown: { lights: 2, green: false, label: '2', windowOpen: false, lastSecond: 0 } }), null, true);
        const lights = [...document.querySelectorAll('.race-lights span')];
        expect(lights.map(l => l.classList.contains('on'))).toEqual([true, true, false]);
        expect(byId('race-count-label').textContent).toBe('2');
        expect(byId('race-countdown').hidden).toBe(false);
        expect(document.body.classList.contains('race-counting')).toBe(true);
        expect(byId('race-go').hidden).toBe(false);
        byId('race-go').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        expect(calls).toEqual([['go']]);
        renderHud(hud({ countdown: { lights: 3, green: false, label: '1', windowOpen: true, lastSecond: 0.7 } }), null, false);
        expect(byId('race-countdown').classList.contains('window')).toBe(true);
        expect(byId('race-go').hidden).toBe(true);
        renderHud(hud({ countdown: { lights: 3, green: true, label: 'GO!', windowOpen: false, lastSecond: 1 }, banner: { text: 'PERFECT START!', kind: 'good' } }), null, false);
        expect(lights.map(l => l.classList.contains('green'))).toEqual([true, true, true]);
        expect(document.body.classList.contains('race-counting')).toBe(false);
        expect(byId('race-banner').textContent).toBe('PERFECT START!');
        expect(byId('race-banner').dataset.kind).toBe('good');
        renderHud(hud(), null, false);
        expect(byId('race-countdown').hidden).toBe(true);
        expect(byId('race-banner').hidden).toBe(true);
    });

    it('shows position, time, lap, split and the next-gate arrow; a spectator gets START OWN RACE instead', () => {
        renderHud(hud({ split: { text: '+0.312', ahead: false } }), { degrees: -90.4, distance: 120, missed: false }, false);
        expect(byId('race-hud').hidden).toBe(false);
        expect(byId('race-pos').textContent).toBe('P2/6');
        expect(byId('race-time').textContent).toBe('0:12.345');
        expect(byId('race-lap').textContent).toBe('LAP 1/3');
        expect(byId('race-split').textContent).toBe('+0.312');
        expect(byId('race-split').classList.contains('behind')).toBe(true);
        expect(byId('race-next-dist').textContent).toBe('120 m');
        expect(document.querySelector<SVGElement>('.race-arrow')!.style.transform).toBe('rotate(-90deg)');
        expect(byId('race-retry').hidden).toBe(true);
        renderHud(hud({ mode: 'timetrial', position: null }), null, false);
        expect(byId('race-pos').hidden).toBe(true);
        expect(byId('race-retry').hidden).toBe(false);
        expect(byId('race-next').hidden).toBe(true);
        renderHud(hud({ spectating: true, position: null }), null, false);
        expect(byId('race-hud').hidden).toBe(true);
        expect(byId('race-spectate').hidden).toBe(false);
        document.querySelector<HTMLElement>('#race-spectate [data-race-action="own"]')!.click();
        expect(calls).toEqual([['own']]);
        renderHud(null, null, false);
        expect(byId('race-hud').hidden).toBe(true);
        expect(byId('race-spectate').hidden).toBe(true);
    });
});
