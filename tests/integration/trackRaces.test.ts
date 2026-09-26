import { afterEach, describe, expect, it } from 'vitest';
import { handleClientMessage } from '../../src/server/dispatch.js';
import { mapFor } from '../../src/server/maps.js';
import { RoomManager } from '../../src/server/rooms/lobby.js';
import { RaceRoom } from '../../src/server/rooms/RaceRoom.js';
import { roomOptions } from '../../src/server/rooms/Room.js';
import type { ClientMessage } from '../../src/shared/protocol.js';
import { START_GHOST_TICKS } from '../../src/shared/race/rules.js';
import { TRACK_IDS } from '../../src/shared/race/tracks/index.js';
import type { TrackId } from '../../src/shared/race/types.js';
import { fakeClock, fakeSession, feed } from '../server/helpers.js';

// Every track of the map raced by a full field of server bots, in the
// room (docs/phase-3-design.md, 13.3 and 15, Integration): the RaceRoom's
// tick with its rules, the start ghost, contact between the cars, the
// resets and the race world of the track, but no sockets and no clock, so
// a race of two minutes runs in a few hundred milliseconds. The one player
// the room needs waits on a parking lot far from every track (an e2e
// placement), so five bots race among themselves, each room with its own
// seed (names, classes, lanes, launches). The race ends 30 s after the
// winner (DNF rule).
//
// "Stuck" is a bot that makes no progress along the course (gates passed,
// then metres towards the next one) for STUCK_LIMIT ticks after the start
// ghost. The bots' own way out of a wall, the stuck logic, takes 444 ticks
// at most (three times 90 ticks without speed, two back-offs of 70, the
// reset held for 34), and a car that spun off the line drives for up to
// 2 s before its reset: a bot over 10 s without progress did not get out.

const map = mapFor();
// The beach parking lot, a Free Roam spawn slot off every race line
const PARKED = { x: -636, z: -92, yaw: Math.PI / 2 };
const STUCK_LIMIT = 600;
const SEEDS = [1, 2, 3];

const rooms: RaceRoom[] = [];
let lobby: RoomManager | null = null;

afterEach(() => {
    for (const r of rooms.splice(0)) r.dispose();
    for (const r of lobby?.list() ?? []) r.dispose();
    roomOptions.allowDebugPlace = false;
});

interface BotLog {
    name: string;
    carType: string;
    status: string;
    // Longest stretch of ticks without progress, and the one at the end
    stalled: number;
    stalledAtEnd: number;
}

function race(id: TrackId, seed: number): BotLog[] {
    const clock = fakeClock();
    lobby = new RoomManager(map, { maxPlayersPerRoom: 32, emptyRoomTtlMs: 60_000, now: clock.now });
    const room = new RaceRoom(seed, map, clock.now, { track: id, seed: seed * 7919 + 17 });
    rooms.push(room);
    const player = fakeSession('Parked');
    const send = (msg: ClientMessage) => expect(handleClientMessage(lobby!, player, msg, clock.now())).toBe('ok');
    room.join(player);
    send({ type: 'ready' });
    room.step();
    send({ type: 'raceReady', ready: true });
    for (let i = 0; i < 200 && room.phase === 'lobby'; i++) {
        feed(room, player);
        room.step();
    }
    expect(room.phase).toBe('countdown');
    roomOptions.allowDebugPlace = true;
    send({ type: 'debugPlace', ...PARKED });
    const S = room.startTick!;
    const bots = room.racers.filter(r => r.bot);
    expect(bots).toHaveLength(5);
    const best = bots.map(() => -Infinity);
    const since = bots.map(() => S + START_GHOST_TICKS);
    const stalled = bots.map(() => 0);
    const stalledNow = bots.map(() => 0);
    // The longest race (the Harbor Circuit, three laps) takes about 2:30
    while (room.phase !== 'results' && room.tick < S + 15_000) {
        feed(room, player);
        room.step();
        bots.forEach((r, i) => {
            const p = r.progress;
            if (room.tick < S + START_GHOST_TICKS) since[i] = room.tick;
            if (p.status !== 'racing') return;
            const score = p.passed * 100_000 - p.remaining;
            if (score > best[i] + 0.5) {
                best[i] = score;
                since[i] = room.tick;
            }
            stalledNow[i] = room.tick - since[i];
            stalled[i] = Math.max(stalled[i], stalledNow[i]);
        });
    }
    expect(room.phase).toBe('results');
    return bots.map((r, i) => ({
        name: `${r.name} (${r.carType}, seed ${seed})`, carType: r.carType, status: r.progress.status,
        stalled: stalled[i], stalledAtEnd: stalledNow[i]
    }));
}

describe.each(TRACK_IDS.map(id => [id] as const))('%s raced by five server bots', id => {
    it.each(SEEDS)('sees every bot through without getting stuck (seed %i)', seed => {
        const logs = race(id, seed);
        for (const log of logs) {
            expect(log.stalled, log.name).toBeLessThan(STUCK_LIMIT);
            // Through the finish, or still on its way when the 30 s after the winner ran out
            if (log.status !== 'finished') {
                expect(log.status, log.name).toBe('dnf');
                expect(log.stalledAtEnd, log.name).toBeLessThan(STUCK_LIMIT);
            }
        }
        expect(logs.filter(log => log.status === 'finished').length).toBeGreaterThanOrEqual(3);
    });
});
