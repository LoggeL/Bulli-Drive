import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HDR_CONTENT_TYPE, hdriMiddleware, versionedAssetCache } from '../../src/server/staticAssets.js';

// Cache headers of hashed model/texture URLs and the compressed HDRIs
// (src/server/staticAssets.ts), against a real Express app.

let server: http.Server;
let base = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulli-assets-'));
// Radiance-like content that compresses well
const hdr = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 64 +X 64\n' + 'abcd'.repeat(20_000));

beforeAll(async () => {
    fs.mkdirSync(path.join(dir, 'textures', 'hdri'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'textures', 'hdri', 'sky.hdr'), hdr);
    fs.writeFileSync(path.join(dir, 'models', 'car.glb'), Buffer.alloc(64, 1));
    fs.writeFileSync(path.join(dir, 'models', 'manifest.json'), '{}');
    const app = express();
    app.use(['/models', '/textures'], versionedAssetCache());
    app.use('/textures/hdri', hdriMiddleware(path.join(dir, 'textures', 'hdri')));
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

    it('leaves unknown HDRI paths to the next handler', async () => {
        expect((await get('/textures/hdri/missing.hdr')).status).toBe(404);
    });
});
