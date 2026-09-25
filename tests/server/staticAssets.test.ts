import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BHF_CONTENT_TYPE, HDR_CONTENT_TYPE, hdriMiddleware, terrainMiddleware, versionedAssetCache } from '../../src/server/staticAssets.js';

// Cache headers of hashed model/texture URLs and the compressed HDRIs
// (src/server/staticAssets.ts), against a real Express app.

let server: http.Server;
let base = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulli-assets-'));
// Radiance-like content that compresses well
const hdr = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 64 +X 64\n' + 'abcd'.repeat(20_000));
// A baked terrain: the magic and smooth heights
const bhf = Buffer.concat([Buffer.from('BDHF'), Buffer.alloc(100_000, 7)]);

beforeAll(async () => {
    fs.mkdirSync(path.join(dir, 'textures', 'hdri'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'textures', 'hdri', 'sky.hdr'), hdr);
    fs.writeFileSync(path.join(dir, 'models', 'car.glb'), Buffer.alloc(64, 1));
    fs.writeFileSync(path.join(dir, 'models', 'manifest.json'), '{}');
    fs.mkdirSync(path.join(dir, 'maps', 'bay'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'maps', 'bay', 'terrain.bhf'), bhf);
    fs.writeFileSync(path.join(dir, 'maps', 'bay', 'manifest.json'), '{}');
    const app = express();
    app.use(['/models', '/textures', '/maps'], versionedAssetCache());
    app.use('/textures/hdri', hdriMiddleware(path.join(dir, 'textures', 'hdri')));
    app.use('/maps', terrainMiddleware(path.join(dir, 'maps')));
    app.use(express.static(dir, { index: false }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        http.get(base + url, { headers }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

describe('static asset caching', () => {
    it('caches hashed model URLs for a year and revalidates the manifest', async () => {
        const hashed = await get('/models/car.glb?v=abc123');
        expect(hashed.status).toBe(200);
        expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        const plain = await get('/models/car.glb');
        expect(plain.headers['cache-control']).toBe('public, max-age=0');
        const manifest = await get('/models/manifest.json?v=1');
        expect(manifest.headers['cache-control']).toBe('no-cache');
    });

    it('serves the HDRIs compressed, typed, with a content ETag', async () => {
        let response = await get('/textures/hdri/sky.hdr', { 'accept-encoding': 'gzip, br' });
        // The compressed copies are made off the event loop right after startup
        for (let i = 0; i < 50 && response.headers['content-encoding'] !== 'br'; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            response = await get('/textures/hdri/sky.hdr', { 'accept-encoding': 'gzip, br' });
        }
        expect(response.headers['content-encoding']).toBe('br');
        expect(response.headers['content-type']).toBe(HDR_CONTENT_TYPE);
        expect(response.body.length).toBeLessThan(hdr.length / 10);
        expect(zlib.brotliDecompressSync(response.body).equals(hdr)).toBe(true);

        const gzip = await get('/textures/hdri/sky.hdr', { 'accept-encoding': 'gzip' });
        expect(gzip.headers['content-encoding']).toBe('gzip');
        expect(zlib.gunzipSync(gzip.body).equals(hdr)).toBe(true);
        const raw = await get('/textures/hdri/sky.hdr');
        expect(raw.headers['content-encoding']).toBeUndefined();
        expect(raw.body.equals(hdr)).toBe(true);

        const etag = String(response.headers.etag);
        expect(etag).toMatch(/^"[0-9a-f]{20}"$/);
        const again = await get('/textures/hdri/sky.hdr', { 'if-none-match': etag });
        expect(again.status).toBe(304);
    });

    it('serves a map\'s baked terrain from its folder compressed, cached for good under its hash', async () => {
        let response = await get('/maps/bay/terrain.bhf?v=abc', { 'accept-encoding': 'br' });
        for (let i = 0; i < 50 && response.headers['content-encoding'] !== 'br'; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            response = await get('/maps/bay/terrain.bhf?v=abc', { 'accept-encoding': 'br' });
        }
        expect(response.headers['content-encoding']).toBe('br');
        expect(response.headers['content-type']).toBe(BHF_CONTENT_TYPE);
        expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(zlib.brotliDecompressSync(response.body).equals(bhf)).toBe(true);
        expect(response.body.length).toBeLessThan(bhf.length / 20);
        // Without the hash a day; the map's manifest always revalidates
        expect((await get('/maps/bay/terrain.bhf')).headers['cache-control']).toBe('public, max-age=86400');
        expect((await get('/maps/bay/manifest.json?v=1')).headers['cache-control']).toBe('no-cache');
    });

    it('leaves unknown HDRI paths to the next handler', async () => {
        expect((await get('/textures/hdri/missing.hdr')).status).toBe(404);
    });
});
