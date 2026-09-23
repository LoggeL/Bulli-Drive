// Performance baseline: starts the production server, joins with N headless
// Chromium clients (?debug=perf), lets all of them drive for a while and prints
// the recorded frame, renderer and WebSocket numbers as JSON.
//
//   npm run perf:baseline                       # build, 2 clients, 20 s
//   npm run perf:baseline -- --duration=30 --clients=3 --device=mobile --out=perf.json
//   npm run perf:baseline -- --gl=gpu           # use the machine's GPU instead
//
// By default headless Chromium renders with SwiftShader (CPU), so FPS and
// frame times are far below a real GPU. Draw calls, triangles and memory
// counters do not depend on the GPU. The client sends at most one position
// update per frame, so the upload rate is only representative when the
// clients reach at least 20 FPS (check "fps"; --gl=gpu usually does).

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import type { PerfHook, PerfRecording, WsTotals } from '../src/client/debug/perfMonitor.js';
import type { BulliDebugSnapshot } from '../src/client/e2eHook.js';

interface Options {
    durationS: number;
    warmupS: number;
    clients: number;
    device: 'desktop' | 'mobile';
    gl: 'swiftshader' | 'gpu';
    port: number;
    out: string | null;
}

function parseArgs(argv: string[]): Options {
    const options: Options = { durationS: 20, warmupS: 5, clients: 2, device: 'desktop', gl: 'swiftshader', port: 8798, out: null };
    for (const arg of argv) {
        const [key, value = ''] = arg.replace(/^--/, '').split('=');
        if (key === 'duration') options.durationS = Number(value);
        else if (key === 'warmup') options.warmupS = Number(value);
        else if (key === 'clients') options.clients = Number(value);
        else if (key === 'device' && (value === 'desktop' || value === 'mobile')) options.device = value;
        else if (key === 'gl' && (value === 'swiftshader' || value === 'gpu')) options.gl = value;
        else if (key === 'port') options.port = Number(value);
        else if (key === 'out') options.out = value;
        else throw new Error(`Unknown argument ${arg}`);
    }
    if (!(options.durationS > 0) || !(options.clients >= 1) || !(options.warmupS >= 0)) {
        throw new Error('duration and clients must be positive numbers');
    }
    return options;
}

const log = (message: string) => process.stderr.write(`[perf] ${message}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Resolves when nothing listens on the port yet. Otherwise our server would
// die with EADDRINUSE while the other one answers the readiness check, and the
// baseline would silently measure a foreign server and build.
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
        throw new Error('No production build in dist/ - run "npm run build" first (or use "npm run perf:baseline")');
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
        let version: string | null = null;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/build-version.txt`);
            if (response.ok) version = (await response.text()).trim();
        } catch { /* not up yet */ }
        if (version !== null) {
            // Make sure it is our server with our build that answered.
            if (server.exitCode !== null || version !== expectedVersion) {
                server.kill();
                throw new Error(`Port ${port} is served by another server (build ${version}, expected ${expectedVersion})`);
            }
            return server;
        }
        await sleep(200);
    }
    server.kill();
    throw new Error('Server did not start within 30 s');
}

function serverRssMb(server: ChildProcess): number | null {
    try {
        const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], { encoding: 'utf8' }).trim());
        return Number.isFinite(kb) ? Math.round(kb / 102.4) / 10 : null;
    } catch {
        return null;
    }
}

function gitCommit(): string | null {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

function contextOptions(device: Options['device'], baseURL: string): BrowserContextOptions {
    return device === 'mobile'
        ? { ...devices['iPhone 13'], baseURL }
        : { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL };
}

async function joinClient(browser: Browser, options: Options, baseURL: string, index: number): Promise<Page> {
    const context = await browser.newContext(contextOptions(options.device, baseURL));
    // Keep the run hermetic, the web fonts come from Google.
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
        route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const page = await context.newPage();
    page.on('pageerror', error => log(`client ${index} page error: ${error.message}`));

    await page.goto('/?e2e=1&debug=perf');
    await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 90_000 });
    await page.locator('#splash-name-input').fill(`Perf ${index + 1}`);
    if (options.device === 'mobile') await page.locator('#start-btn').tap();
    else await page.locator('#start-btn').click();
    await page.locator('#splash-screen.hidden').waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
        const debug = (window as unknown as { __bulliDebug?: { snapshot(): BulliDebugSnapshot } }).__bulliDebug;
        return !!debug && debug.snapshot().connected && !!debug.snapshot().local;
    });
    return page;
}

function launchArgs(gl: Options['gl']): string[] {
    if (gl === 'swiftshader') return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    return process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
        : ['--enable-gpu', '--ignore-gpu-blocklist'];
}

// Hold W and weave left and right, so the cars keep moving through the city.
// A car that got stuck at a wall backs off with a turn and goes on.
async function drive(page: Page, untilMs: number, index: number): Promise<void> {
    const pattern: Array<[string | null, number]> = [[null, 1500], ['d', 700], [null, 1500], ['a', 700]];
    let step = index % pattern.length;
    let steerKey: string | null = null;
    let stepEndsAt = 0;
    let slowSince = 0;
    await page.keyboard.down('w');
    while (Date.now() < untilMs) {
        const now = Date.now();
        if (now >= stepEndsAt) {
            if (steerKey) await page.keyboard.up(steerKey);
            const [key, durationMs] = pattern[step];
            steerKey = key;
            if (steerKey) await page.keyboard.down(steerKey);
            stepEndsAt = now + durationMs;
            step = (step + 1) % pattern.length;
        }

        // Below ~30 km/h for a while with the throttle held: stuck
        const speed = Math.abs((await snapshot(page)).local?.speed ?? 0);
        if (speed > 0.15) slowSince = 0;
        else if (!slowSince) slowSince = now;
        if (slowSince && now - slowSince > 1500) {
            if (steerKey) await page.keyboard.up(steerKey);
            await page.keyboard.up('w');
            const turnKey = index % 2 ? 'a' : 'd';
            await page.keyboard.down('s');
            await page.keyboard.down(turnKey);
            await sleep(1200);
            await page.keyboard.up(turnKey);
            await page.keyboard.up('s');
            await page.keyboard.down('w');
            steerKey = null;
            stepEndsAt = 0;
            slowSince = 0;
        }
        await sleep(150);
    }
    if (steerKey) await page.keyboard.up(steerKey);
    await page.keyboard.up('w');
}

function snapshot(page: Page): Promise<BulliDebugSnapshot> {
    return page.evaluate(() =>
        (window as unknown as { __bulliDebug: { snapshot(): BulliDebugSnapshot } }).__bulliDebug.snapshot());
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const baseURL = `http://127.0.0.1:${options.port}`;
    log(`starting server on ${baseURL}`);
    const server = await startServer(options.port);
    let browser: Browser | null = null;

    try {
        const rssStart = serverRssMb(server);
        browser = await chromium.launch({ args: launchArgs(options.gl) });
        log(`joining ${options.clients} ${options.device} client(s)`);
        const pages: Page[] = [];
        for (let i = 0; i < options.clients; i++) pages.push(await joinClient(browser, options, baseURL, i));
        const initTotals = await Promise.all(pages.map(page =>
            page.evaluate(() => (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.wsTotals())));
        const gpu = await pages[0].evaluate(() => (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.gpu());

        log(`warming up for ${options.warmupS} s`);
        const warmupEnd = Date.now() + options.warmupS * 1000;
        const driveEnd = warmupEnd + options.durationS * 1000;
        const driving = pages.map((page, index) => drive(page, driveEnd, index));
        await sleep(Math.max(0, warmupEnd - Date.now()));

        log(`recording ${options.durationS} s`);
        await Promise.all(pages.map(page =>
            page.evaluate(() => (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.startRecording())));
        // Sample the positions twice a second for the driven distance
        const driven = pages.map(() => 0);
        let last = await Promise.all(pages.map(snapshot));
        while (Date.now() < driveEnd) {
            await sleep(Math.min(500, Math.max(0, driveEnd - Date.now())));
            const now = await Promise.all(pages.map(snapshot));
            now.forEach((current, index) => {
                driven[index] += Math.hypot(
                    current.local!.x - last[index].local!.x,
                    current.local!.z - last[index].local!.z);
            });
            last = now;
        }
        await Promise.all(driving);
        const recordings = await Promise.all(pages.map(page =>
            page.evaluate(() => (window as unknown as { __bulliPerf: PerfHook }).__bulliPerf.stopRecording())));
        const ends = await Promise.all(pages.map(snapshot));
        const rssEnd = serverRssMb(server);

        const result = {
            meta: {
                date: new Date().toISOString(),
                commit: gitCommit(),
                node: process.version,
                chromium: browser.version(),
                gl: options.gl,
                gpu,
                headless: true,
                device: options.device,
                clients: options.clients,
                warmupS: options.warmupS,
                durationS: options.durationS,
                note: options.gl === 'swiftshader'
                    ? 'SwiftShader renders on the CPU: FPS and frame times are not representative. Draw calls, triangles and memory counters are; the upload rate only if fps >= 20.'
                    : 'Headless Chromium on the local GPU: closer to a real desktop, but without vsync/compositor and with all clients sharing one machine.'
            },
            server: { rssMbStart: rssStart, rssMbEnd: rssEnd },
            clients: pages.map((_, index) => ({
                name: `Perf ${index + 1}`,
                // Payload received before driving: mostly the init message with the world
                joinWs: initTotals[index] as WsTotals,
                drivenMeters: Math.round(driven[index]),
                remotesSeen: Object.keys(ends[index].remotes).length,
                ...(recordings[index] as PerfRecording)
            }))
        };

        const json = JSON.stringify(result, null, 2);
        if (options.out) {
            fs.writeFileSync(options.out, json + '\n');
            log(`wrote ${options.out}`);
        }
        process.stdout.write(json + '\n');
    } finally {
        await browser?.close();
        server.kill();
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
});
