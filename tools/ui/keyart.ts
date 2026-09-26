// The loading screen's key art (docs/ui.md 3.3): an in-engine render of the
// menu showroom's start pose (src/client/camera/showroom.ts), the Bulli in
// its factory Sea Green at the head of the pier at sunset. Not an AI image:
// the loader then fades into the menu's first live frame, and a change of
// the map or the car models is one run away.
//
//   npm run build && npx tsx tools/ui/keyart.ts [--port=9290] [--keep=<dir>]
//
// Starts the production server (E2E=1), joins with headless Chromium on the
// GPU (ANGLE/Metal on macOS; the desktop render tier with the HDRI), hides
// the HUD, parks the Bulli at the showroom spot and renders a landscape and
// a portrait frame. cwebp (libwebp) writes
//   public/ui/keyart-1920.webp            1920 x 1080, landscape (<= 250 KB)
//   public/ui/keyart-portrait-900.webp     900 x 1600, portrait  (<= 120 KB)
// and the blurred placeholder (a 32 px WebP, <= 1.5 KB) goes inline into
// index.html between /* keyart-blur */ and /* /keyart-blur */.
// tests/client/uiAssets.test.ts keeps the sizes.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { SHOWROOM_FRAMING, SHOWROOM_SPOT, showroomStartPose, type ShowroomFraming } from '../../src/client/camera/showroom.js';

// Sea Green (docs/ui.md 5, #5E8C7A) as it comes out of the paint mapping of
// assets/carMaterials.ts (saturation * 0.8, lightness 0.2 + 0.42 * l): the
// server's colour code that maps to it. Once palette colours pass unmapped
// (U3), this becomes 0x5E8C7A.
const SEA_GREEN_CODE = 0x85B5A2;
const DECK_Y = 5;

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value = ''] = arg.replace(/^--/, '').split('=');
    return [key, value];
}));
const port = Number(args.port) || 9290;
const keep = args.keep || null;
const log = (message: string) => process.stderr.write(`[keyart] ${message}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function startServer(): Promise<ChildProcess> {
    if (!fs.existsSync('dist/server/index.js')) throw new Error('No production build - run "npm run build" first');
    const server = spawn(process.execPath, ['dist/server/index.js'], {
        env: { ...process.env, PORT: String(port), E2E: '1' },
        stdio: ['ignore', 'ignore', 'inherit']
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
        try {
            if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return server;
        } catch { /* not up yet */ }
        await sleep(200);
    }
    server.kill();
    throw new Error('Server did not start within 30 s');
}

interface Debug {
    snapshot(): { local: unknown; render: { frame: number } };
    placeLocalCar(x: number, z: number, angle: number): void;
    spawnCar(type: string, color: number, x: number, z: number, yaw: number, options: object): unknown;
    setCameraOverride(pose: unknown): void;
    worldInfo(): { tier: string };
}
declare global {
    interface Window { __bulliDebug?: Debug }
}

async function render(width: number, height: number, framing: ShowroomFraming, file: string): Promise<void> {
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    try {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, baseURL: `http://127.0.0.1:${port}` });
        page.on('pageerror', error => log(`page error: ${error.message}`));
        await page.goto('/?e2e=1');
        await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 120_000 });
        await page.locator('#splash-name-input').fill('Keyart');
        await page.locator('.mode-option[data-room="freeroam"]').click();
        await page.locator('#start-btn').click();
        await page.locator('#splash-screen.hidden').waitFor({ state: 'attached', timeout: 60_000 });
        await page.waitForFunction(() => !!window.__bulliDebug?.snapshot().local);
        const tier = await page.evaluate(() => window.__bulliDebug!.worldInfo().tier);
        if (tier !== 'desktop') throw new Error(`render tier ${tier}: the key art needs the desktop tier (GPU, HDRI)`);
        await page.addStyleTag({ content: 'body > *:not(canvas) { visibility: hidden !important; }' });
        // The own car (random colour) out of the way on Main Street, the
        // Bulli in Sea Green at the showroom spot
        await page.evaluate(() => window.__bulliDebug!.placeLocalCar(-446, -20, Math.PI / 2));
        await page.evaluate(spot => window.__bulliDebug!.spawnCar('bulli', spot.color, spot.x, spot.z, spot.yaw, {}),
            { ...SHOWROOM_SPOT, color: SEA_GREEN_CODE });
        await page.evaluate(pose => window.__bulliDebug!.setCameraOverride(pose), showroomStartPose(framing, DECK_Y));
        // A few seconds of frames: shadows, contact shadows, LODs settle
        const start = await page.evaluate(() => window.__bulliDebug!.snapshot().render.frame);
        await sleep(3000);
        await page.waitForFunction(from => window.__bulliDebug!.snapshot().render.frame > from + 30, start);
        await page.screenshot({ path: file });
    } finally {
        await browser.close();
    }
}

function cwebp(input: string, output: string, options: string[]): void {
    const result = spawnSync('cwebp', [...options, input, '-o', output], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`cwebp failed: ${result.stderr}`);
}

async function main(): Promise<void> {
    const work = keep ?? fs.mkdtempSync(path.join(os.tmpdir(), 'keyart-'));
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync('public/ui', { recursive: true });
    const server = await startServer();
    try {
        const landscape = path.join(work, 'keyart-landscape.png');
        const portrait = path.join(work, 'keyart-portrait.png');
        // Rendered larger and scaled down: smoother edges than the game's MSAA alone
        await render(2560, 1440, SHOWROOM_FRAMING.landscape, landscape);
        await render(1350, 2400, SHOWROOM_FRAMING.portrait, portrait);
        cwebp(landscape, 'public/ui/keyart-1920.webp', ['-q', '72', '-m', '6', '-resize', '1920', '1080', '-metadata', 'none']);
        cwebp(portrait, 'public/ui/keyart-portrait-900.webp', ['-q', '70', '-m', '6', '-resize', '900', '1600', '-metadata', 'none']);
        const blur = path.join(work, 'keyart-blur.webp');
        cwebp(landscape, blur, ['-q', '40', '-m', '6', '-resize', '32', '18', '-metadata', 'none']);
        const dataUrl = `data:image/webp;base64,${fs.readFileSync(blur).toString('base64')}`;
        const html = fs.readFileSync('index.html', 'utf8');
        const marker = /(\/\* keyart-blur \*\/)[\s\S]*?(\/\* \/keyart-blur \*\/)/;
        if (!marker.test(html)) throw new Error('index.html has no /* keyart-blur */ ... /* /keyart-blur */ markers');
        fs.writeFileSync('index.html', html.replace(marker, `$1url(${dataUrl})$2`));
        for (const file of ['public/ui/keyart-1920.webp', 'public/ui/keyart-portrait-900.webp', blur]) {
            log(`${file}: ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
        }
    } finally {
        server.kill();
        if (!keep) fs.rmSync(work, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
});
