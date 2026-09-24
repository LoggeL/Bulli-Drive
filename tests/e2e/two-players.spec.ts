import type { Page } from '@playwright/test';
import { test, expect, joinGame, snapshot, distance, placeOnClearRunway, netState, debugCall } from './fixtures.js';
import type { CarInfo } from '../../src/client/e2eHook.js';
import { CAR_IDLE, CAR_LAGGY } from '../../src/shared/net/codec.js';
import { LAGGY_WINDOW_TICKS } from '../../src/shared/net/constants.js';

// Two players see each other, a head-on ram shows on both screens, and a
// player who closes the tab disappears for the other
// (docs/phase-1b-design.md, 15.3): both choose Free Roam on the splash
// screen, the test hook puts the cars 20 m apart facing each other, Alice
// drives into Bob, who stands. The server simulates both cars (5); Alice
// predicts Bob along in her contact set (8.5). Alice's car slows, Bob's car
// is knocked back, on his own screen and on hers. The same bump behind the
// exit criterion's netsim (150/30/3) runs headless in
// tests/integration/bots.test.ts and in the harness of
// tests/shared/net/reconcile.test.ts.

test.use({ viewport: { width: 800, height: 500 } });

interface Frame {
    t: number;
    // Own sim car: forward speed and position
    u: number;
    x: number;
    z: number;
    // The other car as this page shows it
    ox: number | null;
    oz: number | null;
    flags: number;
    // Remote cars in the own prediction (the contact set)
    proxies: number;
}

async function place(page: Page, x: number, z: number, angle: number) {
    await page.evaluate(({ x, z, angle }) => (window as unknown as {
        __bulliDebug: { placeLocalCar(x: number, z: number, angle: number): void };
    }).__bulliDebug.placeLocalCar(x, z, angle), { x, z, angle });
}

// Records every frame of the page until stopRecording
async function startRecording(page: Page, otherId: string) {
    await page.evaluate((otherId) => {
        const w = window as unknown as {
            __bulliDebug: { snapshot(): { v2: { u: number; x: number; z: number; proxies: number } | null; remotes: Record<string, { x: number; z: number }> } };
            __bulliNet: { snapshot(): { selfFlags: number; remoteFlags: Record<string, number> } };
            __bump: { frames: Frame[]; stop: boolean };
        };
        const rec = { frames: [] as Frame[], stop: false };
        w.__bump = rec;
        const loop = () => {
            const view = w.__bulliDebug.snapshot();
            const net = w.__bulliNet.snapshot();
            const other = view.remotes[otherId];
            if (view.v2) {
                rec.frames.push({
                    t: performance.now(), u: view.v2.u, x: view.v2.x, z: view.v2.z,
                    ox: other ? other.x : null, oz: other ? other.z : null,
                    flags: net.selfFlags | (net.remoteFlags[otherId] ?? 0),
                    proxies: view.v2.proxies
                });
            }
            if (!rec.stop && rec.frames.length < 5000) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }, otherId);
}

async function stopRecording(page: Page): Promise<Frame[]> {
    return page.evaluate(() => {
        const rec = (window as unknown as { __bump: { frames: Frame[]; stop: boolean } }).__bump;
        rec.stop = true;
        return rec.frames;
    });
}

// Both cars solid, and neither page missed an input for a whole lag
// window of the server (LAGGY_WINDOW_TICKS of sim ticks): the misses of the
// joins (a page building its world stalls the other one) would otherwise
// still count and turn the next hitch into a lag ghost mid-ram
async function waitUntilSolid(pages: Page[]) {
    const quiet = pages.map(() => ({ since: -1, missed: -1 }));
    const settled = await expect.poll(async () => {
        const nets = await Promise.all(pages.map(page => netState(page)));
        return nets.every((net, i) => {
            if (net.stats.missedInputs !== quiet[i].missed) quiet[i] = { since: net.tick, missed: net.stats.missedInputs };
            return (net.selfFlags & (CAR_IDLE | CAR_LAGGY)) === 0 && net.tick - quiet[i].since >= LAGGY_WINDOW_TICKS;
        });
    }, { timeout: 30_000 }).toBe(true).then(() => true, () => false);
    if (settled) return;
    // Why a car stays a ghost (a stalled page, lost inputs, a hidden tab)
    const why = await Promise.all(pages.map(async page => {
        const net = await netState(page);
        const hidden = await page.evaluate(() => document.hidden);
        return { selfFlags: net.selfFlags, lead: net.lead, leadTicks: net.leadTicks, rtt: net.rtt, suspended: net.suspended, overlay: net.overlay, hidden, stats: net.stats };
    }));
    throw new Error(`a car stayed a ghost or kept missing inputs for 30 s: ${JSON.stringify(why)}`);
}

test('two players see each other, and a head-on ram shows on both screens', async ({ openPlayer }) => {
    // Both pages draw only 2 frames a second (flags.ts), while the game,
    // the netcode and the HUD run every frame: two pages drawing with
    // software WebGL on one CI runner fell to 2 to 3 frames a second,
    // their inputs came in bursts and the server made both cars lag
    // ghosts in every attempt.
    const query = '&drawfps=2';
    const alice = await openPlayer('alice-ram');
    const bob = await openPlayer('bob-ram');
    // Free Roam from the splash screen: no powerup on the runway can
    // make a car a ghost
    const aliceId = await joinGame(alice, 'E2E Alice Ram', query, 'freeroam');
    const bobId = await joinGame(bob, 'E2E Bob Ram', query, 'freeroam');
    // The server put the page into the Party first; the switch went
    // out before the car was asked for
    const types = alice.sentMessages.map(message => message.type);
    expect(types.indexOf('joinRoom')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('joinRoom')).toBeLessThan(types.indexOf('ready'));
    // They see each other, with nametags, Bob as a GLB model on Alice's screen
    await expect.poll(async () => (await snapshot(alice.page)).remotes[bobId]?.name).toBe('E2E Bob Ram');
    await expect.poll(async () => (await snapshot(bob.page)).remotes[aliceId]?.name).toBe('E2E Alice Ram');
    await expect.poll(async () => (await debugCall<CarInfo[]>(alice.page, 'carModels')).some(car => !car.local && car.gltf)).toBe(true);

    const runway = await placeOnClearRunway(alice.page);
    const aliceStart = { x: runway.x, z: runway.z };
    const bobStart = { x: runway.x, z: runway.z + 20 };
    let result: { alice: Frame[]; bob: Frame[] } | null = null;
    // A run in which a stalled page turned into a lag ghost on the way
    // (the server lets ghosts drive through) is driven again
    for (let attempt = 0; attempt < 3; attempt++) {
        // Both cars at rest first: with ?netsim the lead is high, and
        // inputs already on their way would move a car placed while it
        // still rolls
        await expect.poll(async () => Math.abs((await snapshot(alice.page)).v2!.u), { timeout: 20_000 }).toBeLessThan(0.05);
        await expect.poll(async () => Math.abs((await snapshot(bob.page)).v2!.u), { timeout: 20_000 }).toBeLessThan(0.05);
        await place(alice.page, aliceStart.x, aliceStart.z, 0);
        await place(bob.page, bobStart.x, bobStart.z, Math.PI);
        await expect.poll(async () => distance(aliceStart, (await snapshot(alice.page)).v2!)).toBeLessThan(0.1);
        await expect.poll(async () => distance(bobStart, (await snapshot(bob.page)).v2!)).toBeLessThan(0.1);
        await expect.poll(async () => distance(bobStart, (await snapshot(alice.page)).remotes[bobId])).toBeLessThan(0.1);
        await expect.poll(async () => distance(aliceStart, (await snapshot(bob.page)).remotes[aliceId])).toBeLessThan(0.1);
        await waitUntilSolid([alice.page, bob.page]);

        await startRecording(alice.page, bobId);
        await startRecording(bob.page, aliceId);
        await alice.page.keyboard.down('w');
        // Until Alice's recording holds the bump on her screen and most
        // of a second after it, or she drove through a ghost
        await expect.poll(() => alice.page.evaluate(({ bobStart }) => {
            const frames = (window as unknown as { __bump: { frames: Frame[] } }).__bump.frames;
            const hit = frames.findIndex(f => f.ox !== null && Math.hypot(f.ox - bobStart.x, f.oz! - bobStart.z) > 0.5);
            const last = frames[frames.length - 1];
            return (hit >= 0 && last.t - frames[hit].t > 800) || (!!last && last.z > bobStart.z + 3);
        }, { bobStart }), { timeout: 30_000 }).toBe(true);
        // and Bob's screen shows it too (unless a ghost let her through)
        const bobPushed = await expect.poll(async () => distance(bobStart, (await snapshot(bob.page)).v2!), { timeout: 10_000 })
            .toBeGreaterThan(1).then(() => true, () => false);
        await alice.page.keyboard.up('w');
        const frames = { alice: await stopRecording(alice.page), bob: await stopRecording(bob.page) };
        const ghostFlags = (list: Frame[]) => list.reduce((bits, f) => bits | (f.flags & (CAR_IDLE | CAR_LAGGY)), 0);
        const ghost = (ghostFlags(frames.alice) | ghostFlags(frames.bob)) !== 0;
        test.info().annotations.push({
            type: 'ram',
            description: `attempt ${attempt + 1}: ${frames.alice.length}/${frames.bob.length} frames, ghost flags ${ghostFlags(frames.alice)}/${ghostFlags(frames.bob)}`
        });
        if (!ghost) {
            expect(bobPushed, 'Bob was not pushed on his own screen').toBe(true);
            result = frames;
            break;
        }
    }
    expect(result, 'a car was an idle or lag ghost in every attempt').not.toBeNull();
    const { alice: a, bob: b } = result!;

    // Bob's screen: his car stood and was knocked back towards +z
    const bobMoved = b.findIndex(f => distance(bobStart, f) > 0.5);
    expect(bobMoved).toBeGreaterThan(0);
    expect(Math.abs(b[0].u)).toBeLessThan(0.5);
    const bobTop = Math.max(...b.slice(bobMoved).map(f => Math.abs(f.u)));
    expect(bobTop).toBeGreaterThan(2);
    expect(b.at(-1)!.z - bobStart.z).toBeGreaterThan(1);

    // Alice's screen: Bob's car moved the same way, and hers slowed down
    const hit = a.findIndex(f => f.ox !== null && distance(bobStart, { x: f.ox, z: f.oz! }) > 0.5);
    expect(hit, 'Alice never saw Bob move').toBeGreaterThan(0);
    const last = a.at(-1)!;
    expect(last.oz! - bobStart.z).toBeGreaterThan(1);
    const aliceTop = Math.max(...a.slice(0, hit + 1).map(f => f.u));
    expect(aliceTop).toBeGreaterThan(6);
    // From the frame that first shows Bob moving on: with few frames a
    // second (CI) that same frame already holds her slowdown
    const after = a.filter(f => f.t >= a[hit].t && f.t < a[hit].t + 700);
    expect(Math.min(...after.map(f => f.u))).toBeLessThan(aliceTop * 0.75);
    // The cars touched but did not drive through each other on her
    // screen, and Bob was in her contact set while they were close
    const closest = Math.min(...a.filter(f => f.ox !== null).map(f => Math.hypot(f.x - f.ox!, f.z - f.oz!)));
    expect(closest).toBeGreaterThan(1.5);
    expect(Math.max(...a.map(f => f.proxies))).toBe(1);

    // Both views of Bob agree again once the cars stand
    await expect.poll(async () => {
        const [aliceView, bobView] = await Promise.all([snapshot(alice.page), snapshot(bob.page)]);
        return distance(bobView.v2!, aliceView.remotes[bobId]);
    }, { timeout: 30_000 }).toBeLessThan(0.5);

    // Bob closes his tab: once the server lets his session go (grace time
    // of the e2e server, 3 s) his car and his nametag leave Alice's screen
    // instead of standing there frozen
    await expect(alice.page.locator('.nametag-name', { hasText: 'E2E Bob Ram' })).toHaveCount(1);
    await bob.page.close();
    await expect.poll(async () => (await snapshot(alice.page)).remotes[bobId], { timeout: 20_000 }).toBeUndefined();
    await expect(alice.page.locator('.nametag-name', { hasText: 'E2E Bob Ram' })).toHaveCount(0);
});
