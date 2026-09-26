// The loading screen's key art (docs/ui.md 3.3): the menu's first frame,
// rendered by the game itself (the showroom's start pose,
// src/client/camera/showroom.ts, framed for the menu's layout), the Bulli
// in Sea Green at the head of the pier at sunset. Not an AI image:
// the loader then fades into the menu's first live frame, and a change of
// the map or the car models is one run away.
//
//   npm run build && npx tsx tools/ui/keyart.ts [--port=9290] [--keep=<dir>]
//
// Starts the production server (E2E=1), opens the menu with headless
// Chromium on the GPU (ANGLE/Metal on macOS; the desktop render tier with
// the HDRI) with reduced motion (the camera stays at its start), hides the
// menu and captures a landscape and a portrait frame. cwebp (libwebp) writes
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
    worldInfo(): { tier: string };
}
declare global {
    interface Window { __bulliDebug?: Debug }
}

// The menu's first frame: the Bulli in Sea Green (the palette's first
// paint), the camera at the start of its swing (reduced motion holds it
// there), the menu itself hidden but laid out, so the showroom frames the
// car exactly as the menu does at this size
async function render(width: number, height: number, file: string): Promise<void> {
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    try {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce', baseURL: `http://127.0.0.1:${port}` });
        page.on('pageerror', error => log(`page error: ${error.message}`));
        await page.addInitScript(() => {
            localStorage.setItem('bulli-car-type', 'bulli');
            localStorage.setItem('bulli-paint', 'sea');
        });
        await page.goto('/?e2e=1');
        await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 120_000 });
        const tier = await page.evaluate(() => window.__bulliDebug!.worldInfo().tier);
        if (tier !== 'desktop') throw new Error(`render tier ${tier}: the key art needs the desktop tier (GPU, HDRI)`);
        await page.addStyleTag({ content: '#splash-screen { visibility: hidden !important; }' });
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
        // Rendered at the page's own layout of a 16:9 screen and a 9:16 phone,
        // at twice the pixels, scaled down: smoother edges than the game's MSAA alone
        await render(1920, 1080, landscape);
        await render(900, 1600, portrait);
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
