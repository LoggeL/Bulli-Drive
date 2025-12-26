import { state } from '../state.js';

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
