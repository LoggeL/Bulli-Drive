import { state } from '../state.js';

// Hitmarker
let hitmarkerEl: HTMLElement | null = null;
let hitmarkerTimeout: number = 0;

export function showHitmarker() {
    if (!hitmarkerEl) {
        hitmarkerEl = document.getElementById('hitmarker');
    }
    if (!hitmarkerEl) {
        hitmarkerEl = document.createElement('div');
        hitmarkerEl.id = 'hitmarker';
        document.body.appendChild(hitmarkerEl);
    }
    hitmarkerEl.classList.add('visible');
    clearTimeout(hitmarkerTimeout);
    hitmarkerTimeout = window.setTimeout(() => {
        hitmarkerEl?.classList.remove('visible');
    }, 200);
}

// Killfeed
let killfeedContainer: HTMLElement | null = null;

export function addKillfeedEntry(killer: string, victim: string) {
    if (!killfeedContainer) {
        killfeedContainer = document.getElementById('killfeed');
        if (!killfeedContainer) {
            killfeedContainer = document.createElement('div');
            killfeedContainer.id = 'killfeed';
            document.body.appendChild(killfeedContainer);
        }
    }

    const entry = document.createElement('div');
    entry.className = 'killfeed-entry';

    const killerSpan = document.createElement('span');
    killerSpan.className = 'kf-killer';
    killerSpan.textContent = killer;

    const actionSpan = document.createElement('span');
    actionSpan.className = 'kf-action';
    actionSpan.textContent = ' eliminated ';

    const victimSpan = document.createElement('span');
    victimSpan.className = 'kf-victim';
    victimSpan.textContent = victim;

    entry.appendChild(killerSpan);
    entry.appendChild(actionSpan);
    entry.appendChild(victimSpan);
    killfeedContainer.prepend(entry);

    // Trigger animation
    requestAnimationFrame(() => entry.classList.add('visible'));

    // Remove after 5 seconds
    setTimeout(() => {
        entry.classList.add('fading');
        setTimeout(() => entry.remove(), 500);
    }, 5000);

    // Limit to 5 entries
    while (killfeedContainer.children.length > 5) {
        killfeedContainer.lastChild?.remove();
    }
}

export function updateScoreUI() {
    const display = document.getElementById('score-display');
    if (display) {
        display.innerText = state.score.toString();
        display.setAttribute('aria-label', `Score: ${state.score}`);
    }
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

            const icon = createPowerupIcon(type);

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

function createPowerupIcon(type: string): SVGSVGElement {
    const iconIds: Record<string, string> = {
        speed: 'icon-speed',
        size: 'icon-grow',
        jump: 'icon-jump',
        shield: 'icon-shield',
        magnet: 'icon-magnet',
        ghost: 'icon-ghost'
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.classList.add('ui-icon', 'powerup-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    use.setAttribute('href', `#${iconIds[type] || 'icon-shield'}`);
    svg.appendChild(use);
    return svg;
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

export type JumpControlMode = 'jump' | 'super-jump' | 'recover';

/** Keep the mobile action available while changing its meaning visually when stuck. */
export function updateJumpControl(mode: JumpControlMode, enabled: boolean) {
    const button = document.getElementById('btn-flip') as HTMLButtonElement | null;
    if (!button) return;

    button.disabled = !enabled;
    const labels: Record<JumpControlMode, string> = {
        jump: 'Jump and flip vehicle',
        'super-jump': 'Use super jump',
        recover: 'Recover vehicle'
    };
    button.setAttribute('aria-label', labels[mode]);

    if (button.dataset.mode === mode) return;
    button.dataset.mode = mode;
    const use = button.querySelector('use');
    use?.setAttribute('href', mode === 'recover' ? '#icon-recover' : '#icon-jump');
}

// Health bar
export function updateHealthBar() {
    const fill = document.getElementById('health-bar-fill');
    const text = document.getElementById('health-bar-text');
    const meter = document.getElementById('health-bar-container');
    if (!fill || !text || !meter) return;

    const hp = Math.max(0, Math.min(100, state.health));
    const pct = hp / 100;

    fill.style.width = (pct * 100) + '%';
    text.innerText = hp.toString();
    meter.setAttribute('aria-valuenow', hp.toString());
    meter.setAttribute('aria-valuetext', `${hp} percent health`);

    // Keep the branded coral health treatment from the HUD concept while
    // deepening the tone as health becomes critical.
    if (pct > 0.5) {
        fill.style.background = `linear-gradient(90deg, #E84545, #FF6F61)`;
    } else if (pct > 0.25) {
        fill.style.background = `linear-gradient(90deg, #D83B3B, #F05A4F)`;
    } else {
        fill.style.background = `linear-gradient(90deg, #A91515, #D63031)`;
    }
}
