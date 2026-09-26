import GUI, { type Controller } from 'lil-gui';
import { SIM_TUNING, SIM_TUNING_DEFAULTS, type SimTuning } from '../../shared/sim/constants.js';
import { exportTuning, importTuning, refreshCarParams, resetTuning, tuningIsDefault } from '../../shared/sim/tuning.js';
import type { AssistProfile, CarClassId } from '../../shared/sim/types.js';
import { ASSIST_PROFILES, CAR_CLASS_IDS, VEHICLE_CLASSES, type AssistSettings, type ClassParams } from '../../shared/sim/vehicleClasses.js';
import { SANDBOX } from '../flags.js';
import { gameHooks } from '../game/hooks.js';
import { state } from '../state.js';
import { assistProfileForDevice, type LocalVehicle } from '../vehicle/LocalVehicle.js';

// Tuning panel of the v2 physics (?tune=1, docs/phase-1a-design.md, 13).
// Loaded on demand as its own chunk together with lil-gui. It writes into
// SIM_TUNING, the class parameter sets and the assist profiles (shared/sim/
// tuning.ts), shows live telemetry with a plot of the last 5 s, and copies
// the changed values as JSON to the clipboard and back.

const RAD_TO_DEG = 180 / Math.PI;
// Plot history: 5 s of ticks
const HISTORY = 300;
const SPEED_COLOR = '#4FC3F7';
const BETA_COLOR = '#FFB74D';

type Source = 'global' | 'class' | 'profile';

interface Knob {
    source: Source;
    key: string;
    min: number;
    max: number;
    step?: number;
    // Shown in degrees, stored in radians
    degrees?: boolean;
}

const g = (key: keyof SimTuning, min: number, max: number, step?: number, degrees = false): Knob =>
    ({ source: 'global', key, min, max, step, degrees });
const c = (key: keyof ClassParams, min: number, max: number, step?: number, degrees = false): Knob =>
    ({ source: 'class', key, min, max, step, degrees });
const p = (key: keyof AssistSettings, min: number, max: number, step?: number, degrees = false): Knob =>
    ({ source: 'profile', key, min, max, step, degrees });

// The folders of section 13 (class values edit the class picked in the
// panel, profile values the local car's assist profile)
const FOLDERS: [string, Knob[]][] = [
    ['Antrieb', [
        c('accel', 4, 16, 0.1), c('topSpeed', 35, 65, 0.5), c('brakeDecel', 10, 30, 0.5),
        g('ENGINE_BRAKE', 0, 4, 0.1), g('C_AIR', 0, 0.002, 0.00005), g('DRIVE_EXP', 1, 4, 0.1)
    ]],
    ['Reifen', [
        c('gripFront', 1, 3.5, 0.05), c('gripRear', 1, 3.5, 0.05),
        c('slipPeakFront', 3, 12, 0.1, true), c('slipPeakRear', 3, 12, 0.1, true),
        c('slideFront', 0.5, 1, 0.01), c('slideRear', 0.5, 1, 0.01), c('aeroGrip', 0, 0.6, 0.01),
        g('GRIP_CIRCLE', 0, 1, 0.01)
    ]],
    ['Lenkung', [
        c('steerLock', 25, 40, 0.5, true), c('steerFalloff', 10, 25, 0.5),
        g('STEER_RATE_IN', 1, 10, 0.1), g('STEER_RATE_OUT', 1, 10, 0.1)
    ]],
    ['Drift', [
        c('handbrakeGrip', 0.3, 0.7, 0.01), g('HB_DECEL', 0, 10, 0.1), g('HB_RECOVER_TIME', 0.1, 0.6, 0.01),
        g('LOAD_GAIN', 0, 1.5, 0.05), g('driftReleaseKick', 0, 5, 0.1)
    ]],
    ['Assists', [
        p('counterSteer', 0, 1, 0.01), p('spinGuardAngle', 20, 60, 0.5, true),
        g('K_SPIN', 0, 40, 0.5), g('K_BD', 0, 15, 0.1), g('yawDampHigh', 0, 5, 0.1)
    ]],
    ['Boost', [
        g('BOOST_ACCEL', 6, 16, 0.1), g('BOOST_ADD', 0, 35, 0.5), g('BOOST_DRAIN', 0.1, 1, 0.01),
        g('DRIFT_FILL', 0, 1, 0.01), g('AIR_FILL', 0, 0.5, 0.01)
    ]],
    ['Kollision', [
        c('restitutionWall', 0, 0.5, 0.01), g('WALL_FRICTION', 0, 0.5, 0.01),
        g('CAR_RESTITUTION', 0, 0.6, 0.01), g('CAR_FRICTION', 0, 0.6, 0.01), c('massRatioCap', 1, 4, 0.05),
        g('CONTACT_DOMEGA_CAP', 0.5, 6, 0.1)
    ]],
    ['Federung und Luft', [
        g('SUSP_FREQ', 0.8, 4, 0.05), g('SUSP_DAMPING', 0.2, 1.5, 0.05), g('SUSP_TRAVEL', 0.05, 0.5, 0.01),
        g('AIR_YAW_RESPONSE', 0, 10, 0.1), g('AIR_ALIGN', 0, 6, 0.1)
    ]],
    ['Fahrwerk', [
        c('mass', 600, 3000, 10), c('wheelbase', 1.6, 3.6, 0.05), c('cgFront', 0.35, 0.65, 0.01),
        c('cgHeight', 0.3, 1.2, 0.05), c('yawRadius', 0.8, 2, 0.05), c('driftFill', 0, 2, 0.05)
    ]]
];
// Global values in the top folder; the rest is listed under "Alle globalen"
const TOP_GLOBALS: Knob[] = [g('gripScale', 0.8, 1.6, 0.01), g('GRAVITY', 8, 30, 0.5)];
const ANGLE_GLOBALS = new Set<string>(['BETA_DAMP_FROM']);

// Live values of the local car, written once per tick
const telemetry = {
    kmh: 0,
    u: 0,
    w: 0,
    beta: 0,
    yawRate: 0,
    steer: 0,
    boostMeter: 0,
    boosting: false,
    grounded: true,
    drifting: false,
    airTicks: 0,
    wallTicks: 0
};
const speedHistory = new Float32Array(HISTORY);
const betaHistory = new Float32Array(HISTORY);
let historyHead = 0;
let historyCount = 0;

const edit = { classId: 'bulli' as CarClassId };
const status = { message: '' };

function localVehicle(): LocalVehicle | undefined {
    return state.bulli?.vehicle;
}

function editedProfile(): AssistProfile {
    return localVehicle()?.profile ?? assistProfileForDevice();
}

// Pushes class and profile changes into the cars that already exist
function refreshLiveCars(): void {
    const vehicle = localVehicle();
    if (vehicle) refreshCarParams(vehicle.car, vehicle.classId, vehicle.profile);
    for (const hook of gameHooks.tuningChanged) hook();
}

function sourceObject(source: Source): Record<string, unknown> {
    if (source === 'global') return SIM_TUNING as unknown as Record<string, unknown>;
    if (source === 'class') return VEHICLE_CLASSES[edit.classId] as unknown as Record<string, unknown>;
    return ASSIST_PROFILES[editedProfile()] as unknown as Record<string, unknown>;
}

// A controller on a view that reads the current class/profile on every
// access, with the degree conversion for angles
function addKnob(folder: GUI, knob: Knob): Controller {
    const scale = knob.degrees ? RAD_TO_DEG : 1;
    const view = {};
    Object.defineProperty(view, knob.key, {
        get: () => (sourceObject(knob.source)[knob.key] as number) * scale,
        set: (value: number) => {
            sourceObject(knob.source)[knob.key] = value / scale;
            if (knob.source !== 'global') refreshLiveCars();
        },
        enumerable: true
    });
    const label = knob.key + (knob.degrees ? ' (°)' : '') + (knob.source === 'class' ? ' ·K' : knob.source === 'profile' ? ' ·P' : '');
    return folder.add(view as Record<string, number>, knob.key as never, knob.min, knob.max, knob.step).name(label);
}

function updateAll(gui: GUI): void {
    for (const controller of gui.controllersRecursive()) controller.updateDisplay();
}

function sample(vehicle: LocalVehicle): void {
    const s = vehicle.car.state;
    const u = vehicle.forwardSpeed;
    const beta = vehicle.slipAngle * RAD_TO_DEG;
    telemetry.kmh = u * 3.6;
    telemetry.u = u;
    telemetry.w = s.vx * Math.cos(s.yaw) - s.vz * Math.sin(s.yaw);
    telemetry.beta = beta;
    telemetry.yawRate = s.yawRate;
    telemetry.steer = s.steerAngle * RAD_TO_DEG;
    telemetry.boostMeter = s.boostMeter * 100;
    telemetry.boosting = s.boosting;
    telemetry.grounded = s.grounded;
    telemetry.drifting = s.driftTicks > 0;
    telemetry.airTicks = s.airTicks;
    telemetry.wallTicks = s.wallTicks;
    speedHistory[historyHead] = u * 3.6;
    betaHistory[historyHead] = beta;
    historyHead = (historyHead + 1) % HISTORY;
    historyCount = Math.min(HISTORY, historyCount + 1);
}

function createGraph(folder: GUI): () => void {
    const canvas = document.createElement('canvas');
    canvas.className = 'tuning-graph';
    const legend = document.createElement('div');
    legend.className = 'tuning-graph-legend';
    const speedLabel = document.createElement('span');
    speedLabel.style.color = SPEED_COLOR;
    const betaLabel = document.createElement('span');
    betaLabel.style.color = BETA_COLOR;
    legend.append(speedLabel, betaLabel);
    folder.$children.append(canvas, legend);

    return () => {
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        // Scales grow with the data: speed from 0, slip angle around 0
        let topSpeed = 100, topBeta = 20;
        for (let i = 0; i < historyCount; i++) {
            topSpeed = Math.max(topSpeed, speedHistory[i]);
            topBeta = Math.max(topBeta, Math.abs(betaHistory[i]));
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = ratio;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        const plot = (values: Float32Array, color: string, toY: (value: number) => number) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5 * ratio;
            ctx.beginPath();
            for (let i = 0; i < historyCount; i++) {
                const index = (historyHead - historyCount + i + HISTORY) % HISTORY;
                const x = (HISTORY - historyCount + i) / (HISTORY - 1) * width;
                const y = toY(values[index]);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };
        plot(speedHistory, SPEED_COLOR, value => height - 2 - Math.max(0, value) / topSpeed * (height - 4));
        plot(betaHistory, BETA_COLOR, value => height / 2 - value / topBeta * (height / 2 - 2));
        speedLabel.textContent = `Speed ${telemetry.kmh.toFixed(0)} km/h (max ${topSpeed.toFixed(0)})`;
        betaLabel.textContent = `Drift ${telemetry.beta.toFixed(1)}° (±${topBeta.toFixed(0)})`;
    };
}

async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

async function readClipboard(): Promise<string | null> {
    try {
        return await navigator.clipboard.readText();
    } catch {
        return null;
    }
}

// The panel's actions, also used by the e2e test (window.__bulliTune)
export const tuningActions = {
    export(): string {
        return JSON.stringify(exportTuning(), null, 2);
    },
    import(json: string): void {
        importTuning(json);
        refreshLiveCars();
    },
    reset(): void {
        resetTuning();
        refreshLiveCars();
    }
};

export async function installTuningPanel(): Promise<void> {
    const vehicle = localVehicle();
    edit.classId = vehicle?.classId ?? 'bulli';
    const gui = new GUI({ title: 'v2 Tuning' });
    gui.domElement.id = 'tuning-panel';
    // On phones the panel starts folded, it would cover the touch controls
    if (window.matchMedia?.('(pointer: coarse)').matches) gui.close();

    // Telemetry
    const live = gui.addFolder('Telemetrie');
    live.add(telemetry, 'kmh').name('km/h').decimals(1).listen().disable();
    live.add(telemetry, 'u').name('u (m/s)').decimals(2).listen().disable();
    live.add(telemetry, 'w').name('w (m/s)').decimals(2).listen().disable();
    live.add(telemetry, 'beta').name('β Drift (°)').decimals(1).listen().disable();
    live.add(telemetry, 'yawRate').name('r (rad/s)').decimals(2).listen().disable();
    live.add(telemetry, 'steer').name('δ Rad (°)').decimals(1).listen().disable();
    live.add(telemetry, 'boostMeter').name('Boost (%)').decimals(0).listen().disable();
    live.add(telemetry, 'boosting').name('Boost an').listen().disable();
    live.add(telemetry, 'grounded').name('Bodenkontakt').listen().disable();
    live.add(telemetry, 'drifting').name('Drift').listen().disable();
    live.add(telemetry, 'airTicks').name('Luft-Ticks').listen().disable();
    live.add(telemetry, 'wallTicks').name('Ticks seit Wand').listen().disable();
    const drawGraph = createGraph(gui.addFolder('Verlauf 5 s'));
    gameHooks.afterTick.push(sample);

    // Global switches
    const top = gui.addFolder('Global');
    const switches = {
        get assistProfile(): AssistProfile {
            return editedProfile();
        },
        set assistProfile(profile: AssistProfile) {
            const current = localVehicle();
            if (!current) return;
            current.profile = profile;
            refreshLiveCars();
            updateAll(gui);
        }
    };
    for (const knob of TOP_GLOBALS) addKnob(top, knob);
    top.add(switches, 'assistProfile', ['standard', 'touch']).name('Assist-Profil ·P').listen();
    top.add(edit, 'classId', [...CAR_CLASS_IDS]).name('Werte der Klasse ·K').onChange(() => updateAll(gui));

    for (const [title, knobs] of FOLDERS) {
        const folder = gui.addFolder(title);
        for (const knob of knobs) addKnob(folder, knob);
        folder.close();
    }
    const listed = new Set([...TOP_GLOBALS, ...FOLDERS.flatMap(([, knobs]) => knobs)]
        .filter(knob => knob.source === 'global').map(knob => knob.key));
    const rest = gui.addFolder('Alle globalen Werte');
    for (const key of Object.keys(SIM_TUNING_DEFAULTS) as (keyof SimTuning)[]) {
        if (listed.has(key)) continue;
        const value = SIM_TUNING_DEFAULTS[key];
        const degrees = ANGLE_GLOBALS.has(key);
        const span = Math.max(1, Math.abs(value) * 3);
        addKnob(rest, g(key, 0, degrees ? 90 : span, undefined, degrees));
    }
    rest.close();

    if (SANDBOX) {
        const sandbox = await import('../sandbox/sandbox.js');
        const box = gui.addFolder('Sandbox');
        const mods = {} as Record<string, boolean>;
        const MODS: [string, string][] = [
            ['speed', 'Turbo'], ['size', 'Mega'], ['ghost', 'Ghost'], ['shield', 'Schild']
        ];
        for (const [key, label] of MODS) {
            Object.defineProperty(mods, key, {
                get: () => !!state.bulli?.powerups[key]?.active,
                set: (active: boolean) => {
                    const powerup = state.bulli?.powerups[key];
                    if (!powerup) return;
                    powerup.active = active;
                    powerup.timer = active ? 3600 : 0;
                },
                enumerable: true
            });
            box.add(mods, key).name(label).listen();
        }
        const car = {
            get body(): string {
                return state.bulli?.carType ?? 'bulli';
            },
            set body(carType: string) {
                sandbox.switchCar(carType as CarClassId);
                edit.classId = carType as CarClassId;
                updateAll(gui);
            },
            resetDummies: sandbox.resetSandbox
        };
        box.add(car, 'body', [...CAR_CLASS_IDS]).name('Karosse').listen();
        box.add(car, 'resetDummies').name('Dummies zurücksetzen (N)');
    }

    const file = gui.addFolder('Export / Import');
    const actions = {
        exportJson: async () => {
            const json = tuningActions.export();
            if (await copyToClipboard(json)) status.message = 'In die Zwischenablage kopiert';
            else window.prompt('Tuning-JSON (kopieren):', json);
        },
        importJson: async () => {
            const text = (await readClipboard()) ?? window.prompt('Tuning-JSON einfügen:');
            if (!text) return;
            try {
                tuningActions.import(text);
                status.message = 'Importiert';
            } catch (error) {
                status.message = error instanceof Error ? error.message : String(error);
            }
            updateAll(gui);
        },
        reset: () => {
            tuningActions.reset();
            status.message = 'Defaults';
            updateAll(gui);
        },
        get golden(): string {
            return tuningIsDefault() ? 'ja (Defaults)' : 'nein (geändert)';
        }
    };
    file.add(actions, 'exportJson').name('Export → Zwischenablage');
    file.add(actions, 'importJson').name('Import ← Zwischenablage');
    file.add(actions, 'reset').name('Reset auf Defaults');
    file.add(status, 'message').name('Status').listen().disable();
    file.add(actions, 'golden').name('Golden gültig').listen().disable();

    if (new URLSearchParams(window.location.search).get('e2e') === '1') {
        (window as unknown as { __bulliTune: unknown }).__bulliTune = { ...tuningActions, telemetry };
    }

    const loop = () => {
        requestAnimationFrame(loop);
        if (!gui._closed && !gui._hidden) drawGraph();
    };
    requestAnimationFrame(loop);
}
