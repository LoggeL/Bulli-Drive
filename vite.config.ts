import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

// Port of the Node game server (src/server/config.ts). In dev the Vite server
// proxies the game WebSocket there, so the page itself can stay on Vite + HMR.
const GAME_SERVER_PORT = Number(process.env.PORT) || 8000;

const BUILD_VERSION_META = 'bulli-build-version';

/**
 * Derives one version per client build and publishes it twice:
 * - build-version.txt next to index.html (served with no-store by the server)
 * - a <meta name="bulli-build-version"> in the built index.html
 * The client compares both at startup and reloads once when a stale page
 * (older HTML/JS than the deployed build) is running. See src/client/buildVersion.ts.
 */
function buildVersionPlugin(): Plugin {
    let config: ResolvedConfig;
    let buildVersion: string | undefined;

    return {
        name: 'bulli-build-version',
        apply: 'build',
        configResolved(resolvedConfig) {
            config = resolvedConfig;
        },
        transformIndexHtml: {
            order: 'post',
            handler(html, context) {
                if (!context.bundle) {
                    throw new Error('Build version requires the generated client bundle.');
                }
                // Every emitted JS/CSS file name carries a content hash, so the
                // sorted names plus the final HTML identify the whole client build.
                const hash = createHash('sha256');
                for (const fileName of Object.keys(context.bundle).sort()) {
                    hash.update(fileName);
                    hash.update('\0');
                }
                hash.update(html);
                buildVersion = hash.digest('hex').slice(0, 16);
                return [{
                    tag: 'meta',
                    attrs: { name: BUILD_VERSION_META, content: buildVersion },
                    injectTo: 'head'
                }];
            }
        },
        async writeBundle() {
            if (!buildVersion) {
                throw new Error('Client build produced no index.html to version.');
            }
            const outDir = path.resolve(config.root, config.build.outDir);
            await writeFile(path.join(outDir, 'build-version.txt'), `${buildVersion}\n`);
            config.logger.info(`Client build version: ${buildVersion}`);
        }
    };
}

/**
 * Before phase 0 the client was compiled by tsc into public/js and the build
 * wrote public/build-version.txt. public/ is now Vite's publicDir and is copied
 * verbatim into dist/client, so leftovers from such a build in an older
 * checkout would be shipped and served. Fail the build instead.
 */
function legacyOutputGuard(): Plugin {
    const leftovers = ['public/js', 'public/build-version.txt'];
    let root = process.cwd();
    return {
        name: 'bulli-legacy-output-guard',
        apply: 'build',
        configResolved(resolvedConfig) {
            root = resolvedConfig.root;
        },
        buildStart() {
            const found = leftovers.filter(file => existsSync(path.resolve(root, file)));
            if (found.length > 0) {
                throw new Error(`Old client build output found: ${found.join(', ')}. ` +
                    `It would be copied into dist/client; delete it (rm -rf ${found.join(' ')}) and build again.`);
            }
        }
    };
}

export default defineConfig({
    // index.html in the project root is the entry; public/ (audio, favicon)
    // is copied verbatim into the build.
    publicDir: 'public',
    plugins: [legacyOutputGuard(), buildVersionPlugin()],
    build: {
        outDir: 'dist/client',
        emptyOutDir: true,
        // Hashed JS/CSS land in dist/client/assets and are served immutable.
        assetsDir: 'assets',
        sourcemap: true,
        // Lightning CSS minification folds `backdrop-filter` + `-webkit-backdrop-filter`
        // pairs into the prefixed form only, which drops the blur in Chrome and
        // Firefox. The stylesheet is small, so ship it unminified (gzip still applies).
        cssMinify: false,
        rolldownOptions: {
            output: {
                codeSplitting: {
                    // Three.js changes far less often than the game code, so it
                    // gets its own long-lived chunk.
                    groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }]
                }
            }
        }
    },
    server: {
        proxy: {
            '/ws': {
                target: `ws://localhost:${GAME_SERVER_PORT}`,
                ws: true
            },
            // Server health for the ?debug=perf overlay
            '/healthz': `http://localhost:${GAME_SERVER_PORT}`
        }
    }
});
