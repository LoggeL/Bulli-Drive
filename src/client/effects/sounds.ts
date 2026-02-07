import { state } from '../state.js';

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
    gain3.connect(masterGain);
    filter.connect(masterGain);
    masterGain.connect(ctx.destination);

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
    engineGain.connect(state.audioCtx.destination);
    
    engineSource.start();
}

export function updateEngineSound(speed: number, isAccelerating: boolean, turboActive: boolean = false, jumpHeight: number = 0) {
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
    // Jump height adds pitch (revving in air)
    const baseRate = 0.8;
    const speedBoost = absSpeed * 0.7;
    const accelBoost = isAccelerating ? 0.1 : 0;
    const turboBoost = turboActive ? 0.4 : 0;
    const jumpBoost = Math.max(0, Math.min(0.8, jumpHeight * 0.05)); // Cap pitch increase from height

    const targetRate = Math.min(2.5, baseRate + speedBoost + accelBoost + turboBoost + jumpBoost);
    
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
    gain.connect(state.audioCtx.destination);

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, curTime);
    osc.frequency.exponentialRampToValueAtTime(880, curTime + 0.1);

    gain.gain.setValueAtTime(0.1, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.2);

    osc.start(curTime);
    osc.stop(curTime + 0.2);
}

export function playJumpSound() {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const curTime = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, curTime);
    osc.frequency.exponentialRampToValueAtTime(400, curTime + 0.1);
    osc.frequency.exponentialRampToValueAtTime(100, curTime + 0.4);

    gain.gain.setValueAtTime(0.15, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.4);

    osc.start(curTime);
    osc.stop(curTime + 0.4);
}

export function playShootSound() {
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const curTime = state.audioCtx.currentTime;

    // Short laser-like synth sound
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);

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
    gain.connect(state.audioCtx.destination);

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
    gain.connect(state.audioCtx.destination);

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100 + Math.random() * 50, curTime);
    osc.frequency.exponentialRampToValueAtTime(40, curTime + 0.1);

    const volume = Math.min(0.3, intensity * 0.5);
    gain.gain.setValueAtTime(volume, curTime);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.2);

    osc.start(curTime);
    osc.stop(curTime + 0.2);
}
