import type { TrackId } from '../../shared/race/types.js';
import {
    BOGGED_ACCEL, BOGGED_TICKS, DRAFT_ACCEL, DRAFT_FALL, DRAFT_FILL, DRAFT_RISE, DRAFT_TOP_ADD,
    GHOST_PERSONAL_MAX, LAUNCH_ACCEL, LAUNCH_THROTTLE, LAUNCH_TICKS, LAUNCH_WINDOW_TICKS, RESET_BEFORE_GATE
} from '../../shared/race/rules.js';
import { SIM_TUNING_DEFAULTS } from '../../shared/sim/constants.js';
import type { AssistProfile, CarClassId } from '../../shared/sim/types.js';
import { CAR_CLASS_IDS } from '../../shared/sim/vehicleClasses.js';
import { classDefaults, PROFILE_IDS, profileDefaults } from '../../shared/sim/tuning.js';
import { canonicalStringify, fnv1a } from '../../shared/world/mapData.js';

// Time trial ghosts (docs/phase-2-design.md, 15.1 and 15.3): the runs, the
// track record and the personal bests per ghost key. Phase 2 keeps them in
// memory (gone after a restart); phase 4 puts the same interface on SQLite
// (better-sqlite3 is synchronous, so the interface is too). The schema for
// then:
//
//   CREATE TABLE ghosts (
//     id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, track_version INTEGER NOT NULL,
//     map_version INTEGER NOT NULL, sim_hash TEXT NOT NULL, car_type TEXT NOT NULL, profile TEXT NOT NULL,
//     player_key TEXT NOT NULL, player_name TEXT NOT NULL, finish_ticks REAL NOT NULL,
//     gate_ticks TEXT NOT NULL, spawn_to_start INTEGER NOT NULL, inputs BLOB NOT NULL, recorded_at INTEGER NOT NULL
//   );
//   CREATE INDEX ghosts_best ON ghosts (track_id, track_version, map_version, sim_hash, finish_ticks);
//   CREATE INDEX ghosts_player ON ghosts (player_key, track_id, track_version, map_version, sim_hash, finish_ticks);

// A ghost only fits the track, the map and the sim it was driven on
export interface GhostKey {
    trackId: TrackId;
    trackVersion: number;
    mapVersion: number;
    simHash: string;
}

export interface GhostRun {
    key: GhostKey;
    carType: CarClassId;
    profile: AssistProfile;
    // Phase 2: the session id; phase 4: an anonymous device token
    playerKey: string;
    playerName: string;
    // Float ticks since startTick (sub-tick)
    finishTicks: number;
    // Times of every required crossing, for the splits
    gateTicks: number[];
    // Ticks from the grid spawn to startTick
    spawnToStart: number;
    // 4 B per tick from the grid spawn on (shared/race/replay.ts)
    inputs: Uint8Array;
    recordedAt: number;
}

export interface GhostStore {
    /** The track record (all classes). */
    best(key: GhostKey): GhostRun | null;
    personalBest(key: GhostKey, playerKey: string): GhostRun | null;
    /**
     * Keeps the run where it beats the record or the player's best. poses:
     * its pose track when the caller has it (the check replay), so a kept
     * run is not replayed again for it.
     */
    submit(run: GhostRun, poses?: Uint8Array): { record: boolean; personal: boolean };
    /** The run's pose track (computed on demand; the latest ones are kept). */
    poses(run: GhostRun): Uint8Array;
    /** The run's pose track if it is at hand, never computed (null: poses() would replay). */
    cachedPoses(run: GhostRun): Uint8Array | null;
}

/**
 * FNV-1a over the shipped sim defaults: the global tuning, the class and
 * assist parameters and the race rules that act on the car. A change of
 * the tuning gives new keys, so old ghosts are no longer offered.
 */
export function simHash(): string {
    const classes = Object.fromEntries(CAR_CLASS_IDS.map(id => [id, classDefaults(id)]));
    const profiles = Object.fromEntries(PROFILE_IDS.map(id => [id, profileDefaults(id)]));
    const race = {
        BOGGED_ACCEL, BOGGED_TICKS, DRAFT_ACCEL, DRAFT_FALL, DRAFT_FILL, DRAFT_RISE, DRAFT_TOP_ADD,
        LAUNCH_ACCEL, LAUNCH_THROTTLE, LAUNCH_TICKS, LAUNCH_WINDOW_TICKS, RESET_BEFORE_GATE
    };
    return fnv1a(canonicalStringify({ sim: SIM_TUNING_DEFAULTS, classes, profiles, race }));
}

export function ghostKeyString(key: GhostKey): string {
    return `${key.trackId}|${key.trackVersion}|${key.mapVersion}|${key.simHash}`;
}

// Pose tracks kept (least recently used out): about 23 kB each for 90 s
export const GHOST_POSE_CACHE_MAX = 16;

// Replays for pose tracks not at hand, per second and process (a replay of
// a 2 min run takes 15-20 ms in the tick), and how many may come at once
export const GHOST_REPLAYS_PER_S = 2;
export const GHOST_REPLAY_BURST = 2;

/**
 * Bounds the replays the time trial rooms of a process run in the tick
 * (docs/phase-2-design.md 25): a token bucket over the clock. Without it
 * a few sessions asking for more ghosts than the pose cache holds would
 * replay one in every tick.
 */
export class ReplayBudget {
    private tokens: number;
    private lastMs = NaN;

    constructor(readonly perSecond: number = GHOST_REPLAYS_PER_S, readonly burst: number = GHOST_REPLAY_BURST) {
        this.tokens = burst;
    }

    /** One replay now, if the budget has it. */
    take(nowMs: number): boolean {
        if (Number.isFinite(this.lastMs)) this.tokens = Math.min(this.burst, this.tokens + Math.max(0, nowMs - this.lastMs) * this.perSecond / 1000);
        this.lastMs = nowMs;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

interface KeyEntry {
    record: GhostRun | null;
    // Personal bests by player, oldest use first (Map keeps insertion order)
    personal: Map<string, GhostRun>;
}

export class MemoryGhostStore implements GhostStore {
    private readonly entries = new Map<string, KeyEntry>();
    // Oldest use first; a run no longer stored may linger until pushed out
    private readonly poseCache = new Map<GhostRun, Uint8Array>();

    /**
     * posesOf: replays a run into its pose track (the server passes the
     * replay on the run's race world). personalMax: personal bests kept per
     * key; the least recently used goes first.
     */
    constructor(
        private readonly posesOf: (run: GhostRun) => Uint8Array,
        private readonly personalMax: number = GHOST_PERSONAL_MAX
    ) {}

    private entry(key: GhostKey): KeyEntry {
        const k = ghostKeyString(key);
        let entry = this.entries.get(k);
        if (!entry) {
            entry = { record: null, personal: new Map() };
            this.entries.set(k, entry);
        }
        return entry;
    }

    best(key: GhostKey): GhostRun | null {
        return this.entries.get(ghostKeyString(key))?.record ?? null;
    }

    personalBest(key: GhostKey, playerKey: string): GhostRun | null {
        const entry = this.entries.get(ghostKeyString(key));
        const run = entry?.personal.get(playerKey);
        if (!entry || !run) return null;
        // A use keeps it: to the back of the LRU order
        entry.personal.delete(playerKey);
        entry.personal.set(playerKey, run);
        return run;
    }

    submit(run: GhostRun, poses?: Uint8Array): { record: boolean; personal: boolean } {
        const entry = this.entry(run.key);
        const own = entry.personal.get(run.playerKey);
        const personal = !own || run.finishTicks < own.finishTicks;
        if (personal) {
            entry.personal.delete(run.playerKey);
            entry.personal.set(run.playerKey, run);
            while (entry.personal.size > this.personalMax) {
                const oldest = entry.personal.keys().next().value as string;
                entry.personal.delete(oldest);
            }
        } else if (own) {
            entry.personal.delete(run.playerKey);
            entry.personal.set(run.playerKey, own);
        }
        const record = !entry.record || run.finishTicks < entry.record.finishTicks;
        if (record) entry.record = run;
        if (poses && (record || personal)) this.keepPoses(run, poses);
        return { record, personal };
    }

    poses(run: GhostRun): Uint8Array {
        const poses = this.cachedPoses(run) ?? this.posesOf(run);
        this.keepPoses(run, poses);
        return poses;
    }

    cachedPoses(run: GhostRun): Uint8Array | null {
        const poses = this.poseCache.get(run);
        if (!poses) return null;
        // A use keeps it: to the back of the LRU order
        this.poseCache.delete(run);
        this.poseCache.set(run, poses);
        return poses;
    }

    private keepPoses(run: GhostRun, poses: Uint8Array): void {
        this.poseCache.delete(run);
        while (this.poseCache.size >= GHOST_POSE_CACHE_MAX) this.poseCache.delete(this.poseCache.keys().next().value as GhostRun);
        this.poseCache.set(run, poses);
    }

    /** Bytes held in inputs and pose tracks (the 5 MB budget, docs/phase-2-design.md 19). */
    bytes(): number {
        const runs = new Set<GhostRun>();
        for (const entry of this.entries.values()) {
            if (entry.record) runs.add(entry.record);
            for (const run of entry.personal.values()) runs.add(run);
        }
        let total = 0;
        for (const run of runs) total += run.inputs.byteLength;
        for (const poses of this.poseCache.values()) total += poses.byteLength;
        return total;
    }
}
