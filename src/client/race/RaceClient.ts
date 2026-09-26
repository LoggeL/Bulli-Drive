import * as THREE from 'three';
import type { GameEvent, RaceStateBody, RoomInfo, ServerMessage } from '../../shared/protocol.js';
import { TICK_RATE } from '../../shared/net/constants.js';
import { raceGhostFloor, raceInputFilter } from '../../shared/race/inputFilter.js';
import { applyLaunchMods } from '../../shared/race/launch.js';
import { createRaceWorld } from '../../shared/race/raceWorld.js';
import type { TrackId } from '../../shared/race/types.js';
import type { SimWorld } from '../../shared/world/colliders.js';
import type { MapData } from '../../shared/map/mapData.js';
import { gameTrack } from '../map/gameMap.js';
import { inputManager } from '../input/InputManager.js';
import { netDriver } from '../net/netDriver.js';
import { sendToServer } from '../network/socket.js';
import { state } from '../state.js';
import { minimapRace, setMinimapTrack } from '../ui/minimap.js';
import { isRaceKind, requestRoom } from '../ui/roomMenu.js';
import { setWorldOverride } from '../vehicle/simWorldClient.js';
import { GhostCar } from './GhostCar.js';
import { GhostPlayback } from './ghostPlayback.js';
import { arrowDegrees, RaceModel, type GhostMessage } from './raceModel.js';
import { initRaceUi, renderHud, renderLobby, renderResults, type ArrowView } from './raceUi.js';
import { lampsFor, TrackDressing } from './TrackDressing.js';

// The race on the client (docs/phase-2-design.md, 17): the race and time
// trial rooms' messages and events into the model, the prediction with
// the race world and the race rules the server applies (freeze, start
// ghost, launch), the touch auto-gas of the race (armed by a tap on the GO
// zone or one tick after green), the HUD, lobby and results, the track
// dressing, the ghost car of the time trial and the spectator camera.

type RaceMessage = Extract<ServerMessage, { type: 'raceState' | 'raceStatus' | 'raceResults' | 'ghostData' }>;

const _cameraDirection = new THREE.Vector3();

class RaceClient {
    readonly model = new RaceModel();
    active = false;
    private map: MapData | null = null;
    private readonly worlds = new Map<TrackId, SimWorld>();
    private dressing: TrackDressing | null = null;
    private ghost: GhostCar | null = null;
    private playerReady = false;
    private spectateIndex = 0;
    private uiReady = false;
    private carSwitcher: ((carType: string) => void) | null = null;

    /** How the own car is changed (main.ts rebuilds the model). */
    setCarSwitcher(switcher: (carType: string) => void): void {
        this.carSwitcher = switcher;
    }

    /** The splash screen is done: the lobby and results may show. */
    markPlayerReady(): void {
        this.playerReady = true;
    }

    private world(track: TrackId): SimWorld {
        let world = this.worlds.get(track);
        if (!world) {
            world = createRaceWorld(this.map!, gameTrack(track));
            this.worlds.set(track, world);
        }
        return world;
    }

    private initUi(): void {
        if (this.uiReady) return;
        this.uiReady = true;
        initRaceUi({
            ready: ready => sendToServer({ type: 'raceReady', ready }),
            config: change => sendToServer({ type: 'raceConfig', ...change }),
            vote: choice => {
                this.model.vote = choice;
                sendToServer({ type: 'raceVote', choice });
            },
            retry: () => sendToServer({ type: 'timeTrialRestart' }),
            switchMode: () => requestRoom(this.model.mode === 'timetrial' ? 'race' : 'timetrial'),
            ownRace: () => requestRoom('race', { fresh: true }),
            car: carType => this.carSwitcher?.(carType),
            go: () => inputManager.armRaceGas(true)
        });
        // Spectators tap the view to follow the next car
        state.renderer?.domElement.addEventListener('pointerdown', () => {
            if (this.active && this.spectating) this.spectateIndex++;
        });
    }

    /**
     * A new room (roomState), before the prediction is built: a race room
     * sets the race world and the track dressing up, any other room takes
     * everything of the race down.
     */
    enterRoom(room: RoomInfo, race: RaceStateBody | undefined, map: MapData, selfId: string): void {
        this.initUi();
        this.model.clear();
        this.model.selfId = selfId;
        this.disposeGhost();
        if (!isRaceKind(room.kind) || !race) {
            this.leave();
            return;
        }
        this.active = true;
        this.map = map;
        this.model.setState(race);
        inputManager.setRaceTouch(true);
        netDriver.beforeSample = tick => this.beforeSample(tick);
        this.applyTrack();
    }

    private leave(): void {
        if (!this.active) return;
        this.active = false;
        setWorldOverride(null);
        this.dressing?.dispose();
        this.dressing = null;
        setMinimapTrack(null);
        inputManager.setRaceTouch(false);
        netDriver.beforeSample = null;
        renderHud(null, null, false);
        renderLobby(null, state.myCarType);
        renderResults(null);
    }

    // The track of the state: race world for the sim, dressing and map
    private applyTrack(): void {
        const track = this.model.track;
        if (!track || !this.map) return;
        const world = this.world(track.id);
        setWorldOverride(world);
        if (netDriver.prediction) netDriver.prediction.world = world;
        if (this.dressing?.track.id !== track.id) {
            this.dressing?.dispose();
            this.dressing = new TrackDressing(track);
            state.scene?.add(this.dressing.group);
        }
        setMinimapTrack(track);
    }

    /** After the prediction was built for the room: the race rules on it (17.1). */
    bindPrediction(): void {
        const p = netDriver.prediction;
        if (!this.active || !p) return;
        const model = this.model;
        const track = model.track;
        if (track) p.world = this.world(track.id);
        p.filterInput = (tick, input) => { raceInputFilter(model.phaseAt(tick), tick, model.state?.startTick ?? null, input); };
        p.ghostFloor = (tick, car) => { raceGhostFloor(model.phaseAt(tick), tick, model.state?.startTick ?? null, car); };
        const base = p.modsFor;
        p.modsFor = (tick, mods) => {
            base(tick, mods);
            const S = model.state?.startTick ?? null;
            const phase = model.phaseAt(tick);
            if (S === null || (phase !== 'racing' && phase !== 'finished')) {
                mods.launch = mods.bogged = false;
                return;
            }
            applyLaunchMods(model.launchFor(S, t => p.entry(t)?.input.throttle ?? 0), tick, S, mods);
        };
    }

    // Before the input of tick `tick` is sampled: the touch auto-gas of a
    // race starts one tick after green without a tap (17.5)
    private beforeSample(tick: number): void {
        const S = this.model.state?.startTick;
        if (S === null || S === undefined || !inputManager.raceTouch || inputManager.raceGasOn) return;
        if (tick > S && this.model.phaseAt(tick) === 'racing') inputManager.armRaceGas(true);
    }

    /** raceState, raceStatus, raceResults, ghostData. */
    onMessage(message: RaceMessage): void {
        if (!this.active) return;
        switch (message.type) {
            case 'raceState': {
                const { type: _type, ...body } = message;
                const before = this.model.state;
                this.model.setState(body);
                if (before?.trackId !== body.trackId) this.applyTrack();
                if (body.startTick !== null && body.startTick !== before?.startTick) {
                    // A new countdown: auto-gas waits for the tap or green again
                    inputManager.armRaceGas(false);
                    this.buildGhost();
                }
                if (body.phase === 'lobby') this.disposeGhost();
                return;
            }
            case 'raceStatus':
                this.model.onStatus(message.order);
                return;
            case 'raceResults':
                this.model.onResults(message);
                return;
            case 'ghostData':
                this.model.onGhost(message);
                this.buildGhost();
                return;
        }
    }

    private disposeGhost(): void {
        this.ghost?.dispose();
        this.ghost = null;
        minimapRace.ghost = null;
    }

    // The ghost of the time trial races from startTick (15.4)
    private buildGhost(): void {
        this.disposeGhost();
        const ghost: GhostMessage | null = this.model.ghost;
        const S = this.model.state?.startTick ?? null;
        if (!ghost || S === null || this.model.mode !== 'timetrial') return;
        const playback = GhostPlayback.fromMessage(ghost.poses, ghost.hz, TICK_RATE, S);
        if (!playback) return;
        this.ghost = new GhostCar(ghost.carType, ghost.finishTicks, playback);
    }

    onEvent(event: GameEvent): void {
        if (this.active) this.model.onEvent(event, performance.now());
    }

    private get spectating(): boolean {
        const phase = this.model.state?.phase;
        return this.active && !!phase && phase !== 'lobby' && !this.model.racing;
    }

    /** The car a spectator follows (the leader first, a tap for the next), or null. */
    spectateTarget(): { position: THREE.Vector3; yaw: number; airHeight: number } | null {
        if (!this.spectating) return null;
        const ids = (this.model.order.length ? this.model.order.map(e => e.id) : this.model.state!.racers.map(r => r.id))
            .filter(id => state.remotePlayers[id]?.bodyGroup.visible);
        if (!ids.length) return null;
        const remote = state.remotePlayers[ids[this.spectateIndex % ids.length]] as unknown as { group: THREE.Group; angle: number; airHeight: number };
        return { position: remote.group.position, yaw: remote.angle, airHeight: remote.airHeight };
    }

    /** The render tick of the own car: C - 1 + alpha (the pose on screen). */
    private renderTick(): number {
        const p = netDriver.prediction;
        if (!p || p.tick < 0) return -1;
        return p.tick - 1 + (state.bulli?.vehicle?.alpha ?? 0);
    }

    /** Once per frame: HUD, sheets, gate lights, start lights, ghost, minimap. */
    frame(dt: number, now: number, timeSec: number): void {
        if (!this.active) return;
        const model = this.model;
        const t = this.renderTick();
        const serverTick = netDriver.clock.ready ? netDriver.clock.serverTickAt(now) : t;
        const hud = this.playerReady ? model.hud(t, now) : null;
        let arrow: ArrowView | null = null;
        const car = state.bulli;
        // A spectator's own car is not in the race (it waits for the next lobby)
        if (hud?.spectating && car && !netDriver.prediction?.spawned) car.bodyGroup.visible = false;
        if (hud && !hud.spectating && car?.bodyGroup.visible && state.camera) {
            const next = model.nextGate(car.group.position.x, car.group.position.z);
            minimapRace.nextGate = next?.gate ?? -1;
            if (next && !hud.countdown) {
                state.camera.getWorldDirection(_cameraDirection);
                const cameraYaw = Math.atan2(_cameraDirection.x, _cameraDirection.z);
                arrow = { degrees: arrowDegrees(car.group.position.x, car.group.position.z, next.x, next.z, cameraYaw), distance: next.distance, missed: next.missed };
            }
        } else {
            minimapRace.nextGate = -1;
        }
        const C = netDriver.prediction?.tick ?? -1;
        const goZone = !!hud && !hud.spectating && inputManager.touchUi && inputManager.raceTouch && inputManager.autoGasEnabled
            && !inputManager.raceGasOn && model.counting(C);
        const results = this.playerReady ? model.resultsView(serverTick, now) : null;
        // The results sheet takes over from the banner (FINISH before it)
        renderHud(hud && results ? { ...hud, banner: null } : hud, arrow, goZone);
        renderLobby(this.playerReady ? model.lobby(netDriver.members.values(), serverTick) : null, state.myCarType);
        renderResults(results);
        const countdown = hud?.countdown ?? null;
        this.dressing?.update(timeSec, gate => model.gateLook(gate),
            countdown ? { red: lampsFor(countdown.lights), green: countdown.green } : null);
        if (this.ghost) {
            this.ghost.update(t, dt);
            minimapRace.ghost = { x: this.ghost.x, z: this.ghost.z };
        }
    }
}

export const raceClient = new RaceClient();
