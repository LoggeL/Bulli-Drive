// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryDef } from '../../src/shared/map/discoverySchema.js';
import { DiscoveryTracker } from '../../src/client/ui/discoveryTracker.js';

const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
const BODY = /<body>([\s\S]*)<\/body>/.exec(readFileSync(INDEX, 'utf8'))![1].replace(/<script[\s\S]*?<\/script>/g, '');

const DEFS: readonly DiscoveryDef[] = [
    {
        id: 'forge-arch',
        title: 'LMF Forge Arch',
        subtitle: 'Aus Neugier. Gemacht.',
        alloy: 'forge',
        projectRef: 'lmf.logge.top',
        x: 0,
        z: 0,
        hint: 'Drive straight through the glowing arch.',
        codexEntry: 'The central gateway of Logge Media Forge.',
        toast: 'Welcome to Logge Media Forge!',
        rewardEffect: 'sparks',
        trigger: { kind: 'proximity', radius: 15 }
    },
    {
        id: 'secret-toaster',
        title: 'FI Toaster',
        subtitle: 'Breakfast Easter Egg',
        alloy: 'games',
        x: 100,
        z: 100,
        hint: 'Honk by the shiny kitchen appliance.',
        codexEntry: 'Crispy golden bread straight from the arcade.',
        toast: 'Ding! Toast is ready!',
        rewardEffect: 'confetti',
        trigger: { kind: 'horn', radius: 15 },
        secret: true
    }
];

describe('Discovery Codex UI & Toast Banner', () => {
    let codex: typeof import('../../src/client/ui/codex.js');
    let state: (typeof import('../../src/client/state.js'))['state'];
    let tracker: DiscoveryTracker;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        document.body.innerHTML = BODY;
        state = (await import('../../src/client/state.js')).state;
        state.inMenu = false;
        state.isModalOpen = false;
        state.ws = null;
        const store = new Map<string, string>();
        tracker = new DiscoveryTracker({
            getItem: k => store.get(k) ?? null,
            setItem: (k, v) => { store.set(k, v); }
        });
        tracker.setMap('logge-forge', DEFS);
        codex = await import('../../src/client/ui/codex.js');
        codex.initCodex(tracker);
    });

    afterEach(() => {
        codex?.disposeCodex();
        vi.useRealTimers();
    });

    it('renders HUD badge counts, opens via C key, filters by alloy, and toggles radar pinning', () => {
        const chip = document.getElementById('codex-chip')!;
        expect(chip.hidden).toBe(false);
        expect(document.getElementById('codex-chip-count')!.textContent).toBe('0/2');

        // Pressing C opens the Codex modal and pauses driving input
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        const dialog = document.getElementById('codex-dialog') as HTMLDialogElement;
        expect(dialog.open).toBe(true);
        expect(state.isModalOpen).toBe(true);

        // Secret undiscovered entry hides its real title and shows the cryptic hint
        const cards = [...document.querySelectorAll('.codex-card')];
        expect(cards).toHaveLength(2);
        expect(cards[1].querySelector('.codex-card-title')!.textContent).toBe('Classified Secret');
        expect(cards[1].querySelector('.codex-card-body')!.textContent).toBe('Honk by the shiny kitchen appliance.');

        // Filtering to 'games' shows only the games card
        document.querySelector<HTMLButtonElement>('.codex-filter[data-alloy="games"]')!.click();
        expect(document.querySelectorAll('.codex-card')).toHaveLength(1);

        // Pinning via "Track on Radar" updates tracker state & button pressed state
        const pinBtn = document.querySelector<HTMLButtonElement>('.codex-pin-btn')!;
        pinBtn.click();
        expect(tracker.getPinnedId()).toBe('secret-toaster');
        expect(document.querySelector<HTMLButtonElement>('.codex-pin-btn')!.getAttribute('aria-pressed')).toBe('true');

        // Pressing C again closes the modal and clears isModalOpen
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        expect(dialog.open).toBe(false);
        expect(state.isModalOpen).toBe(false);
    });

    it('reveals full codex lore and shows celebratory toast on unlock, plus friend discovery toasts', () => {
        // Unlocking triggers the celebratory toast & updates counter
        tracker.onHorn(100, 100);
        expect(document.getElementById('codex-chip-count')!.textContent).toBe('1/2');
        const toast = document.getElementById('discovery-toast')!;
        expect(toast.hidden).toBe(false);
        expect(document.getElementById('discovery-toast-title')!.textContent).toBe('FI Toaster');
        expect(document.getElementById('discovery-toast-count')!.textContent).toBe('1 / 2');

        // Opening Codex now shows full title + codexEntry lore
        codex.openCodex();
        const secretCard = [...document.querySelectorAll('.codex-card')][1];
        expect(secretCard.classList.contains('found')).toBe(true);
        expect(secretCard.querySelector('.codex-card-title')!.textContent).toBe('FI Toaster');
        expect(secretCard.querySelector('.codex-card-body')!.textContent).toBe('Crispy golden bread straight from the arcade.');
        codex.closeCodex();

        // Advance past first toast, then verify multiplayer friend toast
        vi.advanceTimersByTime(6000);
        codex.showFriendDiscoveryToast('Kalle', 'forge-arch', 'logge-forge');
        expect(toast.hidden).toBe(false);
        expect(document.getElementById('discovery-toast-title')!.textContent).toBe('Kalle found LMF Forge Arch');
    });

    it('pins header, progress bar, and alloy filters outside the scrolling body and preserves scroll on pin click', () => {
        codex.openCodex();
        const dialog = document.getElementById('codex-dialog')!;
        const body = dialog.querySelector<HTMLElement>('.codex-body')!;
        const head = dialog.querySelector<HTMLElement>('.dialog-head')!;
        const progress = dialog.querySelector<HTMLElement>('.codex-progress-track')!;
        const filters = dialog.querySelector<HTMLElement>('#codex-filters')!;

        // Header, progress bar, and filter tabs must NOT live inside the scrolling .codex-body
        expect(body.contains(head)).toBe(false);
        expect(body.contains(progress)).toBe(false);
        expect(body.contains(filters)).toBe(false);
        expect([...dialog.children]).toEqual([head, progress, filters, body]);

        // Clicking "Track on Radar" preserves scroll position inside .codex-body
        body.scrollTop = 240;
        const pinBtn = body.querySelector<HTMLButtonElement>('.codex-pin-btn')!;
        pinBtn.click();
        expect(tracker.getPinnedId()).toBe('forge-arch');
        expect(body.scrollTop).toBe(240);
    });

    it('clears active and queued discovery toasts on map switch and resumes cleanly on the new map', () => {
        const toast = document.getElementById('discovery-toast')!;

        // Unlock both logge-forge discoveries: first is visible, second is queued
        tracker.update({ x: 0, z: 0, speedMs: 5, airborne: false, dt: 0.1 });
        tracker.onHorn(100, 100);
        expect(toast.hidden).toBe(false);
        expect(document.getElementById('discovery-toast-title')!.textContent).toBe('LMF Forge Arch');

        // Live-switch map to alpen-pass: active toast hides immediately and queued toast is dropped
        const alpenDef: DiscoveryDef = {
            id: 'alpen-chalet',
            title: 'Ramsen Chalet',
            subtitle: 'Alpine Refuge',
            alloy: 'alpine',
            x: 10,
            z: 10,
            hint: 'Drive to the chalet.',
            codexEntry: 'Warm cocoa at 210m.',
            toast: 'Chalet reached!',
            rewardEffect: 'sparks',
            trigger: { kind: 'proximity', radius: 15 }
        };
        tracker.setMap('alpen-pass', [alpenDef]);
        expect(toast.hidden).toBe(true);
        expect(toast.classList.contains('visible')).toBe(false);

        // Advancing timers must NEVER pop up the queued logge-forge toast
        vi.advanceTimersByTime(15_000);
        expect(toast.hidden).toBe(true);
        expect(document.getElementById('discovery-toast-title')!.textContent).not.toBe('FI Toaster');

        // Friend toast from old map is also ignored
        codex.showFriendDiscoveryToast('Kalle', 'forge-arch', 'logge-forge');
        expect(toast.hidden).toBe(true);

        // Unlocking a discovery on the new map displays normally (toastVisible was reset)
        tracker.update({ x: 10, z: 10, speedMs: 5, airborne: false, dt: 0.1 });
        expect(toast.hidden).toBe(false);
        expect(document.getElementById('discovery-toast-title')!.textContent).toBe('Ramsen Chalet');
        expect(document.getElementById('discovery-toast-count')!.textContent).toBe('1 / 1');
    });

    it('ignores C shortcut while typing in an input or while the main menu is open', () => {
        const dialog = document.getElementById('codex-dialog') as HTMLDialogElement;
        state.inMenu = true;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        expect(dialog.open).toBe(false);

        state.inMenu = false;
        const input = document.getElementById('splash-name-input') as HTMLInputElement;
        input.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        expect(dialog.open).toBe(false);
    });
});
