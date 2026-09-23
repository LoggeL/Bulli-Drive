import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioFrame } from '../../src/shared/sim/scenarios.js';
import { goldenMismatches } from '../shared/sim/goldenCompare.js';
import { test, expect } from './fixtures.js';

// The golden scenarios of the v2 sim, run in the browser's engine through
// the sandbox hook (docs/phase-1a-design.md, 14.4), compared like in Node
// (tests/shared/sim/golden.test.ts): Math.sin & co. may differ in the last
// bit between engines, so within tests/shared/sim/goldenCompare.ts's
// tolerance, counters and flags exactly.

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/sim/golden');

test('the golden scenarios match in the browser', async ({ openPlayer }) => {
    const { page } = await openPlayer('sim-golden');
    await page.goto('/?e2e=1&sandbox=1');
    await expect.poll(() => page.evaluate(() => 'runGolden' in ((window as unknown as { __bulliSim?: object }).__bulliSim ?? {})),
        { timeout: 60_000 }).toBe(true);

    const names = await page.evaluate(() => (window as unknown as { __bulliSim: { scenarios(): string[] } }).__bulliSim.scenarios());
    const files = readdirSync(GOLDEN_DIR).filter(file => file.endsWith('.json')).map(file => file.replace(/\.json$/, ''));
    expect([...names].sort()).toEqual([...files].sort());

    for (const name of names) {
        const golden = JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as { frames: ScenarioFrame[] };
        const frames = await page.evaluate(scenario => (window as unknown as {
            __bulliSim: { runGolden(name: string): ScenarioFrame[] };
        }).__bulliSim.runGolden(scenario), name);
        expect(goldenMismatches(frames, golden.frames), name).toEqual([]);
    }
});
