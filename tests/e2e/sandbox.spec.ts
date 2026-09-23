import type { Page } from '@playwright/test';
import type { SandboxDummySnapshot } from '../../src/client/sandbox/sandbox.js';
import { test, expect, snapshot, v2, distance, openSandbox } from './fixtures.js';

// The offline v2 sandbox (?sandbox=1) and the tuning panel (?tune=1),
// docs/phase-1a-design.md 12.7 and 13.

interface SimHook {
    dummies(): SandboxDummySnapshot[];
    resetDummies(): void;
}

function dummies(page: Page): Promise<SandboxDummySnapshot[]> {
    return page.evaluate(() => (window as unknown as { __bulliSim: SimHook }).__bulliSim.dummies());
}

async function dummy(page: Page, id: string): Promise<SandboxDummySnapshot> {
    const found = (await dummies(page)).find(candidate => candidate.id === id);
    expect(found, id).toBeTruthy();
    return found!;
}

// Text of the panel's input fields (read-only values like the golden status)
function panelValues(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('#tuning-panel input')].map(input => input.value));
}

test('the sandbox runs offline with dummy cars that move when rammed', async ({ openPlayer }) => {
    const player = await openPlayer('sandbox');
    const { page } = player;
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await openSandbox(player);

    // v2 physics without a server: no WebSocket at all
    const state = await snapshot(page);
    expect(state.physics).toBe('v2');
    expect(state.connected).toBe(false);
    expect(player.sentMessages).toEqual([]);
    await expect(page.locator('#sandbox-banner')).toBeVisible();
    await expect(page.locator('#map-panel')).toBeHidden();
    // The panel and lil-gui stay out of the page without ?tune=1
    expect(requests.filter(url => /tuningPanel|lil-gui/.test(url))).toEqual([]);
    await expect(page.locator('#tuning-panel')).toHaveCount(0);

    // Five dummies of five bodies; the lapping ones are under way
    const all = await dummies(page);
    expect(all.length).toBe(5);
    expect(new Set(all.map(entry => entry.classId)).size).toBe(5);
    await expect.poll(async () => (await dummy(page, 'dummy-sport')).speed).toBeGreaterThan(5);

    // Put the car 25 m west of the parked beetle, facing it, and drive in
    const target = await dummy(page, 'dummy-beetle');
    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, Math.PI / 2), { x: target.x - 25, z: target.z });
    await expect.poll(async () => distance({ x: target.x - 25, z: target.z }, (await v2(page)))).toBeLessThan(0.01);
    await page.keyboard.down('w');
    await expect.poll(async () => distance(target, await dummy(page, 'dummy-beetle')), { timeout: 20_000 }).toBeGreaterThan(1.5);
    await page.keyboard.up('w');
    const hit = await dummy(page, 'dummy-beetle');
    // Pushed forward (+x), along the ram
    expect(hit.x).toBeGreaterThan(target.x + 1);

    // N puts the dummies back. The own car is still rolling right behind the
    // beetle, so move it off first: on the beetle's spot it would push the
    // beetle away again with the next tick
    await page.evaluate(({ x, z }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, Math.PI / 2), { x: target.x - 25, z: target.z });
    await page.keyboard.press('n');
    await expect.poll(async () => distance(target, await dummy(page, 'dummy-beetle'))).toBeLessThan(0.01);
    // and it stays there once ticks have run
    await page.waitForTimeout(500);
    expect(distance(target, await dummy(page, 'dummy-beetle'))).toBeLessThan(0.01);

    // C switches the body; the sim car follows with the next frame
    const classBefore = (await v2(page)).classId;
    await page.keyboard.press('c');
    await expect.poll(async () => (await v2(page)).classId).not.toBe(classBefore);
});

test('the tuning panel shows live telemetry and changes the sim', async ({ openPlayer }) => {
    const player = await openPlayer('sandbox-tune');
    const { page } = player;
    await openSandbox(player, '&tune=1');

    const panel = page.locator('#tuning-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Telemetrie');
    await expect(panel).toContainText('Verlauf 5 s');
    await expect(panel.locator('canvas.tuning-graph')).toBeVisible();

    // Driving shows up in the telemetry
    await page.keyboard.down('w');
    await expect.poll(() => page.evaluate(() => (window as unknown as {
        __bulliTune: { telemetry: { kmh: number } };
    }).__bulliTune.telemetry.kmh)).toBeGreaterThan(20);
    await page.keyboard.up('w');
    await expect(panel).toContainText('km/h');

    // An imported value reaches the local car's sim params, reset undoes it
    const before = await v2(page);
    const exported = await page.evaluate((id) => {
        const tune = (window as unknown as {
            __bulliTune: { import(json: string): void; export(): string };
        }).__bulliTune;
        tune.import(JSON.stringify({ format: 1, global: { gripScale: 1.3 }, classes: { [id]: { topSpeed: 61 } } }));
        return JSON.parse(tune.export());
    }, before.classId);
    expect(exported.global).toEqual({ gripScale: 1.3 });
    expect(exported.classes[before.classId]).toEqual({ topSpeed: 61 });
    await expect.poll(async () => (await v2(page)).topSpeed).toBe(61);
    await expect.poll(() => panelValues(page)).toContain('nein (geändert)');
    await page.evaluate(() => (window as unknown as { __bulliTune: { reset(): void } }).__bulliTune.reset());
    await expect.poll(async () => (await v2(page)).topSpeed).toBe(before.topSpeed);
    await expect.poll(() => panelValues(page)).toContain('ja (Defaults)');
});
