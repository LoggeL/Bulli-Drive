import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so unit tests never pick up the client
// build plugins or the dev-server proxy.
//
// Two projects: the client tests stub window, document and module state and
// run each file in a fresh module graph (isolate). The pure logic of
// src/shared, the server and the tools shares a worker's modules between
// files: the Bulli Bay map (src/server/maps.ts mapFor) is then built once per
// worker instead of once per file, which halves the unit job on the CI
// runner. Their files leave no global state behind: they pass in any order
// without isolation (checked with --sequence.shuffle over several seeds);
// the client files did not.
const exclude = ['tests/integration/**', 'node_modules/**'];

export default defineConfig({
    test: {
        environment: 'node',
        projects: [
            {
                extends: true,
                test: { name: 'client', include: ['tests/client/**/*.test.ts'], exclude }
            },
            {
                extends: true,
                test: {
                    name: 'logic',
                    include: ['tests/**/*.test.ts'],
                    // The bot integration tests start their own server (npm run test:bots)
                    exclude: [...exclude, 'tests/client/**'],
                    isolate: false
                }
            }
        ]
    }
});
