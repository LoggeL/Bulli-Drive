// Mutation testing (Stryker) of the pure logic: the shared sim, contact,
// protocol/codec, world and collider generation, the net layer and the
// server's room rules. It checks that the unit tests actually fail when the
// logic breaks (CLAUDE.md, "Keine tautologischen Tests").
//
// Not part of the normal CI run: a full run takes hours (the instrumented
// sim is many times slower and the golden runs cover almost every sim
// mutant). Run it locally with `npm run test:mutation`, or in GitHub
// Actions via .github/workflows/mutation.yml (weekly and on demand).
// It is incremental: a later run only tests the mutants again whose code or
// covering tests changed, so after the first full run it is quick.
//
// MUTATION_GROUP=sim|contact|net|world|rooms|race runs one group of files with
// its own incremental file and report (the workflow runs the groups in
// parallel). Without it every file is mutated. --mutate narrows further:
//   npm run test:mutation -- --mutate "src/shared/sim/contact.ts"
// (results of the other files stay in the incremental file).
// `npx tsx scripts/mutation-summary.ts --survivors` lists what survived.

const GROUPS = {
    // The vehicle model and its step: covered by the golden sim runs
    sim: [
        'src/shared/sim/vehicle.ts', 'src/shared/sim/world.ts', 'src/shared/sim/tire.ts',
        'src/shared/sim/inputs.ts', 'src/shared/sim/modifiers.ts', 'src/shared/sim/types.ts',
        'src/shared/sim/vehicleClasses.ts', 'src/shared/sim/constants.ts', 'src/shared/sim/tuning.ts'
    ],
    // Car contact, world collision and the scripted scenarios and dummies
    contact: [
        'src/shared/sim/contact.ts', 'src/shared/sim/collision.ts',
        'src/shared/sim/scenarios.ts', 'src/shared/sim/dummies.ts'
    ],
    net: ['src/shared/net/**/*.ts', 'src/shared/protocol.ts', 'src/shared/party/**/*.ts'],
    world: ['src/shared/world/**/*.ts', 'src/shared/math/**/*.ts', 'src/shared/constants.ts'],
    rooms: ['src/server/rooms/**/*.ts'],
    // Race mode (docs/phase-2-design.md, 20): tracks, racing line, gates,
    // progress, standings, launch, freeze and the slipstream
    race: ['src/shared/race/**/*.ts', 'src/shared/sim/slipstream.ts']
};

const group = process.env.MUTATION_GROUP || '';
if (group && !(group in GROUPS)) {
    throw new Error(`MUTATION_GROUP=${group}: use one of ${Object.keys(GROUPS).join(', ')}`);
}
const suffix = group ? `-${group}` : '';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: 'npm',
    testRunner: 'vitest',
    vitest: {
        // The unit test config (no bots, no Playwright) with longer timeouts,
        // the wall-clock and sweep tests skipped and a fix for the per-test filter
        // under Vitest 5 (tests/mutation/strykerSetup.ts)
        configFile: 'vitest.stryker.config.ts',
        // Only run the test files that import the mutated module
        related: true
    },
    plugins: ['@stryker-mutator/vitest-runner'],

    mutate: group
        ? GROUPS[group]
        : ['src/shared/**/*.ts', 'src/server/rooms/**/*.ts', '!src/**/*.d.ts'],
    ignorePatterns: [
        'dist', 'public', 'test-results', 'playwright-report', 'reports',
        'screenshots', 'output', 'tools/models', 'tools/textures'
    ],

    // Each mutant runs only the tests that cover it
    coverageAnalysis: 'perTest',
    // Mutants in code that runs at module load (lookup tables, constant
    // objects) would each need the full suite; they are skipped here and
    // listed as "ignored" in the report.
    ignoreStatic: true,

    incremental: true,
    incrementalFile: `reports/stryker-incremental${suffix}.json`,

    reporters: ['clear-text', 'progress', 'html', 'json'],
    htmlReporter: { fileName: `reports/mutation${suffix}/index.html` },
    jsonReporter: { fileName: `reports/mutation${suffix}/mutation.json` },
    clearTextReporter: { allowEmojis: false, logTests: false, maxTestsToLog: 0 },

    // The golden sim runs are CPU heavy; give slow mutants room before they
    // count as a timeout (an endless loop mutant still ends as one)
    timeoutMS: 10000,
    timeoutFactor: 2,

    // Report only, never a gate (yet)
    thresholds: { high: 80, low: 60, break: null },

    tempDirName: '.stryker-tmp',
    cleanTempDir: 'always'
};
