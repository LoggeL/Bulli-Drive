import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptHello } from '../../src/server/handshake.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { CLOSE_HELLO, CLOSE_VERSION } from '../../src/shared/net/constants.js';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import { FakeTransport } from './helpers.js';

// The handshake (docs/phase-1b-design.md, 3.2 and 15.1): version check with
// a hard reload for old clients, hello validation, welcome and room state.

let lobby: RoomManager;

beforeEach(() => {
    lobby = new RoomManager(mapFor(), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000 });
});

afterEach(() => {
    for (const room of lobby.list()) room.dispose();
});

const hello = {
    type: 'hello', protocolVersion: PROTOCOL_VERSION, build: '0123456789abcdef', connId: 'tab-1',
    name: '  Surf\u0007King  ', carType: 'jeep', profile: 'touch', room: 'freeroam'
};

describe('acceptHello', () => {
    it('welcomes a current client and puts it into the room it asked for', () => {
        const transport = new FakeTransport();
        const session = acceptHello(transport, JSON.stringify(hello), { lobby, serverBuild: 'fedcba9876543210' })!;
        expect(session).not.toBeNull();
        expect([session.name, session.carType, session.profile, session.connId]).toEqual(['SurfKing', 'jeep', 'touch', 'tab-1']);
        const [welcome, roomState] = transport.sent;
        expect(welcome).toEqual(expect.objectContaining({
            type: 'welcome', playerId: session.id, resumed: false, serverBuild: 'fedcba9876543210', tickRate: 60, snapshotRate: 20, name: 'SurfKing'
        }));
        expect((welcome as { sessionToken: string }).sessionToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(roomState).toEqual(expect.objectContaining({ type: 'roomState', room: { id: 'freeroam-1', kind: 'freeroam', index: 1 } }));
        expect(transport.closed).toBeNull();
    });

    it('turns an old or newer protocol away with a reload and close 4000', () => {
        for (const version of [1, PROTOCOL_VERSION + 1]) {
            const transport = new FakeTransport();
            expect(acceptHello(transport, JSON.stringify({ ...hello, protocolVersion: version }), { lobby, serverBuild: null })).toBeNull();
            expect(transport.sent).toEqual([{ type: 'reject', reason: 'version', reload: true, serverProtocol: PROTOCOL_VERSION }]);
            expect(transport.closed?.code).toBe(CLOSE_VERSION);
        }
        expect(lobby.playerCount()).toBe(0);
    });

    it('closes with 4001 on anything that is not a valid hello', () => {
        for (const text of [
            'not json',
            JSON.stringify({ type: 'update', x: 0, z: 0, angle: 0, flipAngle: 0, isFlipping: false }),
            JSON.stringify({ type: 'playerReady' }),
            JSON.stringify({ ...hello, room: 'rally' }),
            JSON.stringify({ ...hello, name: 7 })
        ]) {
            const transport = new FakeTransport();
            expect(acceptHello(transport, text, { lobby, serverBuild: null })).toBeNull();
            expect(transport.sent).toEqual([{ type: 'reject', reason: 'hello', reload: false, serverProtocol: PROTOCOL_VERSION }]);
            expect(transport.closed?.code).toBe(CLOSE_HELLO);
        }
    });

    it('paints the car in the wish from the menu, or in a palette paint drawn from the random source', () => {
        // Dove Blue from the palette (docs/ui.md 5)
        const wished = acceptHello(new FakeTransport(), JSON.stringify({ ...hello, paint: 'blue' }), { lobby, serverBuild: null })!;
        expect(wished.color).toBe(0x5C7C95);
        // Eight paints: 0.3 picks the third (index 2, Sealing Red), 0.99 the last (Anthracite)
        const transport = new FakeTransport();
        const drawn = acceptHello(transport, JSON.stringify(hello), { lobby, serverBuild: null, random: () => 0.3 })!;
        expect(drawn.color).toBe(0x8E2A28);
        expect(transport.sent[0]).toEqual(expect.objectContaining({ type: 'welcome', color: 0x8E2A28 }));
        expect(acceptHello(new FakeTransport(), JSON.stringify(hello), { lobby, serverBuild: null, random: () => 0.99 })!.color).toBe(0x2A2C2E);
        // No paint outside the palette
        const refused = new FakeTransport();
        expect(acceptHello(refused, JSON.stringify({ ...hello, paint: 'neon' }), { lobby, serverBuild: null })).toBeNull();
        expect(refused.closed?.code).toBe(CLOSE_HELLO);
    });

    it('gives an unknown car the Bulli and an empty name a generated one', () => {
        const transport = new FakeTransport();
        const session = acceptHello(transport, JSON.stringify({ ...hello, name: '   ', carType: 'tank' }), { lobby, serverBuild: null })!;
        expect(session.carType).toBe('bulli');
        expect(session.name).toMatch(/^Player \d+$/);
    });
});
