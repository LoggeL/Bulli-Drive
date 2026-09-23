import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so unit tests never pick up the client
// build plugins or the dev-server proxy.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node'
    }
});
