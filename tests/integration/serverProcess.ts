import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A real game server in its own process for the bot integration tests
// (docs/phase-1b-design.md, 15.2): the TypeScript sources through tsx, so
// no build is needed, with E2E=1 (debugPlace) and a short grace time.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ServerProcess {
    port: number;
    // ws://127.0.0.1:port/ws
    url: string;
    origin: string;
    child: ChildProcess;
    // The last lines the server printed (for failure messages)
    output(): string;
    stop(): Promise<void>;
}

function portFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

/** The first free port in [from, to]. */
export async function freePort(from: number, to: number): Promise<number> {
    for (let port = from; port <= to; port++) {
        if (await portFree(port)) return port;
    }
    throw new Error(`no free port in ${from}-${to}`);
}

export async function startServer(env: Record<string, string> = {}): Promise<ServerProcess> {
    const fixed = Number(process.env.BOTS_PORT);
    const port = Number.isInteger(fixed) && fixed > 0 ? fixed : await freePort(8560, 8599);
    const lines: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), E2E: '1', GRACE_MS: '5000', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const keep = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(line);
        if (lines.length > 400) lines.splice(0, lines.length - 400);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const origin = `http://127.0.0.1:${port}`;

    const until = performance.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}:\n${lines.join('\n')}`);
        try {
            const response = await fetch(`${origin}/healthz`);
            if (response.ok && (await response.json() as { ok: boolean }).ok) break;
        } catch { /* not up yet */ }
        if (performance.now() > until) {
            child.kill('SIGKILL');
            throw new Error(`server did not become healthy:\n${lines.join('\n')}`);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
        port,
        url: `ws://127.0.0.1:${port}/ws`,
        origin,
        child,
        output: () => lines.slice(-60).join('\n'),
        async stop() {
            if (child.exitCode !== null) return;
            // Graceful shutdown (11.2) by PID, a hard kill if it hangs
            child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
            await exited;
            clearTimeout(timer);
        }
    };
}
