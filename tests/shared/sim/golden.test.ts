import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordScenario, SIM_SCENARIOS, tuningIsDefault } from '../../../src/shared/sim/scenarios.js';

// Golden scenarios (docs/phase-1a-design.md, 14.4): the state of every car
// after every 30 ticks, compared exactly. A deliberate change to the sim or
// its tuning regenerates them with `UPDATE_GOLDEN=1 npm test`, so the diff
// shows up in the commit.

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
const update = process.env.UPDATE_GOLDEN === '1';

describe('v2 golden scenarios', () => {
    it('runs with the shipped tuning', () => {
        expect(tuningIsDefault()).toBe(true);
    });

    for (const scenario of SIM_SCENARIOS) {
        it(`${scenario.name} matches its golden record`, () => {
            const file = path.join(GOLDEN_DIR, `${scenario.name}.json`);
            const frames = recordScenario(scenario);
            if (update) {
                mkdirSync(GOLDEN_DIR, { recursive: true });
                writeFileSync(file, JSON.stringify({ scenario: scenario.name, frames }, null, 2) + '\n');
            }
            expect(existsSync(file), `missing ${file}; create it with UPDATE_GOLDEN=1 npm test`).toBe(true);
            const golden = JSON.parse(readFileSync(file, 'utf8'));
            expect(golden.frames).toStrictEqual(JSON.parse(JSON.stringify(frames)));
        });
    }
});
