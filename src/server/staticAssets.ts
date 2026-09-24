import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { NextFunction, Request, Response } from 'express';

// Cache and compression rules for the game's binary assets.

/**
 * Models and world textures are requested with their content hash
 * (?v=<hash> from the manifests): such a URL never changes content, so it is
 * cached for a year without revalidation. The manifests always revalidate.
 * (express.static keeps a Cache-Control header that is already set.)
 */
export function versionedAssetCache() {
    return (request: Request, response: Response, next: NextFunction) => {
        if (request.method === 'GET' || request.method === 'HEAD') {
            if (request.path.endsWith('/manifest.json') || request.path === '/manifest.json') response.setHeader('Cache-Control', 'no-cache');
            else if (typeof request.query.v === 'string' && request.query.v) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        next();
    };
}

// The sky HDRIs (public/textures/hdri, 2.7 MB of Radiance .hdr) are not in
// any compression list (Express sends application/octet-stream, the CDN
// passes that through unchanged), yet Radiance RLE packs to about 60 % with
// Brotli. They are compressed once at startup, off the event loop (zlib's
// thread pool), and served with a content ETag, so a deploy that leaves
// them unchanged does not make every client download them again. Until the
// compressed copies exist, the raw file goes out.

interface Entry {
    etag: string;
    raw: Buffer;
    br?: Buffer;
    gzip?: Buffer;
}

export const HDR_CONTENT_TYPE = 'image/vnd.radiance';

export function hdriMiddleware(directory: string) {
    const entries = new Map<string, Entry>();
    const names = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.hdr')) : [];
    for (const name of names) {
        const raw = fs.readFileSync(path.join(directory, name));
        const entry: Entry = { etag: `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20)}"`, raw };
        entries.set(name, entry);
        zlib.brotliCompress(raw, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length }
        }, (error, body) => { if (!error) entry.br = body; });
        zlib.gzip(raw, { level: 9 }, (error, body) => { if (!error) entry.gzip = body; });
    }

    return (request: Request, response: Response, next: NextFunction) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return next();
        const entry = entries.get(request.path.replace(/^\//, ''));
        if (!entry) return next();
        response.setHeader('Content-Type', HDR_CONTENT_TYPE);
        response.setHeader('Cache-Control', 'public, max-age=86400');
        response.setHeader('ETag', entry.etag);
        response.setHeader('Vary', 'Accept-Encoding');
        if (request.headers['if-none-match'] === entry.etag) {
            response.status(304).end();
            return;
        }
        const accept = String(request.headers['accept-encoding'] ?? '');
        let body = entry.raw;
        if (entry.br && /\bbr\b/.test(accept)) {
            body = entry.br;
            response.setHeader('Content-Encoding', 'br');
        } else if (entry.gzip && /\bgzip\b/.test(accept)) {
            body = entry.gzip;
            response.setHeader('Content-Encoding', 'gzip');
        }
        response.setHeader('Content-Length', String(body.length));
        if (request.method === 'HEAD') response.end();
        else response.end(body);
    };
}
