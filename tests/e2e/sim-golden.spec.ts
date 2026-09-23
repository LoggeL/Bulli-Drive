import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioFrame } from '../../src/shared/sim/scenarios.js';
import { test, expect } from './fixtures.js';

// The golden scenarios of the v2 sim, run in the browser's engine through
// the sandbox hook (docs/phase-1a-design.md, 14.4). Node compares them
// exactly (tests/shared/sim/golden.test.ts); here they only have to agree
// within 1 mm and 1e-4 rad, since Math.sin & co. may differ in the last bit
// between engines.

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/sim/golden');
const ANGLES = new Set(['yaw', 'yawRate', 'steerAngle', 'betaPrev', 'flipAngle', 'flipRate']);

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
        expect(frames.length, name).toBe(golden.frames.length);
        frames.forEach((frame, index) => {
            const expected = golden.frames[index];
            expect(frame.tick, name).toBe(expected.tick);
            for (const [carId, carState] of Object.entries(expected.cars)) {
                const actual = frame.cars[carId] as unknown as Record<string, number | boolean>;
                for (const [field, value] of Object.entries(carState as unknown as Record<string, number | boolean>)) {
                    const where = `${name} tick ${frame.tick} ${carId}.${field}`;
                    if (typeof value === 'number') {
                        expect(Math.abs((actual[field] as number) - value), where).toBeLessThanOrEqual(ANGLES.has(field) ? 1e-4 : 1e-3);
                    } else {
                        expect(actual[field], where).toBe(value);
                    }
                }
            }
        });
    }
});
