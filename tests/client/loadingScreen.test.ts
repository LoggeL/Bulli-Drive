// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The loading screen (src/client/ui/loadingScreen.ts, docs/ui.md 3): it
// takes the bar over from the inline bootstrap, shows the real progress,
// covers the page until it fades into the splash screen, and stays as the
// backdrop when WebGL is refused.

type Screen = typeof import('../../src/client/ui/loadingScreen.js');

const MARKUP = `
    <div id="loading-screen" aria-busy="true">
        <p class="loader-notice" hidden></p>
        <div class="loader-progress" role="progressbar" aria-valuenow="0">
            <div class="loader-fill"></div><span class="loader-percent">0 %</span>
        </div>
        <p class="loader-status">Loading the game</p>
        <button class="loader-reload" hidden>Reload</button>
        <p class="loader-tip"></p>
        <p id="loader-live" aria-live="polite"></p>
    </div>
    <div id="splash-screen" class="hidden"><input id="splash-name-input"></div>`;

let screen: Screen;
let now = 0;
const clock = { now: () => now };

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    now = 0;
    document.body.innerHTML = MARKUP;
    delete (window as unknown as { __bulliLoad?: unknown }).__bulliLoad;
    screen = await import('../../src/client/ui/loadingScreen.js');
});

afterEach(() => {
    vi.useRealTimers();
});

const text = (selector: string) => document.querySelector(selector)!.textContent;

describe('the loading screen', () => {
    it('covers the page until it starts to fade, then no longer', () => {
        expect(screen.loadingScreenCovers()).toBe(true);
        // removeLoader: opacity 0 (the fade), then the element goes
        document.getElementById('loading-screen')!.style.opacity = '0';
        expect(screen.loadingScreenCovers()).toBe(false);
        document.getElementById('loading-screen')!.remove();
        expect(screen.loadingScreenCovers()).toBe(false);
    });

    it('takes the bar over from the bootstrap without going back', () => {
        // The bootstrap counted all code files: 20 % (the code step's smallest share)
        const boot = { code: 1, shown: 0.2, taken: false };
        (window as unknown as { __bulliLoad: typeof boot }).__bulliLoad = boot;
        // Phone steps: code 25 of 95 = 26 %
        screen.startLoadingScreen('mobile', { clock });
        expect(boot.taken).toBe(true);
        expect(text('.loader-percent')).toBe('20 %');
        // The bar catches up at 30 % a second
        vi.advanceTimersByTime(1000);
        expect(text('.loader-percent')).toBe('26 %');
        expect(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('26');
    });

    it('names the running step and counts it', () => {
        const progress = screen.startLoadingScreen('desktop', { clock });
        progress.report('textures', 0.5, [14, 28]);
        vi.advanceTimersByTime(100);
        expect(text('.loader-status')).toBe('Loading the bay · textures 14/28');
        // Read out too, but not more than every 2 s (the start was read out at 0 s)
        expect(text('#loader-live')).toBe('Connecting to the server');
        progress.report('textures', 0.6, [17, 28]);
        vi.advanceTimersByTime(1800);
        expect(text('.loader-status')).toBe('Loading the bay · textures 17/28');
        expect(text('#loader-live')).toBe('Connecting to the server');
        vi.advanceTimersByTime(100);
        expect(text('#loader-live')).toBe('Loading the bay · textures 17/28');
    });

    it('reports every step through the polls it runs', () => {
        const progress = screen.startLoadingScreen('mobile', { clock });
        let settled = 0;
        screen.onLoadPoll(() => progress.report('kit', settled / 4, [settled, 4]));
        settled = 3;
        vi.advanceTimersByTime(100);
        expect(progress.task('kit')!.count).toEqual([3, 4]);
    });

    it('fades into the splash screen and then goes', () => {
        screen.startLoadingScreen('desktop', { clock });
        let shows = 0;
        document.getElementById('splash-screen')!.addEventListener('menushow', () => shows++);
        screen.removeLoader();
        const loader = document.getElementById('loading-screen')!;
        expect(document.getElementById('splash-screen')!.classList.contains('hidden')).toBe(false);
        expect(screen.loadingScreenCovers()).toBe(false);
        expect(loader.getAttribute('aria-busy')).toBe('false');
        vi.advanceTimersByTime(600);
        expect(document.getElementById('loading-screen')).toBeNull();
        // A second call changes nothing: the menu opens once
        screen.removeLoader();
        expect(shows).toBe(1);
    });

    it('runs the bar to 100 % before it fades, however far behind it was', async () => {
        const progress = screen.startLoadingScreen('mobile', { clock });
        // The bar shows the code step (26 %), the rest is done at once
        vi.advanceTimersByTime(1000);
        expect(text('.loader-percent')).toBe('26 %');
        for (const id of ['connect', 'map', 'textures', 'kit', 'car', 'warmup'] as const) progress.done(id);
        const finished = screen.finishLoader();
        expect(text('.loader-percent')).toBe('100 %');
        expect(document.querySelector<HTMLElement>('.loader-fill')!.style.transform).toBe('scaleX(1)');
        // Still covering while the bar runs its last stretch (0.26 s)
        vi.advanceTimersByTime(screen.FINISH_MS - 1);
        expect(screen.loadingScreenCovers()).toBe(true);
        vi.advanceTimersByTime(1);
        await finished;
        expect(screen.loadingScreenCovers()).toBe(false);
    });

    it('says it waits for the server instead of a step, and offers a reload after 10 s', () => {
        screen.startLoadingScreen('desktop', { clock });
        vi.advanceTimersByTime(100);
        const reload = document.querySelector<HTMLElement>('.loader-reload')!;
        screen.showLoaderWaiting('Waiting for the server · retrying', performance.now());
        expect(text('.loader-status')).toBe('Waiting for the server · retrying');
        expect(document.querySelector('.loader-status')!.classList.contains('loader-waiting')).toBe(true);
        expect(reload.hidden).toBe(true);
        vi.advanceTimersByTime(screen.LOADER_RELOAD_OFFER_MS - 200);
        expect(reload.hidden).toBe(true);
        vi.advanceTimersByTime(300);
        expect(reload.hidden).toBe(false);
        // The server is there: the steps again, no reload
        screen.clearLoaderWaiting();
        expect(text('.loader-status')).not.toContain('Waiting');
        expect(document.querySelector('.loader-status')!.classList.contains('loader-waiting')).toBe(false);
        expect(reload.hidden).toBe(true);
    });

    it('stays as the backdrop when nothing more will load', () => {
        screen.startLoadingScreen('desktop', { clock });
        screen.stopLoadingScreen('3D graphics unavailable');
        const loader = document.getElementById('loading-screen')!;
        expect(loader.classList.contains('loader-stopped')).toBe(true);
        expect(loader.getAttribute('aria-busy')).toBe('false');
        expect(text('.loader-status')).toBe('3D graphics unavailable');
        // The polls stopped: the line keeps saying so
        vi.advanceTimersByTime(1000);
        expect(text('.loader-status')).toBe('3D graphics unavailable');
        expect(screen.loadingScreenCovers()).toBe(true);
    });

    it('shows a notice, e.g. lite graphics', () => {
        screen.showLoaderNotice('Lite graphics');
        const notice = document.querySelector<HTMLElement>('.loader-notice')!;
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toBe('Lite graphics');
    });
});
