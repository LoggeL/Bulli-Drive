import type { DiscoveryDef } from '../../shared/map/discoverySchema.js';
import { DEFAULT_MAP_ID, isMapId, MAP_REGISTRY, type MapId } from '../../shared/map/registry.js';

// Pure, storage-backed discovery & easter-egg tracker for all playable maps.
// Evaluates all 5 DiscoveryTrigger kinds (proximity, horn, park, airtime, speed),
// persists per-map unlocked IDs in localStorage, tracks a pinned radar target,
// and notifies listeners (Codex UI, 3D beacon visuals, toast banner, server relay).

export const DISCOVERY_STORAGE_KEY = 'bulli-discoveries-v1';
const DEFAULT_PARK_MAX_SPEED_MS = 1.5;

export type DiscoveryStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

export interface DiscoverySample {
    x: number;
    z: number;
    /** Horizontal vehicle speed in m/s. */
    speedMs: number;
    /** True while vehicle wheels are off the ground. */
    airborne: boolean;
    /** Optional override for current continuous airborne duration in seconds. */
    airTimeSec?: number;
    /** Frame delta in seconds. */
    dt: number;
}

export interface DiscoveryProgress {
    found: number;
    total: number;
}

export type DiscoveryUnlockListener = (def: DiscoveryDef, progress: DiscoveryProgress) => void;

interface StoredDiscoveriesV1 {
    version: 1;
    found: Record<string, string[]>;
}

function defaultStorage(): DiscoveryStorage {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
}

function readStored(storage: DiscoveryStorage): Map<MapId, Set<string>> {
    const out = new Map<MapId, Set<string>>();
    if (!storage) return out;
    let raw: string | null = null;
    try {
        raw = storage.getItem(DISCOVERY_STORAGE_KEY);
    } catch {
        return out;
    }
    if (!raw) return out;
    try {
        const parsed = JSON.parse(raw) as Partial<StoredDiscoveriesV1> | null;
        if (!parsed || parsed.version !== 1 || !parsed.found || typeof parsed.found !== 'object') return out;
        for (const [mapId, list] of Object.entries(parsed.found)) {
            if (!isMapId(mapId) || !Array.isArray(list)) continue;
            const ids = list.filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (ids.length > 0) out.set(mapId, new Set(ids));
        }
    } catch {
        return out;
    }
    return out;
}

function writeStored(storage: DiscoveryStorage, foundByMap: Map<MapId, Set<string>>): void {
    if (!storage) return;
    const found: Record<string, string[]> = {};
    for (const [mapId, ids] of foundByMap) {
        if (ids.size > 0) found[mapId] = [...ids].sort();
    }
    const payload: StoredDiscoveriesV1 = { version: 1, found };
    try {
        storage.setItem(DISCOVERY_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // Private browsing or quota full: keep progress in memory for this session
    }
}

export class DiscoveryTracker {
    private readonly storage: DiscoveryStorage;
    private readonly foundByMap: Map<MapId, Set<string>>;
    private mapId: MapId = DEFAULT_MAP_ID;
    private defs: readonly DiscoveryDef[] = [];
    private readonly defById = new Map<string, DiscoveryDef>();
    private readonly parkTimers = new Map<string, number>();
    private airSec = 0;
    private pinnedId: string | null = null;
    private readonly unlockListeners = new Set<DiscoveryUnlockListener>();
    private readonly changeListeners = new Set<() => void>();

    constructor(storage?: DiscoveryStorage) {
        this.storage = storage === undefined ? defaultStorage() : storage;
        this.foundByMap = readStored(this.storage);
    }

    /** Switches active map definitions and resets transient timers & incompatible pin. */
    setMap(mapId: MapId, defs: readonly DiscoveryDef[]): void {
        this.mapId = mapId;
        this.defs = defs;
        this.defById.clear();
        for (const def of defs) this.defById.set(def.id, def);
        this.parkTimers.clear();
        this.airSec = 0;
        if (this.pinnedId && !this.defById.has(this.pinnedId)) {
            this.pinnedId = null;
        }
        this.notifyChange();
    }

    getMapId(): MapId {
        return this.mapId;
    }

    getDefinitions(): readonly DiscoveryDef[] {
        return this.defs;
    }

    getDefinition(id: string): DiscoveryDef | undefined {
        return this.defById.get(id);
    }

    getFoundIds(mapId: MapId = this.mapId): ReadonlySet<string> {
        return this.foundByMap.get(mapId) ?? EMPTY_SET;
    }

    isFound(id: string, mapId: MapId = this.mapId): boolean {
        return this.foundByMap.get(mapId)?.has(id) ?? false;
    }

    /** Progress for a map (uses loaded defs when querying active map, else registry count). */
    getProgress(mapId: MapId = this.mapId): DiscoveryProgress {
        const stored = this.foundByMap.get(mapId);
        if (mapId === this.mapId && this.defs.length > 0) {
            let found = 0;
            if (stored) {
                for (const def of this.defs) if (stored.has(def.id)) found++;
            }
            return { found, total: this.defs.length };
        }
        const total = MAP_REGISTRY[mapId].discoveryCount;
        const found = Math.min(total, stored?.size ?? 0);
        return { found, total };
    }

    /** Total discoveries unlocked across all registered maps. */
    getTotalProgress(): DiscoveryProgress {
        let found = 0;
        let total = 0;
        for (const id of Object.keys(MAP_REGISTRY) as MapId[]) {
            const p = this.getProgress(id);
            found += p.found;
            total += p.total;
        }
        return { found, total };
    }

    getPinnedId(): string | null {
        return this.pinnedId;
    }

    getPinnedDefinition(): DiscoveryDef | null {
        return this.pinnedId ? this.defById.get(this.pinnedId) ?? null : null;
    }

    pin(id: string | null): void {
        const next = id && this.defById.has(id) ? id : null;
        if (next === this.pinnedId) return;
        this.pinnedId = next;
        this.notifyChange();
    }

    onUnlock(listener: DiscoveryUnlockListener): () => void {
        this.unlockListeners.add(listener);
        return () => this.unlockListeners.delete(listener);
    }

    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    /** Evaluates proximity, park, airtime, and speed triggers for one simulation frame. */
    update(sample: DiscoverySample): DiscoveryDef[] {
        const dt = Number.isFinite(sample.dt) && sample.dt > 0 ? Math.min(sample.dt, 0.25) : 0;
        if (sample.airTimeSec !== undefined) {
            this.airSec = Number.isFinite(sample.airTimeSec) && sample.airTimeSec > 0 ? sample.airTimeSec : 0;
        } else if (sample.airborne) {
            this.airSec += dt;
        } else {
            this.airSec = 0;
        }

        if (this.defs.length === 0) return [];
        const speedMs = Math.abs(sample.speedMs);
        const speedKmh = speedMs * 3.6;
        const unlocked: DiscoveryDef[] = [];

        for (const def of this.defs) {
            if (this.isFound(def.id)) continue;
            const trigger = def.trigger;
            if (trigger.kind === 'horn') continue;

            const dx = sample.x - def.x;
            const dz = sample.z - def.z;
            const inside = dx * dx + dz * dz <= trigger.radius * trigger.radius;

            switch (trigger.kind) {
                case 'proximity':
                    if (inside) unlocked.push(def);
                    break;
                case 'park': {
                    const maxSpeed = trigger.maxSpeed ?? DEFAULT_PARK_MAX_SPEED_MS;
                    if (inside && speedMs <= maxSpeed) {
                        const held = (this.parkTimers.get(def.id) ?? 0) + dt;
                        this.parkTimers.set(def.id, held);
                        if (held >= trigger.holdSec) {
                            this.parkTimers.delete(def.id);
                            unlocked.push(def);
                        }
                    } else if (this.parkTimers.has(def.id)) {
                        this.parkTimers.delete(def.id);
                    }
                    break;
                }
                case 'airtime':
                    if (inside && this.airSec >= trigger.minAirSec) {
                        unlocked.push(def);
                    }
                    break;
                case 'speed':
                    if (inside && speedKmh >= trigger.minSpeedKmh) {
                        unlocked.push(def);
                    }
                    break;
            }
        }

        if (unlocked.length > 0) this.commitUnlocks(unlocked);
        return unlocked;
    }

    /** Evaluates horn-triggered discoveries near (x, z). */
    onHorn(x: number, z: number): DiscoveryDef[] {
        if (this.defs.length === 0) return [];
        const unlocked: DiscoveryDef[] = [];
        for (const def of this.defs) {
            if (this.isFound(def.id) || def.trigger.kind !== 'horn') continue;
            const dx = x - def.x;
            const dz = z - def.z;
            if (dx * dx + dz * dz <= def.trigger.radius * def.trigger.radius) {
                unlocked.push(def);
            }
        }
        if (unlocked.length > 0) this.commitUnlocks(unlocked);
        return unlocked;
    }

    /** Explicitly unlocks a discovery by ID on the active map (no-op if unknown or already found). */
    unlockById(id: string): DiscoveryDef | null {
        const def = this.defById.get(id);
        if (!def || this.isFound(id)) return null;
        this.commitUnlocks([def]);
        return def;
    }

    /** Current continuous park hold progress in [0, 1] for a park-triggered discovery. */
    parkProgress(id: string): number {
        const def = this.defById.get(id);
        if (!def || def.trigger.kind !== 'park' || def.trigger.holdSec <= 0) return 0;
        return Math.min(1, (this.parkTimers.get(id) ?? 0) / def.trigger.holdSec);
    }

    resetProgress(mapId?: MapId): void {
        if (mapId) this.foundByMap.delete(mapId);
        else this.foundByMap.clear();
        this.parkTimers.clear();
        writeStored(this.storage, this.foundByMap);
        this.notifyChange();
    }

    private commitUnlocks(defs: readonly DiscoveryDef[]): void {
        let bucket = this.foundByMap.get(this.mapId);
        if (!bucket) {
            bucket = new Set<string>();
            this.foundByMap.set(this.mapId, bucket);
        }
        const newlyAdded: DiscoveryDef[] = [];
        for (const def of defs) {
            if (bucket.has(def.id)) continue;
            bucket.add(def.id);
            if (this.pinnedId === def.id) this.pinnedId = null;
            newlyAdded.push(def);
        }
        if (newlyAdded.length === 0) return;
        writeStored(this.storage, this.foundByMap);
        const progress = this.getProgress(this.mapId);
        for (const def of newlyAdded) {
            for (const listener of this.unlockListeners) listener(def, progress);
        }
        this.notifyChange();
    }

    private notifyChange(): void {
        for (const listener of this.changeListeners) listener();
    }
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Shared client singleton (uses browser localStorage). */
export const discoveryTracker = new DiscoveryTracker();
