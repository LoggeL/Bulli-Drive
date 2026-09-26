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

// Binary assets that no CDN or Express compresses on its own: the sky
// HDRIs (public/textures/hdri, 2.7 MB of Radiance .hdr, about 60 % with
// Brotli), the maps' baked terrain (public/maps/<map>/terrain.bhf, 3 MB,
// about 10 % with Brotli; docs/phase-3-design.md, E13 and A37) and the
// models (public/models: the cars and the building kit, meshopt packed
// GLBs, which meshopt lays out for a general compressor after it: Brotli
// takes the kit's 2.09 MB down to 0.84 MB, 60 % smaller; the KTX2 textures
// beside them are compressed already and served as they are). They are
// compressed once at startup, off the event loop (zlib's thread pool), and
// served with a content ETag, so a deploy that leaves them unchanged does
// not make every client download them again. Until the compressed copies
// exist, the raw file goes out.

interface Entry {
    etag: string;
    raw: Buffer;
    br?: Buffer;
    gzip?: Buffer;
}

export const HDR_CONTENT_TYPE = 'image/vnd.radiance';
export const BHF_CONTENT_TYPE = 'application/octet-stream';
export const GLB_CONTENT_TYPE = 'model/gltf-binary';

// Relative paths (with /) of the files under directory with the extension
function filesUnder(directory: string, extension: string, prefix = ''): string[] {
    if (!fs.existsSync(directory)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...filesUnder(path.join(directory, entry.name), extension, relative));
        else if (entry.name.endsWith(extension)) out.push(relative);
    }
    return out;
}

/**
 * Serves the files with the extension under directory (and its
 * subdirectories) compressed with Brotli or Gzip as the request accepts,
 * with the content type and a content ETag. A Cache-Control set before
 * (versionedAssetCache for a hashed URL) stays; otherwise a day.
 */
export function compressedAssets(directory: string, extension: string, contentType: string) {
    const entries = new Map<string, Entry>();
    for (const name of filesUnder(directory, extension)) {
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
        response.setHeader('Content-Type', contentType);
        if (!response.getHeader('Cache-Control')) response.setHeader('Cache-Control', 'public, max-age=86400');
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

export function hdriMiddleware(directory: string) {
    return compressedAssets(directory, '.hdr', HDR_CONTENT_TYPE);
}

export function terrainMiddleware(directory: string) {
    return compressedAssets(directory, '.bhf', BHF_CONTENT_TYPE);
}

export function modelMiddleware(directory: string) {
    return compressedAssets(directory, '.glb', GLB_CONTENT_TYPE);
}
