import { DEFAULT_ROOM_KIND, type RoomKind } from '../../shared/protocol.js';
import { replayRun } from '../../shared/race/replay.js';
import { RACE_ROOM_MAX_MEMBERS } from '../../shared/race/rules.js';
import type { TrackId } from '../../shared/race/types.js';
import type { MapData } from '../../shared/world/mapData.js';
import { MemoryGhostStore, type GhostStore } from '../race/ghostStore.js';
import type { Session } from '../session.js';
import { FreeRoamRoom } from './FreeRoamRoom.js';
import { PartyRoom } from './PartyRoom.js';
import { RaceRoom, trackRuntime } from './RaceRoom.js';
import type { Room, RoomMember } from './Room.js';
import { TimeTrialRoom } from './TimeTrialRoom.js';

// All rooms of the process (docs/phase-1b-design.md, 2.3). New players go
// to the fullest room of the kind they asked for that still has space, so
// they meet; a new instance opens when all are full. party-1 always exists,
// every other instance closes a while after its last player left. Races
// (docs/phase-2-design.md, 6.5): a room in its lobby first, then a running
// one to watch until the next start; fresh opens a new one ("START OWN
// RACE"). Every time trial is a new private instance.

export interface RoomManagerOptions {
    maxPlayersPerRoom: number;
    emptyRoomTtlMs: number;
    now?: () => number;
    // The time trial ghosts (default: in memory, replayed on the race world)
    ghosts?: GhostStore;
}

export interface JoinOptions {
    // A new instance even when one with space exists (race only)
    fresh?: boolean;
    // The track of a new race or time trial instance
    track?: TrackId;
}

export class RoomManager {
    private readonly rooms = new Map<string, Room>();
    private readonly now: () => number;
    readonly ghosts: GhostStore;
    // Idle kick (5.4); server/index.ts closes the socket
    onIdleKick: (session: Session) => void = () => { /* set by the server */ };

    constructor(readonly map: MapData, readonly options: RoomManagerOptions) {
        this.now = options.now ?? Date.now;
        this.ghosts = options.ghosts ?? new MemoryGhostStore(run => {
            const { world, course } = trackRuntime(map, run.key.trackId);
            return replayRun(world, course, run).poses;
        });
        this.create(DEFAULT_ROOM_KIND, 1);
    }

    list(): Room[] {
        return [...this.rooms.values()];
    }

    get(id: string): Room | undefined {
        return this.rooms.get(id);
    }

    private create(kind: RoomKind, index: number, options: JoinOptions = {}): Room {
        const room = kind === 'party' ? new PartyRoom(index, this.map, this.now)
            : kind === 'race' ? new RaceRoom(index, this.map, this.now, { track: options.track })
                : kind === 'timetrial' ? new TimeTrialRoom(index, this.map, this.now, { track: options.track, ghosts: this.ghosts })
                    : new FreeRoamRoom(index, this.map, this.now);
        this.rooms.set(room.id, room);
        this.orderedCache = null;
        room.onIdleKick = member => this.onIdleKick(member.session);
        console.log(`Room ${room.id} opened`);
        return room;
    }

    private capacity(room: Room): number {
        return room instanceof RaceRoom ? Math.min(RACE_ROOM_MAX_MEMBERS, this.options.maxPlayersPerRoom) : this.options.maxPlayersPerRoom;
    }

    // The fullest room of the kind with space that passes the filter (ties: the lowest index)
    private fullest(kind: RoomKind, filter: (room: Room) => boolean = () => true): Room | null {
        let best: Room | null = null;
        for (const room of this.rooms.values()) {
            if (room.kind !== kind || room.size >= this.capacity(room) || !filter(room)) continue;
            if (!best || room.size > best.size || (room.size === best.size && room.index < best.index)) best = room;
        }
        return best;
    }

    /** The room of that kind a new player joins, created when all are full. */
    findOrCreate(kind: RoomKind, options: JoinOptions = {}): Room {
        let best: Room | null = null;
        if (kind === 'race' && !options.fresh) {
            // A lobby to drive in before a race to watch
            best = this.fullest(kind, room => (room as RaceRoom).phase === 'lobby') ?? this.fullest(kind);
        } else if (kind !== 'race' && kind !== 'timetrial') {
            best = this.fullest(kind);
        }
        if (best) return best;
        let index = 1;
        while (this.rooms.has(`${kind}-${index}`)) index++;
        return this.create(kind, index, options);
    }

    /** Puts a session without a room into a room of that kind. */
    join(session: Session, kind: RoomKind, options: JoinOptions = {}): RoomMember {
        if (session.member) throw new Error(`session ${session.id} is already in ${session.room?.id}`);
        return this.findOrCreate(kind, options).join(session);
    }

    /**
     * Moves a session to a room of another kind: leave the old room, join
     * the new one. The car shows up there right away if it was visible.
     * Returns null when the session already is in a room of that kind
     * (unless fresh asks for a new instance).
     */
    switch(session: Session, kind: RoomKind, options: JoinOptions = {}): RoomMember | null {
        const current = session.member;
        if (!current || !session.room) return this.join(session, kind, options);
        if (session.room.kind === kind && !options.fresh) return null;
        const wasReady = current.ready;
        session.room.leave(current, 'switch');
        return this.findOrCreate(kind, options).join(session, { ready: wasReady });
    }

    /**
     * The session is back on a new page (a reload within the grace time):
     * a fresh membership behind the splash screen in a room of that kind,
     * with the Party score kept.
     */
    rejoin(session: Session, kind: RoomKind): RoomMember {
        const room = session.room, member = session.member;
        if (room && member) {
            if (room.kind === 'party' && kind === 'party') session.carryScore = room.scoreOf(member);
            room.leave(member, 'disconnect');
        }
        return this.findOrCreate(kind).join(session);
    }

    /** The session disconnected (or was kicked). */
    leave(session: Session, reason: 'disconnect' | 'kicked' = 'disconnect'): void {
        if (session.room && session.member) session.room.leave(session.member, reason);
    }

    /** One scheduler tick: every room with members, in id order (5.1). */
    stepAll(nowMs: number): void {
        for (const room of this.ordered()) {
            if (room.size > 0) room.step(nowMs);
        }
    }

    private orderedCache: Room[] | null = null;

    private ordered(): Room[] {
        if (!this.orderedCache) {
            this.orderedCache = [...this.rooms.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        }
        return this.orderedCache;
    }

    /** Closes the extra instances that have been empty for emptyRoomTtlMs. */
    sweep(): void {
        const now = this.now();
        for (const room of [...this.rooms.values()]) {
            if (room.id === `${DEFAULT_ROOM_KIND}-1`) continue;
            if (room.size > 0 || now - room.emptySinceMs < this.options.emptyRoomTtlMs) continue;
            room.dispose();
            this.rooms.delete(room.id);
            this.orderedCache = null;
            console.log(`Room ${room.id} closed`);
        }
    }

    playerCount(): number {
        let count = 0;
        for (const room of this.rooms.values()) count += room.size;
        return count;
    }
}
