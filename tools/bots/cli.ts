// Load and robustness runs against a game server (docs/phase-1b-design.md,
// 15.2):
//
//   npm run bots -- --url ws://127.0.0.1:8500/ws --count 32 \
//       --mix drive:24,ram:6,reconnect:1,hop:1 --netsim 150,30,3 --duration 120
//
// --count without --mix drives all bots in mode drive; with --mix the mix
// decides (--count is then a check). Prints a line every --report seconds
// and a summary at the end (--json: as JSON); exits with 1 when a bot hit
// an error.

import { parseNetsimFlag } from '../../src/shared/net/netsim.js';
import { isRoomKind, type RoomKind } from '../../src/shared/protocol.js';
import { BotSwarm, fetchHealth, formatReport, mixTotal, parseMix, type MixEntry } from './swarm.js';

interface CliOptions {
    url: string;
    mix: MixEntry[];
    netsim: string | null;
    durationS: number;
    reportS: number;
    room: RoomKind;
    seed: number;
    json: boolean;
    verbose: boolean;
}

const USAGE = `usage: npm run bots -- [--url ws://127.0.0.1:8000/ws] [--count N] [--mix drive:24,ram:6,reconnect:1,hop:1]
                     [--netsim RTT,JITTER,LOSS[,tcp|drop]] [--duration S] [--report S] [--room party|freeroam]
                     [--seed N] [--json] [--verbose]
modes: drive, ram, idle, reconnect, hop, flood`;

function parseArgs(argv: string[]): CliOptions {
    const args = new Map<string, string>();
    const flags = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
        const [key, inline] = arg.slice(2).split('=', 2);
        if (key === 'json' || key === 'verbose' || key === 'help') {
            flags.add(key);
            continue;
        }
        const value = inline ?? argv[++i];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        args.set(key, value);
    }
    if (flags.has('help')) {
        console.log(USAGE);
        process.exit(0);
    }
    const count = args.has('count') ? Number(args.get('count')) : null;
    if (count !== null && (!Number.isInteger(count) || count < 1)) throw new Error('--count must be a positive integer');
    const mix = args.has('mix') ? parseMix(args.get('mix')!) : [{ mode: 'drive' as const, count: count ?? 8 }];
    if (count !== null && mixTotal(mix) !== count) throw new Error(`--mix has ${mixTotal(mix)} bots, --count says ${count}`);
    const room = args.get('room') ?? 'party';
    if (!isRoomKind(room)) throw new Error(`unknown room kind "${room}"`);
    const netsim = args.get('netsim') ?? null;
    if (netsim && !parseNetsimFlag(netsim)) throw new Error(`bad --netsim "${netsim}" (RTT,JITTER,LOSS[,tcp|drop])`);
    return {
        url: args.get('url') ?? 'ws://127.0.0.1:8000/ws',
        mix,
        netsim,
        durationS: Number(args.get('duration') ?? 60),
        reportS: Number(args.get('report') ?? 5),
        room,
        seed: Number(args.get('seed') ?? 1),
        json: flags.has('json'),
        verbose: flags.has('verbose')
    };
}

async function main(): Promise<void> {
    let options: CliOptions;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`${(err as Error).message}\n${USAGE}`);
        process.exit(2);
    }
    const health = await fetchHealth(options.url);
    if (!health) {
        console.error(`No server answers /healthz for ${options.url}`);
        process.exit(2);
    }
    const swarm = new BotSwarm({
        url: options.url,
        mix: options.mix,
        netsim: parseNetsimFlag(options.netsim),
        room: options.room,
        seed: options.seed,
        log: options.verbose ? line => console.log(line) : undefined
    });
    const total = mixTotal(options.mix);
    console.log(`${total} bots (${options.mix.map(e => `${e.mode}:${e.count}`).join(',')}) against ${options.url}` +
        `${options.netsim ? ` with netsim ${options.netsim}` : ''} for ${options.durationS} s`);

    let stopping = false;
    const finish = async (): Promise<never> => {
        stopping = true;
        const report = await swarm.report();
        await swarm.stop();
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else console.log(`\nSummary\n${formatReport(report)}`);
        process.exit(report.errors.length > 0 ? 1 : 0);
    };
    process.on('SIGINT', () => { if (!stopping) void finish(); });

    await swarm.start();
    // The first seconds are the joins and the clock sync
    await new Promise(resolve => setTimeout(resolve, 3000));
    swarm.markWindow();
    const started = performance.now();
    const ticker = setInterval(async () => {
        if (stopping) return;
        const report = await swarm.report();
        const elapsed = Math.round((performance.now() - started) / 1000);
        console.log(`[${elapsed} s] ${formatReport(report).split('\n').slice(0, 2).join(' | ')}`);
    }, options.reportS * 1000);
    await new Promise(resolve => setTimeout(resolve, options.durationS * 1000));
    clearInterval(ticker);
    await finish();
}

void main();
