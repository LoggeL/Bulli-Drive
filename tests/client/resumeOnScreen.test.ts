// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyResumeOutcome, type ResumePage } from '../../src/client/network/resumeOutcome.js';
import { showRespawnOverlay } from '../../src/client/ui/respawnOverlay.js';

// What the page shows after a room state (applyResumeOutcome in
// src/client/network/resumeOutcome.ts, docs/phase-1b-design.md 11.1), on
// the real respawn overlay: the decision itself is tested in
// resumeOutcome.test.ts. The case behind it: shot down in the Party, the
// connection dropped before the respawn event came, and back within the
// grace time the server has respawned the car meanwhile.

const overlay = () => document.getElementById('respawn-overlay');
const countdown = () => document.getElementById('respawn-timer')?.textContent;

// The page right after a kill (websocket.ts killLocalCar): car hidden,
// health 0, the overlay counting down
function killedPage(): ResumePage {
    showRespawnOverlay();
    return { bulli: { bodyGroup: { visible: false }, health: 0 }, health: 0, dead: true };
}

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('the own car on screen after a room state', () => {
    it('killed and back while the server respawned the car: overlay gone, car shown with its health', () => {
        const page = killedPage();
        expect(overlay()!.style.display).toBe('flex');
        // enterRoom took the health from the room state and cleared dead
        page.health = 80;
        page.dead = false;
        const ready: string[] = [];
        applyResumeOutcome('resumedCar', page, () => ready.push('ready'));
        expect(overlay()!.style.display).toBe('none');
        expect(page.bulli).toEqual({ bodyGroup: { visible: true }, health: 80 });
        expect(page.dead).toBe(false);
        // The car is on the server already: no new one is asked for
        expect(ready).toEqual([]);
    });

    it('back in the Party while dead: car hidden, the overlay counts down to the respawn', () => {
        vi.useFakeTimers();
        const page: ResumePage = { bulli: { bodyGroup: { visible: true }, health: 100 }, health: 100, dead: false };
        applyResumeOutcome('deadInParty', page, () => { throw new Error('no ready while dead'); });
        expect(page.dead).toBe(true);
        expect(page.bulli!.bodyGroup.visible).toBe(false);
        expect(overlay()!.style.display).toBe('flex');
        expect(overlay()!.textContent).toContain('ELIMINATED');
        expect(countdown()).toBe('Respawning in 3...');
        vi.advanceTimersByTime(1000);
        expect(countdown()).toBe('Respawning in 2...');
        vi.advanceTimersByTime(2000);
        expect(countdown()).toBe('Respawning...');
    });

    it('a new session past the splash screen asks for the car once and leaves the screen alone', () => {
        const page: ResumePage = { bulli: { bodyGroup: { visible: true }, health: 100 }, health: 100, dead: false };
        const ready: string[] = [];
        applyResumeOutcome('sendReady', page, () => ready.push('ready'));
        expect(ready).toEqual(['ready']);
        expect(overlay()).toBeNull();
        expect(page).toEqual({ bulli: { bodyGroup: { visible: true }, health: 100 }, health: 100, dead: false });
    });

    it('on the splash screen nothing happens until START', () => {
        const page: ResumePage = { bulli: null, health: 100, dead: false };
        const ready: string[] = [];
        applyResumeOutcome('wait', page, () => ready.push('ready'));
        expect(ready).toEqual([]);
        expect(overlay()).toBeNull();
        expect(page.dead).toBe(false);
    });
});
