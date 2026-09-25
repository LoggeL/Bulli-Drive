import type { RaceResultEntry, ServerMessage } from '../../shared/protocol.js';
import { toBase64 } from '../../shared/race/ghostTrack.js';
import { replayRun, RunRecorder } from '../../shared/race/replay.js';
import { GHOST_POSE_HZ, TIMETRIAL_PREP_TICKS } from '../../shared/race/rules.js';
import type { VehicleInput } from '../../shared/sim/types.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import type { MapData } from '../../shared/map/mapData.js';
import { ghostKeyString, ReplayBudget, simHash, type GhostKey, type GhostRun, type GhostStore } from '../race/ghostStore.js';
import { RaceRoom, trackRuntime, type Racer, type RaceRoomOptions } from './RaceRoom.js';
import type { RoomMember } from './Room.js';

// The time trial (docs/phase-2-design.md, 6.2 and 15): one player alone on
// the track, no bots, no slipstream partner. START and RETRY begin a
// countdown at once (the shorter preparation). The room records the input
// the car took in every tick from the grid spawn; a finished run is
// replayed (it must give the same finish time bit for bit) and kept in the
// ghost store. At the countdown the player gets the ghost to race: their
// own best, else the track record; only when it is not the one they already
// have (the client keeps it in the room while the track stays). RETRY is
// ignored in the countdown, so a client cannot start one per message. A
// pose track that is not at hand waits for the process's replay budget.

export interface TimeTrialOptions extends RaceRoomOptions {
    ghosts: GhostStore;
    // Shared by the process's time trial rooms (RoomManager); default: the room's own
    replays?: ReplayBudget;
}

const SIM_HASH = simHash();

export function ghostKeyFor(map: MapData, trackId: RaceRoom['trackId']): GhostKey {
    const track = trackRuntime(map, trackId).track;
    return { trackId, trackVersion: track.trackVersion, mapVersion: track.mapVersion, simHash: SIM_HASH };
}

// The same run (a store on a database hands out new objects)
function runId(run: GhostRun): string {
    return `${ghostKeyString(run.key)}|${run.playerKey}|${run.finishTicks}|${run.recordedAt}`;
}

export class TimeTrialRoom extends RaceRoom {
    protected readonly mode = 'timetrial' as const;
    private readonly ghosts: GhostStore;
    private readonly replays: ReplayBudget;
    private readonly recorder = new RunRecorder();
    // The ghost the player's client has, and the one still to send (its pose track not at hand yet)
    private ghostSent: string | null = null;
    private ghostDue: { run: GhostRun; kind: 'personal' | 'record' } | null = null;
    private spawnTick = -1;
    private recordNote: { record: { name: string; finishTicks: number } | null; personal: { finishTicks: number; improved: boolean } | null } | null = null;
    // Runs dropped because the replay disagreed (a bug; logged)
    rejectedRuns = 0;

    constructor(index: number, map: MapData, now: () => number = Date.now, options: TimeTrialOptions) {
        super(index, map, now, options, 'timetrial');
        this.ghosts = options.ghosts;
        this.replays = options.replays ?? new ReplayBudget();
        this.prepTicks = TIMETRIAL_PREP_TICKS;
        this.allReadyTicks = 0;
        this.fieldTarget = 0;
    }

    get ghostKey(): GhostKey {
        return ghostKeyFor(this.map, this.trackId);
    }

    // The track changes only on purpose (raceConfig, a 'next' vote)
    protected trackAfterVote(rematch: number, next: number): RaceRoom['trackId'] {
        return next > rematch ? super.trackAfterVote(rematch, next) : this.trackId;
    }

    // RETRY, in any phase but the countdown: a new countdown at once
    protected onRestart(member: RoomMember): void {
        if (member.bot || !member.ready || this.phase === 'countdown') return;
        this.startCountdown(this.tick, [member]);
    }

    protected onCountdown(T0: number): void {
        this.spawnTick = T0;
        this.recorder.clear();
        this.recordNote = null;
        this.ghostDue = null;
        const member = this.racers[0]?.member;
        if (!member) return;
        const key = this.ghostKey;
        const personal = this.ghosts.personalBest(key, member.session.id);
        const ghost = personal ?? this.ghosts.best(key);
        if (!ghost || runId(ghost) === this.ghostSent) return;
        this.ghostDue = { run: ghost, kind: personal ? 'personal' : 'record' };
        this.sendGhost();
    }

    // The due ghost, once its pose track is at hand or the budget allows a replay
    private sendGhost(): void {
        const due = this.ghostDue;
        const member = this.racers[0]?.member;
        if (!due || !member) return;
        const poses = this.ghosts.cachedPoses(due.run) ?? (this.replays.take(this.now()) ? this.ghosts.poses(due.run) : null);
        if (!poses) return;
        this.ghostDue = null;
        this.ghostSent = runId(due.run);
        const ghost = due.run;
        this.sendTo(member, {
            type: 'ghostData',
            kind: due.kind,
            name: ghost.playerName,
            carType: ghost.carType,
            finishTicks: ghost.finishTicks,
            gateTicks: ghost.gateTicks,
            hz: GHOST_POSE_HZ,
            poses: toBase64(poses)
        });
    }

    protected afterStep(T: number): void {
        super.afterStep(T);
        if (this.ghostDue) this.sendGhost();
    }

    // The client drops its ghost with the track, and everything on a new page or socket
    protected onTrackChanged(): void {
        this.ghostSent = null;
    }

    resume(member: RoomMember): void {
        this.ghostSent = null;
        super.resume(member);
    }

    protected onRacerInput(racer: Racer, input: VehicleInput, _tick: number): void {
        if (racer.progress.status === 'racing' && this.spawnTick >= 0) this.recorder.push(input);
    }

    protected onRacerFinished(racer: Racer, _tick: number): void {
        const member = racer.member;
        if (!member || racer.progress.finishTicks === null || this.startTick === null) return;
        const session = member.session;
        const run: GhostRun = {
            key: this.ghostKey,
            carType: isCarClassId(racer.carType) ? racer.carType : 'bulli',
            profile: session.profile,
            playerKey: session.id,
            playerName: session.name,
            finishTicks: racer.progress.finishTicks,
            gateTicks: [...racer.progress.gateTimes],
            spawnToStart: this.startTick - this.spawnTick,
            inputs: this.recorder.finish(),
            recordedAt: this.now()
        };
        const { world, course } = this.runtime;
        const replay = replayRun(world, course, run);
        if (replay.finishTicks !== run.finishTicks) {
            this.rejectedRuns++;
            console.warn(`Time trial run of ${session.name} on ${this.trackId} dropped: replay finished at ${replay.finishTicks}, the room at ${run.finishTicks}`);
            return;
        }
        const before = this.ghosts.personalBest(run.key, run.playerKey);
        const outcome = this.ghosts.submit(run, replay.poses);
        const record = this.ghosts.best(run.key);
        this.recordNote = {
            record: record ? { name: record.playerName, finishTicks: record.finishTicks } : null,
            personal: { finishTicks: Math.min(run.finishTicks, before?.finishTicks ?? Infinity), improved: outcome.personal && before !== null }
        };
    }

    protected resultsMessage(entries: RaceResultEntry[]): Extract<ServerMessage, { type: 'raceResults' }> {
        const message = super.resultsMessage(entries);
        const note = this.recordNote;
        if (note?.record) message.record = note.record;
        if (note?.personal) message.personal = note.personal;
        return message;
    }
}
