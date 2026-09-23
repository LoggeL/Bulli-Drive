import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIM_TUNING } from '../../../src/shared/sim/constants.js';
import { findScenario, recordScenario, SIM_SCENARIOS, tuningIsDefault, type ScenarioFrame } from '../../../src/shared/sim/scenarios.js';
import { goldenMismatches } from './goldenCompare.js';
import { restoreTuningAfterEach } from './helpers.js';

// Golden scenarios (docs/phase-1a-design.md, 14.4): the state of every car
// after every 30 ticks. A deliberate change to the sim or its tuning
// regenerates them with `UPDATE_GOLDEN=1 npm test`, so the diff shows up in
// the commit. The comparison allows for last-bit differences of Math.sin & co.
// between platforms (goldenCompare.ts, scripts/sim-golden-drift.ts).

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
const update = process.env.UPDATE_GOLDEN === '1';

function readGolden(name: string): ScenarioFrame[] {
    return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')).frames;
}

// Goldens hold what JSON keeps of a run (no -0, no undefined)
function asJson(frames: ScenarioFrame[]): ScenarioFrame[] {
    return JSON.parse(JSON.stringify(frames));
}

describe('v2 golden scenarios', () => {
    restoreTuningAfterEach();

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
            expect(goldenMismatches(asJson(frames), readGolden(scenario.name))).toEqual([]);
        });
    }

    it('still catches a tuning change of one in a million', () => {
        // The tolerance only hides rounding noise: 1e-6 on the tyre load
        // moves the accel run by about 1e-4 (scripts/sim-golden-drift.ts)
        SIM_TUNING.G_TIRE *= 1 + 1e-6;
        const frames = asJson(recordScenario(findScenario('accel-grip-bulli')));
        expect(goldenMismatches(frames, readGolden('accel-grip-bulli')).length).toBeGreaterThan(0);
    });
});
