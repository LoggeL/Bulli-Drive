import { state } from '../state.js';

// Engine sound state
let engineBuffer: AudioBuffer | null = null;
let engineSource: AudioBufferSourceNode | null = null;
let engineGain: GainNode | null = null;
let engineLoaded = false;

// Honk sound state
let honkBuffer: AudioBuffer | null = null;
let honkLoaded = false;

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

    // Load honk sound
    if (!honkLoaded) {
        try {
            const response = await fetch('/audio/honk.wav');
            const arrayBuffer = await response.arrayBuffer();
            honkBuffer = await state.audioCtx.decodeAudioData(arrayBuffer);
            honkLoaded = true;
            console.log('Honk sound loaded');
        } catch (e) {
            console.warn('Failed to load honk sound:', e);
        }
    }
}

export function playHonkSound(pitch: number = 1.0) {
    if (!state.audioCtx || !honkBuffer) return;
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    const source = state.audioCtx.createBufferSource();
    source.buffer = honkBuffer;
    
    // Vary pitch slightly based on the car's pitch offset
    source.playbackRate.value = pitch;
    
    const gain = state.audioCtx.createGain();
    const curTime = state.audioCtx.currentTime;
    
    gain.gain.setValueAtTime(0.5, curTime);
    // Hold full volume for 0.5s, then fade out over the next 0.5s
    gain.gain.setValueAtTime(0.5, curTime + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.01, curTime + 1.0);
    
    source.connect(gain);
    gain.connect(state.audioCtx.destination);
    
    // Skip first 0.5s of the audio file (horrible part)
    source.start(curTime, 0.5);
    // Stop after 1s total
    source.stop(curTime + 1.0);
}

export async function initEngineSound() {
    // Deprecated, use initSounds instead
    await initSounds();
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
