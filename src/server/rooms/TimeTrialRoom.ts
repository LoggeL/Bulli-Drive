import type { RaceResultEntry, ServerMessage } from '../../shared/protocol.js';
import { toBase64 } from '../../shared/race/ghostTrack.js';
import { replayRun, RunRecorder } from '../../shared/race/replay.js';
import { GHOST_POSE_HZ, TIMETRIAL_PREP_TICKS } from '../../shared/race/rules.js';
import type { VehicleInput } from '../../shared/sim/types.js';
import { isCarClassId } from '../../shared/sim/vehicleClasses.js';
import type { MapData } from '../../shared/world/mapData.js';
import { simHash, type GhostKey, type GhostRun, type GhostStore } from '../race/ghostStore.js';
import { RaceRoom, trackRuntime, type Racer, type RaceRoomOptions } from './RaceRoom.js';
import type { RoomMember } from './Room.js';

// The time trial (docs/phase-2-design.md, 6.2 and 15): one player alone on
// the track, no bots, no slipstream partner. START and RETRY begin a
// countdown at once (the shorter preparation). The room records the input
// the car took in every tick from the grid spawn; a finished run is
// replayed (it must give the same finish time bit for bit) and kept in the
// ghost store. At the countdown the player gets the ghost to race: their
// own best, else the track record.

export interface TimeTrialOptions extends RaceRoomOptions {
    ghosts: GhostStore;
}

const SIM_HASH = simHash();

export function ghostKeyFor(map: MapData, trackId: RaceRoom['trackId']): GhostKey {
    const track = trackRuntime(map, trackId).track;
    return { trackId, trackVersion: track.trackVersion, mapVersion: track.mapVersion, simHash: SIM_HASH };
}

export class TimeTrialRoom extends RaceRoom {
    protected readonly mode = 'timetrial' as const;
    private readonly ghosts: GhostStore;
    private readonly recorder = new RunRecorder();
    private spawnTick = -1;
    private recordNote: { record: { name: string; finishTicks: number } | null; personal: { finishTicks: number; improved: boolean } | null } | null = null;
    // Runs dropped because the replay disagreed (a bug; logged)
    rejectedRuns = 0;

    constructor(index: number, map: MapData, now: () => number = Date.now, options: TimeTrialOptions) {
        super(index, map, now, options, 'timetrial');
        this.ghosts = options.ghosts;
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

    // RETRY, in any phase: a new countdown at once
    protected onRestart(member: RoomMember): void {
        if (member.bot || !member.ready) return;
        this.startCountdown(this.tick, [member]);
    }

    protected onCountdown(T0: number): void {
        this.spawnTick = T0;
        this.recorder.clear();
        this.recordNote = null;
        const racer = this.racers[0];
        const member = racer?.member;
        if (!member) return;
        const key = this.ghostKey;
        const personal = this.ghosts.personalBest(key, member.session.id);
        const ghost = personal ?? this.ghosts.best(key);
        if (!ghost) return;
        this.sendTo(member, {
            type: 'ghostData',
            kind: personal ? 'personal' : 'record',
            name: ghost.playerName,
            carType: ghost.carType,
            finishTicks: ghost.finishTicks,
            gateTicks: ghost.gateTicks,
            hz: GHOST_POSE_HZ,
            poses: toBase64(this.ghosts.poses(ghost))
        });
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
        const outcome = this.ghosts.submit(run);
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
