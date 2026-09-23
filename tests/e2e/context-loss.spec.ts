import { test, expect, joinGame, snapshot } from './fixtures.js';

type LoseContextWindow = Window & { __loseContext?: WEBGL_lose_context };

test('pauses on a lost WebGL context and resumes once it is restored', async ({ openPlayer }) => {
    const player = await openPlayer('context-loss');
    const { page } = player;
    await joinGame(player, 'E2E GPU Reset');

    const notice = page.locator('#context-lost');
    await expect(notice).toHaveCount(0);
    const before = (await snapshot(page)).render.frame;
    await expect.poll(async () => (await snapshot(page)).render.frame).toBeGreaterThan(before + 2);

    // Simulate a GPU reset. The extension has to be fetched before the loss.
    await page.evaluate(() => {
        const canvas = document.querySelector('body > canvas') as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const ext = gl!.getExtension('WEBGL_lose_context')!;
        (window as LoseContextWindow).__loseContext = ext;
        ext.loseContext();
    });

    await expect(notice).toBeVisible();
    await expect(notice.getByRole('heading')).toHaveText('Graphics paused');
    const reload = notice.getByRole('button', { name: 'Reload game' });
    await expect(reload).toBeHidden();

    // Nothing is rendered while the context is gone.
    const pausedAt = (await snapshot(page)).render.frame;
    await page.waitForTimeout(500);
    expect((await snapshot(page)).render.frame).toBe(pausedAt);

    // A reload is offered if the context stays away for a few seconds.
    await expect(reload).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => (window as LoseContextWindow).__loseContext!.restoreContext());

    // three.js rebuilds its GL state, the notice goes away and the full scene
    // is drawn again. It also starts fresh info counters on the restored
    // context (the frame count drops below pausedAt), so count from here on.
    await expect(notice).toBeHidden();
    const restoredAt = (await snapshot(page)).render.frame;
    await expect.poll(async () => (await snapshot(page)).render.frame).toBeGreaterThan(restoredAt + 5);
    await expect.poll(async () => (await snapshot(page)).render.calls).toBeGreaterThan(10);
    expect((await snapshot(page)).connected).toBe(true);
});
