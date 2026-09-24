#!/usr/bin/env node
// Keeps the raw image generations and prepared sources of the AI textures
// reproducible. They are too large for git (about 70 MB) and cannot be
// generated again byte for byte, so they live in one tar archive outside the
// repository; sources.json (next to this script, in git) lists every file
// with its SHA-256, so an archive can be checked before it is used.
//
//   node tools/textures/generated/sources.mjs pack <gen-root> <out.tar>
//       hash <gen-root> into sources.json and write the archive
//   node tools/textures/generated/sources.mjs unpack [<archive.tar | https URL>]
//       extract into tools/textures/.cache/gen-work (the prep scripts' default
//       BD_GEN_ROOT) and verify every file; default archive: $BD_GEN_SOURCES
//   node tools/textures/generated/sources.mjs verify [<gen-root>]
//
// <gen-root> has the layout the prep scripts expect: assets/gen/raw,
// assets/facade, assets/decals, world/gen/raw, world/tex.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST = path.join(HERE, 'sources.json');
const WORK = path.join(HERE, '..', '.cache', 'gen-work');
const DIRS = ['assets/gen/raw', 'assets/facade', 'assets/decals', 'world/gen/raw', 'world/tex'];
const EXT = /\.(png|jpe?g|webp|json|txt)$/i;

function walk(root, dir) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full, { withFileTypes: true }).flatMap(entry => {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) return walk(root, rel);
        return EXT.test(entry.name) ? [rel] : [];
    });
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(root) {
    const list = JSON.parse(fs.readFileSync(LIST, 'utf8'));
    const bad = [];
    for (const [rel, want] of Object.entries(list.files)) {
        const file = path.join(root, rel);
        if (!fs.existsSync(file)) bad.push(`missing ${rel}`);
        else if (sha256(file) !== want.sha256) bad.push(`changed ${rel}`);
    }
    if (bad.length) throw new Error(`${bad.length} of ${Object.keys(list.files).length} files differ:\n  ${bad.slice(0, 20).join('\n  ')}`);
    console.log(`[sources] ${Object.keys(list.files).length} files verified in ${root}`);
}

const [command, a, b] = process.argv.slice(2);
if (command === 'pack') {
    if (!a || !b) throw new Error('pack <gen-root> <out.tar>');
    const files = DIRS.flatMap(dir => walk(a, dir)).sort();
    const list = {
        _doc: 'Raw image generations and prepared sources of the AI textures (tools/textures/generated/sources.mjs). Not in git; the archive lies outside the repository (tools/textures/README.md).',
        archive: path.basename(b),
        files: Object.fromEntries(files.map(rel => [rel, { bytes: fs.statSync(path.join(a, rel)).size, sha256: sha256(path.join(a, rel)) }]))
    };
    fs.writeFileSync(LIST, JSON.stringify(list, null, 1) + '\n');
    fs.mkdirSync(path.dirname(path.resolve(b)), { recursive: true });
    execFileSync('tar', ['-cf', path.resolve(b), '-C', a, ...files]);
    const archiveHash = sha256(path.resolve(b));
    console.log(`[sources] ${files.length} files, ${(fs.statSync(b).size / 1e6).toFixed(1)} MB -> ${b} (sha256 ${archiveHash})`);
} else if (command === 'unpack') {
    let archive = a ?? process.env.BD_GEN_SOURCES;
    if (!archive) throw new Error('unpack <archive.tar | URL> (or set BD_GEN_SOURCES)');
    if (/^https?:\/\//.test(archive)) {
        const response = await fetch(archive);
        if (!response.ok) throw new Error(`${archive}: HTTP ${response.status}`);
        const temp = path.join(os.tmpdir(), `bd-gen-sources-${process.pid}.tar`);
        fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
        archive = temp;
    }
    fs.mkdirSync(WORK, { recursive: true });
    execFileSync('tar', ['-xf', path.resolve(archive), '-C', WORK]);
    verify(WORK);
    console.log(`[sources] ready: BD_GEN_ROOT=${WORK} (the prep scripts' default)`);
} else if (command === 'verify') {
    verify(a ?? WORK);
} else {
    throw new Error('usage: sources.mjs pack <gen-root> <out.tar> | unpack [<archive | URL>] | verify [<gen-root>]');
}
