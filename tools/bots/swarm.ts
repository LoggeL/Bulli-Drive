// Many bots at once (docs/phase-1b-design.md, 15.2): built from a mix like
// "drive:24,ram:6,reconnect:1,hop:1", pumped by one timer, and summed up
// into a report (snapshot rate, downlink, corrections, contacts) together
// with the server's /healthz.

import type { NetStats } from '../../src/shared/net/client.js';
import type { NetsimOptions } from '../../src/shared/net/netsim.js';
import type { RoomKind } from '../../src/shared/protocol.js';
import { Bot, isBotMode, rates, type BotCounters, type BotMode, type BotOptions } from './bot.js';

export interface MixEntry {
    mode: BotMode;
    count: number;
}

/** "drive:24,ram:6" → entries; throws on unknown modes or bad counts. */
export function parseMix(text: string): MixEntry[] {
    const entries: MixEntry[] = [];
    for (const part of text.split(',').map(p => p.trim()).filter(Boolean)) {
        const [mode, countText = '1'] = part.split(':').map(p => p.trim());
        const count = Number(countText);
        if (!isBotMode(mode)) throw new Error(`unknown bot mode "${mode}"`);
        if (!Number.isInteger(count) || count < 0) throw new Error(`bad count "${countText}" for ${mode}`);
        if (count > 0) entries.push({ mode, count });
    }
    return entries;
}

export function mixTotal(mix: MixEntry[]): number {
    return mix.reduce((sum, e) => sum + e.count, 0);
}

export interface SwarmOptions {
    url: string;
    mix: MixEntry[];
    netsim?: NetsimOptions | null;
    room?: RoomKind;
    seed?: number;
    namePrefix?: string;
    // Between two bots connecting (ms)
    staggerMs?: number;
    // Pump interval (ms)
    pumpMs?: number;
    // Extra options for every bot
    bot?: Partial<BotOptions>;
    log?: (line: string) => void;
}

// The server's /healthz (docs/phase-1b-design.md, 11.4)
export interface ServerHealth {
    ok: boolean;
    rooms: number;
    players: number;
    sessions: number;
    graceSessions: number;
    connections: number;
    tickMeanMs: number;
    tickP95Ms: number;
    tickP99Ms: number;
    overruns: number;
    bytesOutPerSec: number;
    kicks: number;
    heapUsedMb?: number;
    rssMb?: number;
}

/** http(s)://host:port for a ws(s)://host:port/ws URL. */
export function httpOrigin(wsUrl: string): string {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return url.origin;
}

export async function fetchHealth(wsUrl: string): Promise<ServerHealth | null> {
    try {
        const response = await fetch(`${httpOrigin(wsUrl)}/healthz`);
        return await response.json() as ServerHealth;
    } catch {
        return null;
    }
}

export interface BotReport {
    name: string;
    mode: BotMode;
    seconds: number;
    snapshotsPerSec: number;
    kbInPerSec: number;
    kbOutPerSec: number;
    // Mean position error at T_s over the snapshots without contact (cm)
    correctionMeanCm: number;
    // Largest such error (cm), corrections too large to smooth
    correctionMaxCm: number;
    snaps: number;
    // Distance the bot's own car covered in the window (m)
    distanceM: number;
    contacts: number;
    reconnects: number;
    resumes: number;
    hops: number;
    missedInputs: number;
    // Share of the own car's snapshots in which it was a lag ghost / idle ghost
    laggyShare: number;
    idleShare: number;
    errors: string[];
}

export interface SwarmReport {
    bots: BotReport[];
    seconds: number;
    minSnapshotsPerSec: number;
    meanSnapshotsPerSec: number;
    maxKbInPerSec: number;
    meanKbInPerSec: number;
    // Over all bots without drops (cm)
    correctionMeanCm: number;
    contacts: number;
    // Contacts both cars reported (the same pair within a second)
    mutualContacts: number;
    errors: string[];
    server: ServerHealth | null;
}

interface Mark {
    counters: BotCounters;
    net: NetStats;
    contacts: number;
    welcomes: number;
    hops: number;
    distance: number;
}

function mark(bot: Bot, now: number): Mark {
    return {
        counters: bot.sample(now),
        net: { ...bot.net.stats },
        contacts: bot.stats.contacts.length,
        welcomes: bot.stats.welcomes.length,
        hops: bot.stats.hops,
        distance: bot.driver.distance
    };
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, total: number) => (total > 0 ? round(part / total, 3) : 0);

export class BotSwarm {
    readonly bots: Bot[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private marks = new Map<Bot, Mark>();
    private markedAt = 0;
    private readonly pumpMs: number;

    constructor(readonly options: SwarmOptions) {
        this.pumpMs = options.pumpMs ?? 4;
        const seed = options.seed ?? 1;
        let index = 0;
        for (const entry of options.mix) {
            for (let k = 0; k < entry.count; k++) {
                index++;
                this.bots.push(new Bot({
                    url: options.url,
                    name: `${options.namePrefix ?? 'Bot'} ${entry.mode} ${index}`,
                    mode: entry.mode,
                    seed: seed * 1000 + index,
                    room: options.room,
                    netsim: options.netsim ?? null,
                    log: options.log,
                    ...options.bot
                }));
            }
        }
    }

    /** Connects every bot (staggered) and starts pumping. */
    async start(): Promise<void> {
        this.timer ??= setInterval(() => this.pump(), this.pumpMs);
        const stagger = this.options.staggerMs ?? 50;
        for (const bot of this.bots) {
            bot.connect();
            if (stagger > 0) await new Promise(resolve => setTimeout(resolve, stagger));
        }
    }

    pump(): void {
        const now = performance.now();
        for (const bot of this.bots) bot.pump(now);
    }

    /** Stops every bot and the timer. */
    async stop(): Promise<void> {
        await Promise.all(this.bots.map(bot => bot.stop()));
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** Resolves once pred holds (checked every 50 ms), rejects after timeoutMs. */
    async waitFor(pred: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
        const until = performance.now() + timeoutMs;
        while (!pred()) {
            if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    /** Starts a measuring window: the report counts from here. */
    markWindow(): void {
        const now = performance.now();
        this.markedAt = now;
        this.marks = new Map(this.bots.map(bot => [bot, mark(bot, now)]));
    }

    /** The numbers since markWindow (or since the start). */
    async report(withServer = true): Promise<SwarmReport> {
        const now = performance.now();
        const bots: BotReport[] = [];
        for (const bot of this.bots) {
            const from = this.marks.get(bot) ?? {
                counters: {
                    at: this.markedAt, bytesIn: 0, bytesInText: 0, bytesInBinary: 0, bytesOut: 0,
                    snapshots: 0, selfSnapshots: 0, laggySnapshots: 0, idleSnapshots: 0
                },
                net: { correctionSum: 0, corrections: 0, contactCorrections: 0, exactMatches: 0, snaps: 0, missedInputs: 0 } as NetStats,
                contacts: 0, welcomes: 0, hops: 0, distance: 0
            };
            const r = rates(from.counters, bot.sample(now));
            const s = bot.net.stats, f = from.net;
            const clean = (s.exactMatches - f.exactMatches) + (s.corrections - f.corrections) - (s.contactCorrections - f.contactCorrections);
            const welcomes = bot.stats.welcomes.slice(from.welcomes);
            const selfSnapshots = bot.stats.counters.selfSnapshots - from.counters.selfSnapshots;
            bots.push({
                name: bot.name,
                mode: bot.mode,
                seconds: round(r.seconds),
                snapshotsPerSec: round(r.snapshotsPerSec),
                kbInPerSec: round(r.bytesInPerSec / 1000, 2),
                kbOutPerSec: round(r.bytesOutPerSec / 1000, 2),
                correctionMeanCm: clean > 0 ? round((s.correctionSum - f.correctionSum) / clean * 100, 2) : 0,
                correctionMaxCm: round(s.correctionMax * 100),
                snaps: s.snaps - f.snaps,
                distanceM: Math.round(bot.driver.distance - from.distance),
                contacts: bot.stats.contacts.length - from.contacts,
                reconnects: Math.max(0, welcomes.length - (from.welcomes === 0 ? 1 : 0)),
                resumes: welcomes.filter(w => w.resumed).length,
                hops: bot.stats.hops - from.hops,
                missedInputs: s.missedInputs - f.missedInputs,
                laggyShare: share(bot.stats.counters.laggySnapshots - from.counters.laggySnapshots, selfSnapshots),
                idleShare: share(bot.stats.counters.idleSnapshots - from.counters.idleSnapshots, selfSnapshots),
                errors: [...bot.stats.errors]
            });
        }
        const active = bots.filter(b => b.mode !== 'flood');
        const steady = active.filter(b => b.mode !== 'reconnect' && b.mode !== 'idle');
        let correctionSum = 0, clean = 0;
        for (const bot of this.bots) {
            if (bot.mode === 'reconnect' || bot.mode === 'flood' || bot.mode === 'idle') continue;
            const f = this.marks.get(bot)?.net;
            const s = bot.net.stats;
            correctionSum += s.correctionSum - (f?.correctionSum ?? 0);
            clean += (s.exactMatches - (f?.exactMatches ?? 0)) + (s.corrections - (f?.corrections ?? 0)) - (s.contactCorrections - (f?.contactCorrections ?? 0));
        }
        const snapshotRates = steady.map(b => b.snapshotsPerSec);
        const kbIn = active.map(b => b.kbInPerSec);
        return {
            bots,
            seconds: round((now - this.markedAt) / 1000),
            minSnapshotsPerSec: snapshotRates.length ? Math.min(...snapshotRates) : 0,
            meanSnapshotsPerSec: snapshotRates.length ? round(snapshotRates.reduce((a, b) => a + b, 0) / snapshotRates.length) : 0,
            maxKbInPerSec: kbIn.length ? Math.max(...kbIn) : 0,
            meanKbInPerSec: kbIn.length ? round(kbIn.reduce((a, b) => a + b, 0) / kbIn.length, 2) : 0,
            correctionMeanCm: clean > 0 ? round(correctionSum / clean * 100, 2) : 0,
            contacts: bots.reduce((sum, b) => sum + b.contacts, 0),
            mutualContacts: this.mutualContacts(),
            errors: bots.flatMap(b => b.errors.map(e => `${b.name}: ${e}`)),
            server: withServer ? await fetchHealth(this.options.url) : null
        };
    }

    // Contacts of the window that both cars of the pair saw (within 1 s)
    private mutualContacts(): number {
        const byId = new Map<string, Bot>();
        for (const bot of this.bots) if (bot.playerId) byId.set(bot.playerId, bot);
        let count = 0;
        for (const bot of this.bots) {
            const from = this.marks.get(bot)?.contacts ?? 0;
            for (const contact of bot.stats.contacts.slice(from)) {
                const other = byId.get(contact.other);
                if (!other || !bot.playerId || bot.playerId > contact.other) continue;
                if (other.stats.contacts.some(c => c.other === bot.playerId && Math.abs(c.at - contact.at) < 1000)) count++;
            }
        }
        return count;
    }
}

/** A few lines for the terminal. */
export function formatReport(report: SwarmReport): string {
    const lines = [
        `${report.bots.length} bots over ${report.seconds} s: snapshots/s min ${report.minSnapshotsPerSec} mean ${report.meanSnapshotsPerSec}, ` +
        `downlink max ${report.maxKbInPerSec} kB/s mean ${report.meanKbInPerSec} kB/s, correction ${report.correctionMeanCm} cm, ` +
        `contacts ${report.contacts} (${report.mutualContacts} seen by both)`
    ];
    const s = report.server;
    if (s) {
        lines.push(`server: ${s.players} players in ${s.rooms} rooms, tick mean ${s.tickMeanMs} p95 ${s.tickP95Ms} p99 ${s.tickP99Ms} ms, ` +
            `${s.overruns} overruns, out ${round(s.bytesOutPerSec / 1000)} kB/s, kicks ${s.kicks}` +
            (s.heapUsedMb !== undefined ? `, heap ${s.heapUsedMb} MB, rss ${s.rssMb} MB` : ''));
    }
    for (const error of report.errors.slice(0, 20)) lines.push(`error: ${error}`);
    return lines.join('\n');
}
