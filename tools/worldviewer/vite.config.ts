import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The worldviewer, map viewer and spline editor (README, section
// "Worldviewer"): its own Vite app with its own entry, never part of the
// game bundle (vite.config.ts at the root builds only index.html).
//
//   npm run worldviewer            dev server, http://localhost:5174
//   npm run worldviewer -- --port 8810
//
// It imports the map sources from src/shared/maps and the baked
// public/maps/*/terrain.bhf directly, so the dev server may read the whole
// repository, and it has no public directory of its own.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
    root: path.join(ROOT, 'tools/worldviewer'),
    publicDir: false,
    server: {
        port: 5174,
        fs: { allow: [ROOT] }
    },
    worker: { format: 'es' },
    build: {
        outDir: path.join(ROOT, 'output/worldviewer'),
        emptyOutDir: true,
        chunkSizeWarningLimit: 1500
    }
});
