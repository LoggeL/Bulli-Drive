// Summary of a Stryker run (npm run test:mutation) as Markdown: the score
// per file and, with --survivors, every surviving and uncovered mutant with
// its line and replacement, grouped by file. Reads the JSON report that
// stryker.config.mjs writes.
//
//   npx tsx scripts/mutation-summary.ts                  # score table
//   npx tsx scripts/mutation-summary.ts --survivors      # plus the survivors
//   npx tsx scripts/mutation-summary.ts --report=path/to/mutation.json
//
// The mutation workflow (.github/workflows/mutation.yml) appends the table
// to the job summary.

import fs from 'node:fs';

interface Position { line: number; column: number }
interface Mutant {
    id: string;
    mutatorName: string;
    replacement?: string;
    location: { start: Position; end: Position };
    status: 'Killed' | 'Survived' | 'NoCoverage' | 'Timeout' | 'CompileError' | 'RuntimeError' | 'Ignored' | 'Pending';
}
interface Report { files: Record<string, { source: string; mutants: Mutant[] }> }

const args = process.argv.slice(2);
const reportPath = args.find(arg => arg.startsWith('--report='))?.slice('--report='.length)
    ?? 'reports/mutation/mutation.json';
const withSurvivors = args.includes('--survivors');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;

interface Counts { killed: number; timeout: number; survived: number; noCoverage: number; ignored: number; errors: number }
const empty = (): Counts => ({ killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, errors: 0 });

function count(mutants: Mutant[]): Counts {
    const counts = empty();
    for (const mutant of mutants) {
        switch (mutant.status) {
            case 'Killed': counts.killed++; break;
            case 'Timeout': counts.timeout++; break;
            case 'Survived': counts.survived++; break;
            case 'NoCoverage': counts.noCoverage++; break;
            case 'Ignored': counts.ignored++; break;
            default: counts.errors++;
        }
    }
    return counts;
}

// Stryker's mutation score: detected / (detected + undetected); ignored
// mutants and compile or runtime errors are left out
function score(counts: Counts): string {
    const detected = counts.killed + counts.timeout;
    const valid = detected + counts.survived + counts.noCoverage;
    return valid === 0 ? 'n/a' : (100 * detected / valid).toFixed(1);
}

const files = Object.keys(report.files).sort();
const total = empty();
const lines = [
    '| File | Score % | Killed | Timeout | Survived | No coverage | Ignored |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
];
for (const file of files) {
    const counts = count(report.files[file].mutants);
    for (const key of Object.keys(total) as (keyof Counts)[]) total[key] += counts[key];
    lines.push(`| ${file} | ${score(counts)} | ${counts.killed} | ${counts.timeout} | ${counts.survived} | ${counts.noCoverage} | ${counts.ignored} |`);
}
lines.push(`| **All** | **${score(total)}** | ${total.killed} | ${total.timeout} | ${total.survived} | ${total.noCoverage} | ${total.ignored} |`);
console.log('## Mutation score\n');
console.log(lines.join('\n'));

if (withSurvivors) {
    console.log('\n## Surviving and uncovered mutants\n');
    for (const file of files) {
        const { source, mutants } = report.files[file];
        const open = mutants
            .filter(mutant => mutant.status === 'Survived' || mutant.status === 'NoCoverage')
            .sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column);
        if (open.length === 0) continue;
        const sourceLines = source.split('\n');
        console.log(`### ${file} (${open.length})\n`);
        for (const mutant of open) {
            const line = mutant.location.start.line;
            const code = (sourceLines[line - 1] ?? '').trim().slice(0, 100);
            const replacement = (mutant.replacement ?? '').replace(/\s+/g, ' ').slice(0, 80);
            const tag = mutant.status === 'NoCoverage' ? ' (no coverage)' : '';
            console.log(`- L${line} ${mutant.mutatorName}${tag}: \`${code}\` -> \`${replacement}\``);
        }
        console.log('');
    }
}
