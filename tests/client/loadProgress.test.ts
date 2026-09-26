import { describe, expect, it } from 'vitest';
import {
    approachProgress,
    createLoadProgress,
    DESKTOP_LOAD_TASKS,
    loadTasksFor,
    PHONE_LOAD_TASKS,
    type LoadTaskSpec
} from '../../src/client/ui/loadProgress.js';

// The loading screen's progress (docs/ui.md 3.2): sum(weight * fraction) /
// sum(weight) over the steps not skipped, never going down, 100 % only
// once every step is done. Expected values are worked out by hand.

function clock(start = 0) {
    let t = start;
    return { now: () => t, set: (ms: number) => { t = ms; } };
}

const three: LoadTaskSpec[] = [
    { id: 'code', weight: 20, label: 'Code', phase: 'loader' },
    { id: 'connect', weight: 5, label: 'Connect', phase: 'loader' },
    { id: 'map', weight: 15, label: 'Map', phase: 'loader' }
];

describe('the weighted progress', () => {
    it('adds the weighted fractions up', () => {
        const progress = createLoadProgress(three, clock());
        expect(progress.overall()).toBe(0);
        progress.done('code');
        progress.done('connect');
        progress.report('map', 0.5);
        // (20 * 1 + 5 * 1 + 15 * 0.5) / 40 = 32.5 / 40
        expect(progress.overall()).toBeCloseTo(0.8125, 12);
        expect(progress.percent()).toBe(81);
    });

    it('uses the desktop weights of docs/ui.md', () => {
        const progress = createLoadProgress(loadTasksFor('desktop'), clock());
        progress.done('code');
        progress.done('connect');
        progress.report('map', 0.5);
        progress.report('textures', 0.4);
        // Loader steps weigh 20 + 5 + 15 + 25 + 15 + 5 + 7 + 8 = 100:
        // 20 + 5 + 7.5 + 10 = 42.5
        expect(progress.overall()).toBeCloseTo(0.425, 12);
        // The menu phase adds the other cars (5): 42.5 / 105
        expect(progress.overall('menu')).toBeCloseTo(42.5 / 105, 12);
    });

    it('leaves the HDRI out on phones and in lite graphics', () => {
        expect(loadTasksFor('mobile')).toBe(PHONE_LOAD_TASKS);
        expect(loadTasksFor('software')).toBe(PHONE_LOAD_TASKS);
        expect(loadTasksFor('desktop')).toBe(DESKTOP_LOAD_TASKS);
        const progress = createLoadProgress(loadTasksFor('mobile'), clock());
        expect(progress.task('hdri')).toBeUndefined();
        progress.done('code');
        // Phone loader steps: 25 + 5 + 20 + 15 + 15 + 5 + 10 = 95
        expect(progress.overall()).toBeCloseTo(25 / 95, 12);
    });

    it('takes a skipped step out of the total', () => {
        const progress = createLoadProgress(three, clock());
        progress.done('code');
        progress.skip('map');
        // 20 / (20 + 5)
        expect(progress.overall()).toBeCloseTo(0.8, 12);
    });

    it('never goes back, not on a smaller report and not on a skip', () => {
        const progress = createLoadProgress(three, clock());
        progress.report('map', 0.6);
        const before = progress.overall();
        expect(before).toBeCloseTo(9 / 40, 12);
        // More textures requested than before: the step's share drops
        progress.report('map', 0.2);
        expect(progress.overall()).toBe(before);
        // Skipping the only step with progress would give 0 / 25
        progress.skip('map');
        expect(progress.overall()).toBe(before);
        progress.done('code');
        expect(progress.overall()).toBeCloseTo(0.8, 12);
    });

    it('shows 100 % only once every step is done or skipped', () => {
        const progress = createLoadProgress(three, clock());
        progress.done('code');
        progress.done('connect');
        progress.report('map', 0.9999);
        // 39.9985 / 40 = 99.996 %: rounding would say 100
        expect(progress.percent()).toBe(99);
        progress.done('map');
        expect(progress.percent()).toBe(100);
        expect(progress.overall()).toBe(1);
    });

    it('does not call a timed-out step 100 %', () => {
        const time = clock();
        const progress = createLoadProgress([{ ...three[0], timeoutMs: 1000 }], time);
        progress.report('code', 1);
        time.set(1000);
        progress.poll();
        expect(progress.task('code')!.state).toBe('timedOut');
        expect(progress.percent()).toBe(99);
    });
});

describe('the steps over time', () => {
    const specs: LoadTaskSpec[] = [
        { id: 'connect', weight: 5, label: 'Connect', phase: 'loader' },
        { id: 'textures', weight: 25, label: 'Textures', phase: 'loader', timeoutMs: 20_000 },
        { id: 'cars', weight: 5, label: 'Cars', phase: 'menu', timeoutMs: 20_000 }
    ];

    it('gives up on a step after its timeout, not on one without', async () => {
        const time = clock(1000);
        const progress = createLoadProgress(specs, time);
        progress.start('connect');
        progress.start('textures');
        time.set(1000 + 19_999);
        progress.poll();
        expect(progress.task('textures')!.state).toBe('running');
        time.set(1000 + 20_000);
        progress.poll();
        expect(progress.task('textures')!.state).toBe('timedOut');
        time.set(1e9);
        progress.poll();
        expect(progress.task('connect')!.state).toBe('running');
        expect(progress.settled('loader')).toBe(false);
        progress.done('connect');
        expect(progress.settled('loader')).toBe(true);
        await progress.whenPhase('loader');
    });

    it('lets a timed-out step still finish', () => {
        const time = clock();
        const progress = createLoadProgress(specs, time);
        progress.start('textures');
        time.set(20_000);
        progress.poll();
        progress.done('textures');
        expect(progress.task('textures')!.state).toBe('done');
        expect(progress.task('textures')!.fraction).toBe(1);
    });

    it('resolves a phase once its steps and the ones before are settled', async () => {
        const progress = createLoadProgress(specs, clock());
        const order: string[] = [];
        const loader = progress.whenPhase('loader').then(() => order.push('loader'));
        const menu = progress.whenPhase('menu').then(() => order.push('menu'));
        progress.done('cars');
        progress.done('connect');
        await Promise.resolve();
        expect(order).toEqual([]);
        expect(progress.settled('menu')).toBe(false);
        progress.skip('textures');
        await Promise.all([loader, menu]);
        expect(order).toEqual(['loader', 'menu']);
    });

    it('expires the steps of one phase only', () => {
        const progress = createLoadProgress(specs, clock());
        progress.start('textures');
        progress.done('connect');
        progress.expire('loader');
        expect(progress.task('textures')!.state).toBe('timedOut');
        expect(progress.task('connect')!.state).toBe('done');
        expect(progress.task('cars')!.state).toBe('pending');
    });

    it('names the running step with the most weight still open', () => {
        const progress = createLoadProgress(DESKTOP_LOAD_TASKS, clock());
        // Textures 25 * (1 - 0.8) = 5 open, kit 15 * (1 - 0.2) = 12 open
        progress.report('textures', 0.8, [22, 28]);
        progress.report('kit', 0.2);
        expect(progress.status()).toBe('Loading the buildings');
        progress.report('kit', 0.9);
        // Kit 1.5 open: the textures lead again, with their counter
        expect(progress.status()).toBe('Loading the bay · textures 22/28');
        // A step of the menu phase is not the loader's
        progress.report('cars', 0);
        expect(progress.status()).toBe('Loading the bay · textures 22/28');
        expect(progress.status('menu')).toBe('Loading the other cars');
    });
});

describe('the shown bar', () => {
    it('follows the real value upwards at most 30 % a second', () => {
        expect(approachProgress(0.2, 0.9, 1)).toBeCloseTo(0.5, 12);
        expect(approachProgress(0.2, 0.9, 0.1)).toBeCloseTo(0.23, 12);
        expect(approachProgress(0.2, 0.25, 1)).toBe(0.25);
    });

    it('never goes down', () => {
        expect(approachProgress(0.6, 0.4, 1)).toBe(0.6);
        expect(approachProgress(0.6, 0.9, -1)).toBe(0.6);
    });
});
