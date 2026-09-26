// The real progress of the loading screen (docs/ui.md 3.2): the page's load
// is a list of weighted steps (code, connection, map, textures, ...), each
// reporting a fraction. The bar shows sum(weight * fraction) / sum(weight)
// over the steps that were not skipped. Pure: no DOM, no three.js, the
// clock is injected (tests script it); ui/loadingScreen.ts binds it to the
// page and the loaders.

export type TaskId = 'code' | 'connect' | 'map' | 'textures' | 'kit' | 'car' | 'hdri' | 'warmup' | 'cars';
export type TaskState = 'pending' | 'running' | 'done' | 'skipped' | 'timedOut';
/** 'loader': the loading screen waits for it; 'menu': the DRIVE/START button does. */
export type LoadPhase = 'loader' | 'menu';

export interface LoadTaskSpec {
    id: TaskId;
    /** Expected share of the wall clock (not bytes), relative to the others */
    weight: number;
    /** Status line text while the step runs */
    label: string;
    phase: LoadPhase;
    /** Gives up waiting this long after start(); none: waits for good (connection, map) */
    timeoutMs?: number;
}

export interface LoadTask extends LoadTaskSpec {
    state: TaskState;
    /** 0..1 */
    fraction: number;
    count?: [done: number, total: number];
    startedAt: number;
}

export interface LoadClock {
    now(): number;
}

// Weights (docs/ui.md 3.2): expected shares of the wall clock, measured on a
// desktop and estimated for a phone on 4G; ?debug=load logs the timeline
// to calibrate them. The phone and lite (software) tiers load no HDRI.
const STEP_CAP_MS = 20_000;
const LABELS: Record<TaskId, string> = {
    code: 'Loading the game',
    connect: 'Connecting to the server',
    map: 'Loading Bulli Bay',
    textures: 'Loading the bay · textures',
    kit: 'Loading the buildings',
    car: 'Loading your car',
    hdri: 'Lighting the sky',
    warmup: 'Warming up shaders',
    cars: 'Loading the other cars'
};

function spec(id: TaskId, weight: number, phase: LoadPhase, timeoutMs?: number): LoadTaskSpec {
    return { id, weight, label: LABELS[id], phase, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export const DESKTOP_LOAD_TASKS: readonly LoadTaskSpec[] = [
    spec('code', 20, 'loader'),
    spec('connect', 5, 'loader'),
    spec('map', 15, 'loader'),
    spec('textures', 25, 'loader', STEP_CAP_MS),
    spec('kit', 15, 'loader', STEP_CAP_MS),
    spec('car', 5, 'loader', STEP_CAP_MS),
    spec('hdri', 7, 'loader', STEP_CAP_MS),
    spec('warmup', 8, 'loader', 10_000),
    spec('cars', 5, 'menu', STEP_CAP_MS)
];

export const PHONE_LOAD_TASKS: readonly LoadTaskSpec[] = [
    spec('code', 25, 'loader'),
    spec('connect', 5, 'loader'),
    spec('map', 20, 'loader'),
    spec('textures', 15, 'loader', STEP_CAP_MS),
    spec('kit', 15, 'loader', STEP_CAP_MS),
    spec('car', 5, 'loader', STEP_CAP_MS),
    spec('warmup', 10, 'loader', 10_000),
    spec('cars', 5, 'menu', STEP_CAP_MS)
];

/** The steps of a page on this render tier ('desktop', 'mobile' or 'software'). */
export function loadTasksFor(tier: string): readonly LoadTaskSpec[] {
    return tier === 'desktop' ? DESKTOP_LOAD_TASKS : PHONE_LOAD_TASKS;
}

const SETTLED: readonly TaskState[] = ['done', 'skipped', 'timedOut'];

export interface LoadProgress {
    start(id: TaskId): void;
    report(id: TaskId, fraction: number, count?: [number, number]): void;
    done(id: TaskId): void;
    skip(id: TaskId): void;
    /** Gives up on every step of `phase` that is not settled yet (the phase's overall wait ran out). */
    expire(phase: LoadPhase): void;
    /** Applies the step timeouts at the clock's time. */
    poll(): void;
    /** 0..1 over the steps of `phase` ('all': every step); never goes down. */
    overall(phase?: LoadPhase | 'all'): number;
    /** Whole percent for the display: 100 only once every step is done or skipped. */
    percent(phase?: LoadPhase | 'all'): number;
    /** The running step with the most weight still open, with its counter. */
    status(phase?: LoadPhase | 'all'): string;
    /** Resolves once every step of the phase (and of the phases before it) is done, skipped or timed out. */
    whenPhase(phase: LoadPhase): Promise<void>;
    settled(phase: LoadPhase): boolean;
    task(id: TaskId): Readonly<LoadTask> | undefined;
}

export function createLoadProgress(specs: readonly LoadTaskSpec[], clock: LoadClock): LoadProgress {
    const tasks = new Map<TaskId, LoadTask>();
    for (const s of specs) tasks.set(s.id, { ...s, state: 'pending', fraction: 0, startedAt: 0 });
    const highWater = new Map<string, number>();
    const waiters: Array<{ phase: LoadPhase; resolve: () => void }> = [];

    const inPhase = (task: LoadTask, phase: LoadPhase | 'all') =>
        phase === 'all' || task.phase === phase || (phase === 'menu' && task.phase === 'loader');
    const isSettled = (task: LoadTask) => SETTLED.includes(task.state);

    function settled(phase: LoadPhase): boolean {
        for (const task of tasks.values()) if (inPhase(task, phase) && !isSettled(task)) return false;
        return true;
    }

    function notify(): void {
        // In the order they were asked for
        const ready = waiters.filter(waiter => settled(waiter.phase));
        for (const waiter of ready) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
        }
    }

    function begin(task: LoadTask): void {
        if (task.state !== 'pending') return;
        task.state = 'running';
        task.startedAt = clock.now();
    }

    const api: LoadProgress = {
        start(id) {
            const task = tasks.get(id);
            if (task) begin(task);
        },
        report(id, fraction, count) {
            const task = tasks.get(id);
            if (!task || task.state === 'done' || task.state === 'skipped') return;
            begin(task);
            task.fraction = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
            if (count) task.count = [count[0], count[1]];
        },
        done(id) {
            const task = tasks.get(id);
            if (!task || task.state === 'skipped') return;
            begin(task);
            task.state = 'done';
            task.fraction = 1;
            if (task.count) task.count = [task.count[1], task.count[1]];
            notify();
        },
        skip(id) {
            const task = tasks.get(id);
            if (!task || task.state === 'done') return;
            task.state = 'skipped';
            notify();
        },
        expire(phase) {
            for (const task of tasks.values()) {
                if (task.phase === phase && !isSettled(task)) task.state = 'timedOut';
            }
            notify();
        },
        poll() {
            const now = clock.now();
            let changed = false;
            for (const task of tasks.values()) {
                if (task.state !== 'running' || task.timeoutMs === undefined) continue;
                if (now - task.startedAt >= task.timeoutMs) {
                    task.state = 'timedOut';
                    changed = true;
                }
            }
            if (changed) notify();
        },
        overall(phase = 'loader') {
            let sum = 0, total = 0;
            for (const task of tasks.values()) {
                if (!inPhase(task, phase) || task.state === 'skipped') continue;
                sum += task.weight * task.fraction;
                total += task.weight;
            }
            const value = total > 0 ? sum / total : 1;
            const shown = Math.max(highWater.get(phase) ?? 0, value);
            highWater.set(phase, shown);
            return shown;
        },
        percent(phase = 'loader') {
            let complete = true;
            for (const task of tasks.values()) {
                if (inPhase(task, phase) && task.state !== 'done' && task.state !== 'skipped') complete = false;
            }
            const value = api.overall(phase);
            return complete ? 100 : Math.min(99, Math.floor(value * 100));
        },
        status(phase = 'loader') {
            let best: LoadTask | null = null;
            let bestOpen = -1;
            for (const task of tasks.values()) {
                if (!inPhase(task, phase) || task.state !== 'running') continue;
                const open = task.weight * (1 - task.fraction);
                if (open > bestOpen) {
                    best = task;
                    bestOpen = open;
                }
            }
            if (!best) return settled(phase === 'all' ? 'menu' : phase) ? 'Ready' : 'Loading';
            return best.count ? `${best.label} ${best.count[0]}/${best.count[1]}` : best.label;
        },
        whenPhase(phase) {
            if (settled(phase)) return Promise.resolve();
            return new Promise(resolve => waiters.push({ phase, resolve }));
        },
        settled,
        task(id) {
            return tasks.get(id);
        }
    };
    return api;
}

/**
 * The bar's shown value one frame later: it follows the real value upwards
 * at most `ratePerSecond` (the bar does not jump when a heavy step
 * finishes) and never goes down.
 */
export function approachProgress(shown: number, target: number, dtSeconds: number, ratePerSecond = 0.3): number {
    if (target <= shown) return shown;
    return Math.min(target, shown + ratePerSecond * Math.max(0, dtSeconds));
}
