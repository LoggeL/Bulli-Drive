// The server reads the maps' JSON sources at startup (src/server/maps.ts).
// tsc emits only the imported modules, so the build copies the sources next
// to the compiled shared code: dist/shared/maps/<map>/*.json (the Docker
// image keeps only dist/). The baked terrain comes with the client build
// (public/maps -> dist/client/maps).

import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'shared', 'maps');
const to = path.join(root, 'dist', 'shared', 'maps');
for (const map of readdirSync(from)) {
    mkdirSync(path.join(to, map), { recursive: true });
    for (const file of readdirSync(path.join(from, map)).filter(name => name.endsWith('.json'))) {
        cpSync(path.join(from, map, file), path.join(to, map, file));
    }
}
console.log(`copied the map sources to ${path.relative(root, to)}`);
