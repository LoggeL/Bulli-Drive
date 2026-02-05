import { state } from '../state.js';

export function updateScoreUI() {
    const display = document.getElementById('score-display');
    if (display) display.innerText = state.score.toString();
}

export function showInteractionPrompt(text: string) {
    const prompt = document.getElementById('interaction-prompt');
    if (prompt) {
        prompt.innerText = text;
        prompt.classList.remove('hidden');
        setTimeout(() => prompt.classList.add('hidden'), 3000);
    }
}

export function updatePowerupsUI() {
    const panel = document.getElementById('powerup-panel');
    if (!panel || !state.bulli) return;

    // Iterate through supported powerup types
    const activeKeys = Object.keys(state.bulli.powerups).filter(k => state.bulli.powerups[k as keyof typeof state.bulli.powerups].active);

    // Remove indicators for inactive powerups
    const existing = Array.from(panel.children) as HTMLElement[];
    existing.forEach(el => {
        const type = el.dataset.type;
        if (type && !state.bulli.powerups[type as keyof typeof state.bulli.powerups].active) {
            el.remove();
        }
    });

    // Add or update active powerups
    activeKeys.forEach(type => {
        const key = type as keyof typeof state.bulli.powerups;
        const p = state.bulli.powerups[key];
        let el = panel.querySelector(`.powerup-indicator[data-type="${type}"]`) as HTMLElement;

        if (!el) {
            el = document.createElement('div');
            el.className = 'powerup-indicator';
            el.dataset.type = type;

            const icon = document.createElement('span');
            icon.className = 'powerup-icon';
            icon.innerText = getPowerupIcon(type);

            const barBg = document.createElement('div');
            barBg.className = 'powerup-bar-bg';

            const barFill = document.createElement('div');
            barFill.className = 'powerup-bar-fill';
            barFill.style.backgroundColor = '#' + getPowerupColor(type).toString(16).padStart(6, '0');

            barBg.appendChild(barFill);
            el.appendChild(icon);
            el.appendChild(barBg);
            panel.appendChild(el);
        }

        // Update bar width/transform
        const fill = el.querySelector('.powerup-bar-fill') as HTMLElement;
        const maxTime = type === 'shield' || type === 'ghost' ? 8.0 : 5.0;
        const pct = Math.max(0, p.timer / maxTime);
        fill.style.transform = `scaleX(${pct})`;
    });
}

// Speedometer
let speedoCanvas: HTMLCanvasElement | null = null;
let speedoCtx: CanvasRenderingContext2D | null = null;
let speedoValue: HTMLElement | null = null;
let speedoTurbo: HTMLElement | null = null;

function initSpeedoRefs() {
    speedoCanvas = document.getElementById('speedo-canvas') as HTMLCanvasElement;
    speedoCtx = speedoCanvas?.getContext('2d') || null;
    speedoValue = document.getElementById('speedo-value');
    speedoTurbo = document.getElementById('speedo-turbo');
}

export function updateSpeedometer() {
    if (!state.bulli) return;
    if (!speedoCanvas) initSpeedoRefs();
    if (!speedoCtx || !speedoCanvas || !speedoValue || !speedoTurbo) return;

    const rawSpeed = Math.abs(state.bulli.speed);
    const kmh = Math.round(rawSpeed * 120);
    const maxKmh = 180;
    const pct = Math.min(kmh / maxKmh, 1);
    const turboActive = state.bulli.powerups.speed.active;

    speedoValue.innerText = kmh.toString();

    if (turboActive) {
        speedoTurbo.classList.remove('hidden');
    } else {
        speedoTurbo.classList.add('hidden');
    }

    // Draw gauge arc
    const w = speedoCanvas.width;
    const h = speedoCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 10;
    const startAngle = 0.75 * Math.PI;
    const endAngle = 2.25 * Math.PI;
    const sweepAngle = startAngle + pct * (endAngle - startAngle);

    speedoCtx.clearRect(0, 0, w, h);

    // Background arc
    speedoCtx.beginPath();
    speedoCtx.arc(cx, cy, r, startAngle, endAngle);
    speedoCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    speedoCtx.lineWidth = 6;
    speedoCtx.lineCap = 'round';
    speedoCtx.stroke();

    // Filled arc
    if (pct > 0.005) {
        speedoCtx.beginPath();
        speedoCtx.arc(cx, cy, r, startAngle, sweepAngle);
        if (turboActive) {
            const grad = speedoCtx.createLinearGradient(0, h, w, 0);
            grad.addColorStop(0, '#FFD54F');
            grad.addColorStop(1, '#E84545');
            speedoCtx.strokeStyle = grad;
        } else {
            const grad = speedoCtx.createLinearGradient(0, h, w, 0);
            grad.addColorStop(0, '#F5A623');
            grad.addColorStop(0.7, '#E84545');
            grad.addColorStop(1, '#D63031');
            speedoCtx.strokeStyle = grad;
        }
        speedoCtx.lineWidth = 6;
        speedoCtx.lineCap = 'round';
        speedoCtx.stroke();
    }

    // Tick marks
    const numTicks = 10;
    for (let i = 0; i <= numTicks; i++) {
        const tickAngle = startAngle + (i / numTicks) * (endAngle - startAngle);
        const innerR = r - 10;
        const outerR = r - 4;
        speedoCtx.beginPath();
        speedoCtx.moveTo(cx + Math.cos(tickAngle) * innerR, cy + Math.sin(tickAngle) * innerR);
        speedoCtx.lineTo(cx + Math.cos(tickAngle) * outerR, cy + Math.sin(tickAngle) * outerR);
        speedoCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        speedoCtx.lineWidth = 1.5;
        speedoCtx.stroke();
    }
}

function getPowerupIcon(type: string) {
    switch(type) {
        case 'speed': return '\u26A1';
        case 'size': return '\uD83C\uDF44';
        case 'jump': return '\uD83E\uDD98';
        case 'shield': return '\uD83D\uDEE1\uFE0F';
        case 'magnet': return '\uD83E\uDDF2';
        case 'ghost': return '\uD83D\uDC7B';
        default: return '\u2753';
    }
}

function getPowerupColor(type: string) {
    switch(type) {
        case 'speed': return 0xFFD700;
        case 'size': return 0xFF1493;
        case 'jump': return 0x00FF7F;
        case 'shield': return 0x00BFFF;
        case 'magnet': return 0xFF6600;
        case 'ghost': return 0x9966FF;
        default: return 0xFFFFFF;
    }
}

// Health bar
export function updateHealthBar() {
    const fill = document.getElementById('health-bar-fill');
    const text = document.getElementById('health-bar-text');
    if (!fill || !text) return;

    const hp = Math.max(0, Math.min(100, state.health));
    const pct = hp / 100;

    fill.style.width = (pct * 100) + '%';
    text.innerText = hp.toString();

    // Green to red gradient based on health
    if (pct > 0.5) {
        fill.style.background = `linear-gradient(90deg, #4CAF50, #8BC34A)`;
    } else if (pct > 0.25) {
        fill.style.background = `linear-gradient(90deg, #FF9800, #FFC107)`;
    } else {
        fill.style.background = `linear-gradient(90deg, #f44336, #E84545)`;
    }
}

