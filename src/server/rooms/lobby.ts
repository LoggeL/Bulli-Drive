import { DEFAULT_ROOM_KIND, type MapId, type RoomKind } from '../../shared/protocol.js';
import { replayRun } from '../../shared/race/replay.js';
import { RACE_ROOM_MAX_MEMBERS } from '../../shared/race/rules.js';
import { trackIdsForMap } from '../../shared/race/tracks/index.js';
import type { TrackId } from '../../shared/race/types.js';
import type { MapData } from '../../shared/map/mapData.js';
import { DEFAULT_MAP_ID, isMapId } from '../../shared/map/registry.js';
import { mapFor } from '../maps.js';
import { MemoryGhostStore, ReplayBudget, type GhostStore } from '../race/ghostStore.js';
import type { Session } from '../session.js';
import { FreeRoamRoom } from './FreeRoamRoom.js';
import { PartyRoom } from './PartyRoom.js';
import { RaceRoom, trackRuntime } from './RaceRoom.js';
import type { Room, RoomMember } from './Room.js';
import { ghostKeyFor, TimeTrialRoom } from './TimeTrialRoom.js';

// All rooms of the process (docs/phase-1b-design.md, 2.3), scoped by mapId.
// New players go to the fullest room of the map & kind they asked for that
// still has space, so they meet; a new instance opens when all are full.
// Default map (bulli-bay) party-1 always exists; every other instance closes
// a while after its last player left. Races: a room in its lobby first, then
// a running one to watch until the next start; fresh opens a new one. Every
// time trial is a new private instance. Empty race/timetrial rooms close at once.

export interface RoomManagerOptions {
    maxPlayersPerRoom: number;
    emptyRoomTtlMs: number;
    now?: () => number;
    // The time trial ghosts (default: in memory, replayed on the race world)
    ghosts?: GhostStore;
    // Custom map loader for tests (default: lazy-cached server mapFor)
    mapResolver?: (mapId: MapId) => MapData;
}

export interface JoinOptions {
    // Target map (defaults to bulli-bay on join, or current room's map on switch)
    mapId?: MapId;
    // A new instance even when one with space exists (race only)
    fresh?: boolean;
    // The track of a new race or time trial instance
    track?: TrackId;
}

export function roomIdFor(mapId: MapId, kind: RoomKind, index: number): string {
    return mapId === DEFAULT_MAP_ID ? `${kind}-${index}` : `${mapId}:${kind}-${index}`;
}

export class RoomManager {
    private readonly rooms = new Map<string, Room>();
    private readonly now: () => number;
    private readonly resolveMapFn: (mapId: MapId) => MapData;
    readonly defaultMapId: MapId;
    readonly ghosts: GhostStore;
    // The time trial replays of the process (ghostStore.ts)
    readonly replays = new ReplayBudget();
    // Idle kick (5.4); server/index.ts closes the socket
    onIdleKick: (session: Session) => void = () => { /* set by the server */ };

    constructor(readonly map: MapData, readonly options: RoomManagerOptions) {
        this.now = options.now ?? Date.now;
        this.defaultMapId = isMapId(map.mapId) ? map.mapId : DEFAULT_MAP_ID;
        this.resolveMapFn = options.mapResolver ?? ((id: MapId) => (id === map.mapId ? map : mapFor(id)));
        this.ghosts = options.ghosts ?? new MemoryGhostStore(run => {
            const runMap = this.resolveMap(run.key.mapId ?? this.defaultMapId);
            const { world, course } = trackRuntime(runMap, run.key.trackId);
            return replayRun(world, course, run).poses;
        });
        // Ghosts only fit the map, track, and sim they were driven on
        const dropped = this.ghosts.retain(trackIdsForMap(map).map(id => ghostKeyFor(map, id)));
        if (dropped > 0) console.log(`Ghost store: ${dropped} runs of old tracks dropped`);
        this.create(this.defaultMapId, DEFAULT_ROOM_KIND, 1);
    }

    resolveMap(mapId: MapId = this.defaultMapId): MapData {
        return this.resolveMapFn(mapId);
    }

    list(): Room[] {
        return [...this.rooms.values()];
    }

    get(id: string): Room | undefined {
        return this.rooms.get(id);
    }

    private create(mapId: MapId, kind: RoomKind, index: number, options: JoinOptions = {}): Room {
        const targetMap = this.resolveMap(mapId);
        const validTrack = options.track && trackIdsForMap(targetMap).includes(options.track) ? options.track : undefined;
        const room = kind === 'party' ? new PartyRoom(index, targetMap, this.now)
            : kind === 'race' ? new RaceRoom(index, targetMap, this.now, { track: validTrack })
                : kind === 'timetrial' ? new TimeTrialRoom(index, targetMap, this.now, { track: validTrack, ghosts: this.ghosts, replays: this.replays })
                    : new FreeRoamRoom(index, targetMap, this.now);
        this.rooms.set(room.id, room);
        this.orderedCache = null;
        room.onIdleKick = member => this.onIdleKick(member.session);
        console.log(`Room ${room.id} opened`);
        return room;
    }

    private capacity(room: Room): number {
        return room instanceof RaceRoom ? Math.min(RACE_ROOM_MAX_MEMBERS, this.options.maxPlayersPerRoom) : this.options.maxPlayersPerRoom;
    }

    // The fullest room of the map & kind with space that passes the filter (ties: the lowest index)
    private fullest(mapId: MapId, kind: RoomKind, filter: (room: Room) => boolean = () => true): Room | null {
        let best: Room | null = null;
        for (const room of this.rooms.values()) {
            if (room.mapId !== mapId || room.kind !== kind || room.size >= this.capacity(room) || !filter(room)) continue;
            if (!best || room.size > best.size || (room.size === best.size && room.index < best.index)) best = room;
        }
        return best;
    }

    /** The room of that map and kind a new player joins, created when all are full. */
    findOrCreate(kind: RoomKind, options: JoinOptions = {}): Room {
        const mapId = options.mapId && isMapId(options.mapId) ? options.mapId : this.defaultMapId;
        let best: Room | null = null;
        if (kind === 'race' && !options.fresh) {
            // A lobby to drive in before a race to watch
            best = this.fullest(mapId, kind, room => (room as RaceRoom).phase === 'lobby') ?? this.fullest(mapId, kind);
        } else if (kind !== 'race' && kind !== 'timetrial') {
            best = this.fullest(mapId, kind);
        }
        if (best) return best;
        let index = 1;
        while (this.rooms.has(roomIdFor(mapId, kind, index))) index++;
        return this.create(mapId, kind, index, options);
    }

    /** Puts a session without a room into a room of that map and kind. */
    join(session: Session, kind: RoomKind, options: JoinOptions = {}): RoomMember {
        if (session.member) throw new Error(`session ${session.id} is already in ${session.room?.id}`);
        return this.findOrCreate(kind, options).join(session);
    }

    /**
     * Moves a session to a room of another kind or map: leave the old room,
     * join the new one. The car shows up there right away if it was visible.
     * Returns null when the session already is in a room of that map and kind
     * (unless fresh asks for a new instance).
     */
    switch(session: Session, kind: RoomKind, options: JoinOptions = {}): RoomMember | null {
        const current = session.member;
        if (!current || !session.room) return this.join(session, kind, options);
        const targetMapId = options.mapId && isMapId(options.mapId) ? options.mapId : session.room.mapId;
        if (session.room.kind === kind && session.room.mapId === targetMapId && !options.fresh) return null;
        const wasReady = current.ready;
        const old = session.room;
        old.leave(current, 'switch');
        // The new one first: its index is never the old one's
        const member = this.findOrCreate(kind, { ...options, mapId: targetMapId }).join(session, { ready: wasReady });
        this.closeIfDone(old);
        return member;
    }

    /**
     * The session is back on a new page (a reload within the grace time):
     * a fresh membership behind the splash screen in a room of that map & kind,
     * with the Party score kept.
     */
    rejoin(session: Session, kind: RoomKind, mapId?: MapId): RoomMember {
        const room = session.room, member = session.member;
        const targetMapId = mapId && isMapId(mapId) ? mapId : (room?.mapId ?? this.defaultMapId);
        if (room && member) {
            if (room.kind === 'party' && kind === 'party') session.carryScore = room.scoreOf(member);
            room.leave(member, 'disconnect');
        }
        const joined = this.findOrCreate(kind, { mapId: targetMapId }).join(session);
        if (room) this.closeIfDone(room);
        return joined;
    }

    /** The session disconnected (or was kicked). */
    leave(session: Session, reason: 'disconnect' | 'kicked' = 'disconnect'): void {
        const room = session.room;
        if (!room || !session.member) return;
        room.leave(session.member, reason);
        this.closeIfDone(room);
    }

    // An empty race or time trial instance closes at once
    private closeIfDone(room: Room): void {
        if (room.size > 0 || (room.kind !== 'race' && room.kind !== 'timetrial') || this.rooms.get(room.id) !== room) return;
        this.close(room);
    }

    private close(room: Room): void {
        room.dispose();
        this.rooms.delete(room.id);
        this.orderedCache = null;
        console.log(`Room ${room.id} closed`);
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
        const permanentId = roomIdFor(this.defaultMapId, DEFAULT_ROOM_KIND, 1);
        for (const room of [...this.rooms.values()]) {
            if (room.id === permanentId) continue;
            if (room.size > 0 || now - room.emptySinceMs < this.options.emptyRoomTtlMs) continue;
            this.close(room);
        }
    }

    playerCount(): number {
        let count = 0;
        for (const room of this.rooms.values()) count += room.size;
        return count;
    }
}
