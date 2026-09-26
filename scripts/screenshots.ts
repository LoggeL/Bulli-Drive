// Screenshot set for visual before/after comparisons: starts the production
// server, joins with headless Chromium (?e2e=1) and captures fixed views:
// the main menu (menu, menu-phone, menu-landscape) and its showroom frame
// alone (showroom, docs/ui.md 4), and Bulli Bay (docs/phase-3-design.md
// 10): the chase camera on Main
// Street, the car up close, its rear with brake lights, a showroom of all
// car types from the front and the rear, close-ups of the Kaefer, Pritsche,
// 356 and 181, the plaza and its fountain, the palms, the promenade, the
// beach and the pier at sunset, a hairpin of the Ridge Road, the lookout
// over the bay, the harbour and its cranes, the Party arena with eight
// cars, the diner and the gas station, Seaview Heights, the ranch, the
// north cliffs, an overview, mobile), and the race (lobby, the grid in the
// countdown with the start portal, a checkpoint with barriers and chevrons,
// the finish from far away, the phone HUD in the countdown and the race,
// the results).
// race-start also records the meshes and triangles of the track dressing
// (dressingMeshes, dressingTriangles; budget +20 draw calls and +30 k
// triangles, docs/phase-2-design.md 17.4).
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
import { mapFor } from '../src/server/maps.js';
import { heightAt } from '../src/shared/map/heightfield.js';
import { mapTracks } from '../src/shared/race/tracks/index.js';

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
        // E2E=1: the server takes debugPlace (placeLocalCar)
        env: { ...process.env, PORT: String(port), E2E: '1' },
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

async function join(browser: Browser, contextOptions: BrowserContextOptions, baseURL: string, name: string, mode: 'party' | 'freeroam' | 'race' = 'party'): Promise<Page> {
    const context = await browser.newContext({ ...contextOptions, baseURL });
    const page = await context.newPage();
    page.on('pageerror', error => log(`page error: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') log(`console.error: ${message.text()}`); });

    // The Bulli, as every view expects
    await page.addInitScript(() => localStorage.setItem('bulli-car-type', 'bulli'));
    await page.goto('/?e2e=1');
    await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 90_000 });
    await page.locator('#splash-name-input').fill(name);
    const tap = (selector: string) => (contextOptions.hasTouch ? page.locator(selector).tap() : page.locator(selector).click());
    await tap(`.mode-option[data-room="${mode}"]`);
    await tap('#start-btn');
    await page.locator('#splash-screen.hidden').waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
        const debug = (window as unknown as { __bulliDebug?: Debug }).__bulliDebug;
        return !!debug && debug.snapshot().connected && !!debug.snapshot().local;
    });
    return page;
}

// Draw calls (including the shadow pass) and triangles per render tier
// (docs/phase-3-design.md 10). The phone tier is checked in the render job
// (tests/e2e-render/phone-tier.spec.ts) and the software tier in the E2E
// desktop path; the desktop needs a GPU, so this script measures it and
// warns about every view above its tier's budget.
const BUDGETS: Record<string, { calls: number; triangles: number }> = {
    desktop: { calls: 300, triangles: 1_200_000 },
    mobile: { calls: 150, triangles: 500_000 },
    software: { calls: 110, triangles: 300_000 }
};
const overBudget: string[] = [];

interface ShotStats {
    view: string; tier?: string; calls: number; triangles: number; shadowCalls?: number; carWidth?: number; carHeight?: number;
    // race-start: meshes and triangles of the track dressing and the map features
    dressingMeshes?: number;
    dressingTriangles?: number;
}

// chase: the view comes from the chase camera, so the car's share of the
// frame is worth recording
async function shoot(page: Page, out: string, view: string, stats: ShotStats[], chase = false): Promise<void> {
    const file = path.join(out, `${view}.png`);
    const box = chase
        ? await page.evaluate(() => (window as unknown as { __bulliDebug: Debug }).__bulliDebug.localCarScreenBox())
        : null;
    await page.screenshot({ path: file });
    const { render } = await snapshot(page);
    const tier = await page.evaluate(() => (window as unknown as { __bulliDebug: { worldInfo(): { tier: string } } }).__bulliDebug.worldInfo().tier);
    // calls/triangles: the whole frame including the shadow pass (shadowCalls)
    const entry: ShotStats = { view, tier, calls: render.calls, triangles: render.triangles, shadowCalls: render.shadowCalls };
    const budget = BUDGETS[tier];
    if (budget && (render.calls > budget.calls || render.triangles > budget.triangles)) {
        overBudget.push(`${view} (${tier}): ${render.calls} calls, ${render.triangles} triangles, budget ${budget.calls} and ${budget.triangles}`);
    }
    if (box) {
        entry.carWidth = Number(box.width.toFixed(3));
        entry.carHeight = Number(box.height.toFixed(3));
    }
    stats.push(entry);
    const car = box ? `, car ${(box.width * 100).toFixed(1)} % wide, ${(box.height * 100).toFixed(1)} % high` : '';
    log(`${view}: ${render.calls} calls (${render.shadowCalls} shadow), ${render.triangles} triangles${car}`);
}

interface SpawnSpec { type: string; color: number; x: number; z: number; yaw: number; brake?: boolean; steer?: number; surfboard?: boolean }

// Game cars placed like remote players (e2e hook spawnCar), for the showroom
async function spawnCars(page: Page, cars: SpawnSpec[]): Promise<void> {
    await page.evaluate(cars => {
        const debug = (window as unknown as { __bulliDebug: { spawnCar(...args: unknown[]): unknown } }).__bulliDebug;
        for (const car of cars) {
            debug.spawnCar(car.type, car.color, car.x, car.z, car.yaw, { brake: car.brake, steer: car.steer, surfboard: car.surfboard });
        }
    }, cars);
}

async function clearSpawned(page: Page): Promise<void> {
    await page.evaluate(() => (window as unknown as { __bulliDebug: { clearModels(): void } }).__bulliDebug.clearModels());
}

// Bulli Bay: cameras stand at a height above the ground (or the sea) under
// them, looking at a point above the ground under it
const map = mapFor();
const ground = (x: number, z: number) => Math.max(map.hf.spec.waterLevel, heightAt(map.hf, x, z));
function view(position: [number, number, number], lookAt: [number, number, number], fov: number): CameraPose {
    return {
        position: [position[0], position[1] + ground(position[0], position[2]), position[2]],
        lookAt: [lookAt[0], lookAt[1] + ground(lookAt[0], lookAt[2]), lookAt[2]],
        fov
    };
}

// Main Street between 1st and 2nd Avenue, heading east (+x)
const MAIN = { x: -446, z: -20, yaw: Math.PI / 2 };
// The diner's lot: a wide flat asphalt lot for the showroom (cars along x at z = 60)
const LOT = { x: 610, z: 62 };
const PLAZA = { x: -350, z: -76 };

async function captureDesktop(browser: Browser, baseURL: string, options: Options, stats: ShotStats[]): Promise<void> {
    const want = (name: string) => !options.only || options.only.includes(name);
    const page = await join(browser, {
        ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1
    }, baseURL, 'Shots', 'freeroam');
    // The sim's colliders and the rendered props standing on them, to check
    // that a visual change of the world left the gameplay alone (compare
    // before/after; tests/client/mapScene.test.ts checks they match)
    const colliders = await page.evaluate(() => {
        const debug = (window as unknown as { __bulliDebug: { colliders(): unknown[]; colliderProps(): unknown[] } }).__bulliDebug;
        return { colliders: debug.colliders(), props: debug.colliderProps() };
    });
    fs.writeFileSync(path.join(options.out, 'colliders.json'), JSON.stringify(colliders) + '\n');

    // A fixed view with the car parked at (x, z, yaw) and the HUD hidden
    const still = async (name: string, car: [number, number, number], pose: CameraPose, ms = 1500) => {
        if (!want(name)) return;
        await place(page, ...car);
        await hideHud(page, true);
        await setCamera(page, pose);
        await settle(page, ms);
        await shoot(page, options.out, name, stats);
        await setCamera(page, null);
        await hideHud(page, false);
    };
    // The chase camera behind the car at (x, z, yaw), HUD visible
    const chase = async (name: string, car: [number, number, number], ms = 2500) => {
        if (!want(name)) return;
        await place(page, ...car);
        await settle(page, ms);
        await shoot(page, options.out, name, stats, true);
    };

    // Main Street, the chase camera looking east: shop rows, palms,
    // markings, HUD legibility. The car is fresh, so the respawn shield is up.
    await chase('street', [MAIN.x, MAIN.z, MAIN.yaw]);

    // Close-up of the car and its shield: materials, contact shadow, rim
    await still('car', [MAIN.x, MAIN.z, MAIN.yaw], view([MAIN.x - 8.5, 3.2, MAIN.z + 6], [MAIN.x, 1.2, MAIN.z], 40), 1200);

    // Close-up of the car from the rear: brake lights, left blinker, the
    // cabin through the rear window, wheel and tyre detail
    if (want('car-rear')) {
        await place(page, MAIN.x - 60, MAIN.z, MAIN.yaw);
        await hideHud(page, true);
        const x = MAIN.x + 20, z = MAIN.z - 3;
        await spawnCars(page, [{ type: 'bulli', color: 0x2E6FA8, x, z, yaw: MAIN.yaw + 0.35, brake: true, steer: 0.3 }]);
        await setCamera(page, view([x - 7.4, 2.6, z - 4.2], [x, 1.0, z], 40));
        await settle(page, 1500);
        await shoot(page, options.out, 'car-rear', stats);
        await clearSpawned(page);
        await setCamera(page, null);
        await hideHud(page, false);
    }

    // Showroom on the diner's lot: every car type side by side in fixed
    // colours (and the Bulli with its optional surfboard), from the front
    // (they face +z, the camera looks from +z) and from the rear
    const types = ['jeep', 'sport', 'bulli', 'beetle', 'pickup'];
    const colors = [0x6B8E4E, 0xC0392B, 0xD9A441, 0x2E6FA8, 0x8E5B3A];
    if (want('showroom')) {
        await place(page, LOT.x - 30, LOT.z - 20, 0);
        await hideHud(page, true);
        const cars: SpawnSpec[] = types.map((type, i) => ({ type, color: colors[i], x: LOT.x - 13 + i * 5.2, z: LOT.z, yaw: 0 }));
        cars.push({ type: 'bulli', color: 0x3D8C7A, x: LOT.x + 13, z: LOT.z - 1, yaw: -0.5, surfboard: true });
        await spawnCars(page, cars);
        await setCamera(page, view([LOT.x + 2, 4.2, LOT.z + 17], [LOT.x, 1.1, LOT.z], 55));
        await settle(page, 1500);
        await shoot(page, options.out, 'showroom', stats);
        await clearSpawned(page);
        await setCamera(page, null);
        await hideHud(page, false);
    }
    if (want('showroom-rear')) {
        await place(page, LOT.x - 30, LOT.z - 20, 0);
        await hideHud(page, true);
        await spawnCars(page, types.map((type, i) => ({ type, color: colors[i], x: LOT.x - 13 + i * 5.2, z: LOT.z, yaw: 0, brake: true })));
        await setCamera(page, view([LOT.x - 2, 4.2, LOT.z - 17], [LOT.x, 1.1, LOT.z], 55));
        await settle(page, 1500);
        await shoot(page, options.out, 'showroom-rear', stats);
        await clearSpawned(page);
        await setCamera(page, null);
        await hideHud(page, false);
    }

    // Close-ups of the other four Blender cars (front three-quarter, braking,
    // steering left), on Main Street
    for (const [type, color] of [['beetle', 0x2E6FA8], ['pickup', 0x6B8E4E], ['sport', 0xC0392B], ['jeep', 0xD9A441]] as const) {
        if (!want(`car-${type}`)) continue;
        await place(page, MAIN.x - 60, MAIN.z, MAIN.yaw);
        await hideHud(page, true);
        const x = MAIN.x + 20, z = MAIN.z + 3;
        await spawnCars(page, [{ type, color, x, z, yaw: MAIN.yaw - 0.35, brake: true, steer: 0.25 }]);
        await setCamera(page, view([x + 6.4, 2.4, z - 5.2], [x, 0.9, z], 40));
        await settle(page, 1500);
        await shoot(page, options.out, `car-${type}`, stats);
        await clearSpawned(page);
        await setCamera(page, null);
        await hideHud(page, false);
    }

    // The plaza: pavers, lawns, the fountain; the car on the pavers
    await still('car-plaza', [PLAZA.x - 9, PLAZA.z + 22, 0.8], view([PLAZA.x - 1.5, 4.2, PLAZA.z + 28.5], [PLAZA.x - 9, 1.0, PLAZA.z + 22], 42), 1200);
    await still('plaza', [MAIN.x, MAIN.z, MAIN.yaw], view([PLAZA.x + 24, 9, PLAZA.z + 50], [PLAZA.x, 1.5, PLAZA.z], 55));
    await still('fountain', [MAIN.x, MAIN.z, MAIN.yaw], view([PLAZA.x + 1.5, 3.2, PLAZA.z + 16.5], [PLAZA.x, 1.3, PLAZA.z + 6], 50));

    // Looking up at the palms of Main Street (crowns against the sky), and
    // the same with every palm beyond 12 m drawn as impostor (far LOD)
    await still('palms', [MAIN.x - 60, MAIN.z, MAIN.yaw], view([MAIN.x - 10, 2.5, MAIN.z + 1], [MAIN.x + 20, 10, MAIN.z - 6], 55));
    if (want('palms-lod')) {
        await page.evaluate(() => (window as unknown as { __bulliDebug: { setPalmImpostorDistance(m: number | null): void } }).__bulliDebug.setPalmImpostorDistance(12));
        await still('palms-lod', [MAIN.x - 60, MAIN.z, MAIN.yaw], view([MAIN.x - 10, 2.5, MAIN.z + 1], [MAIN.x + 20, 10, MAIN.z - 6], 55));
        await page.evaluate(() => (window as unknown as { __bulliDebug: { setPalmImpostorDistance(m: number | null): void } }).__bulliDebug.setPalmImpostorDistance(null));
    }

    // The promenade (Ocean Boulevard) with the chase camera heading north,
    // the beach and the pier into the evening sun over the sea
    await chase('promenade', [-560, -47.5, Math.PI]);
    await still('sunset', [-560, -47.5, Math.PI], view([-600, 5, -80], [-800, 0, -60], 60));
    await still('pier', [-560, -47.5, Math.PI], view([-596, 12, 25], [-700, 4, -20], 55));

    // A hairpin of the Ridge Road (chase camera), the lookout over the bay
    await chase('ridge', [471.3, -390.1, -3.133]);
    // (from its lot's railing, behind the coin telescopes, towards the pier)
    await still('lookout', [690, -790, 0], view([648, 3.2, -761], [-640, 0, -20], 50));

    // The harbour: Harbor Boulevard with its halls (chase camera), the
    // quay cranes from the beach
    await chase('harbor', [-250, 298, 1.546]);
    await still('cranes', [-455, 640, Math.PI], view([-462, 4, 645], [-492, 12, 500], 55));

    // The Party arena from above its gate, with eight cars
    if (want('arena')) {
        await place(page, -250, 298, 1.546);
        await hideHud(page, true);
        const cars: SpawnSpec[] = ['bulli', 'beetle', 'pickup', 'sport', 'jeep', 'bulli', 'beetle', 'pickup'].map((type, i) => ({
            type, color: 0x3366aa + i * 0x151515, x: -200 + (i % 4) * 20, z: 560 + Math.floor(i / 4) * 40, yaw: i * 0.8
        }));
        await spawnCars(page, cars);
        await setCamera(page, view([-170, 30, 470], [-170, 0, 590], 60));
        await settle(page, 1500);
        await shoot(page, options.out, 'arena', stats);
        await clearSpawned(page);
        await setCamera(page, null);
        await hideHud(page, false);
    }

    // The diner and the gas station from Canyon Road
    await still('diner', [600, 59, 1.349], view([600, 7, 95], [645, 3, 140], 55));
    await still('gas-station', [600, 59, 1.349], view([600, 7, 40], [640, 3, -10], 55));

    // Seaview Heights, the ranch's fire road, the coast road on the north cliffs (chase camera)
    await chase('residential', [-87.5, -191.5, 2.816]);
    await chase('ranch', [574.5, 177.1, 0.22]);
    await chase('cliffs', [-766.2, -814, 3.07]);

    // High overview of the bay and the town
    await still('overview', [MAIN.x, MAIN.z, MAIN.yaw], view([-900, 160, 300], [-300, 0, -100], 55));

    // Driving: chase camera in motion with exhaust/drift smoke
    if (want('drive')) {
        await place(page, MAIN.x - 40, MAIN.z - 3, MAIN.yaw);
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

    // Turning at a crossing: the car mid-corner at Main Street and 2nd
    // Avenue, the cross street ahead has to stay readable
    await chase('corner', [-400, -30, Math.PI / 4], 1500);

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
        const page = await join(browser, { ...iphone, viewport, screen: viewport }, baseURL, 'Mobile', 'freeroam');
        await place(page, MAIN.x, MAIN.z, MAIN.yaw);
        await settle(page, 2500);
        await shoot(page, options.out, view, stats, true);
        await page.context().close();
    }
}

// ---- Race ----

type RaceDebug = { race(): { phase: string; trackId: string; startTick: number | null; tick: number } | null };

function raceState(page: Page) {
    return page.evaluate(() => (window as unknown as { __bulliDebug: RaceDebug }).__bulliDebug.race());
}

async function waitRace(page: Page, test: (race: NonNullable<Awaited<ReturnType<typeof raceState>>>) => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
        const race = await raceState(page);
        if (race && test(race)) return;
        if (Date.now() > deadline) throw new Error(`race: timed out waiting for ${what}`);
        await sleep(100);
    }
}

// Meshes (each one draw call, the props also in the shadow pass) and
// triangles of the track dressing and the map features
function dressing(page: Page): Promise<{ meshes: number; triangles: number }> {
    return page.evaluate(() => (window as unknown as { __bulliDebug: { raceDressing(): { meshes: number; triangles: number } } }).__bulliDebug.raceDressing());
}

// The tracks on Bulli Bay: the Downtown Loop's first checkpoint, the Ridge
// Climb's start portal, its first ramp and its finish on the lookout
const TRACKS = mapTracks(map);
const LOOP = TRACKS['downtown-loop'];
const CLIMB = TRACKS['hill-sprint'];
const CLIMB_FINISH = CLIMB.gates[CLIMB.gates.length - 1];
const BEFORE_FINISH = { x: CLIMB_FINISH.x - 25 * Math.sin(CLIMB_FINISH.yaw), z: CLIMB_FINISH.z - 25 * Math.cos(CLIMB_FINISH.yaw), yaw: CLIMB_FINISH.yaw };
// A camera `back` m behind (x, z) against the heading yaw, `side` m to its right
function behind(p: { x: number; z: number; yaw: number }, back: number, side: number, up: number, ahead: number, fov: number): CameraPose {
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    return view([p.x - fx * back - fz * side, up, p.z - fz * back + fx * side], [p.x + fx * ahead, 3, p.z + fz * ahead], fov);
}

async function captureRace(browser: Browser, baseURL: string, options: Options, stats: ShotStats[]): Promise<void> {
    const views = ['race-lobby', 'race-checkpoint', 'race-start', 'race-portal', 'race-ramps', 'race-finish-far', 'race-results'];
    const want = (view: string) => !options.only || options.only.includes(view);
    if (views.some(want)) {
        const page = await join(browser, {
            ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1
        }, baseURL, 'Shots', 'race');
        await waitRace(page, race => race.phase === 'lobby', 'the lobby');
        // The Downtown Loop is the first track
        if (want('race-lobby')) {
            await settle(page, 1500);
            await shoot(page, options.out, 'race-lobby', stats);
            const { meshes, triangles } = await dressing(page);
            Object.assign(stats[stats.length - 1], { dressingMeshes: meshes, dressingTriangles: triangles });
            log(`race-lobby (Downtown Loop): the track dressing has ${meshes} meshes and ${triangles} triangles`);
        }
        // Checkpoint 1 of the Downtown Loop, the barriers across the side
        // streets and the chevron boards
        if (want('race-checkpoint')) {
            await hideHud(page, true);
            await setCamera(page, behind(LOOP.gates[1], 30, 3, 3.2, 10, 55));
            await settle(page, 1500);
            await shoot(page, options.out, 'race-checkpoint', stats);
            await setCamera(page, null);
            await hideHud(page, false);
        }
        // The Ridge Climb: the grid in the countdown, two red lights
        await page.locator('#race-lobby [data-track="hill-sprint"]').click();
        await waitRace(page, race => race.trackId === 'hill-sprint', 'the Ridge Climb');
        await page.locator('#race-ready').click();
        await waitRace(page, race => race.startTick !== null && race.tick >= race.startTick - 110, 'two red lights');
        if (want('race-start')) {
            await shoot(page, options.out, 'race-start', stats, true);
            const { meshes, triangles } = await dressing(page);
            Object.assign(stats[stats.length - 1], { dressingMeshes: meshes, dressingTriangles: triangles });
            log(`race-start: the track dressing has ${meshes} meshes and ${triangles} triangles`);
        }
        if (want('race-portal')) {
            await hideHud(page, true);
            await setCamera(page, behind(CLIMB.gates[0], -12, 4, 2.2, -30, 50));
            await settle(page, 600);
            await shoot(page, options.out, 'race-portal', stats);
            await setCamera(page, null);
            await hideHud(page, false);
        }
        await waitRace(page, race => race.phase === 'racing' && race.tick > (race.startTick ?? 0) + 30, 'the start');
        if (want('race-ramps') && CLIMB.ramps.length) {
            await hideHud(page, true);
            await setCamera(page, behind(CLIMB.ramps[0], 25, 6, 6, 20, 55));
            await settle(page, 1500);
            await shoot(page, options.out, 'race-ramps', stats);
        }
        // The finish portal on the lookout from 600 m below (visibility, fog)
        if (want('race-finish-far')) {
            await hideHud(page, true);
            await setCamera(page, behind(CLIMB_FINISH, 600, 0, 45, 0, 20));
            await settle(page, 1500);
            await shoot(page, options.out, 'race-finish-far', stats);
        }
        await setCamera(page, null);
        await hideHud(page, false);
        if (want('race-results')) {
            await place(page, BEFORE_FINISH.x, BEFORE_FINISH.z, BEFORE_FINISH.yaw);
            await page.keyboard.down('w');
            await waitRace(page, race => race.phase === 'results', 'the results');
            await page.keyboard.up('w');
            await page.locator('#race-results').waitFor({ state: 'visible' });
            await settle(page, 800);
            await shoot(page, options.out, 'race-results', stats);
        }
        await page.context().close();
    }

    // The phone: the lobby, the countdown with the GO zone, the race HUD
    const iphone = devices['iPhone 13'];
    for (const orientation of ['portrait', 'landscape'] as const) {
        const prefix = `race-mobile-${orientation}`;
        if (options.only && !options.only.some(view => view.startsWith(prefix))) continue;
        const viewport = orientation === 'portrait' ? iphone.viewport : { width: iphone.viewport.height, height: iphone.viewport.width };
        const page = await join(browser, { ...iphone, viewport, screen: viewport }, baseURL, 'Mobile', 'race');
        await waitRace(page, race => race.phase === 'lobby', 'the lobby');
        await settle(page, 1500);
        await shoot(page, options.out, `${prefix}-lobby`, stats);
        await page.locator('#race-ready').tap();
        await waitRace(page, race => race.startTick !== null && race.tick >= race.startTick - 50, 'the last light');
        await shoot(page, options.out, `${prefix}-countdown`, stats, true);
        await waitRace(page, race => race.phase === 'racing' && race.tick > (race.startTick ?? 0) + 150, 'the race');
        await shoot(page, options.out, `${prefix}-race`, stats, true);
        await page.context().close();
    }
}

// The main menu over its showroom (docs/ui.md 4): desktop, phone upright and
// sideways (views menu, menu-phone, menu-landscape), and the showroom
// frame alone (showroom, the menu hidden) for the draw call budget: the
// menu draws while the last assets load
async function captureMenu(browser: Browser, baseURL: string, options: Options, stats: ShotStats[]): Promise<void> {
    const want = (view: string) => !options.only || options.only.includes(view);
    const iphone = devices['iPhone 13'];
    const setups: Array<[string, BrowserContextOptions]> = [
        ['menu', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
        ['menu-phone', iphone],
        ['menu-landscape', devices['iPhone SE landscape']]
    ];
    for (const [name, contextOptions] of setups) {
        const views = name === 'menu' ? [name, 'showroom'] : [name];
        if (!views.some(want)) continue;
        const context = await browser.newContext({ ...contextOptions, baseURL, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.on('pageerror', error => log(`page error: ${error.message}`));
        await page.addInitScript(() => {
            localStorage.setItem('bulli-car-type', 'bulli');
            localStorage.setItem('bulli-paint', 'sea');
        });
        await page.goto('/?e2e=1');
        await page.locator('#loading-screen').waitFor({ state: 'detached', timeout: 90_000 });
        await settle(page, 1500);
        if (want(name)) await shoot(page, options.out, name, stats);
        if (views.includes('showroom') && want('showroom')) {
            await page.addStyleTag({ content: '#splash-screen { visibility: hidden !important; }' });
            await settle(page, 500);
            await shoot(page, options.out, 'showroom', stats);
        }
        await context.close();
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
        await captureMenu(browser, baseURL, options, stats);
        await captureDesktop(browser, baseURL, options, stats);
        await captureMobile(browser, baseURL, options, stats);
        await captureRace(browser, baseURL, options, stats);
        const summary = { date: new Date().toISOString(), renderer, shots: stats };
        fs.writeFileSync(path.join(options.out, 'stats.json'), JSON.stringify(summary, null, 2) + '\n');
        log(`wrote ${stats.length} screenshots to ${options.out}`);
        // Only a warning: the views and the GPU decide, not a test runner
        if (overBudget.length) log(`WARNING: ${overBudget.length} views above their tier's budget:\n  ${overBudget.join('\n  ')}`);
        else log('every view within its tier\'s budget of draw calls and triangles');
    } finally {
        await browser?.close();
        server.kill();
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
});
