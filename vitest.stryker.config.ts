import { defineConfig } from 'vitest/config';

// The unit test config as Stryker runs it (stryker.config.mjs). Stryker
// instruments every mutated module (a switch per mutant plus per-test
// coverage counters), which makes the long sim runs many times slower
// than a plain `npm test`, so the per-test timeout is raised (a mutant that
// loops forever still ends as a Stryker timeout, timeoutMS there) and the
// wall-clock and long sweep tests are skipped (tests/mutation/strykerSetup.ts).
// One plain project with the unit tests of vitest.config.ts, each file
// isolated: Stryker's runner needs neither the projects nor their shared
// modules.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        exclude: ['tests/integration/**', 'node_modules/**'],
        environment: 'node',
        testTimeout: 60_000,
        hookTimeout: 60_000,
        setupFiles: ['tests/mutation/strykerSetup.ts']
    }
});
