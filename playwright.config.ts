import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Smoke tests run against the production build (dist/), served by the real
// game server on its own port. "npm run test:e2e" builds first; a bare
// "npx playwright test" reuses whatever is in dist/.
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
    timeout: 60_000,
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
        }
    ],
    webServer: {
        command: 'node dist/server/index.js',
        env: { PORT: String(PORT) },
        url: `${BASE_URL}/build-version.txt`,
        reuseExistingServer: false,
        timeout: 30_000,
        // Server warnings and errors show up in the test output.
        stdout: 'ignore',
        stderr: 'pipe'
    }
});
