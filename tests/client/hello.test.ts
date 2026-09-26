import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { helloFor, type HelloContext } from '../../src/client/network/hello.js';
import { HelloSchema, PROTOCOL_VERSION } from '../../src/shared/protocol.js';

// The page's hello (src/client/network/hello.ts): what the menu kept in the
// browser's storage goes to the server with the first message, the paint
// included: without it a reload would lose the picked paint, and a first
// visit would get a random one instead of the key art's Sea Green (the
// loader fades into the menu's car, docs/ui.md D28).

const context: HelloContext = { build: 'b1', connId: 'c1', profile: 'standard', room: 'party' };
const storage = (entries: Record<string, string>) => ({
    getItem: (key: string) => entries[key] ?? null,
    setItem: () => undefined
});

describe('the hello', () => {
    it('sends Sea Green, the key art\'s paint, on a first visit', () => {
        const hello = helloFor(storage({}), context);
        expect(hello.paint).toBe('sea');
        expect(hello.carType).toBe('bulli');
        expect(hello.name).toBe('');
        // A hello the server's schema takes
        expect(v.safeParse(HelloSchema, hello).success).toBe(true);
    });

    it('sends the paint, car and name the menu kept', () => {
        const hello = helloFor(storage({ 'bulli-paint': 'ochre', 'bulli-car-type': 'sport', 'bulli-player-name': 'Ada' }), context);
        expect(hello).toMatchObject({ paint: 'ochre', carType: 'sport', name: 'Ada', protocolVersion: PROTOCOL_VERSION });
    });

    it('falls back to Sea Green for a paint that is not in the palette, and without storage', () => {
        expect(helloFor(storage({ 'bulli-paint': 'neon' }), context).paint).toBe('sea');
        expect(helloFor(null, context).paint).toBe('sea');
        const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
        expect(helloFor(throwing, context).paint).toBe('sea');
    });

    it('carries the session token and the resume ticket only when there are some', () => {
        expect(helloFor(storage({}), context)).not.toHaveProperty('sessionToken');
        expect(helloFor(storage({}), context)).not.toHaveProperty('resume');
        expect(helloFor(storage({}), { ...context, sessionToken: 't', resume: 'r' })).toMatchObject({ sessionToken: 't', resume: 'r' });
    });
});
