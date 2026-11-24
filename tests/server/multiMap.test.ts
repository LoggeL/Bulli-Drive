import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { acceptHello } from '../../src/server/handshake.js';
import { mapFor } from '../../src/server/maps.js';
import { MemoryGhostStore, type GhostRun } from '../../src/server/race/ghostStore.js';
import { TicketSigner } from '../../src/server/resumeTicket.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import type { RaceRoom } from '../../src/server/rooms/RaceRoom.js';
import { ghostKeyFor } from '../../src/server/rooms/TimeTrialRoom.js';
import { ticketFor } from '../../src/server/shutdown.js';
import { MAP_IDS, mapDescriptor } from '../../src/shared/map/registry.js';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import { trackIdsForMap } from '../../src/shared/race/tracks/index.js';
import { fakeClock, fakeSession, FakeTransport, ready, steps } from './helpers.js';

let clock: ReturnType<typeof fakeClock>;
let lobby: RoomManager;

beforeEach(() => {
    clock = fakeClock(10_000);
    lobby = new RoomManager(mapFor('bulli-bay'), { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000, now: clock.now });
});

afterEach(() => {
    for (const room of lobby.list()) room.dispose();
});

describe('multi-map server loader & room scoping', () => {
    it('lazily loads and caches all 4 registered maps with their discoveries.json', () => {
        for (const id of MAP_IDS) {
            const first = mapFor(id);
            const second = mapFor(id);
            expect(first).toBe(second);
            expect(first.mapId).toBe(id);
            expect(first.discoveries.length).toBe(mapDescriptor(id).discoveryCount);
        }
        expect(mapFor('logge-forge').discoveries).toHaveLength(22);
        expect(() => mapFor('unknown-map')).toThrow(/unknown map/);
    });

    it('isolates rooms per mapId and allows live map switching even within the same RoomKind', () => {
        const alice = fakeSession('Alice');
        const bob = fakeSession('Bob');
        lobby.join(alice, 'freeroam', { mapId: 'bulli-bay' });
        lobby.join(bob, 'freeroam', { mapId: 'bulli-bay' });
        ready(lobby, alice);
        ready(lobby, bob);
        expect(alice.room!.id).toBe('freeroam-1');
        expect(bob.room!.id).toBe('freeroam-1');

        alice.transport.clear();
        bob.transport.clear();

        // Switch map ONLY (freeroam -> freeroam on logge-forge)
        const result = handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam', mapId: 'logge-forge' }, clock.now());
        expect(result).toBe('ok');
        expect(alice.room!.id).toBe('logge-forge:freeroam-1');
        expect(alice.room!.mapId).toBe('logge-forge');
        expect(alice.member!.ready).toBe(true);
        expect(bob.room!.id).toBe('freeroam-1');
        expect(bob.transport.of('playerLeft')).toEqual([{ type: 'playerLeft', id: alice.id, reason: 'switch' }]);

        const [roomState] = alice.transport.of('roomState');
        const forgeMap = mapFor('logge-forge');
        expect(roomState.room).toEqual({ id: 'logge-forge:freeroam-1', kind: 'freeroam', index: 1, mapId: 'logge-forge' });
        expect(roomState.world).toEqual({ mapId: 'logge-forge', mapVersion: forgeMap.mapVersion, worldHash: forgeMap.worldHash });

        // Switching to the exact same map + kind is a no-op
        alice.transport.clear();
        clock.advance(2500);
        handleClientMessage(lobby, alice, { type: 'joinRoom', kind: 'freeroam', mapId: 'logge-forge' }, clock.now());
        expect(alice.transport.of('roomState')).toEqual([]);
    });

    it('defaults race tracks per map and rejects tracks that belong to another map', () => {
        const alice = fakeSession('Alice');
        // Passing a Bulli Bay track when opening an Alpen Pass race falls back to Alpen Pass's default track
        lobby.join(alice, 'race', { mapId: 'alpen-pass', track: 'hill-sprint' });
        const raceRoom = alice.room as RaceRoom;
        expect(raceRoom.id).toBe('alpen-pass:race-1');
        expect(raceRoom.trackId).toBe(mapDescriptor('alpen-pass').defaultTrackId);

        ready(lobby, alice);
        steps(raceRoom, 2);

        // raceConfig with a Bulli Bay track on Alpen Pass must be ignored (no crash, track unchanged)
        handleClientMessage(lobby, alice, { type: 'raceConfig', track: 'downtown-loop' }, clock.now());
        expect(raceRoom.trackId).toBe(mapDescriptor('alpen-pass').defaultTrackId);

        // Valid track on Alpen Pass succeeds after config interval
        steps(raceRoom, 65);
        const alpenTracks = trackIdsForMap(mapFor('alpen-pass'));
        const secondTrack = alpenTracks.find(t => t !== raceRoom.trackId)!;
        handleClientMessage(lobby, alice, { type: 'raceConfig', track: secondTrack }, clock.now());
        expect(raceRoom.trackId).toBe(secondTrack);
    });

    it('keys time trial ghosts by mapId so maps never collide', () => {
        const store = new MemoryGhostStore(() => new Uint8Array(13));
        const bayKey = ghostKeyFor(mapFor('bulli-bay'), 'downtown-loop');
        const forgeKey = ghostKeyFor(mapFor('logge-forge'), 'forge-grand-circuit');
        expect(bayKey.mapId).toBe('bulli-bay');
        expect(forgeKey.mapId).toBe('logge-forge');

        const makeRun = (key: typeof bayKey, finishTicks: number): GhostRun => ({
            key,
            carType: 'bulli',
            profile: 'standard',
            playerKey: 'p1',
            playerName: 'Ada',
            finishTicks,
            gateTicks: [100, finishTicks],
            spawnToStart: 120,
            inputs: new Uint8Array(16),
            recordedAt: clock.now()
        });

        store.submit(makeRun(bayKey, 2400));
        expect(store.best(bayKey)?.finishTicks).toBe(2400);
        expect(store.best(forgeKey)).toBeNull();

        store.submit(makeRun(forgeKey, 3100));
        expect(store.best(forgeKey)?.finishTicks).toBe(3100);
        expect(store.best(bayKey)?.finishTicks).toBe(2400);

        // Even with identical trackId/version/simHash, distinct mapIds never overwrite each other
        const sameTrackOtherMap = { ...bayKey, mapId: 'logge-forge' as const };
        store.submit(makeRun(sameTrackOtherMap, 1900));
        expect(store.best(sameTrackOtherMap)?.finishTicks).toBe(1900);
        expect(store.best(bayKey)?.finishTicks).toBe(2400);
    });

    it('honours hello.mapId and preserves mapId inside shutdown resume tickets', () => {
        const signer = new TicketSigner('a-very-secret-test-key-1234', clock.now);
        const t1 = new FakeTransport();
        const session = acceptHello(t1, JSON.stringify({
            type: 'hello', protocolVersion: PROTOCOL_VERSION, build: null, connId: 'c1',
            name: 'Logge', carType: 'bulli', profile: 'standard', room: 'freeroam', mapId: 'stunt-forge'
        }), { lobby, serverBuild: null, tickets: signer })!;
        expect(session.room!.id).toBe('stunt-forge:freeroam-1');

        // Sign a shutdown ticket and redeem on a new connection that omits mapId
        const resume = ticketFor(session, signer);
        const t2 = new FakeTransport();
        const restored = acceptHello(t2, JSON.stringify({
            type: 'hello', protocolVersion: PROTOCOL_VERSION, build: null, connId: 'c2',
            name: 'Logge', carType: 'bulli', profile: 'standard', room: 'freeroam', resume
        }), { lobby, serverBuild: null, tickets: signer })!;
        expect(restored.room!.mapId).toBe('stunt-forge');
    });

    it('relays valid discoveries to other room members once, ignores invalid IDs, and rate-limits', () => {
        const alice = fakeSession('Alice');
        const bob = fakeSession('Bob');
        lobby.join(alice, 'freeroam', { mapId: 'logge-forge' });
        lobby.join(bob, 'freeroam', { mapId: 'logge-forge' });
        ready(lobby, alice);
        ready(lobby, bob);
        const room = alice.room!;
        steps(room, 3);
        alice.transport.clear();
        bob.transport.clear();

        const forgeDiscoveries = mapFor('logge-forge').discoveries;
        const firstId = forgeDiscoveries[0].id;
        const secondId = forgeDiscoveries[1].id;
        const bayOnlyId = mapFor('bulli-bay').discoveries[0].id;

        // Unknown / wrong-map discovery ID is dropped silently
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: bayOnlyId }, clock.now());
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: 'non-existent-egg' }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('discovery')).toEqual([]);

        // Valid discovery relays to Bob (excluding Alice)
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: firstId }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('discovery')).toEqual([
            { type: 'discovery', playerId: alice.id, playerName: 'Alice', discoveryId: firstId, mapId: 'logge-forge' }
        ]);
        expect(alice.transport.events('discovery')).toEqual([]);

        // Duplicate discovery from Alice is deduplicated even after cooldown
        bob.transport.clear();
        clock.advance(2000);
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: firstId }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('discovery')).toEqual([]);

        // Rapid second discovery within DISCOVERY_INTERVAL_MS (500ms) is rate-limited
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: secondId }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('discovery')).toHaveLength(1);

        // Sending a third one immediately (< 500ms later) gets rate-limited
        bob.transport.clear();
        const thirdId = forgeDiscoveries[2].id;
        clock.advance(100);
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: thirdId }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('discovery')).toEqual([]);

        // After cooldown (>= 500ms) it succeeds
        clock.advance(500);
        handleClientMessage(lobby, alice, { type: 'discovery', discoveryId: thirdId }, clock.now());
        steps(room, 3);
        expect(bob.transport.events('discovery')).toEqual([
            { type: 'discovery', playerId: alice.id, playerName: 'Alice', discoveryId: thirdId, mapId: 'logge-forge' }
        ]);
    });
});
