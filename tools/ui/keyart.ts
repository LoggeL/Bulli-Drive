// The loading screen's key art (docs/ui.md 3.3): the menu's first frame,
// rendered by the game itself (the showroom's start pose,
// src/client/camera/showroom.ts, framed for the menu's layout), the Bulli
// in Sea Green at the head of the pier at sunset. Not an AI image: the
// loader then fades into the menu's first live frame, and a change of the
// map or the car models is one run away.
//
//   npm run build && npx tsx tools/ui/keyart.ts [--port=9290] [--keep=<dir>] [--only=portrait,lite-portrait]
//
// Starts the production server (E2E=1), opens the menu with headless
// Chromium on the GPU (ANGLE/Metal on macOS) with reduced motion (the
// camera stays at its start), hides the menu and captures one frame per
// layout of the menu, each in the render tier that layout's devices draw
// the menu in, so the loader fades into the same picture (D20, D29):
//   public/ui/keyart-1920.webp             desktop, 1920 x 1080 CSS px at 2x, scaled to 1x (desktop tier, HDRI)
//   public/ui/keyart-portrait.webp         phones upright, 390 x 750 at 2x (phone tier)
//   public/ui/keyart-phone-landscape.webp  phones sideways, 844 x 390 at 2x (phone tier)
// and the same three with lite graphics (?lite=1) as keyart-lite-*.webp,
// which index.html shows when this page loads in lite graphics. The
// blurred placeholder (a 32 px WebP, <= 1.5 KB) goes inline into
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

interface Variant {
    /** File name part: keyart-<name>.webp */
    name: string;
    width: number;
    height: number;
    /** Device pixels per CSS pixel of the capture (the file is scaled to out) */
    scale: number;
    out: [number, number];
    /** The tier this layout's devices draw the menu in (?tier=) */
    tier: 'high' | 'low';
    quality: number;
}

const LAYOUTS: Variant[] = [
    // A 16:9 screen; rendered at twice the pixels and scaled down: smoother edges than the MSAA alone
    { name: '1920', width: 1920, height: 1080, scale: 2, out: [1920, 1080], tier: 'high', quality: 72 },
    // Between an iPhone in Safari (390 x 664) and a tall Android (412 x 839)
    { name: 'portrait', width: 390, height: 750, scale: 2, out: [780, 1500], tier: 'low', quality: 70 },
    // An iPhone 13 sideways; an SE (667 x 375) crops its sides
    { name: 'phone-landscape', width: 844, height: 390, scale: 2, out: [1688, 780], tier: 'low', quality: 70 }
];

const VARIANTS: Array<Variant & { lite: boolean }> = [
    ...LAYOUTS.map(layout => ({ ...layout, lite: false })),
    ...LAYOUTS.map(layout => ({ ...layout, name: `lite-${layout.name}`, lite: true }))
];

// The menu's first frame: the Bulli in Sea Green (a first visit's paint),
// the camera at the start of its swing (reduced motion holds it there), the
// menu itself hidden but laid out, so the showroom frames the car exactly
// as the menu does at this size
async function render(variant: Variant & { lite: boolean }, file: string): Promise<void> {
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    try {
        const page = await browser.newPage({
            viewport: { width: variant.width, height: variant.height }, deviceScaleFactor: variant.scale,
            reducedMotion: 'reduce', baseURL: `http://127.0.0.1:${port}`
        });
        page.on('pageerror', error => log(`page error: ${error.message}`));
        await page.addInitScript(() => {
            localStorage.setItem('bulli-car-type', 'bulli');
            localStorage.setItem('bulli-paint', 'sea');
        });
        // Lite graphics bring their own tier (a forced tier would win over them)
        await page.goto(variant.lite ? '/?e2e=1&lite=1' : `/?e2e=1&tier=${variant.tier}`);
        await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 120_000 });
        const tier = await page.evaluate(() => window.__bulliDebug!.worldInfo().tier);
        const expected = variant.lite ? 'software' : variant.tier === 'high' ? 'desktop' : 'mobile';
        if (tier !== expected) throw new Error(`render tier ${tier}: the ${variant.name} key art needs the ${expected} tier`);
        await page.addStyleTag({ content: '#splash-screen { visibility: hidden !important; }' });
        // A few seconds of frames: shadows, contact shadows, LODs settle
        await sleep(3000);
        if (variant.lite) {
            // Lite draws a still after each change: one more (a resize draws again)
            await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            await sleep(1500);
        } else {
            const start = await page.evaluate(() => window.__bulliDebug!.snapshot().render.frame);
            await page.waitForFunction(from => window.__bulliDebug!.snapshot().render.frame > from + 30, start);
        }
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
    const only = args.only ? String(args.only).split(',') : null;
    const server = await startServer();
    try {
        for (const variant of VARIANTS) {
            if (only && !only.includes(variant.name)) continue;
            const png = path.join(work, `keyart-${variant.name}.png`);
            await render(variant, png);
            const file = `public/ui/keyart-${variant.name}.webp`;
            cwebp(png, file, ['-q', String(variant.quality), '-m', '6', '-resize', String(variant.out[0]), String(variant.out[1]), '-metadata', 'none']);
            log(`${file}: ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
            if (variant.name !== '1920') continue;
            // The placeholder: the desktop frame, blurred
            const blur = path.join(work, 'keyart-blur.webp');
            cwebp(png, blur, ['-q', '40', '-m', '6', '-resize', '32', '18', '-metadata', 'none']);
            const dataUrl = `data:image/webp;base64,${fs.readFileSync(blur).toString('base64')}`;
            const html = fs.readFileSync('index.html', 'utf8');
            const marker = /(\/\* keyart-blur \*\/)[\s\S]*?(\/\* \/keyart-blur \*\/)/;
            if (!marker.test(html)) throw new Error('index.html has no /* keyart-blur */ ... /* /keyart-blur */ markers');
            fs.writeFileSync('index.html', html.replace(marker, `$1url(${dataUrl})$2`));
            log(`${blur}: ${(fs.statSync(blur).size / 1024).toFixed(1)} KB`);
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
