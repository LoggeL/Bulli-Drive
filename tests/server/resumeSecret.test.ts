import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_FILE, TicketSigner, type TicketContent } from '../../src/server/resumeTicket.js';

// Where the resume-ticket secret comes from (docs/ops.md): a restart must
// honour the tickets of the process before it, which only works when both
// processes find the same secret.

const content: TicketContent = { name: 'Ada', color: 0x123456, carType: 'jeep', profile: 'touch', roomKind: 'party', score: 30 };

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulli-secret-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('TicketSigner.fromEnv', () => {
    it('keeps a secret in DATA_DIR so the next process honours the tickets of this one', () => {
        const before = TicketSigner.fromEnv({ DATA_DIR: dir });
        const ticket = before.sign(content);
        const after = TicketSigner.fromEnv({ DATA_DIR: dir });
        expect(after.redeem(ticket)).toMatchObject(content);
    });

    it('writes the secret as 64 hex characters readable only by the owner', () => {
        TicketSigner.fromEnv({ DATA_DIR: path.join(dir, 'nested') });
        const file = path.join(dir, 'nested', SECRET_FILE);
        expect(fs.readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('does not share a secret between different data directories', () => {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bulli-secret-other-'));
        try {
            const ticket = TicketSigner.fromEnv({ DATA_DIR: dir }).sign(content);
            expect(TicketSigner.fromEnv({ DATA_DIR: other }).redeem(ticket)).toBeNull();
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });

    it('prefers SESSION_SECRET over the file and leaves DATA_DIR untouched', () => {
        const secret = 'an operator secret of some length';
        const ticket = TicketSigner.fromEnv({ SESSION_SECRET: secret, DATA_DIR: dir }).sign(content);
        expect(new TicketSigner(secret).redeem(ticket)).toMatchObject(content);
        expect(fs.existsSync(path.join(dir, SECRET_FILE))).toBe(false);
    });

    it('ignores a damaged secret file without overwriting it', () => {
        const file = path.join(dir, SECRET_FILE);
        fs.writeFileSync(file, 'not hex at all\n');
        const ticket = TicketSigner.fromEnv({ DATA_DIR: dir }).sign(content);
        // Each process falls back to its own random secret
        expect(TicketSigner.fromEnv({ DATA_DIR: dir }).redeem(ticket)).toBeNull();
        expect(fs.readFileSync(file, 'utf8')).toBe('not hex at all\n');
    });

    it('still starts when DATA_DIR is not writable', () => {
        const blocked = path.join(dir, 'file-not-dir');
        fs.writeFileSync(blocked, '');
        const signer = TicketSigner.fromEnv({ DATA_DIR: blocked });
        expect(signer.redeem(signer.sign(content))).toMatchObject(content);
    });
});
