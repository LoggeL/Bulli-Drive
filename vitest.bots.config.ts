import { defineConfig } from 'vitest/config';

// Bot integration tests (docs/phase-1b-design.md, 15.2): headless bots
// against a real game server process on real WebSockets. One file after
// the other, each test with its own time budget.
export default defineConfig({
    test: {
        include: ['tests/integration/**/*.test.ts'],
        environment: 'node',
        fileParallelism: false,
        testTimeout: 120_000,
        hookTimeout: 60_000
    }
});
