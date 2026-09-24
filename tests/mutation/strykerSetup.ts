import { beforeEach } from 'vitest';

// Setup file of the Stryker run only (vitest.stryker.config.ts), never of
// `npm test`.

// 1. Per-test filter under Vitest 5. For each mutant Stryker runs only the
// tests that cover it, by setting testNamePattern to the names of those
// tests with describe and it joined by a space. Vitest 5 matches the pattern
// against the full name joined by ' > ', so it matches nothing, every
// mutant runs zero tests and "survives" (stryker-js issue #6210, open for
// @stryker-mutator/vitest-runner 10.0.0). The worker's pattern is wrapped
// so it is tested against the name in the form Stryker built it. Setup
// files run before Vitest applies the pattern to the collected tests.
// Remove this once the runner handles Vitest 5.
interface WorkerConfig { testNamePattern?: RegExp | { [Symbol.match](name: string): RegExpMatchArray | null } }
const WRAPPED = Symbol('strykerNamePattern');
const worker = (globalThis as { __vitest_worker__?: { config?: WorkerConfig } }).__vitest_worker__;
const pattern = worker?.config?.testNamePattern;
if (worker?.config && pattern instanceof RegExp && !(WRAPPED in pattern)) {
    worker.config.testNamePattern = {
        [WRAPPED]: true,
        [Symbol.match]: (name: string) => name.split(' > ').join(' ').match(pattern)
    } as WorkerConfig['testNamePattern'];
}

// 2. Tests that cannot run under Stryker. Stryker instruments the mutated
// modules, which makes the hot sim code ~30x slower. They are skipped here
// and keep running in the normal unit test run.
const SKIPPED_TESTS = new Set([
    // Long sweeps with an explicit 30 s timeout (a config testTimeout cannot
    // raise it). Instrumented they take 20-40 s on a fast machine and fail
    // the dry run on a slower one. In the first full run (2026-09-24) they
    // killed 502 mutants, all but one of which other tests cover as well.
    'v2 tunneling between cars > two beetles meeting head-on at 85 m/s each never pass through each other',
    'v2 tunneling between cars > a beetle T-boning another at 85 m/s never passes through it',
    'v2 stability > stays finite over 10 000 ticks of random input among colliders and other cars'
]);

beforeEach(context => {
    const names: string[] = [];
    for (let task: { name: string; suite?: unknown } | undefined = context.task; task; task = task.suite as typeof task) {
        if (task.name) names.unshift(task.name);
    }
    if (SKIPPED_TESTS.has(names.join(' > '))) context.skip();
});
