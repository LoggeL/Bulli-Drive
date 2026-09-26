import * as v from 'valibot';

// Graphics trouble reports from clients (src/client/net/clientReport.ts): a
// lost or refused WebGL context only shows on real devices. The server keeps
// the last MAX_REPORTS in memory, logs each one on a line and serves them at
// GET /api/client-reports. Each address may send REPORTS_PER_MINUTE.

export const MAX_REPORTS = 200;
export const REPORTS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

const ReportSchema = v.object({
    event: v.picklist(['context-lost', 'context-restored', 'webgl-unavailable']),
    detail: v.pipe(v.string(), v.maxLength(200)),
    build: v.pipe(v.string(), v.maxLength(64)),
    userAgent: v.pipe(v.string(), v.maxLength(300)),
    gpu: v.pipe(v.string(), v.maxLength(200)),
    safeMode: v.boolean(),
    devicePixelRatio: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(16)),
    screen: v.pipe(v.string(), v.maxLength(20)),
    deviceMemory: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1024))),
    cores: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1024))),
    secondsSinceLoad: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000_000))
});

export type ClientReport = v.InferOutput<typeof ReportSchema> & { at: string };

export type ReportOutcome = 'stored' | 'invalid' | 'limited';

export class ClientReports {
    private readonly reports: ClientReport[] = [];
    private readonly recent = new Map<string, number[]>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Validates and stores one report from `address`. */
    add(address: string, body: unknown): ReportOutcome {
        const t = this.now();
        const times = (this.recent.get(address) ?? []).filter(at => at > t - MINUTE_MS);
        if (times.length >= REPORTS_PER_MINUTE) {
            this.recent.set(address, times);
            return 'limited';
        }
        const parsed = v.safeParse(ReportSchema, body);
        if (!parsed.success) return 'invalid';
        times.push(t);
        this.recent.set(address, times);
        this.prune(t);
        const report: ClientReport = { ...parsed.output, at: new Date(t).toISOString() };
        this.reports.push(report);
        if (this.reports.length > MAX_REPORTS) this.reports.shift();
        console.warn(`[client-report] ${report.event} gpu="${report.gpu}" dpr=${report.devicePixelRatio} ` +
            `mem=${report.deviceMemory ?? '?'} lite=${report.safeMode} t=${report.secondsSinceLoad}s ua="${report.userAgent}"` +
            (report.detail ? ` detail="${report.detail}"` : ''));
        return 'stored';
    }

    /** Newest first. */
    list(): ClientReport[] {
        return [...this.reports].reverse();
    }

    private prune(t: number): void {
        if (this.recent.size < 1000) return;
        for (const [address, times] of this.recent) {
            if (times.every(at => at <= t - MINUTE_MS)) this.recent.delete(address);
        }
    }
}
