import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientOutputPath = fileURLToPath(new URL('../public/js/', import.meta.url));

// TypeScript does not delete output for sources that were renamed or removed.
// A clean graph prevents stale modules from influencing the build version.
await rm(clientOutputPath, { recursive: true, force: true });
