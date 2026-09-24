import type { IncomingMessage } from 'http';
import { describe, expect, it } from 'vitest';
import { AddressLimits, clientAddress, isPrivateAddress, ThrottledLog } from '../../src/server/access.js';

// Limits per client address (docs/phase-1b-design.md, 11.7)

function req(peer: string, headers: Record<string, string> = {}): IncomingMessage {
    return { socket: { remoteAddress: peer }, headers } as unknown as IncomingMessage;
}

describe('clientAddress', () => {
    it('believes the forwarding headers only from a private peer (the proxy)', () => {
        // Live: Cloudflare -> Traefik (a Docker address) -> the server
        expect(clientAddress(req('172.18.0.3', { 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '198.51.100.1' }), {})).toBe('203.0.113.7');
        expect(clientAddress(req('10.0.1.2', { 'x-real-ip': '198.51.100.1' }), {})).toBe('198.51.100.1');
        expect(clientAddress(req('::ffff:192.168.1.10', { 'x-forwarded-for': '1.1.1.1, 198.51.100.9' }), {})).toBe('198.51.100.9');
        // A client straight from the internet cannot pick its address
        expect(clientAddress(req('198.51.100.20', { 'cf-connecting-ip': '1.2.3.4' }), {})).toBe('198.51.100.20');
        // A private peer without headers is the client (LAN, dev)
        expect(clientAddress(req('192.168.1.10'), {})).toBe('192.168.1.10');
    });

    it('follows CLIENT_IP_HEADER', () => {
        const r = req('172.18.0.3', { 'cf-connecting-ip': '203.0.113.7', 'x-client': '198.51.100.3' });
        expect(clientAddress(r, { CLIENT_IP_HEADER: 'X-Client' })).toBe('198.51.100.3');
        expect(clientAddress(r, { CLIENT_IP_HEADER: 'socket' })).toBe('172.18.0.3');
        expect(clientAddress(r, { CLIENT_IP_HEADER: 'none' })).toBeNull();
    });

    it('knows the private ranges', () => {
        for (const a of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', 'fd00::1', '::ffff:10.0.0.1']) {
            expect(isPrivateAddress(a), a).toBe(true);
        }
        for (const a of ['172.15.0.1', '172.32.0.1', '8.8.8.8', '2001:db8::1', '193.168.0.1']) {
            expect(isPrivateAddress(a), a).toBe(false);
        }
    });
});

describe('AddressLimits', () => {
    const options = { maxSockets: 3, helloBurst: 5, hellosPerMinute: 20 };

    it('holds at most maxSockets open sockets per address, others unaffected', () => {
        const limits = new AddressLimits(options);
        for (let i = 0; i < 3; i++) expect(limits.openSocket('203.0.113.7', 0)).toBe(true);
        expect(limits.openSocket('203.0.113.7', 0)).toBe(false);
        expect(limits.openSocket('198.51.100.1', 0)).toBe(true);
        limits.closeSocket('203.0.113.7');
        expect(limits.openSocket('203.0.113.7', 0)).toBe(true);
    });

    it('lets a burst of new sessions through, then 20 a minute', () => {
        const limits = new AddressLimits(options);
        const burst = Array.from({ length: 8 }, () => limits.admitNewSession('203.0.113.7', 0));
        expect(burst.filter(Boolean)).toHaveLength(5);
        // Three seconds give one more
        expect(limits.admitNewSession('203.0.113.7', 2999)).toBe(false);
        expect(limits.admitNewSession('203.0.113.7', 3000)).toBe(true);
        // A churn of 1000 hellos in a minute gets 5 + 20
        const churn = new AddressLimits(options);
        let admitted = 0;
        for (let i = 0; i < 1000; i++) if (churn.admitNewSession('198.51.100.1', i * 60)) admitted++;
        expect(admitted).toBeGreaterThanOrEqual(24);
        expect(admitted).toBeLessThanOrEqual(25);
    });

    it('does not limit loopback or unknown addresses', () => {
        const limits = new AddressLimits(options);
        for (let i = 0; i < 50; i++) {
            expect(limits.openSocket('127.0.0.1', 0)).toBe(true);
            expect(limits.admitNewSession('::1', 0)).toBe(true);
            expect(limits.openSocket(null, 0)).toBe(true);
        }
        expect(limits.size).toBe(0);
    });

    it('forgets an address once it has no socket and a full budget', () => {
        const limits = new AddressLimits(options);
        limits.openSocket('203.0.113.7', 0);
        limits.admitNewSession('203.0.113.7', 0);
        limits.closeSocket('203.0.113.7');
        limits.sweep(1000);
        expect(limits.size).toBe(1);
        limits.sweep(3000);
        expect(limits.size).toBe(0);
    });
});

describe('ThrottledLog', () => {
    it('writes at most the limit per window and sums up the rest', () => {
        let now = 0;
        const lines: string[] = [];
        const log = new ThrottledLog(3, 10_000, line => lines.push(line), () => now);
        for (let i = 0; i < 1000; i++) log.log(`join ${i}`);
        expect(lines).toEqual(['join 0', 'join 1', 'join 2']);
        now = 10_000;
        log.log('join late');
        expect(lines.slice(3)).toEqual(['(997 more join/leave lines in the last 10 s not shown)', 'join late']);
    });
});
