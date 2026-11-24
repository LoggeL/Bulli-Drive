import type { DiscoveryAlloy } from '../../shared/map/discoverySchema.js';
import { SURFACE } from '../../shared/map/types.js';
import { state } from '../state.js';

// Sound on or off (the menu's settings and its quick switch, docs/ui.md
// 4.3): every sound goes through one master gain, which the setting mutes.
// Kept under SOUND_KEY for the next visit.
export const SOUND_KEY = 'bulli-sound';
let master: GainNode | null = null;
let soundOn = readSoundSetting();

function readSoundSetting(): boolean {
    try {
        return typeof localStorage === 'undefined' || localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
        return true;
    }
}

/** The master gain of the page's audio context (created on first use). */
function soundOutput(context: AudioContext): AudioNode {
    if (!master || master.context !== context) {
        master = context.createGain();
        master.gain.value = soundOn ? 1 : 0;
        master.connect(context.destination);
    }
    return master;
}

/** Whether the game makes sound. */
export function soundEnabled(): boolean {
    return soundOn;
}

/** Switches all sound on or off, now and for the next visit. */
export function setSoundEnabled(on: boolean): void {
    soundOn = on;
    try {
        localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch { /* private mode: for this page only */ }
    if (master) master.gain.setTargetAtTime(on ? 1 : 0, master.context.currentTime, 0.03);
}

// Engine sound state
let engineBuffer: AudioBuffer | null = null;
let engineSource: AudioBufferSourceNode | null = null;
let engineGain: GainNode | null = null;
let engineLoaded = false;


export async function initSounds() {
    if (!state.audioCtx) return;

    // Load engine sound
    if (!engineLoaded) {
        try {
            const response = await fetch('/audio/engine.wav');
            const arrayBuffer = await response.arrayBuffer();
            engineBuffer = await state.audioCtx.decodeAudioData(arrayBuffer);
            engineLoaded = true;
            console.log('Engine sound loaded');
        } catch (e) {
            console.warn('Failed to load engine sound:', e);
        }
    }

}

export function playHonkSound(pitch: number = 1.0): number {
    if (!state.audioCtx) return 0;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const ctx = state.audioCtx;
    const t = ctx.currentTime;
    const duration = 0.55;
    const baseFreq = 340 * pitch;

    // Main horn oscillator - square wave for buzzy old horn character
    const osc1 = ctx.createOscillator();
    osc1.type = 'square';
    osc1.frequency.setValueAtTime(baseFreq, t);
    // Slight sag on attack like an old electromagnetic horn
    osc1.frequency.setValueAtTime(baseFreq * 0.92, t);
    osc1.frequency.linearRampToValueAtTime(baseFreq, t + 0.06);
    // Gentle wobble from mechanical vibration
    osc1.frequency.setValueAtTime(baseFreq, t + 0.06);
    osc1.frequency.linearRampToValueAtTime(baseFreq * 1.01, t + 0.15);
    osc1.frequency.linearRampToValueAtTime(baseFreq * 0.99, t + 0.3);
    osc1.frequency.linearRampToValueAtTime(baseFreq, t + 0.45);
    // Droop off at the end
    osc1.frequency.linearRampToValueAtTime(baseFreq * 0.88, t + duration);

    // Second oscillator slightly detuned for richness - old horns aren't clean
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(baseFreq * 1.005, t);
    osc2.frequency.setValueAtTime(baseFreq * 0.925, t);
    osc2.frequency.linearRampToValueAtTime(baseFreq * 1.005, t + 0.06);
    osc2.frequency.linearRampToValueAtTime(baseFreq * 0.885, t + duration);

    // Third oscillator - sub harmonic for body
    const osc3 = ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(baseFreq * 0.5, t);

    // Gain envelope - sharp attack, sustain, quick release
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, t);
    masterGain.gain.linearRampToValueAtTime(0.12, t + 0.02);
    masterGain.gain.setValueAtTime(0.12, t + 0.04);
    masterGain.gain.linearRampToValueAtTime(0.10, t + 0.1);
    masterGain.gain.setValueAtTime(0.10, t + duration - 0.08);
    masterGain.gain.linearRampToValueAtTime(0, t + duration);

    // Individual gains for mixing
    const gain1 = ctx.createGain();
    gain1.gain.value = 0.6;
    const gain2 = ctx.createGain();
    gain2.gain.value = 0.25;
    const gain3 = ctx.createGain();
    gain3.gain.value = 0.15;

    // Bandpass filter to simulate the resonant horn bell
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = baseFreq * 1.8;
    filter.Q.value = 2.5;

    osc1.connect(gain1);
    osc2.connect(gain2);
    osc3.connect(gain3);
    gain1.connect(filter);
    gain2.connect(filter);
    // osc3 is the sub-harmonic body; bypass the bandpass so the low end isn't carved out
    gain3.connect(masterGain);
    filter.connect(masterGain);
    masterGain.connect(soundOutput(ctx));

    osc1.start(t);
    osc2.start(t);
    osc3.start(t);
    osc1.stop(t + duration);
    osc2.stop(t + duration);
    osc3.stop(t + duration);

    return duration;
}

export function startEngineSound() {
    if (!state.audioCtx || !engineBuffer || engineSource) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    
    engineSource = state.audioCtx.createBufferSource();
    engineSource.buffer = engineBuffer;
    engineSource.loop = true;
    
    engineGain = state.audioCtx.createGain();
    engineGain.gain.value = 0;
    
    engineSource.connect(engineGain);
    engineGain.connect(soundOutput(state.audioCtx));
    
    engineSource.start();
}

export function updateEngineSound(speed: number, isAccelerating: boolean, turboActive: boolean = false, airHeight: number = 0) {
    if (!engineSource || !engineGain || !state.audioCtx) return;
    
    const absSpeed = Math.abs(speed);
    
    // Volume based on speed (0 when stopped, max 0.3 at full speed)
    // Slightly louder during turbo
    const baseVolume = Math.min(0.3, absSpeed * 0.4);
    const targetVolume = turboActive ? Math.min(0.4, baseVolume * 1.3) : baseVolume;
    
    // Smooth volume transition
    const currentTime = state.audioCtx.currentTime;
    engineGain.gain.cancelScheduledValues(currentTime);
    engineGain.gain.setValueAtTime(engineGain.gain.value, currentTime);
    engineGain.gain.linearRampToValueAtTime(targetVolume, currentTime + 0.1);
    
    // Playback rate based on speed (0.8 idle to 1.5 at max speed)
    // Turbo boost adds extra pitch
    // In the air the wheels spin free: the engine revs up with the height
    const baseRate = 0.8;
    const speedBoost = absSpeed * 0.7;
    const accelBoost = isAccelerating ? 0.1 : 0;
    const turboBoost = turboActive ? 0.4 : 0;
    const airBoost = Math.max(0, Math.min(0.8, airHeight * 0.05)); // Cap pitch increase from height

    const targetRate = Math.min(2.5, baseRate + speedBoost + accelBoost + turboBoost + airBoost);
    
    engineSource.playbackRate.cancelScheduledValues(currentTime);
    engineSource.playbackRate.setValueAtTime(engineSource.playbackRate.value, currentTime);
    engineSource.playbackRate.linearRampToValueAtTime(targetRate, currentTime + 0.1);
}

export function stopEngineSound() {
    if (engineSource) {
        engineSource.stop();
        engineSource.disconnect();
        engineSource = null;
    }
    if (engineGain) {
        engineGain.disconnect();
        engineGain = null;
    }
}

export function playCollectSound() {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const curTime = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(soundOutput(state.audioCtx));

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, curTime);
    osc.frequency.exponentialRampToValueAtTime(880, curTime + 0.1);

    gain.gain.setValueAtTime(0.1, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.2);

    osc.start(curTime);
    osc.stop(curTime + 0.2);
}

export function playShootSound() {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const curTime = state.audioCtx.currentTime;

    // Short laser-like synth sound
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(soundOutput(state.audioCtx));

    osc.type = 'square';
    osc.frequency.setValueAtTime(880, curTime);
    osc.frequency.exponentialRampToValueAtTime(220, curTime + 0.15);

    gain.gain.setValueAtTime(0.12, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.15);

    osc.start(curTime);
    osc.stop(curTime + 0.15);
}

export function playHitSound() {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const curTime = state.audioCtx.currentTime;

    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(soundOutput(state.audioCtx));

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, curTime);
    osc.frequency.exponentialRampToValueAtTime(80, curTime + 0.2);

    gain.gain.setValueAtTime(0.15, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.25);

    osc.start(curTime);
    osc.stop(curTime + 0.25);
}

export function playCollisionSound(intensity: number) {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const curTime = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(soundOutput(state.audioCtx));

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100 + Math.random() * 50, curTime);
    osc.frequency.exponentialRampToValueAtTime(40, curTime + 0.1);

    const volume = Math.min(0.3, intensity * 0.5);
    gain.gain.setValueAtTime(volume, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.2);

    osc.start(curTime);
    osc.stop(curTime + 0.2);
}

const ALLOY_CHORDS: Record<DiscoveryAlloy, readonly number[]> = {
    forge: [392.0, 493.88, 587.33, 783.99],
    web: [523.25, 659.25, 783.99, 1046.5],
    games: [440.0, 554.37, 659.25, 880.0],
    ai: [329.63, 493.88, 659.25, 987.77],
    film: [293.66, 440.0, 587.33, 880.0],
    alpine: [587.33, 739.99, 880.0, 1174.66],
    stunt: [349.23, 440.0, 523.25, 698.46],
    coastal: [440.0, 523.25, 659.25, 880.0]
};

/** Harmonic arpeggio chime played when a player unlocks a discovery POI. */
export function playDiscoveryChime(alloy: DiscoveryAlloy = 'forge'): void {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const ctx = state.audioCtx;
    const t0 = ctx.currentTime;
    const notes = ALLOY_CHORDS[alloy] ?? ALLOY_CHORDS.forge;
    const out = soundOutput(ctx);

    notes.forEach((freq, idx) => {
        const start = t0 + idx * 0.065;
        const dur = idx === notes.length - 1 ? 0.55 : 0.28;
        const osc = ctx.createOscillator();
        const over = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        over.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        over.frequency.setValueAtTime(freq * 2, start);

        const overGain = ctx.createGain();
        overGain.gain.value = 0.22;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.11, start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0008, start + dur);

        osc.connect(gain);
        over.connect(overGain);
        overGain.connect(gain);
        gain.connect(out);

        osc.start(start);
        over.start(start);
        osc.stop(start + dur + 0.02);
        over.stop(start + dur + 0.02);
    });
}

/** Crisp futuristic turbo-zap played when hitting a boost pad. */
export function playBoostPadSound(): void {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const ctx = state.audioCtx;
    const t = ctx.currentTime;
    const out = soundOutput(ctx);

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(220, t);
    osc1.frequency.exponentialRampToValueAtTime(940, t + 0.26);
    osc2.frequency.setValueAtTime(330, t);
    osc2.frequency.exponentialRampToValueAtTime(1410, t + 0.26);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(600, t);
    filter.frequency.exponentialRampToValueAtTime(2400, t + 0.26);
    filter.Q.value = 1.8;

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.14, t + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.34);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.36);
    osc2.stop(t + 0.36);
}

/** Punchy mini-turbo release whoosh scaled by drift charge tier (1..3). */
export function playDriftKickSound(tier: 1 | 2 | 3): void {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const ctx = state.audioCtx;
    const t = ctx.currentTime;
    const out = soundOutput(ctx);
    const dur = 0.2 + tier * 0.06;
    const base = 180 + tier * 85;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 2.4, t + dur * 0.75);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.09 + tier * 0.025, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
}

// Continuous subtle tire-surface noise synth (snow crunch, ice hiss, gravel rustle, drift screech)
let surfaceNoise: AudioBufferSourceNode | null = null;
let surfaceFilter: BiquadFilterNode | null = null;
let surfaceGain: GainNode | null = null;
let surfaceCtx: AudioContext | null = null;

function ensureSurfaceNodes(ctx: AudioContext): boolean {
    if (surfaceNoise && surfaceFilter && surfaceGain && surfaceCtx === ctx) return true;
    try {
        const len = Math.max(1, Math.floor(ctx.sampleRate * 1.5));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        // Deterministic LCG white noise so no unpredictable spikes
        let seed = 0x51a7c3;
        for (let i = 0; i < len; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            data[i] = (seed / 0xffffffff) * 2 - 1;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 900;
        filter.Q.value = 1.2;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(filter);
        filter.connect(gain);
        gain.connect(soundOutput(ctx));
        src.start();
        surfaceNoise = src;
        surfaceFilter = filter;
        surfaceGain = gain;
        surfaceCtx = ctx;
        return true;
    } catch {
        return false;
    }
}

/** Updates continuous tire/surface audio feedback (snow crunch, ice glide, gravel, asphalt slip). */
export function updateSurfaceSound(surface: number, speedMs: number, slipAngle: number, grounded: boolean): void {
    const ctx = state.audioCtx;
    if (!ctx || ctx.state !== 'running') return;
    if (!ensureSurfaceNodes(ctx) || !surfaceFilter || !surfaceGain) return;

    const now = ctx.currentTime;
    const speed = Math.abs(speedMs);
    if (!grounded || speed < 1.5 || surface < 0) {
        surfaceGain.gain.setTargetAtTime(0, now, 0.05);
        return;
    }

    const slip = Math.min(1, Math.abs(slipAngle) / 0.45);
    const speedFactor = Math.min(1, speed / 32);
    let freq = 950;
    let q = 1.4;
    let targetGain = 0;

    if (surface === SURFACE.snow) {
        freq = 520 + speedFactor * 480;
        q = 0.85;
        targetGain = (0.028 + slip * 0.04) * speedFactor;
    } else if (surface === SURFACE.ice) {
        freq = 2200 + speedFactor * 1400;
        q = 3.2;
        targetGain = (0.014 + slip * 0.045) * speedFactor;
    } else if (surface === SURFACE.gravel || surface === SURFACE.dirt || surface === SURFACE.sand) {
        freq = 700 + speedFactor * 550;
        q = 0.9;
        targetGain = (0.025 + slip * 0.035) * speedFactor;
    } else if (slip > 0.2) {
        // Paved tire squeal on hard drift
        freq = 1550 + slip * 700;
        q = 4.2;
        targetGain = (slip - 0.2) * 0.055 * speedFactor;
    }

    surfaceFilter.frequency.setTargetAtTime(freq, now, 0.06);
    surfaceFilter.Q.setTargetAtTime(q, now, 0.06);
    surfaceGain.gain.setTargetAtTime(targetGain, now, 0.06);
}
