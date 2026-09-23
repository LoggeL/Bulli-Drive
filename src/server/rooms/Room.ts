import type {
    ClientMessage,
    CoinData,
    PlayerData,
    PowerupData,
    RoomInfo,
    RoomKind,
    ScoreboardEntry,
    ServerMessage
} from '../../shared/protocol.js';
import { WORLD_BOUND } from '../../shared/constants.js';
import type { MapData } from '../../shared/world/mapData.js';
import { HONK_INTERVAL_MS, MIN_UPDATE_INTERVAL_MS, Y_MAX, Y_MIN } from '../config.js';
import type { Session } from '../session.js';
import { randomSpawn, type SpawnPoint } from './spawn.js';

// A room instance (docs/phase-1b-design.md, 2): its members and everything
// that changes while they play. The map itself (MapData) is shared by all
// rooms and never mutated. Until the server simulates (phase 1b, step 8)
// the clients still send their positions ('update') and a room relays them
// to its own members only.

export type LeaveReason = 'disconnect' | 'switch' | 'closed';

// Slots are u8 (the binary snapshots of step 8 address cars by slot) and are
// only handed out again after a delay, so a late snapshot never shows a new
// player in the place of the one who left.
export const SLOT_COUNT = 256;
export const SLOT_REUSE_DELAY_MS = 5000;

export interface RoomMember {
    readonly id: string;
    readonly session: Session;
    readonly slot: number;
    // Past the splash screen: visible to the others, on the scoreboard
    ready: boolean;
    x: number;
    y: number;
    z: number;
    angle: number;
    flipAngle: number;
    isFlipping: boolean;
    // Time of the last position update (AFK rule of the Party)
    lastActivity: number;
}

// What a client needs to show a room: sent in 'init' and 'roomJoined'
export interface RoomSnapshot {
    room: RoomInfo;
    spawn: SpawnPoint;
    players: Record<string, PlayerData>;
    powerups: PowerupData[];
    coins: CoinData[];
    scoreboard: ScoreboardEntry[];
}

// Messages about the session itself (name, car, room) are handled before
// they reach a room (server/dispatch.ts)
export type RoomMessage = Exclude<ClientMessage, { type: 'rename' | 'setCarType' | 'joinRoom' }>;
type Msg<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

export abstract class Room {
    readonly id: string;
    readonly members = new Map<string, RoomMember>();
    // Since when the room has no members (ms), 0 while it has some
    emptySinceMs: number;
    private readonly slotFreedAt = new Map<number, number>();

    constructor(
        readonly kind: RoomKind,
        readonly index: number,
        readonly map: MapData,
        protected readonly now: () => number = Date.now
    ) {
        this.id = `${kind}-${index}`;
        this.emptySinceMs = now();
    }

    get info(): RoomInfo {
        return { id: this.id, kind: this.kind, index: this.index };
    }

    get size(): number {
        return this.members.size;
    }

    // ---- Membership ----

    /**
     * Adds the session at a free spawn point. ready = true (a room switch
     * after the splash screen) shows the car to the others right away.
     */
    join(session: Session, options: { ready?: boolean } = {}): RoomMember {
        const occupied = [...this.members.values()].map(m => ({ x: m.x, z: m.z }));
        const spawn = randomSpawn(this.map.world.city, occupied);
        const member: RoomMember = {
            id: session.id,
            session,
            slot: this.allocateSlot(),
            ready: false,
            x: spawn.x,
            y: 0,
            z: spawn.z,
            angle: 0,
            flipAngle: 0,
            isFlipping: false,
            lastActivity: this.now()
        };
        this.members.set(member.id, member);
        session.room = this;
        session.member = member;
        this.emptySinceMs = 0;
        this.onJoin(member);
        if (options.ready) this.markReady(member);
        return member;
    }

    leave(member: RoomMember, reason: LeaveReason): void {
        if (this.members.get(member.id) !== member) return;
        this.members.delete(member.id);
        this.slotFreedAt.set(member.slot, this.now());
        this.onLeave(member, reason);
        if (member.session.member === member) {
            member.session.room = null;
            member.session.member = null;
        }
        if (member.ready) {
            this.broadcast({ type: 'removePlayer', id: member.id });
            this.membersChanged();
        }
        if (this.members.size === 0) this.emptySinceMs = this.now();
    }

    // Lowest slot that is neither taken nor freed less than SLOT_REUSE_DELAY_MS ago
    private allocateSlot(): number {
        const taken = new Set([...this.members.values()].map(m => m.slot));
        const now = this.now();
        let fallback = -1;
        for (let slot = 0; slot < SLOT_COUNT; slot++) {
            if (taken.has(slot)) continue;
            const freedAt = this.slotFreedAt.get(slot);
            if (freedAt === undefined || now - freedAt >= SLOT_REUSE_DELAY_MS) return slot;
            if (fallback < 0) fallback = slot;
        }
        if (fallback < 0) throw new Error(`room ${this.id} has no free slot`);
        return fallback;
    }

    snapshotFor(member: RoomMember): RoomSnapshot {
        return {
            room: this.info,
            spawn: { x: member.x, z: member.z },
            players: this.publicPlayers(),
            powerups: this.powerupList(),
            coins: this.coinList(),
            scoreboard: this.scoreboard()
        };
    }

    // ---- Messages ----

    onMessage(member: RoomMember, msg: RoomMessage): void {
        switch (msg.type) {
            case 'update': return this.handleUpdate(member, msg);
            case 'honk': return this.handleHonk(member);
            case 'playerReady': return this.markReady(member);
            default: return this.onGameMessage(member, msg);
        }
    }

    // The session was renamed (server/dispatch.ts)
    onRenamed(member: RoomMember): void {
        if (!member.ready) return;
        this.broadcast({ type: 'playerRenamed', id: member.id, name: member.session.name });
        this.membersChanged();
    }

    private handleUpdate(member: RoomMember, msg: Msg<'update'>): void {
        if (!member.ready) return;
        const now = this.now();
        const session = member.session;
        if (now - session.lastUpdateAt < MIN_UPDATE_INTERVAL_MS) return;
        // x/z/angle/flipAngle are finite numbers (schema); y may be missing.
        const y = typeof msg.y === 'number' && Number.isFinite(msg.y) ? msg.y : 0;

        session.lastUpdateAt = now;
        member.x = clamp(msg.x, -WORLD_BOUND, WORLD_BOUND);
        member.y = clamp(y, Y_MIN, Y_MAX);
        member.z = clamp(msg.z, -WORLD_BOUND, WORLD_BOUND);
        member.angle = msg.angle;
        member.flipAngle = msg.flipAngle;
        member.isFlipping = msg.isFlipping;
        member.lastActivity = now;

        this.broadcastPlayerState(member, member.id);
    }

    private handleHonk(member: RoomMember): void {
        if (!member.ready) return;
        const now = this.now();
        const session = member.session;
        if (now - session.lastHonkAt < HONK_INTERVAL_MS) return;
        session.lastHonkAt = now;
        this.broadcast({ type: 'honk', id: member.id }, member.id);
    }

    private markReady(member: RoomMember): void {
        if (member.ready) return;
        member.ready = true;
        this.broadcast({ type: 'newPlayer', player: this.publicPlayer(member) }, member.id);
        this.membersChanged();
    }

    // ---- Sending ----

    // To every member of this room (ready or not: the splash screen shows the
    // live game behind it). Movement updates are dropped for backed-up sockets.
    broadcast(msg: ServerMessage, excludeId?: string): void {
        const data = JSON.stringify(msg);
        const droppable = msg.type === 'update';
        for (const member of this.members.values()) {
            if (member.id === excludeId) continue;
            member.session.sendRaw(data, droppable);
        }
    }

    protected broadcastPlayerState(member: RoomMember, excludeId?: string): void {
        if (!member.ready) return;
        const flags = this.stateFlags(member);
        this.broadcast({
            type: 'update',
            id: member.id,
            x: member.x,
            z: member.z,
            y: member.y,
            angle: member.angle,
            flipAngle: member.flipAngle,
            isFlipping: member.isFlipping,
            scale: flags.scale,
            ghostActive: flags.ghostActive,
            shieldActive: flags.shieldActive
        }, excludeId);
    }

    publicPlayer(member: RoomMember): PlayerData {
        const extras = this.stateFlags(member);
        return {
            id: member.id,
            color: member.session.color,
            name: member.session.name,
            carType: member.session.carType,
            x: member.x,
            z: member.z,
            angle: member.angle,
            flipAngle: member.flipAngle,
            isFlipping: member.isFlipping,
            scale: extras.scale,
            score: extras.score,
            health: extras.health
        };
    }

    publicPlayers(): Record<string, PlayerData> {
        const players: Record<string, PlayerData> = {};
        for (const member of this.members.values()) {
            if (member.ready) players[member.id] = this.publicPlayer(member);
        }
        return players;
    }

    // ---- Extension points of the room types ----

    protected onJoin(_member: RoomMember): void { /* no per-member state */ }
    protected onLeave(_member: RoomMember, _reason: LeaveReason): void { /* no per-member state */ }
    // Game messages beyond driving (items, shooting); ignored by default
    protected onGameMessage(_member: RoomMember, _msg: RoomMessage): void { /* ignored */ }
    // A member became visible, left or was renamed
    protected membersChanged(): void { /* no scoreboard */ }

    protected stateFlags(_member: RoomMember): { scale: number; score: number; health: number; ghostActive: boolean; shieldActive: boolean } {
        return { scale: 1, score: 0, health: 100, ghostActive: false, shieldActive: false };
    }

    powerupList(): PowerupData[] { return []; }
    coinList(): CoinData[] { return []; }
    scoreboard(): ScoreboardEntry[] { return []; }

    // Stops every timer; the room is closed and never used again
    dispose(): void {
        for (const member of [...this.members.values()]) this.leave(member, 'closed');
    }
}
