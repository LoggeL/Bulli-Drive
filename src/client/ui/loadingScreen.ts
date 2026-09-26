import { approachProgress, createLoadProgress, loadTasksFor, type LoadClock, type LoadProgress, type TaskId, type TaskState } from './loadProgress.js';
import { inputKindFor, tipFor, TIP_INTERVAL_MS, type InputKind } from './loaderTips.js';

// The loading screen (index.html #loading-screen, docs/ui.md 3): the key art
// of the menu's showroom, the wordmark, a bar with the real progress
// (ui/loadProgress.ts), a status line and tips. It paints before any game
// code (inline CSS, and the inline bootstrap that counts the code files in
// window.__bulliLoad); this module takes over once the game code runs,
// polls the loaders, and fades the loader out into the menu once every
// step of the loader phase is done or gave up (main.ts).
//
// It is opaque and covers the whole page until then. While it covers the
// page, a drawn frame is thrown away, so the render loop skips drawing
// (main.ts): on a phone that is battery, on a CPU rasterizer most of the
// page's first seconds.

interface Bootstrap {
    code: number;
    shown: number;
    taken: boolean;
}

const POLL_MS = 100;
// The status line is read out at most this often (aria-live)
const ANNOUNCE_MS = 2000;
const FADE_MS = 400;

let progress: LoadProgress | null = null;
let taskIds: TaskId[] = [];
const pollers: Array<() => void> = [];
let pollTimer = 0;
let tipTimer = 0;
let shown = 0;
let lastPaint = 0;
let lastAnnounce = -Infinity;
let announced = '';
let removed = false;
let debugStates: Map<TaskId, TaskState> | null = null;
let debugStart = 0;

/** Whether the loading screen still covers the page (not fading out, not gone). */
export function loadingScreenCovers(doc: Document = document): boolean {
    const loader = doc.getElementById('loading-screen');
    return !!loader && loader.style.opacity !== '0';
}

/** The page's load progress (null before startLoadingScreen). */
export function loadProgress(): LoadProgress | null {
    return progress;
}

/** Runs `poll` every POLL_MS while something still loads: it reports a loader's progress. */
export function onLoadPoll(poll: () => void): void {
    pollers.push(poll);
}

/**
 * Takes the loading screen over from the inline bootstrap: the steps of
 * this render tier, the bar, the status line and the tips.
 * debug: logs the timeline of the steps (?debug=load, to calibrate the weights).
 */
export function startLoadingScreen(tier: string, options: { clock?: LoadClock; debug?: boolean } = {}): LoadProgress {
    const clock = options.clock ?? performance;
    const specs = loadTasksFor(tier);
    taskIds = specs.map(spec => spec.id);
    progress = createLoadProgress(specs, clock);
    const boot = (window as unknown as { __bulliLoad?: Bootstrap }).__bulliLoad;
    if (boot) {
        boot.taken = true;
        shown = boot.shown;
    }
    // The game code runs, so all of it is in
    progress.done('code');
    if (options.debug) {
        debugStates = new Map();
        debugStart = clock.now();
    }
    lastPaint = performance.now();
    startTips();
    pollTimer = window.setInterval(tick, POLL_MS);
    tick();
    return progress;
}

function tick(): void {
    if (!progress) return;
    for (const poll of pollers) {
        try {
            poll();
        } catch (error) {
            console.warn('[load] progress poll failed', error);
        }
    }
    progress.poll();
    logTimeline();
    paint();
    // Keeps polling for the menu phase (the start button's progress) after the loader is gone
    if (removed && progress.settled('menu')) {
        window.clearInterval(pollTimer);
        pollTimer = 0;
    }
}

function paint(): void {
    const root = document.getElementById('loading-screen');
    if (!root || !progress || removed) return;
    const now = performance.now();
    shown = approachProgress(shown, progress.overall('loader'), (now - lastPaint) / 1000);
    lastPaint = now;
    const percent = Math.min(progress.percent('loader'), Math.floor(shown * 100));
    const fill = root.querySelector<HTMLElement>('.loader-fill');
    if (fill) fill.style.transform = `scaleX(${shown})`;
    const label = root.querySelector('.loader-percent');
    if (label) label.textContent = `${percent} %`;
    root.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(percent));
    const status = progress.status('loader');
    const line = root.querySelector('.loader-status');
    if (line && line.textContent !== status) line.textContent = status;
    if (status !== announced && now - lastAnnounce >= ANNOUNCE_MS) {
        const live = document.getElementById('loader-live');
        if (live) live.textContent = status;
        announced = status;
        lastAnnounce = now;
    }
}

// ?debug=load: every change of a step's state with its time since the start
function logTimeline(): void {
    if (!debugStates || !progress) return;
    for (const id of taskIds) {
        const task = progress.task(id);
        if (!task || debugStates.get(id) === task.state) continue;
        debugStates.set(id, task.state);
        const ms = Math.round(performance.now() - debugStart);
        console.info(`[load] +${ms} ms ${id} ${task.state}${task.count ? ` ${task.count[0]}/${task.count[1]}` : ''}`);
    }
}

function currentInput(): InputKind {
    const gamepad = typeof navigator.getGamepads === 'function' && [...navigator.getGamepads()].some(pad => !!pad?.connected);
    const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return inputKindFor({ coarsePointer, gamepad });
}

// One tip every TIP_INTERVAL_MS for the input in use; the first one is in
// the page already (per pointer, index.html)
function startTips(): void {
    const tip = document.querySelector<HTMLElement>('#loading-screen .loader-tip');
    if (!tip) return;
    let index = 0;
    let kind = currentInput();
    const show = () => {
        tip.textContent = tipFor(kind, index);
        tip.style.opacity = '1';
    };
    window.addEventListener('gamepadconnected', () => {
        kind = currentInput();
        index = 0;
        show();
    });
    tipTimer = window.setInterval(() => {
        if (!document.getElementById('loading-screen')) {
            window.clearInterval(tipTimer);
            return;
        }
        kind = currentInput();
        index++;
        tip.style.opacity = '0';
        window.setTimeout(show, 300);
    }, TIP_INTERVAL_MS);
}

/** A note on the loading screen, e.g. that it loads lite graphics. */
export function showLoaderNotice(text: string): void {
    const notice = document.querySelector<HTMLElement>('#loading-screen .loader-notice');
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = false;
}

/**
 * Nothing more will load (WebGL refused): the key art stays as the
 * backdrop of the notice above it, the bar and the tips go.
 */
export function stopLoadingScreen(status: string): void {
    window.clearInterval(pollTimer);
    window.clearInterval(tipTimer);
    pollTimer = tipTimer = 0;
    const root = document.getElementById('loading-screen');
    if (!root) return;
    root.classList.add('loader-stopped');
    root.setAttribute('aria-busy', 'false');
    const line = root.querySelector('.loader-status');
    if (line) line.textContent = status;
}

/**
 * The loader is done: the menu shows (over the showroom, which the key art
 * showed until now), the loader fades out over it and goes. The menu hears
 * of it by the 'menushow' event on #splash-screen (ui/menu/menu.ts).
 * Idempotent.
 */
export function removeLoader(): void {
    if (removed) return;
    removed = true;
    const loader = document.getElementById('loading-screen');
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.classList.remove('hidden');
        splash.dispatchEvent(new Event('menushow'));
    }
    if (loader) {
        loader.setAttribute('aria-busy', 'false');
        loader.style.opacity = '0';
        window.clearInterval(tipTimer);
        window.setTimeout(() => loader.remove(), FADE_MS + 100);
    }
}
