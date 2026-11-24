#!/usr/bin/env node
// Generates raw PNG assets from tools/textures/refactor-prompts.json using the
// Codex imagegen skill (codex_images.py). Resumable: skips files already present
// in tools/textures/.cache/refactor-raw/ unless --force is passed.
//
// Usage:
//   node tools/textures/generate-refactor.mjs                       # all groups
//   node tools/textures/generate-refactor.mjs --group=biomes        # biomes | billboards | ui
//   node tools/textures/generate-refactor.mjs --only=alpine_snow,sign_lmf_welcome
//   node tools/textures/generate-refactor.mjs --concurrency=4
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'refactor-prompts.json'), 'utf8'));
const RAW_DIR = path.join(HERE, '.cache', 'refactor-raw');
const PROMPTS_DIR = path.join(HERE, 'prompts');
const CODEX_IMG = path.join(os.homedir(), '.codex', 'skills', 'codex-imagegen-models', 'scripts', 'codex_images.py');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
}));

const groups = args.group ? String(args.group).split(',') : ['biomes', 'billboards', 'ui'];
const only = args.only ? new Set(String(args.only).split(',')) : null;
const concurrency = Math.max(1, Number(args.concurrency ?? 4));
const force = Boolean(args.force);
const model = String(args.model ?? CATALOG.model ?? 'gpt-image-2');

const jobs = [];
for (const group of groups) {
    const items = CATALOG[group];
    if (!Array.isArray(items)) throw new Error(`Unknown group: ${group}`);
    fs.mkdirSync(path.join(RAW_DIR, group), { recursive: true });
    fs.mkdirSync(path.join(PROMPTS_DIR, group), { recursive: true });
    for (const item of items) {
        if (only && !only.has(item.id)) continue;
        const promptFile = path.join(PROMPTS_DIR, group, `${item.id}.txt`);
        fs.writeFileSync(promptFile, item.prompt.trim() + '\n');
        const outFile = path.join(RAW_DIR, group, `${item.id}.png`);
        jobs.push({ group, item, promptFile, outFile });
    }
}

function runOne(job, attempt = 1) {
    return new Promise((resolve, reject) => {
        if (!force && fs.existsSync(job.outFile) && fs.statSync(job.outFile).size > 1000) {
            console.log(`[skip] ${job.group}/${job.item.id} (cached)`);
            resolve({ skipped: true });
            return;
        }
        if (fs.existsSync(job.outFile)) fs.unlinkSync(job.outFile);
        const t0 = Date.now();
        const child = spawn('python3', [
            CODEX_IMG,
            '--model', job.item.model ?? model,
            '--prompt-file', job.promptFile,
            '--size', job.item.size,
            '--quality', job.item.quality ?? 'medium',
            '--out', job.outFile
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => {
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            if (code === 0 && fs.existsSync(job.outFile)) {
                console.log(`[ok]   ${job.group}/${job.item.id} (${dt}s) -> ${out.trim()}`);
                resolve({ skipped: false });
            } else if (attempt < 3) {
                console.warn(`[retry ${attempt}] ${job.group}/${job.item.id} failed (${code}): ${err.trim()}`);
                setTimeout(() => runOne(job, attempt + 1).then(resolve, reject), 3000 * attempt);
            } else {
                reject(new Error(`${job.group}/${job.item.id} failed after ${attempt} attempts: ${err.trim()}`));
            }
        });
    });
}

let idx = 0;
let done = 0;
const failures = [];
async function worker() {
    while (idx < jobs.length) {
        const job = jobs[idx++];
        try {
            await runOne(job);
            done++;
        } catch (err) {
            failures.push(err.message);
            console.error(`[FAIL] ${err.message}`);
        }
    }
}

console.log(`[generate-refactor] ${jobs.length} jobs across [${groups.join(', ')}], concurrency=${concurrency}, model=${model}`);
const tStart = Date.now();
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, () => worker()));
console.log(`[generate-refactor] finished ${done}/${jobs.length} in ${((Date.now() - tStart) / 1000).toFixed(1)}s (${failures.length} failures)`);
if (failures.length) process.exit(1);
