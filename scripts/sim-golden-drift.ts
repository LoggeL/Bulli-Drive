// How far the v2 golden scenarios drift when Math.sin & co. round
// differently in the last bit, the way they may between V8 versions and
// between macOS arm64 and Linux x64. Nudges the inexact results of the
// transcendental functions by a few ulp, reruns every golden scenario and
// prints the largest deviation from the stored goldens. Then the other side:
// how far a change of one in a million in each SIM_TUNING value moves them.
// tests/shared/sim/goldenCompare.ts takes its tolerance from these numbers
// (docs/phase-1a-design.md, 24.2).
//
//   npx tsx scripts/sim-golden-drift.ts

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_TUNING, SIM_TUNING_DEFAULTS } from '../src/shared/sim/constants.js';
import { recordScenario, SIM_SCENARIOS, type ScenarioFrame } from '../src/shared/sim/scenarios.js';
import { GOLDEN_TOLERANCE } from '../tests/shared/sim/goldenCompare.js';

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/shared/sim/golden');
const PATCHED = ['sin', 'cos', 'tan', 'atan2', 'exp', 'pow', 'hypot'] as const;

const buffer = new Float64Array(1);
const bits = new BigInt64Array(buffer.buffer);

// |direction| ulps towards +inf (direction > 0) or -inf (< 0)
function nudge(value: number, direction: number): number {
    buffer[0] = value;
    bits[0] += BigInt(value > 0 === direction > 0 ? Math.abs(direction) : -Math.abs(direction));
    return buffer[0];
}

// Small deterministic generator, so every run of the script is the same
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

type Mode = { name: string; pick: () => number };

const original = Object.fromEntries(PATCHED.map(name => [name, Math[name]])) as Record<(typeof PATCHED)[number], (...args: number[]) => number>;

function withNudgedMath<T>(mode: Mode, run: () => T): T {
    for (const name of PATCHED) {
        const fn = original[name];
        (Math as unknown as Record<string, unknown>)[name] = (...args: number[]) => {
            const result = fn(...args);
            // Exact results (0, ±1, integer powers, ...) are the same on every
            // platform; only inexact ones may differ in the last bit.
            if (!Number.isFinite(result) || result === 0 || Number.isInteger(result)) return result;
            const direction = mode.pick();
            return direction === 0 ? result : nudge(result, direction);
        };
    }
    try {
        return run();
    } finally {
        for (const name of PATCHED) (Math as unknown as Record<string, unknown>)[name] = original[name];
    }
}

interface Drift {
    // Largest |actual - golden| per field class, and where it happened
    abs: number;
    where: string;
    // Largest |actual - golden| / max(1, |golden|)
    scaled: number;
    discrete: string[];
}

const ANGLES = new Set(['yaw', 'yawRate', 'steerAngle', 'betaPrev', 'flipAngle', 'flipRate']);

function compare(name: string, frames: ScenarioFrame[], golden: ScenarioFrame[], drift: Drift): void {
    frames.forEach((frame, index) => {
        for (const [carId, expected] of Object.entries(golden[index].cars)) {
            const actual = frame.cars[carId] as unknown as Record<string, number | boolean>;
            for (const [field, value] of Object.entries(expected as unknown as Record<string, number | boolean>)) {
                const got = actual[field];
                if (typeof value !== 'number' || Number.isInteger(value) && Number.isInteger(got) && !ANGLES.has(field) && field !== 'x' && field !== 'z') {
                    if (got !== value) drift.discrete.push(`${name} t${frame.tick} ${carId}.${field} ${value} -> ${got}`);
                    continue;
                }
                const diff = Math.abs((got as number) - value);
                if (diff > drift.abs) {
                    drift.abs = diff;
                    drift.where = `${name} t${frame.tick} ${carId}.${field}`;
                }
                drift.scaled = Math.max(drift.scaled, diff / Math.max(1, Math.abs(value)));
            }
        }
    });
}

const modes: Mode[] = [
    { name: 'every result +1 ulp', pick: () => 1 },
    { name: 'every result -1 ulp', pick: () => -1 },
    // Two libms that are each within 1 ulp may differ by 2; 16 shows how
    // the drift scales
    { name: 'every result +2 ulp', pick: () => 2 },
    { name: 'every result -16 ulp', pick: () => -16 }
];
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const random = lcg(seed);
    modes.push({ name: `random ±1 ulp on all (seed ${seed})`, pick: () => (random() < 0.5 ? -1 : 1) });
}
for (const seed of [11, 12, 13, 14]) {
    const random = lcg(seed);
    // Closer to reality: only a few results differ at all
    modes.push({ name: `random ±1 ulp on 1% (seed ${seed})`, pick: () => { const r = random(); return r < 0.005 ? -1 : r < 0.01 ? 1 : 0; } });
}

const goldens = new Map(SIM_SCENARIOS.map(scenario => [
    scenario.name,
    (JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.json`), 'utf8')) as { frames: ScenarioFrame[] }).frames
]));

let worst = 0, worstScaled = 0;
for (const mode of modes) {
    const drift: Drift = { abs: 0, where: '-', scaled: 0, discrete: [] };
    for (const scenario of SIM_SCENARIOS) {
        const frames = withNudgedMath(mode, () => recordScenario(scenario));
        compare(scenario.name, JSON.parse(JSON.stringify(frames)), goldens.get(scenario.name)!, drift);
    }
    worst = Math.max(worst, drift.abs);
    worstScaled = Math.max(worstScaled, drift.scaled);
    console.log(`${mode.name.padEnd(34)} max abs ${drift.abs.toExponential(2)} (${drift.where}), max scaled ${drift.scaled.toExponential(2)}, discrete changes ${drift.discrete.length}`);
    for (const line of drift.discrete.slice(0, 5)) console.log(`    ${line}`);
}
console.log(`worst abs ${worst.toExponential(2)}, worst scaled ${worstScaled.toExponential(2)}`);

// The other side: how far a tiny real change moves the goldens. Each tuning
// value alone is scaled by 1 + 1e-6 (plain Math again).
console.log(`\ntuning value × (1 + 1e-6), max scaled drift (tolerance ${GOLDEN_TOLERANCE.toExponential(0)}):`);
const numericKeys = (Object.keys(SIM_TUNING_DEFAULTS) as Array<keyof typeof SIM_TUNING_DEFAULTS>)
    .filter(key => typeof SIM_TUNING_DEFAULTS[key] === 'number' && SIM_TUNING_DEFAULTS[key] !== 0);
let caught = 0, moved = 0;
for (const key of numericKeys) {
    const drift: Drift = { abs: 0, where: '-', scaled: 0, discrete: [] };
    (SIM_TUNING as Record<string, unknown>)[key] = (SIM_TUNING_DEFAULTS[key] as number) * (1 + 1e-6);
    try {
        for (const scenario of SIM_SCENARIOS) {
            compare(scenario.name, JSON.parse(JSON.stringify(recordScenario(scenario))), goldens.get(scenario.name)!, drift);
        }
    } finally {
        Object.assign(SIM_TUNING, SIM_TUNING_DEFAULTS);
    }
    // Values the scenarios never reach (or only through a threshold that a
    // change of 1e-6 does not cross) cannot move the goldens at all, and a
    // change below the platform noise is not one an exact comparison could
    // tell apart from that noise either
    const detectable = drift.scaled > worstScaled || drift.discrete.length > 0;
    const hit = drift.scaled > GOLDEN_TOLERANCE || drift.discrete.length > 0;
    if (detectable) moved++;
    if (detectable && hit) caught++;
    const note = !detectable ? '  (no effect beyond platform noise)' : hit ? '' : '  (NOT CAUGHT)';
    console.log(`  ${key.padEnd(24)} ${drift.scaled.toExponential(2)}${note}`);
}
console.log(`${caught} of ${moved} tuning changes with an effect are caught (${numericKeys.length - moved} have none)`);
