// Screenshot set for visual before/after comparisons: starts the production
// server, joins with headless Chromium (?e2e=1) and captures fixed views
// (chase camera on a street, plaza, park, overview, city edge, mobile).
//
//   npm run screenshots -- --out=shots/after                 # build + capture
//   npm run screenshots -- --out=shots/after --gl=swiftshader
//   npx tsx scripts/screenshots.ts --compare=shots/before,shots/after --out=shots/compare
//
// --gl=gpu (default) renders on the machine's GPU (ANGLE/Metal on macOS) and
// falls back to SwiftShader when no GPU context comes up. --compare writes one
// side-by-side image per view that exists in both folders (compare-<view>.png).
// For the chase camera views stats.json also records how much of the frame
// the car takes (carWidth/carHeight, fractions of the image).

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import type { BulliDebugSnapshot, CameraPose, ScreenBox } from '../src/client/e2eHook.js';
import { PARK_BLOCK, PLAZA_BLOCK, blockCenter, roadLineCenter } from '../src/shared/world/cityGen.js';

interface Options {
    out: string;
    gl: 'gpu' | 'swiftshader';
    port: number;
    only: string[] | null;
    compare: [string, string] | null;
}

function parseArgs(argv: string[]): Options {
    const options: Options = { out: 'screenshots', gl: 'gpu', port: 8260, only: null, compare: null };
    for (const arg of argv) {
        const [key, value = ''] = arg.replace(/^--/, '').split('=');
        if (key === 'out') options.out = value;
        else if (key === 'gl' && (value === 'gpu' || value === 'swiftshader')) options.gl = value;
        else if (key === 'port') options.port = Number(value);
        else if (key === 'only') options.only = value.split(',').filter(Boolean);
        else if (key === 'compare') {
            const [before, after] = value.split(',');
            if (!before || !after) throw new Error('--compare needs two folders: --compare=before,after');
            options.compare = [before, after];
        } else throw new Error(`Unknown argument ${arg}`);
    }
    return options;
}

const log = (message: string) => process.stderr.write(`[shots] ${message}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ensurePortFree(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', (err: NodeJS.ErrnoException) => {
            reject(err.code === 'EADDRINUSE'
                ? new Error(`Port ${port} is already in use - stop that server or pass --port=<free port>`)
                : err);
        });
        probe.listen(port, () => probe.close(() => resolve()));
    });
}

async function startServer(port: number): Promise<ChildProcess> {
    if (!fs.existsSync('dist/client/index.html') || !fs.existsSync('dist/server/index.js')) {
        throw new Error('No production build in dist/ - run "npm run build" first (or use "npm run screenshots")');
    }
    await ensurePortFree(port);
    const expectedVersion = fs.readFileSync('dist/client/build-version.txt', 'utf8').trim();
    const server = spawn(process.execPath, ['dist/server/index.js'], {
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'ignore', 'inherit']
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/build-version.txt`);
            if (response.ok) {
                const version = (await response.text()).trim();
                if (version !== expectedVersion) {
                    server.kill();
                    throw new Error(`Port ${port} is served by another build (${version}, expected ${expectedVersion})`);
                }
                return server;
            }
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Port')) throw error;
        }
        await sleep(200);
    }
    server.kill();
    throw new Error('Server did not start within 30 s');
}

function launchArgs(gl: Options['gl']): string[] {
    if (gl === 'swiftshader') return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    return process.platform === 'darwin'
        ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
        : ['--enable-gpu', '--ignore-gpu-blocklist'];
}

async function glRenderer(browser: Browser): Promise<string> {
    const page = await browser.newPage();
    try {
        return await page.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl2');
            if (!gl) return 'none';
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
        });
    } finally {
        await page.close();
    }
}

type Debug = {
    snapshot(): BulliDebugSnapshot;
    placeLocalCar(x: number, z: number, angle: number): void;
    setCameraOverride(pose: CameraPose | null): void;
    localCarScreenBox(): ScreenBox | null;
};

function snapshot(page: Page): Promise<BulliDebugSnapshot> {
    return page.evaluate(() => (window as unknown as { __bulliDebug: Debug }).__bulliDebug.snapshot());
}

async function place(page: Page, x: number, z: number, angle: number): Promise<void> {
    await page.evaluate(({ x, z, angle }) =>
        (window as unknown as { __bulliDebug: Debug }).__bulliDebug.placeLocalCar(x, z, angle), { x, z, angle });
}

async function setCamera(page: Page, pose: CameraPose | null): Promise<void> {
    await page.evaluate(pose =>
        (window as unknown as { __bulliDebug: Debug }).__bulliDebug.setCameraOverride(pose), pose);
}

async function hideHud(page: Page, hide: boolean): Promise<void> {
    await page.evaluate(hide => {
        let style = document.getElementById('shots-hide-hud');
        if (!style) {
            style = document.createElement('style');
            style.id = 'shots-hide-hud';
            style.textContent = 'body.shots-hide-hud > *:not(canvas) { visibility: hidden !important; }';
            document.head.appendChild(style);
        }
        document.body.classList.toggle('shots-hide-hud', hide);
    }, hide);
}

// Waits until the renderer drew a few more frames (and at least minMs passed)
async function settle(page: Page, minMs: number): Promise<void> {
    const start = (await snapshot(page)).render.frame;
    await sleep(minMs);
    const deadline = Date.now() + 10_000;
    while ((await snapshot(page)).render.frame < start + 10 && Date.now() < deadline) await sleep(100);
}

async function join(browser: Browser, contextOptions: BrowserContextOptions, baseURL: string, name: string): Promise<Page> {
    const context = await browser.newContext({ ...contextOptions, baseURL });
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
        route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const page = await context.newPage();
    page.on('pageerror', error => log(`page error: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') log(`console.error: ${message.text()}`); });

    await page.goto('/?e2e=1');
    await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 90_000 });
    await page.locator('.car-card[data-car="bulli"]').click();
    await page.locator('#splash-name-input').fill(name);
    if (contextOptions.hasTouch) await page.locator('#start-btn').tap();
    else await page.locator('#start-btn').click();
    await page.locator('#splash-screen.hidden').waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
        const debug = (window as unknown as { __bulliDebug?: Debug }).__bulliDebug;
        return !!debug && debug.snapshot().connected && !!debug.snapshot().local;
    });
    return page;
}

interface ShotStats { view: string; calls: number; triangles: number; carWidth?: number; carHeight?: number }

// chase: the view comes from the chase camera, so the car's share of the
// frame is worth recording
async function shoot(page: Page, out: string, view: string, stats: ShotStats[], chase = false): Promise<void> {
    const file = path.join(out, `${view}.png`);
    const box = chase
        ? await page.evaluate(() => (window as unknown as { __bulliDebug: Debug }).__bulliDebug.localCarScreenBox())
        : null;
    await page.screenshot({ path: file });
    const { render } = await snapshot(page);
    const entry: ShotStats = { view, calls: render.calls, triangles: render.triangles };
    if (box) {
        entry.carWidth = Number(box.width.toFixed(3));
        entry.carHeight = Number(box.height.toFixed(3));
    }
    stats.push(entry);
    const car = box ? `, car ${(box.width * 100).toFixed(1)} % wide, ${(box.height * 100).toFixed(1)} % high` : '';
    log(`${view}: ${render.calls} calls, ${render.triangles} triangles${car}`);
}

// Road center lines run at -98, -46, 6, 58, 110 on both axes.
const MID_ROAD = roadLineCenter(2, 'x');
const MID_CROSS = roadLineCenter(2, 'z');
const EDGE_ROAD = roadLineCenter(4, 'x');
const plaza = blockCenter(PLAZA_BLOCK.x, PLAZA_BLOCK.z);
const park = blockCenter(PARK_BLOCK.x, PARK_BLOCK.z);

async function captureDesktop(browser: Browser, baseURL: string, options: Options, stats: ShotStats[]): Promise<void> {
    const want = (view: string) => !options.only || options.only.includes(view);
    const page = await join(browser, {
        ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1
    }, baseURL, 'Shots');

    // Chase camera on the middle road looking north towards the plaza, HUD
    // visible (checks UI legibility too). The car is fresh, so the respawn
    // shield is still up.
    if (want('street')) {
        await place(page, MID_ROAD, -60, 0);
        await settle(page, 2500);
        await shoot(page, options.out, 'street', stats, true);
    }

    // Close-up of the car and its shield: materials, contact shadow, rim
    if (want('car')) {
        await place(page, MID_ROAD, -60, 0);
        await hideHud(page, true);
        await setCamera(page, { position: [MID_ROAD + 6, 3.2, -60 + 8.5], lookAt: [MID_ROAD, 1.2, -60], fov: 40 });
        await settle(page, 1200);
        await shoot(page, options.out, 'car', stats);
        await setCamera(page, null);
        await hideHud(page, false);
    }

    // The car on the light plaza tiles: contact shadow, reflections, shield
    if (want('car-plaza')) {
        const x = plaza.x - 9;
        const z = plaza.z + 10;
        await place(page, x, z, 0.8);
        await hideHud(page, true);
        await setCamera(page, { position: [x + 7.5, 4.2, z + 6.5], lookAt: [x, 1.0, z], fov: 42 });
        await settle(page, 1200);
        await shoot(page, options.out, 'car-plaza', stats);
        await setCamera(page, null);
        await hideHud(page, false);
    }

    // Plaza with fountain, parasols and planters, seen from the south east
    if (want('plaza')) {
        await place(page, plaza.x + 2, plaza.z + 22, Math.PI);
        await hideHud(page, true);
        await setCamera(page, { position: [plaza.x + 18, 9, plaza.z + 24], lookAt: [plaza.x, 1.5, plaza.z], fov: 55 });
        await settle(page, 1500);
        await shoot(page, options.out, 'plaza', stats);
    }

    // Palm Park from its south west corner
    if (want('park')) {
        await place(page, park.x - 26, park.z - 24, 0);
        await hideHud(page, true);
        await setCamera(page, { position: [park.x - 24, 10, park.z - 26], lookAt: [park.x, 1, park.z], fov: 55 });
        await settle(page, 1500);
        await shoot(page, options.out, 'park', stats);
    }

    // High overview of the whole city and the terrain around it
    if (want('overview')) {
        await place(page, MID_ROAD, -60, 0);
        await hideHud(page, true);
        await setCamera(page, { position: [-170, 110, -170], lookAt: [5, 0, 5], fov: 50 });
        await settle(page, 1500);
        await shoot(page, options.out, 'overview', stats);
    }

    // From the hills back to the city: terrain, fog and the city edge
    if (want('outskirts-city')) {
        await place(page, EDGE_ROAD, 100, 0);
        await hideHud(page, true);
        await setCamera(page, { position: [150, 30, -150], lookAt: [0, 0, 0], fov: 55 });
        await settle(page, 1500);
        await shoot(page, options.out, 'outskirts-city', stats);
    }
    await setCamera(page, null);
    await hideHud(page, false);

    // Chase camera at the city edge, looking out over the terrain
    if (want('outskirts')) {
        await place(page, EDGE_ROAD, 100, 0);
        await settle(page, 2000);
        await shoot(page, options.out, 'outskirts', stats, true);
    }

    // Driving: chase camera in motion with exhaust/drift smoke
    if (want('drive')) {
        await place(page, MID_ROAD, -95, 0);
        await settle(page, 800);
        await page.keyboard.down('w');
        await sleep(1600);
        await page.keyboard.down('d');
        await sleep(450);
        await page.keyboard.up('d');
        await sleep(250);
        await shoot(page, options.out, 'drive', stats, true);
        await page.keyboard.up('w');
    }

    // Turning at a crossing: the car mid-corner, the cross street ahead has
    // to stay readable with the chase camera
    if (want('corner')) {
        await place(page, MID_ROAD - 3, MID_CROSS - 14, Math.PI / 4);
        await settle(page, 1500);
        await shoot(page, options.out, 'corner', stats, true);
    }

    await page.context().close();
}

async function captureMobile(browser: Browser, baseURL: string, options: Options, stats: ShotStats[]): Promise<void> {
    const iphone = devices['iPhone 13'];
    for (const orientation of ['portrait', 'landscape'] as const) {
        const view = `mobile-${orientation}`;
        if (options.only && !options.only.includes(view)) continue;
        const viewport = orientation === 'portrait'
            ? iphone.viewport
            : { width: iphone.viewport.height, height: iphone.viewport.width };
        const page = await join(browser, { ...iphone, viewport, screen: viewport }, baseURL, 'Mobile');
        await place(page, MID_ROAD, -60, 0);
        await settle(page, 2500);
        await shoot(page, options.out, view, stats, true);
        await page.context().close();
    }
}

// Side-by-side image per view, composed in the browser (no image library needed)
async function compare(browser: Browser, [beforeDir, afterDir]: [string, string], out: string): Promise<void> {
    const views = fs.readdirSync(afterDir)
        .filter(file => file.endsWith('.png') && fs.existsSync(path.join(beforeDir, file)));
    const page = await browser.newPage();
    for (const file of views) {
        const dataUrl = (dir: string) => `data:image/png;base64,${fs.readFileSync(path.join(dir, file)).toString('base64')}`;
        // No named helper functions inside: tsx would wrap them in __name(),
        // which does not exist in the page.
        const png = await page.evaluate(async ({ before, after, label }) => {
            const [a, b] = await Promise.all([before, after].map(src => new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = reject;
                image.src = src;
            })));
            const gap = 8;
            const canvas = document.createElement('canvas');
            canvas.width = a.width + gap + b.width;
            canvas.height = Math.max(a.height, b.height);
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(a, 0, 0);
            ctx.drawImage(b, a.width + gap, 0);
            const scale = Math.max(1, a.width / 800);
            ctx.font = `600 ${Math.round(18 * scale)}px sans-serif`;
            ctx.textBaseline = 'top';
            for (const [text, x] of [[`BEFORE  ${label}`, 0], [`AFTER  ${label}`, a.width + gap]] as const) {
                const width = ctx.measureText(text).width + 20 * scale;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
                ctx.fillRect(x, 0, width, 32 * scale);
                ctx.fillStyle = '#fff';
                ctx.fillText(text, x + 10 * scale, 7 * scale);
            }
            return canvas.toDataURL('image/png');
        }, { before: dataUrl(beforeDir), after: dataUrl(afterDir), label: file.replace(/\.png$/, '') });
        const target = path.join(out, `compare-${file}`);
        fs.writeFileSync(target, Buffer.from(png.split(',')[1], 'base64'));
        log(`wrote ${target}`);
    }
    await page.close();
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    fs.mkdirSync(options.out, { recursive: true });

    if (options.compare) {
        const browser = await chromium.launch();
        try {
            await compare(browser, options.compare, options.out);
        } finally {
            await browser.close();
        }
        return;
    }

    const baseURL = `http://127.0.0.1:${options.port}`;
    log(`starting server on ${baseURL}`);
    const server = await startServer(options.port);
    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({ args: launchArgs(options.gl) });
        let renderer = await glRenderer(browser);
        if (options.gl === 'gpu' && /swiftshader|none/i.test(renderer)) {
            log(`no GPU context (${renderer}), falling back to SwiftShader`);
            await browser.close();
            browser = await chromium.launch({ args: launchArgs('swiftshader') });
            renderer = await glRenderer(browser);
        }
        log(`GL renderer: ${renderer}`);

        const stats: ShotStats[] = [];
        await captureDesktop(browser, baseURL, options, stats);
        await captureMobile(browser, baseURL, options, stats);
        const summary = { date: new Date().toISOString(), renderer, shots: stats };
        fs.writeFileSync(path.join(options.out, 'stats.json'), JSON.stringify(summary, null, 2) + '\n');
        log(`wrote ${stats.length} screenshots to ${options.out}`);
    } finally {
        await browser?.close();
        server.kill();
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
});
