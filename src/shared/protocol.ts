// Shared wire protocol - single source of truth for client and server.
// Field shapes must match what is actually serialized on each side.

import * as v from 'valibot';

// Bumped on every incompatible wire change. The client sends it in 'hello';
// the server rejects any other version with reload: true
// (docs/phase-1b-design.md, 3.2). There is no adapter for old versions.
// v3 (docs/phase-2-design.md, 16): draft in the self block, launch/bogged
// mod bits, race-ghost and drafting car flags.
export const PROTOCOL_VERSION = 3;

// ---------- DTOs ----------

export interface TerrainConfig {
    size: number;
    segments: number;
    frequency1: number;
    amplitude1: number;
    frequency2: number;
    amplitude2: number;
    frequency3: number;
    amplitude3: number;
}

export interface PowerupData {
    id: number;
    x: number;
    z: number;
    type: string;
    color: number;
    label: string;
    collected: boolean;
}

export interface CoinData {
    id: number;
    x: number;
    z: number;
    collected: boolean;
}

export interface TreeData {
    id: number;
    x: number;
    z: number;
    height: number;
}

export interface BuildingData {
    x: number;
    z: number;
    width: number;
    depth: number;
    height: number;
    color: number;
}

export interface RoadData {
    x: number;
    z: number;
    width: number;
    length: number;
    rotation: number;
}

export interface CityData {
    buildings: BuildingData[];
    roads: RoadData[];
}

// Room types (docs/phase-1b-design.md, section 2): the Party with coins,
// powerups, shooting and HP is the default; Free Roam only drives and bumps.
export const ROOM_KINDS = ['party', 'freeroam'] as const;
export type RoomKind = typeof ROOM_KINDS[number];
export const DEFAULT_ROOM_KIND: RoomKind = 'party';

export function isRoomKind(value: unknown): value is RoomKind {
    return typeof value === 'string' && (ROOM_KINDS as readonly string[]).includes(value);
}

// The room instance a player is in: id 'party-1', kind 'party', index 1
export interface RoomInfo {
    id: string;
    kind: RoomKind;
    index: number;
}

export interface ScoreboardEntry {
    id: string;
    name: string;
    score: number;
    color: number;
}

// ---------- Shared shapes ----------

export const ASSIST_PROFILE_IDS = ['standard', 'touch'] as const;
export type ProfileId = typeof ASSIST_PROFILE_IDS[number];

// A member of a room as the others see it. slot addresses the car in the
// binary snapshots.
export interface MemberInfo {
    id: string;
    slot: number;
    name: string;
    color: number;
    carType: string;
    profile: ProfileId;
    // Past the splash screen (only ready members drive and are listed)
    ready: boolean;
}

// The map is generated on both sides from the seed; the hash proves the
// client built the same world and colliders (3.2)
export interface WorldRef {
    seed: number;
    mapVersion: number;
    worldHash: string;
}

export type LeaveReason = 'disconnect' | 'switch' | 'closed' | 'kicked';

// ---------- Client -> Server (JSON) ----------
// Runtime schemas: the server validates every inbound text frame against
// these and drops anything that does not match (and counts it against the
// policy limit). The TypeScript types are derived from them, so sender and
// validator cannot drift apart. Non-finite numbers never pass (3.1).

const finiteNumber = v.pipe(v.number(), v.finite());
const shortString = (max: number) => v.pipe(v.string(), v.maxLength(max));

export const HelloSchema = v.object({
    type: v.literal('hello'),
    protocolVersion: v.pipe(v.number(), v.integer()),
    // The page's build stamp (null from the Vite dev server)
    build: v.nullable(shortString(64)),
    // Random per page load, only kept in memory (duplicated tabs, 11.1)
    connId: shortString(64),
    sessionToken: v.optional(shortString(64)),
    // Resume ticket from a 'shutdown' (11.3)
    resume: v.optional(shortString(1024)),
    // Length and control characters are cleaned up by the server
    name: shortString(200),
    // Unknown car types fall back to the Bulli (VALID_CAR_TYPES)
    carType: shortString(32),
    profile: v.picklist(ASSIST_PROFILE_IDS),
    room: v.picklist(ROOM_KINDS)
});

export type HelloMessage = v.InferOutput<typeof HelloSchema>;

export const ClientMessageSchema = v.variant('type', [
    HelloSchema,
    // Past the splash screen: the car spawns
    v.object({ type: v.literal('ready') }),
    // Clock sync (3.7); t is the client's performance.now()
    v.object({ type: v.literal('ping'), t: finiteNumber }),
    // Moves the player into a room of that kind (the fullest one with room)
    v.object({ type: v.literal('joinRoom'), kind: v.picklist(ROOM_KINDS) }),
    v.object({ type: v.literal('setCar'), carType: shortString(32), profile: v.picklist(ASSIST_PROFILE_IDS) }),
    v.object({ type: v.literal('rename'), name: shortString(200) }),
    v.object({ type: v.literal('honk') }),
    v.object({ type: v.literal('shoot'), targetId: shortString(64) }),
    v.object({ type: v.literal('visibility'), hidden: v.boolean() }),
    // E2E only (server started with E2E=1): puts the own car at rest there
    v.object({ type: v.literal('debugPlace'), x: finiteNumber, z: finiteNumber, yaw: finiteNumber })
]);

export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

// Returns the validated message (unknown keys stripped), or null if the
// value is not a well-formed client message.
export function parseClientMessage(value: unknown): ClientMessage | null {
    const result = v.safeParse(ClientMessageSchema, value);
    return result.success ? result.output : null;
}

// The binary input packet after decoding (shared/net/codec.ts) goes through
// this schema too, so the binary path has the same single source. The value
// ranges are clamped afterwards (server/rooms/InputBuffer.ts).
const u32 = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffffffff));
const byteInt = v.pipe(v.number(), v.integer(), v.minValue(-128), v.maxValue(255));
export const InputPacketSchema = v.object({
    flags: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)),
    seq: u32,
    tick: u32,
    inputs: v.pipe(v.array(v.object({
        steer: byteInt,
        throttle: byteInt,
        brake: byteInt,
        buttons: byteInt
    })), v.minLength(1), v.maxLength(8))
});

// ---------- Server -> Client (JSON) ----------

export type RejectReason = 'version' | 'hello' | 'full';

// Events of a tick (3.6), sent in one 'events' message before the snapshot
// of the same snapshot tick. Every event carries its own tick where the sim
// needs it.
export type GameEvent =
    // The car appears (after 'ready' or a room switch) at rest, facing yaw
    | { type: 'spawn'; id: string; tick: number; x: number; z: number; yaw: number }
    // A car-car contact from CONTACT_EVENT_MIN_DV on (for sound and sparks)
    | { type: 'contact'; a: string; b: string; dv: number; x: number; z: number }
    // kind 'powerup' carries the effect window [startTick, endTick)
    | { type: 'pickup'; kind: 'coin' | 'powerup'; itemId: number; playerId: string; powerupType?: string; startTick?: number; endTick?: number }
    | { type: 'itemReset'; kind: 'coin' | 'powerup'; itemId: number }
    | { type: 'hit'; target: string; source: string; damage: number; health: number; cause: 'shot' | 'ram' }
    | { type: 'killed'; target: string; killer: string; killerName: string; targetName: string; cause: 'shot' | 'ram' }
    // Back from the dead at (x, z): the car state is reset at tick
    | { type: 'respawn'; id: string; tick: number; x: number; z: number; yaw: number; health: number }
    | { type: 'carChanged'; id: string; carType: string; profile: ProfileId; tick: number }
    | { type: 'honk'; id: string };

// The own car of a resumed session: whether it is in the sim, the tick it
// last spawned (respawn shield) and its powerup windows
export interface ResumeState {
    alive: boolean;
    spawnTick: number;
    powerups: { type: string; startTick: number; endTick: number }[];
}

export interface RoomStateItems {
    powerups: { id: number; collected: boolean }[];
    coins: { id: number; collected: boolean }[];
}

export type ServerMessage =
    | { type: 'reject'; reason: RejectReason; reload: boolean; serverProtocol: number }
    | { type: 'welcome'; playerId: string; sessionToken: string; resumed: boolean; serverBuild: string | null; tickRate: number; snapshotRate: number; color: number; name: string }
    // After 'welcome' and after every room switch. items only in the Party
    | {
        type: 'roomState';
        room: RoomInfo;
        tick: number;
        world: WorldRef;
        members: MemberInfo[];
        items: RoomStateItems | null;
        scoreboard: ScoreboardEntry[];
        health: Record<string, number>;
        // Where the camera looks while the splash screen is up
        preview: { x: number; z: number; yaw: number };
        // Only for a resumed session (11.1): the own car goes on as the
        // server has it; the client takes its state from the next snapshot
        resume?: ResumeState;
    }
    | { type: 'playerJoined'; member: MemberInfo }
    | { type: 'playerLeft'; id: string; reason: LeaveReason }
    | { type: 'playerUpdated'; id: string; name?: string; carType?: string; profile?: ProfileId }
    // Clock sync: the room tick and how far (0..1) the running tick interval is
    | { type: 'pong'; t: number; tick: number; sub: number }
    | { type: 'events'; tick: number; list: GameEvent[] }
    // The top 10, and for the receiver its own score and rank (also when it
    // is not among the 10; missing from older servers)
    | { type: 'scoreboard'; scoreboard: ScoreboardEntry[]; own?: { score: number; rank: number } }
    | { type: 'shutdown'; reconnectInMs: number; resume?: string }
    | { type: 'kicked'; reason: 'policy' | 'idle' };
