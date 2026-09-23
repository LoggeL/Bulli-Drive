// Builds every car in models.json and packs it for the game.
//
//   npm --prefix tools ci                          # once (gltf-transform, gltfpack, ktx2-encoder, sharp)
//   npm --prefix tools run models                  # Blender build + pack -> public/models
//   node tools/models/build-all.mjs --only=bulli   # one car
//   node tools/models/build-all.mjs --skip-blender # re-pack the GLBs already in tools/models/.out
//   node tools/models/build-all.mjs --render       # also render the Eevee look-dev stills
//
// Blender: $BLENDER, else /opt/homebrew/bin/blender, /Applications/Blender.app, or `blender`
// on the PATH. Tested with Blender 5.2 LTS. Writes public/models/<id>_lod<n>.glb and
// public/models/manifest.json (read by src/client/assets/ModelCache.ts).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packModel, PUBLIC_DIR, RAW_DIR } from './pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(fs.readFileSync(path.join(HERE, 'models.json'), 'utf8')).models;

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
}));

function findBlender() {
    const candidates = [process.env.BLENDER, '/opt/homebrew/bin/blender',
        '/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender'];
    for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
    return 'blender';
}

const ids = args.only ? String(args.only).split(',') : Object.keys(REGISTRY);
for (const id of ids) if (!REGISTRY[id]) throw new Error(`Unknown model ${id} (models.json has ${Object.keys(REGISTRY).join(', ')})`);

const manifestPath = path.join(PUBLIC_DIR, 'manifest.json');
const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: 1, models: {} };

for (const id of ids) {
    const spec = REGISTRY[id];
    if (!args['skip-blender']) {
        const blender = findBlender();
        const script = path.join(HERE, spec.script);
        const blenderArgs = ['-b', '--factory-startup', '--python', script, '--',
            `--out=${path.join(RAW_DIR, id)}`, `--lods=${[...spec.lods].sort((a, b) => b - a).join(',')}`];
        if (!args.render) blenderArgs.push('--no-render');
        console.log(`[models] ${id}: ${blender} ${path.relative(process.cwd(), script)}`);
        const t0 = Date.now();
        const run = spawnSync(blender, blenderArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
        fs.mkdirSync(path.join(RAW_DIR, id), { recursive: true });
        fs.writeFileSync(path.join(RAW_DIR, id, 'blender.log'), log);
        if (run.error) throw run.error;
        if (run.status !== 0 || /Traceback \(most recent call last\)/.test(log)) {
            throw new Error(`Blender build of ${id} failed, see ${path.join(RAW_DIR, id, 'blender.log')}\n${log.slice(-2000)}`);
        }
        for (const line of log.split('\n')) if (/^(LOD \d|DONE)/.test(line)) console.log(`  ${line.slice(0, 160)}`);
        console.log(`  blender ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    console.log(`[models] ${id}: pack`);
    manifest.models[id] = await packModel(id, spec);
}

// Stable key order keeps the manifest diff small
manifest.models = Object.fromEntries(Object.entries(manifest.models).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const total = Object.values(manifest.models).flatMap(m => m.lods).reduce((sum, l) => sum + l.bytes, 0);
console.log(`[models] wrote ${path.relative(process.cwd(), manifestPath)} (${Object.keys(manifest.models).length} models, ${(total / 1024).toFixed(0)} KB)`);
