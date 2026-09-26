import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { placeholderTexel } from '../../src/client/world/texturePlaceholders.js';
import { TREE_UV } from '../../src/client/world/vegetation.js';

// The shipped world textures (public/textures) against the client code: no
// texture the game asks for is missing, none is shipped without being used,
// the tree card UVs match the atlas sidecar, and the placeholders of late or
// failed textures are neutral (textures.ts).

const ROOT = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/textures/manifest.json'), 'utf8')) as {
    textures: Record<string, { file: string }>;
    generated: Record<string, { sidecar?: string }>;
};

function clientSources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return clientSources(file);
        return file.endsWith('.ts') ? [fs.readFileSync(file, 'utf8')] : [];
    });
}

describe('world textures', () => {
    const code = clientSources(path.join(ROOT, 'src/client')).join('\n');
    const requested = new Set<string>();
    // worldTexture('...'), and the foliage card materials (materials.ts card())
    for (const [, name] of code.matchAll(/(?:worldTexture|card)\(\s*'([^']+)'/g)) requested.add(name);
    for (const [, set] of code.matchAll(/pbr\('([a-z_]+)'\)/g)) {
        for (const map of ['albedo', 'normal', 'arm']) requested.add(`pbr/${set}_${map}`);
    }

    it('ships exactly the textures the client requests', () => {
        expect([...requested].sort()).toEqual(Object.keys(manifest.textures).sort());
    });

    it('has no stray files next to the manifest', () => {
        const shipped = new Set([
            'manifest.json', 'LICENSES.md',
            ...Object.values(manifest.textures).map(entry => entry.file),
            ...Object.values(manifest.generated).flatMap(entry => (entry.sidecar ? [entry.sidecar] : []))
        ]);
        const onDisk = (dir: string, prefix = ''): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
            entry.isDirectory() ? onDisk(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
        const files = onDisk(path.join(ROOT, 'public/textures')).filter(file => !file.startsWith('hdri/'));
        expect(files.filter(file => !shipped.has(file))).toEqual([]);
    });

    it('uses the tree card rects of the atlas sidecar', () => {
        const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/textures/generated/tree_cards.json'), 'utf8')) as Record<string, number[]>;
        for (const kind of ['oak', 'cypress'] as const) {
            TREE_UV[kind].forEach((value, i) => expect(value).toBeCloseTo(sidecar[kind][i], 3));
        }
    });

    it('keeps late or missing textures neutral instead of black', () => {
        expect(placeholderTexel('pbr/asphalt_normal')).toEqual({ rgba: [128, 128, 255, 255], srgb: false });
        // ARM: no occlusion, rough, not metallic
        const arm = placeholderTexel('pbr/asphalt_arm').rgba;
        expect(arm[0]).toBe(255);
        expect(arm[1]).toBeGreaterThan(150);
        expect(arm[2]).toBe(0);
        // Albedo: the material's mean color
        expect(placeholderTexel('pbr/asphalt_albedo', 0x55524e)).toEqual({ rgba: [0x55, 0x52, 0x4e, 255], srgb: true });
        expect(Math.min(...placeholderTexel('generated/rock_albedo').rgba)).toBeGreaterThan(100);
        // Foliage cut-outs vanish
        expect(placeholderTexel('generated/tree_cards').rgba[3]).toBe(0);
        expect(placeholderTexel('generated/palm_fronds').rgba[3]).toBe(0);
    });
});
