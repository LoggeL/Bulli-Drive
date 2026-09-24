// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../src/client/state.js';
import {
    applySplashChoice, initModeSelector, initRoomMenu, preferredRoomKind, requestRoom, setCurrentRoom
} from '../../src/client/ui/roomMenu.js';

// Party or Free Roam on the client (src/client/ui/roomMenu.ts,
// docs/phase-1b-design.md 9): the remembered mode, the splash choice that
// moves the connection before the car spawns, and the room chip with its
// menu, the switch lock and the page classes that hide the Party HUD. The
// markup is index.html's own. Room isolation and switching on the server:
// tests/server/lobby.test.ts and the bot test 'room switch'.

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const sent: Array<{ type: string; kind?: string }> = [];

const option = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;
const text = (id: string) => document.getElementById(id)!.textContent;

describe('the game mode', () => {
    beforeAll(() => {
        // The switch lock runs on performance.now and timers
        vi.useFakeTimers();
        document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(readFileSync(INDEX, 'utf8'))![1]
            .replace(/<script[\s\S]*?<\/script>/g, '');
        state.ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket;
        initRoomMenu();
    });

    beforeEach(() => {
        sent.length = 0;
        localStorage.clear();
    });

    afterAll(() => vi.useRealTimers());

    it('remembers the last mode, Party by default', () => {
        expect(preferredRoomKind()).toBe('party');
        localStorage.setItem('bulli-room-kind', 'freeroam');
        expect(preferredRoomKind()).toBe('freeroam');
        localStorage.setItem('bulli-room-kind', 'deathmatch');
        expect(preferredRoomKind()).toBe('party');
        const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
        expect(preferredRoomKind()).toBe('party');
        blocked.mockRestore();
    });

    it('moves to the mode chosen on the splash screen before the car spawns', () => {
        localStorage.setItem('bulli-room-kind', 'party');
        initModeSelector();
        expect(option('.mode-option[data-room="party"]').getAttribute('aria-checked')).toBe('true');
        option('.mode-option[data-room="freeroam"]').click();
        expect(option('.mode-option[data-room="freeroam"]').getAttribute('aria-checked')).toBe('true');
        expect(option('.mode-option[data-room="party"]').getAttribute('aria-checked')).toBe('false');

        // The server put the connection into the Party; START moves it
        // (main.ts sends 'ready' right after this)
        setCurrentRoom({ id: 'party-1', kind: 'party', index: 1 });
        applySplashChoice();
        expect(sent).toEqual([{ type: 'joinRoom', kind: 'freeroam' }]);
        expect(preferredRoomKind()).toBe('freeroam');
        // Already in the chosen mode: nothing to send
        setCurrentRoom({ id: 'freeroam-1', kind: 'freeroam', index: 1 });
        sent.length = 0;
        applySplashChoice();
        expect(sent).toEqual([]);
    });

    it('shows the room on the chip and hides the Party HUD in Free Roam', () => {
        setCurrentRoom({ id: 'freeroam-2', kind: 'freeroam', index: 2 });
        expect(document.body.classList.contains('room-freeroam')).toBe(true);
        expect(document.body.classList.contains('room-party')).toBe(false);
        expect(text('room-chip-mode')).toBe('FREE ROAM');
        expect(text('room-chip-index')).toBe('ROOM 2');
        setCurrentRoom({ id: 'party-1', kind: 'party', index: 1 });
        expect(document.body.classList.contains('room-party')).toBe(true);
        expect(text('room-chip-mode')).toBe('PARTY');
    });

    it('switches from the chip menu, locked while it waits and for the 2 s cooldown', () => {
        setCurrentRoom({ id: 'freeroam-1', kind: 'freeroam', index: 1 });
        // Past the lock of the earlier switch
        vi.advanceTimersByTime(2000);
        option('#room-chip').click();
        expect(document.getElementById('room-panel')!.hidden).toBe(false);
        expect(option('.room-option[data-room="freeroam"]').disabled).toBe(true);
        expect(option('.room-option[data-room="party"]').disabled).toBe(false);

        option('.room-option[data-room="party"]').click();
        expect(sent).toEqual([{ type: 'joinRoom', kind: 'party' }]);
        expect(preferredRoomKind()).toBe('party');
        // Waiting for the server: no second request
        expect(option('.room-option[data-room="party"]').disabled).toBe(true);
        requestRoom('party');
        expect(sent).toHaveLength(1);

        setCurrentRoom({ id: 'party-1', kind: 'party', index: 1 });
        expect(document.getElementById('room-panel')!.hidden).toBe(true);
        // The server takes one switch per 2 s
        requestRoom('freeroam');
        expect(sent).toHaveLength(1);
        vi.advanceTimersByTime(2000);
        requestRoom('freeroam');
        expect(sent).toEqual([{ type: 'joinRoom', kind: 'party' }, { type: 'joinRoom', kind: 'freeroam' }]);
        setCurrentRoom({ id: 'freeroam-1', kind: 'freeroam', index: 1 });
    });
});
