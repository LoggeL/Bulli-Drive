import { defineConfig, devices } from '@playwright/test';

// Map determinism across browser engines (tests/engines, docs/phase-3-design.md
// A28): no build and no server, a bundle of the map modules in a blank page
// of WebKit (Safari, iOS) and Chromium, compared with Node.
// "npm run test:engines"; the browsers: npx playwright install webkit chromium.
export default defineConfig({
    testDir: 'tests/engines',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    // A whole bake in the browser takes a few seconds
    timeout: 120_000,
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
    projects: [
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
    ]
});
