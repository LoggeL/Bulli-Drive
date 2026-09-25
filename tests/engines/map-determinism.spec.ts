import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fingerprint, type FingerprintInput } from './fingerprint.js';

// Bit-identical map data in every engine (docs/phase-3-design.md, E4, 5.3
// and A28): the fingerprint of heightAt, the road samples, the rail
// colliders, the TrackDefs and the whole bake, computed in Node and in the
// browser engine of the project (WebKit for Safari and iOS, Chromium).
// worldHash and trackHash are compared strictly between client and server;
// a stray last bit in one engine would send its players into a reload loop.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAP = path.join(ROOT, 'src/shared/maps/bulli-bay');
const text = (name: string) => readFileSync(path.join(MAP, name), 'utf8');

function input(): FingerprintInput {
    return {
        roads: text('roads.json'), map: text('map.json'), zones: text('zones.json'), base: text('base.json'),
        tracks: text('tracks.json'),
        terrain: new Uint8Array(readFileSync(path.join(ROOT, 'public/maps/bulli-bay/terrain.bhf')))
    };
}

test('computes the map data bit for bit as Node does', async ({ page }) => {
    const bundle = await build({
        stdin: { contents: 'export { fingerprint } from "./fingerprint.ts";', resolveDir: path.dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
        bundle: true, format: 'iife', globalName: 'mapFingerprint', platform: 'browser', target: 'es2022', write: false
    });
    const node = fingerprint(input());
    // The committed terrain.bhf is the bake of the committed sources
    expect(node.bake).toBe(node.committedTerrain);

    await page.setContent('<!doctype html><title>map determinism</title>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const { terrain, ...sources } = input();
    const browser = await page.evaluate(({ sources, terrain }) => {
        const bytes = Uint8Array.from(atob(terrain), c => c.charCodeAt(0));
        const api = (globalThis as unknown as { mapFingerprint: { fingerprint: typeof fingerprint } }).mapFingerprint;
        return api.fingerprint({ ...sources, terrain: bytes });
    }, { sources, terrain: Buffer.from(terrain).toString('base64') });
    expect(browser).toEqual(node);
});
