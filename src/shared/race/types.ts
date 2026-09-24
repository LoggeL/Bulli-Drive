// Data shapes of the race mode (docs/phase-2-design.md, 5.1 and 9).
// Conventions as in the sim: 1 u = 1 m, forward is (sin yaw, cos yaw), left
// is (cos yaw, -sin yaw); yaw = 0 points to +z, π/2 to +x.

export const TRACK_IDS = ['downtown-loop', 'hill-sprint'] as const;
export type TrackId = typeof TRACK_IDS[number];

export type RacePhase = 'lobby' | 'countdown' | 'racing' | 'finished' | 'results';

export type RacerStatus = 'racing' | 'finished' | 'dnf' | 'left';

export const BOT_LEVELS = ['easy', 'medium', 'hard'] as const;
export type BotLevel = typeof BOT_LEVELS[number];

export const RACE_VOTES = ['rematch', 'next'] as const;
export type RaceVote = typeof RACE_VOTES[number];

export interface Vec2 { x: number; z: number }

// A gate is a line segment of the given width through (x, z), across the
// driving direction yaw. Only a crossing in the driving direction counts.
export interface GateDef {
    x: number; z: number;
    yaw: number;                 // driving direction when passing
    width: number;               // m, segment from left (+w/2) to right (-w/2)
    visual: 'startFinish' | 'start' | 'finish' | 'arch';
}

// Grid slot k: position and heading, k = 0 is the pole
export interface GridSlot { x: number; z: number; yaw: number }

// Track limits and hints. Barriers and chevron posts collide in the race
// world only (E3); delineators and arrows are looks only.
export type TrackHint =
    // Row of water barriers across yaw (the row runs along the left axis),
    // collider: box 0.6 m deep, top 1.0; yaw a multiple of 90°
    | { kind: 'barrier'; x: number; z: number; yaw: number; length: number }
    // Direction board on 2 posts, facing yaw; collider: 2 circles r 0.35
    | { kind: 'chevron'; x: number; z: number; yaw: number; dir: 'left' | 'right' }
    // Delineator posts left and right of the line, looks only
    | { kind: 'delineators'; line: Vec2[]; offset: number; spacing: number }
    // Arrow painted on the road, looks only
    | { kind: 'arrow'; x: number; z: number; yaw: number };

export interface TrackDef {
    id: TrackId;
    name: string;
    kind: 'circuit' | 'sprint';
    laps: number;                // circuit 3, sprint 1
    mapVersion: number;          // map the track is built for
    trackVersion: number;        // +1 on every change of gates, grid, line or hints (ghost key)
    centerline: Vec2[];          // driving path (circuit: closed, last point ≠ first)
    lineOptions: { radius: number; apexShift: number };
    gates: GateDef[];            // in order; circuit: gates[0] is start/finish
    grid: GridSlot[];            // at least MAX_RACERS slots behind gates[0]
    hints: TrackHint[];
    minimap: { minX: number; maxX: number; minZ: number; maxZ: number };
}
