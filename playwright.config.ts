import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// The critical user paths (tests/e2e) run against the production build
// (dist/), served by the real game server on its own port: desktop, two
// players, touch on a phone, a new deploy, missing assets. "npm run
// test:e2e" builds first and runs the desktop and mobile projects; the
// render checks of the phone tier (tests/e2e-render) are their own
// project, "npm run test:e2e:render". A bare "npx playwright test" reuses whatever
// is in dist/ and runs all three.
const PORT = Number(process.env.E2E_PORT) || 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync('dist/client/index.html') || !fs.existsSync('dist/server/index.js')) {
    throw new Error('No production build in dist/ - run "npm run build" first (or use "npm run test:e2e")');
}

// Headless Chromium has no GPU; SwiftShader gives three.js a software WebGL.
const chromiumArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export default defineConfig({
    testDir: 'tests/e2e',
    // All tests share one game server (and its player list), and software
    // WebGL is CPU heavy, so run them one after another.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    // Generous: software WebGL on a busy CI runner can take a while to
    // build the city before the splash screen appears.
    timeout: 120_000,
    expect: { timeout: 15_000 },
    reporter: process.env.CI
        ? [['github'], ['list'], ['html', { open: 'never' }]]
        : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: BASE_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: { args: chromiumArgs }
    },
    projects: [
        {
            name: 'desktop',
            testIgnore: /mobile\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
        },
        {
            name: 'mobile',
            testMatch: /mobile\.spec\.ts$/,
            // iPhone 13 viewport, touch and user agent, rendered by Chromium
            use: { ...devices['iPhone 13'], browserName: 'chromium' }
        },
        {
            // Draw call budget and texture placeholders of the phone tier:
            // renderer measurements, not user paths (own CI job)
            name: 'render',
            testDir: 'tests/e2e-render',
            use: { ...devices['Desktop Chrome'] }
        }
    ],
    webServer: {
        command: 'node dist/server/index.js',
        // E2E=1: the server takes debugPlace (placeLocalCar in the tests).
        // GRACE_MS: a closed test page's car leaves after 3 s instead of
        // waiting 30 s as an idle ghost on the runway of the next test
        env: { PORT: String(PORT), E2E: '1', GRACE_MS: '3000' },
        // Healthy once the tick runs (docs/phase-1b-design.md, 11.4)
        url: `${BASE_URL}/healthz`,
        reuseExistingServer: false,
        timeout: 30_000,
        // Server warnings and errors show up in the test output.
        stdout: 'ignore',
        stderr: 'pipe'
    }
});
