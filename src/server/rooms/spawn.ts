import type { SpawnSlot } from '../../shared/map/mapData.js';

// Where a car (re)spawns (docs/phase-3-design.md, 3.5 and 12): the fixed
// slots of pois.json, per mode. Free Roam has groups of four at the plaza,
// the diner, the beach and the lookout, the Party sixteen slots round the
// arena. The groups take turns; within a group the first slot that keeps
// clear of the room's other cars and pickups is taken (a car must not earn
// a coin by spawning on it). Deterministic: the room counts the turns.

export interface SpawnPoint {
    x: number;
    z: number;
}

// Where a car spawns and which way it faces
export interface SpawnPose extends SpawnPoint {
    yaw: number;
}

// A circle no car spawns in (a coin or powerup with its pickup radius)
export interface SpawnKeepOut extends SpawnPoint {
    radius: number;
}

// Cars spawn at least this far apart (m)
export const SPAWN_PLAYER_SPACING = 12;

function clearsPlayers(point: SpawnPoint, others: readonly SpawnPoint[]): boolean {
    const minDistanceSq = SPAWN_PLAYER_SPACING * SPAWN_PLAYER_SPACING;
    for (const other of others) {
        const dx = point.x - other.x;
        const dz = point.z - other.z;
        if (dx * dx + dz * dz < minDistanceSq) return false;
    }
    return true;
}

function clearsKeepOut(point: SpawnPoint, keepOut: readonly SpawnKeepOut[]): boolean {
    for (const zone of keepOut) {
        const dx = point.x - zone.x;
        const dz = point.z - zone.z;
        if (dx * dx + dz * dz < zone.radius * zone.radius) return false;
    }
    return true;
}

function distanceToClosestSq(point: SpawnPoint, others: readonly SpawnPoint[]): number {
    let closest = Number.POSITIVE_INFINITY;
    for (const other of others) {
        const dx = point.x - other.x;
        const dz = point.z - other.z;
        closest = Math.min(closest, dx * dx + dz * dz);
    }
    return closest;
}

/**
 * The slots in the order turn `turn` tries them: the groups in turn from
 * group turn mod G (in the order they first appear), each group's slots
 * rotated by floor(turn / G), so a group handed out again starts at its
 * next slot.
 */
export function slotOrder(slots: readonly SpawnSlot[], turn: number): SpawnSlot[] {
    const groups: SpawnSlot[][] = [];
    const byName = new Map<string, SpawnSlot[]>();
    for (const slot of slots) {
        let group = byName.get(slot.group);
        if (!group) {
            group = [];
            byName.set(slot.group, group);
            groups.push(group);
        }
        group.push(slot);
    }
    const count = groups.length;
    const round = Math.floor(turn / count);
    const order: SpawnSlot[] = [];
    for (let g = 0; g < count; g++) {
        const group = groups[(turn + g) % count];
        for (let k = 0; k < group.length; k++) order.push(group[(round + k) % group.length]);
    }
    return order;
}

/**
 * The spawn pose for turn `turn`: the first slot in slotOrder that keeps
 * SPAWN_PLAYER_SPACING from the other cars of the room and is outside every
 * keep-out; if none is, the slot farthest from the other cars (a crowded
 * room still spawns on a road, never in a building).
 */
export function slotSpawn(
    slots: readonly SpawnSlot[], turn: number, others: readonly SpawnPoint[], keepOut: readonly SpawnKeepOut[] = []
): SpawnPose {
    if (slots.length === 0) throw new Error('no spawn slots');
    const order = slotOrder(slots, turn);
    const free = order.find(slot => clearsPlayers(slot, others) && clearsKeepOut(slot, keepOut));
    if (free) return { x: free.x, z: free.z, yaw: free.yaw };
    let best = order[0];
    let bestClearance = distanceToClosestSq(best, others);
    for (let i = 1; i < order.length; i++) {
        const clearance = distanceToClosestSq(order[i], others);
        if (clearance > bestClearance) {
            best = order[i];
            bestClearance = clearance;
        }
    }
    return { x: best.x, z: best.z, yaw: best.yaw };
}
