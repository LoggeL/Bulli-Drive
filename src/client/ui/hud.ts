import { state } from '../state.js';

// Hitmarker
let hitmarkerEl: HTMLElement | null = null;
let hitmarkerTimeout: number = 0;
let scoreDisplay: HTMLElement | null = null;
let lastScore = Number.NaN;
let interactionPrompt: HTMLElement | null = null;
let interactionPromptTimeout = 0;


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
    if (!scoreDisplay) scoreDisplay = document.getElementById('score-display');
    if (!scoreDisplay || state.score === lastScore) return;
    lastScore = state.score;
    const score = state.score.toString();
    scoreDisplay.innerText = score;
    scoreDisplay.setAttribute('aria-label', `Score: ${score}`);
}

export function showInteractionPrompt(text: string) {
    if (!interactionPrompt) interactionPrompt = document.getElementById('interaction-prompt');
    if (!interactionPrompt) return;

    if (interactionPrompt.innerText !== text) interactionPrompt.innerText = text;
    interactionPrompt.classList.remove('hidden');
    clearTimeout(interactionPromptTimeout);
    interactionPromptTimeout = window.setTimeout(() => {
        interactionPrompt?.classList.add('hidden');
        interactionPromptTimeout = 0;
    }, 3000);
}

const POWERUP_KEYS = ['speed', 'size', 'jump', 'shield', 'magnet', 'ghost'] as const;
const POWERUP_UI_INTERVAL_MS = 100;
const POWERUP_COLOR_CSS: Record<(typeof POWERUP_KEYS)[number], string> = {
    speed: '#ffd700',
    size: '#ff1493',
    jump: '#00ff7f',
    shield: '#00bfff',
    magnet: '#ff6600',
    ghost: '#9966ff'
};
const POWERUP_ICON_IDS: Record<(typeof POWERUP_KEYS)[number], string> = {
    speed: 'icon-speed',
    size: 'icon-grow',
    jump: 'icon-jump',
    shield: 'icon-shield',
    magnet: 'icon-magnet',
    ghost: 'icon-ghost'
};


interface PowerupIndicator {
    element: HTMLElement;
    fill: HTMLElement;
    lastScale: number;
}

let powerupPanel: HTMLElement | null = null;
let lastPowerupUpdate = -Infinity;
let lastPowerupSignature = -1;
const powerupIndicators = new Map<(typeof POWERUP_KEYS)[number], PowerupIndicator>();

export function updatePowerupsUI() {
    if (!powerupPanel) powerupPanel = document.getElementById('powerup-panel');
    if (!powerupPanel || !state.bulli) return;

    let signature = 0;
    for (let i = 0; i < POWERUP_KEYS.length; i++) {
        if (state.bulli.powerups[POWERUP_KEYS[i]].active) signature |= 1 << i;
    }
    const now = performance.now();
    if (signature === lastPowerupSignature && now - lastPowerupUpdate < POWERUP_UI_INTERVAL_MS) return;
    lastPowerupSignature = signature;
    lastPowerupUpdate = now;

    for (const type of POWERUP_KEYS) {
        const powerup = state.bulli.powerups[type];
        let indicator = powerupIndicators.get(type);
        if (!powerup.active) {
            if (indicator) {
                indicator.element.remove();
                powerupIndicators.delete(type);
            }
            continue;
        }

        if (!indicator) {
            const element = document.createElement('div');
            element.className = 'powerup-indicator';
            element.dataset.type = type;

            const barBg = document.createElement('div');
            barBg.className = 'powerup-bar-bg';
            const fill = document.createElement('div');
            fill.className = 'powerup-bar-fill';
            fill.style.backgroundColor = POWERUP_COLOR_CSS[type];
            barBg.appendChild(fill);
            element.appendChild(createPowerupIcon(type));
            element.appendChild(barBg);
            powerupPanel.appendChild(element);
            indicator = { element, fill, lastScale: -1 };
            powerupIndicators.set(type, indicator);
        }

        const maxTime = type === 'shield' || type === 'ghost' ? 8 : 5;
        const scale = Math.max(0, powerup.timer / maxTime);
        if (scale !== indicator.lastScale) {
            indicator.fill.style.transform = `scaleX(${scale})`;
            indicator.lastScale = scale;
        }
    }
}

// Speedometer
const SPEEDO_REDRAW_INTERVAL_MS = 1000 / 30;
const SPEEDO_START_ANGLE = 0.75 * Math.PI;
const SPEEDO_END_ANGLE = 2.25 * Math.PI;
let speedoCanvas: HTMLCanvasElement | null = null;
let speedoCtx: CanvasRenderingContext2D | null = null;
let speedoValue: HTMLElement | null = null;
let speedoTurbo: HTMLElement | null = null;
let speedoStaticLayer: HTMLCanvasElement | null = null;
let speedoNormalGradient: CanvasGradient | null = null;
let speedoTurboGradient: CanvasGradient | null = null;
let lastSpeedoRedraw = -Infinity;
let lastDisplayedKmh = -1;
let lastTurboActive: boolean | null = null;

function initSpeedoRefs() {
    speedoCanvas = document.getElementById('speedo-canvas') as HTMLCanvasElement | null;
    speedoCtx = speedoCanvas?.getContext('2d') || null;
    speedoValue = document.getElementById('speedo-value');
    speedoTurbo = document.getElementById('speedo-turbo');
    if (speedoCanvas && speedoCtx) rebuildSpeedoStaticLayer();
}

function rebuildSpeedoStaticLayer() {
    if (!speedoCanvas || !speedoCtx) return;
    const w = speedoCanvas.width;
    const h = speedoCanvas.height;
    speedoStaticLayer = document.createElement('canvas');
    speedoStaticLayer.width = w;
    speedoStaticLayer.height = h;
    const ctx = speedoStaticLayer.getContext('2d');
    if (!ctx) return;

    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, SPEEDO_START_ANGLE, SPEEDO_END_ANGLE);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 10; i++) {
        const angle = SPEEDO_START_ANGLE + (i / 10) * (SPEEDO_END_ANGLE - SPEEDO_START_ANGLE);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * (r - 10), cy + Math.sin(angle) * (r - 10));
        ctx.lineTo(cx + Math.cos(angle) * (r - 4), cy + Math.sin(angle) * (r - 4));
        ctx.stroke();
    }

    speedoNormalGradient = speedoCtx.createLinearGradient(0, h, w, 0);
    speedoNormalGradient.addColorStop(0, '#F5A623');
    speedoNormalGradient.addColorStop(0.7, '#E84545');
    speedoNormalGradient.addColorStop(1, '#D63031');
    speedoTurboGradient = speedoCtx.createLinearGradient(0, h, w, 0);
    speedoTurboGradient.addColorStop(0, '#FFD54F');
    speedoTurboGradient.addColorStop(1, '#E84545');
}

export function updateSpeedometer() {
    if (!state.bulli) return;
    if (!speedoCanvas) initSpeedoRefs();
    if (!speedoCtx || !speedoCanvas || !speedoValue || !speedoTurbo) return;
    if (
        !speedoStaticLayer ||
        speedoStaticLayer.width !== speedoCanvas.width ||
        speedoStaticLayer.height !== speedoCanvas.height
    ) {
        rebuildSpeedoStaticLayer();
    }

    const kmh = Math.round(Math.abs(state.bulli.speed) * 120);
    const turboActive = state.bulli.powerups.speed.active;
    if (kmh !== lastDisplayedKmh) {
        speedoValue.innerText = kmh.toString();
        lastDisplayedKmh = kmh;
    }
    if (turboActive !== lastTurboActive) {
        speedoTurbo.classList.toggle('hidden', !turboActive);
        lastTurboActive = turboActive;
    }

    const now = performance.now();
    if (now - lastSpeedoRedraw < SPEEDO_REDRAW_INTERVAL_MS) return;
    lastSpeedoRedraw = now;

    const w = speedoCanvas.width;
    const h = speedoCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - 10;
    const pct = Math.min(kmh / 180, 1);
    speedoCtx.clearRect(0, 0, w, h);
    if (speedoStaticLayer) speedoCtx.drawImage(speedoStaticLayer, 0, 0);
    if (pct <= 0.005) return;

    speedoCtx.beginPath();
    speedoCtx.arc(cx, cy, r, SPEEDO_START_ANGLE, SPEEDO_START_ANGLE + pct * (SPEEDO_END_ANGLE - SPEEDO_START_ANGLE));
    speedoCtx.strokeStyle = turboActive ? speedoTurboGradient! : speedoNormalGradient!;
    speedoCtx.lineWidth = 6;
    speedoCtx.lineCap = 'round';
    speedoCtx.stroke();
}

function createPowerupIcon(type: string): SVGSVGElement {
    const iconId = POWERUP_ICON_IDS[type as keyof typeof POWERUP_ICON_IDS] || 'icon-shield';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.classList.add('ui-icon', 'powerup-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    use.setAttribute('href', `#${iconId}`);
    svg.appendChild(use);
    return svg;
}


export type JumpControlMode = 'jump' | 'super-jump' | 'recover';
const JUMP_CONTROL_LABELS: Record<JumpControlMode, string> = {
    jump: 'Jump and flip vehicle',
    'super-jump': 'Use super jump',
    recover: 'Recover vehicle'
};
let jumpControlButton: HTMLButtonElement | null = null;


/** Keep the mobile action available while changing its meaning visually when stuck. */
export function updateJumpControl(mode: JumpControlMode, enabled: boolean) {
    if (!jumpControlButton) {
        jumpControlButton = document.getElementById('btn-flip') as HTMLButtonElement | null;
    }
    if (!jumpControlButton) return;

    if (jumpControlButton.disabled === enabled) jumpControlButton.disabled = !enabled;
    if (jumpControlButton.getAttribute('aria-label') !== JUMP_CONTROL_LABELS[mode]) {
        jumpControlButton.setAttribute('aria-label', JUMP_CONTROL_LABELS[mode]);
    }
    if (jumpControlButton.dataset.mode === mode) return;
    jumpControlButton.dataset.mode = mode;
    const use = jumpControlButton.querySelector('use');
    use?.setAttribute('href', mode === 'recover' ? '#icon-recover' : '#icon-jump');
}

// Health bar
const HEALTH_GRADIENTS = [
    'linear-gradient(90deg, #A91515, #D63031)',
    'linear-gradient(90deg, #D83B3B, #F05A4F)',
    'linear-gradient(90deg, #E84545, #FF6F61)'
] as const;
let healthFill: HTMLElement | null = null;
let healthText: HTMLElement | null = null;
let healthMeter: HTMLElement | null = null;
let lastHealth = Number.NaN;

export function updateHealthBar() {
    if (!healthFill) healthFill = document.getElementById('health-bar-fill');
    if (!healthText) healthText = document.getElementById('health-bar-text');
    if (!healthMeter) healthMeter = document.getElementById('health-bar-container');
    if (!healthFill || !healthText || !healthMeter) return;

    const hp = Math.max(0, Math.min(100, state.health));
    if (hp === lastHealth) return;
    lastHealth = hp;
    const value = hp.toString();
    healthFill.style.width = `${hp}%`;
    healthText.innerText = value;
    healthMeter.setAttribute('aria-valuenow', value);
    healthMeter.setAttribute('aria-valuetext', `${value} percent health`);
    healthFill.style.background = HEALTH_GRADIENTS[hp > 50 ? 2 : hp > 25 ? 1 : 0];
}
