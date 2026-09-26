// The menu's car cards (docs/ui.md 4.3): each car alone, three-quarter from
// the front left, in its factory paint, rendered by its own Blender build
// script (the same product shot as the race lobby's small icons, larger).
//
//   node tools/ui/menu-renders.mjs [--only=bulli,beetle] [--jobs=2] [--keep=<dir>] [--skip-blender]
//
// --skip-blender re-encodes the renders kept in --keep=<dir> from an earlier run.
//
// Builds LOD0 of each car into a scratch directory (public/models stays as
// it is), renders the icon at 1280 x 720 with a transparent background,
// trims it to the car and writes public/icons/car-<id>-menu.webp:
// 320 x 180 CSS px at 2x = 640 x 360, WebP with alpha, <= 20 KB each
// (tests/client/uiAssets.test.ts keeps the sizes).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
// sharp is a dependency of tools/ (npm --prefix tools ci)
const sharp = createRequire(path.join(REPO, 'tools', 'package.json'))('sharp');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/models/models.json'), 'utf8')).models;
const OUT_DIR = path.join(REPO, 'public', 'icons');
const WIDTH = 640;
const HEIGHT = 360;
const MAX_BYTES = 20 * 1024;

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
}));
const ids = args.only ? String(args.only).split(',') : Object.keys(REGISTRY);
const jobs = Math.max(1, Number(args.jobs) || 2);
const work = args.keep ? path.resolve(String(args.keep)) : fs.mkdtempSync(path.join(os.tmpdir(), 'menu-renders-'));

function findBlender() {
    const candidates = [process.env.BLENDER, '/opt/homebrew/bin/blender',
        '/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender'];
    for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
    return 'blender';
}

function renderIcon(id) {
    const out = path.join(work, id);
    fs.mkdirSync(out, { recursive: true });
    const png = path.join(out, 'menu.png');
    const script = path.join(REPO, 'tools/models', REGISTRY[id].script);
    const blenderArgs = ['-b', '--factory-startup', '--python', script, '--',
        `--out=${out}`, '--lods=0', '--no-render', `--icon=${png}`, '--icon-size=1280x720'];
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const child = spawn(findBlender(), blenderArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        child.stdout.on('data', chunk => { log += chunk; });
        child.stderr.on('data', chunk => { log += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            fs.writeFileSync(path.join(out, 'blender.log'), log);
            if (code !== 0 || /Traceback \(most recent call last\)/.test(log) || !fs.existsSync(png)) {
                reject(new Error(`Blender icon of ${id} failed, see ${path.join(out, 'blender.log')}\n${log.slice(-1500)}`));
                return;
            }
            console.log(`[menu] ${id}: blender ${((Date.now() - t0) / 1000).toFixed(0)} s`);
            resolve(png);
        });
    });
}

async function writeWebp(id, png) {
    const target = path.join(OUT_DIR, `car-${id}-menu.webp`);
    const trimmed = await sharp(png).trim({ threshold: 1 }).toBuffer();
    // The car fills the card's width with a little air, standing on its bottom edge
    const fitted = await sharp(trimmed)
        .resize(Math.round(WIDTH * 0.94), Math.round(HEIGHT * 0.92), { fit: 'inside' })
        .toBuffer();
    const meta = await sharp(fitted).metadata();
    const left = Math.round((WIDTH - meta.width) / 2);
    const top = HEIGHT - meta.height - Math.round(HEIGHT * 0.04);
    // The soft alpha edge costs the most bytes; half quality there is invisible
    for (const quality of [82, 76, 70, 64, 58]) {
        await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite([{ input: fitted, left, top }])
            .webp({ quality, alphaQuality: 50, effort: 6 })
            .toFile(target);
        if (fs.statSync(target).size <= MAX_BYTES) break;
    }
    console.log(`[menu] ${path.relative(REPO, target)} (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const queue = [...ids];
async function worker() {
    for (let id = queue.shift(); id; id = queue.shift()) {
        const png = args['skip-blender'] ? path.join(work, id, 'menu.png') : await renderIcon(id);
        await writeWebp(id, png);
    }
}
try {
    await Promise.all(Array.from({ length: Math.min(jobs, ids.length) }, worker));
} finally {
    if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
}
