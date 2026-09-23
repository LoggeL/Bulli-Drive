import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIM_TUNING, SIM_TUNING_DEFAULTS } from '../../../src/shared/sim/constants.js';
import { findScenario, recordScenario, SIM_SCENARIOS, tuningIsDefault, type ScenarioFrame } from '../../../src/shared/sim/scenarios.js';
import { classDefaults, PROFILE_IDS, profileDefaults } from '../../../src/shared/sim/tuning.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { goldenMismatches } from './goldenCompare.js';
import { restoreTuningAfterEach } from './helpers.js';

// Golden scenarios (docs/phase-1a-design.md, 14.4): the state of every car
// after every 30 ticks. A deliberate change to the sim or its tuning
// regenerates them with `UPDATE_GOLDEN=1 npm test`, so the diff shows up in
// the commit. The comparison allows for last-bit differences of Math.sin & co.
// between platforms (goldenCompare.ts, scripts/sim-golden-drift.ts).
//
// The scenarios only see the values their scripts reach (no off-road yet,
// jumps by button only for the jeep, a few thresholds), so the shipped
// tuning itself is a golden as well: every value of SIM_TUNING, the classes
// and the assist profiles. Any change to one of them needs UPDATE_GOLDEN=1.

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
// Outside GOLDEN_DIR, which holds exactly one file per scenario
// (tests/e2e/sim-golden.spec.ts)
const TUNING_GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden-tuning.json');
const update = process.env.UPDATE_GOLDEN === '1';

function readGolden(name: string): ScenarioFrame[] {
    return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')).frames;
}

// The shipped defaults, angles in radians as the sim uses them
function shippedTuning(): object {
    return {
        global: SIM_TUNING_DEFAULTS,
        classes: Object.fromEntries(CAR_CLASS_IDS.map(id => [id, classDefaults(id)])),
        profiles: Object.fromEntries(PROFILE_IDS.map(id => [id, profileDefaults(id)]))
    };
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

    it('ships the tuning of its golden record', () => {
        // Exact: the values are plain decimals and products with DEG, no
        // transcendental functions
        const tuning = JSON.parse(JSON.stringify(shippedTuning()));
        if (update) writeFileSync(TUNING_GOLDEN, JSON.stringify(tuning, null, 2) + '\n');
        expect(existsSync(TUNING_GOLDEN), `missing ${TUNING_GOLDEN}; create it with UPDATE_GOLDEN=1 npm test`).toBe(true);
        expect(tuning).toEqual(JSON.parse(readFileSync(TUNING_GOLDEN, 'utf8')));
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

    it('catches a tyre-load change of one in a million in a scenario', () => {
        // The tolerance only hides rounding noise: 1e-6 on the tyre load
        // moves the accel run by about 1e-4 (scripts/sim-golden-drift.ts)
        SIM_TUNING.G_TIRE *= 1 + 1e-6;
        const frames = asJson(recordScenario(findScenario('accel-grip-bulli')));
        expect(goldenMismatches(frames, readGolden('accel-grip-bulli')).length).toBeGreaterThan(0);
    });
});
