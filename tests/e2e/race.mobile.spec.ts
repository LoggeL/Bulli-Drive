import type { Page } from '@playwright/test';
import type { RaceDebugSnapshot } from '../../src/client/e2eHook.js';
import { mapFor } from '../../src/server/maps.js';
import { createProjection, pointAt } from '../../src/shared/race/geometry.js';
import { createCourse } from '../../src/shared/race/progress.js';
import { racingLine } from '../../src/shared/race/racingLine.js';
import { trackDef } from '../../src/shared/race/tracks/index.js';
import { test, expect, FLOW_DRAW_FPS, openGame, joinFromSplash, debugCall } from './fixtures.js';

// The race on a phone (docs/phase-2-design.md, 20.3), the one E2E test of
// phase 2, in the "mobile" project (touch; the keyboard drives the same
// UI in the desktop tests): RACE on the splash, the lobby with the Hill
// Sprint and READY, the countdown with its lights and the GO zone, then
// GO! (auto-gas starts one tick after green). The test hook puts the car
// 20 m before the finish (the server counts the gates before it as
// passed, E2E only), auto-gas drives it over the line: position, time,
// FINISH, the results with the own name, REMATCH and the next race on the
// same track. Everything behind it (the rules, the views, the taps) is
// tested on its own level: tests/client/raceModel.test.ts, raceUi.test.ts,
// input.test.ts, tests/server/raceRoom.test.ts and the bot race in
// tests/integration/race.test.ts; the way out of a room by the room chip
// in mobile.spec.ts (the E2E job stays under 5 min, CLAUDE.md).

// 20 m before the Ridge Climb's finish gate on its racing line (past the
// crest ramp before it), facing along it
const BEFORE_FINISH = (() => {
    const track = trackDef(mapFor(), 'hill-sprint');
    const line = racingLine(track);
    const p = pointAt(line, createCourse(track, line).gateS.at(-1)! - 20, createProjection());
    return { x: p.x, z: p.z, yaw: Math.atan2(p.tx, p.tz) };
})();

function race(page: Page): Promise<RaceDebugSnapshot | null> {
    return debugCall<RaceDebugSnapshot | null>(page, 'race');
}

test('a race on the phone: splash, lobby, countdown, over the finish line, results, rematch', async ({ openPlayer }) => {
    const player = await openPlayer('racer');
    const { page } = player;

    // ---- Splash: RACE ----
    await openGame(player, FLOW_DRAW_FPS);
    const raceOption = page.locator('.mode-option[data-room="race"]');
    expect((await raceOption.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const id = await joinFromSplash(player, 'E2E Racer', 'race');

    // ---- Lobby: the Hill Sprint, READY ----
    const lobby = page.locator('#race-lobby');
    await expect(lobby).toBeVisible();
    await expect(page.locator('#race-drivers')).toContainText('E2E Racer');
    await page.locator('#race-lobby [data-track="hill-sprint"]').tap();
    await expect.poll(async () => (await race(page))?.trackId).toBe('hill-sprint');
    await expect(page.locator('#race-lobby [data-track="hill-sprint"]')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#race-ready').tap();

    // ---- Countdown: lights and the GO zone, then GO! ----
    const countdown = page.locator('#race-countdown');
    await expect(countdown).toBeVisible();
    await expect(lobby).toBeHidden();
    await expect(page.locator('.race-lights span.on').first()).toBeVisible();
    await expect(page.locator('#race-go')).toBeVisible();
    const start = await race(page);
    expect(start!.phase).toBe('countdown');
    // The own car and the bots that filled the grid up to six
    expect(start!.racers).toHaveLength(6);
    expect(start!.racers.find(r => r.id === id)).toMatchObject({ grid: 0, bot: false });
    await expect(page.locator('#race-count-label')).toHaveText('GO!');
    await expect(page.locator('#race-go')).toBeHidden();

    // ---- Racing: the HUD, then the car put before the finish ----
    await expect(page.locator('#race-pos')).toHaveText(/^P[1-6]\/6$/);
    await expect(page.locator('#race-time')).toHaveText(/^0:0\d\.\d{3}$/);
    await expect.poll(async () => {
        const now = await race(page);
        return now!.phase === 'racing' && now!.tick > now!.startTick! + 30;
    }).toBe(true);
    await debugCall(page, 'placeLocalCar', BEFORE_FINISH.x, BEFORE_FINISH.z, BEFORE_FINISH.yaw);

    // ---- Finish: banner, then the results with the own name ----
    await expect(page.locator('#race-banner')).toContainText('FINISH');
    await expect.poll(async () => (await race(page))?.finish?.pos).toBeGreaterThanOrEqual(1);
    const results = page.locator('#race-results');
    await expect(results).toBeVisible();
    await expect(page.locator('#race-table tr.self')).toContainText('E2E Racer');
    await expect(page.locator('#race-next-track')).toBeVisible();
    const done = await race(page);
    expect(done!.results!.find(e => e.id === id)).toMatchObject({ status: 'finished', name: 'E2E Racer' });

    // ---- REMATCH: the lobby, and the voter is ready: the next countdown on the same track ----
    await page.locator('#race-rematch').tap();
    await expect(results).toBeHidden();
    await expect.poll(async () => {
        const next = await race(page);
        return next && next.startTick !== null && next.startTick > done!.startTick! ? next.trackId : null;
    }).toBe('hill-sprint');
});
