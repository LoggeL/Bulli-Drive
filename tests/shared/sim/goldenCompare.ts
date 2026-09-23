import type { ScenarioFrame } from '../../../src/shared/sim/scenarios.js';

// Stored goldens are compared with a tolerance, not bit for bit: they are
// recorded on one machine (macOS arm64) and checked on another (Linux x64 in
// CI), and Math.sin/cos/tan/atan2/exp/pow/hypot may round differently in the
// last bit between platforms and V8 versions. Two runs in the same process
// stay bit-identical (stability.test.ts, sandbox.test.ts).
//
// scripts/sim-golden-drift.ts measures both sides:
// - every inexact transcendental result nudged by ±1, 2 or 16 ulp (all at
//   once or at random) moves no golden value by more than about 1e-11
//   (scaled as below; ±1 ulp stays below 1e-12, the long slides of
//   slalom-touch-beetle are the most sensitive); no counter or flag changes;
// - scaling any single SIM_TUNING value by 1 + 1e-6 moves the goldens by
//   far more than the tolerance for every value the scenarios use.
// 1e-9 leaves three orders of magnitude over ±1 ulp noise (two over 16 ulp)
// and is still
// three orders below the smallest deliberate change worth a golden update.
export const GOLDEN_TOLERANCE = 1e-9;

// Numbers may differ by GOLDEN_TOLERANCE × max(1, |golden|): absolute for
// small values (rates, grip, angles), relative for positions of up to a few
// hundred metres. Integer counters and booleans still have to match exactly,
// since a changed counter means a different code path. Returns one line per
// mismatch, empty when the run matches.
export function goldenMismatches(actual: ScenarioFrame[], golden: ScenarioFrame[], limit = 20): string[] {
    const out: string[] = [];
    const push = (line: string) => {
        if (out.length < limit) out.push(line);
    };
    if (actual.length !== golden.length) push(`${actual.length} frames, golden has ${golden.length}`);
    for (let index = 0; index < Math.min(actual.length, golden.length); index++) {
        const frame = actual[index], expected = golden[index];
        if (frame.tick !== expected.tick) push(`frame ${index}: tick ${frame.tick}, golden ${expected.tick}`);
        const carIds = new Set([...Object.keys(frame.cars), ...Object.keys(expected.cars)]);
        for (const carId of carIds) {
            const got = frame.cars[carId] as unknown as Record<string, unknown> | undefined;
            const want = expected.cars[carId] as unknown as Record<string, unknown> | undefined;
            if (!got || !want) {
                push(`tick ${expected.tick}: car ${carId} ${got ? 'not in the golden' : 'missing'}`);
                continue;
            }
            const fields = new Set([...Object.keys(got), ...Object.keys(want)]);
            for (const field of fields) {
                const a = got[field], g = want[field];
                const where = `tick ${expected.tick} ${carId}.${field}`;
                if (typeof a === 'number' && typeof g === 'number') {
                    const diff = Math.abs(a - g);
                    if (!(diff <= GOLDEN_TOLERANCE * Math.max(1, Math.abs(g)))) push(`${where}: ${a}, golden ${g} (off by ${diff.toExponential(2)})`);
                } else if (a !== g) {
                    push(`${where}: ${String(a)}, golden ${String(g)}`);
                }
            }
        }
    }
    return out;
}
