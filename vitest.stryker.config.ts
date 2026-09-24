import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// The unit test config as Stryker runs it (stryker.config.mjs). Stryker
// instruments every mutated module (a switch per mutant plus per-test
// coverage counters), which makes the long sim runs many times slower
// than a plain `npm test`, so the per-test timeout is raised (a mutant that
// loops forever still ends as a Stryker timeout, timeoutMS there) and the
// wall-clock and long sweep tests are skipped (tests/mutation/strykerSetup.ts).
export default mergeConfig(base, defineConfig({
    test: {
        testTimeout: 60_000,
        hookTimeout: 60_000,
        setupFiles: ['tests/mutation/strykerSetup.ts']
    }
}));
