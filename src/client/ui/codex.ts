import type { DiscoveryAlloy, DiscoveryDef } from '../../shared/map/discoverySchema.js';
import { isMapId, mapDescriptor, type MapId } from '../../shared/map/registry.js';
import { releaseKeyboardInputs } from '../controls/keyboard.js';
import { resetMobileControls } from '../controls/mobile.js';
import { sendToServer } from '../network/socket.js';
import { state } from '../state.js';
import { syncWorldDiscoveries, triggerWorldDiscoveryFx } from '../map/worldBridge.js';
import { setMinimapDiscoveries } from './minimap.js';
import { closeOpenDialog, dialogOpen } from './menu/settingsDialog.js';
import { discoveryTracker, type DiscoveryProgress, type DiscoveryTracker } from './discoveryTracker.js';

// Discovery Codex modal (<dialog id="codex-dialog">), HUD counter pill,
// and celebratory slide-in toast banner for local & multiplayer discoveries.

const ALLOY_LABELS: Readonly<Record<DiscoveryAlloy, string>> = {
    forge: 'Forge',
    web: 'Web & Ramsen',
    games: 'Purpur Games',
    ai: 'AI Lab',
    film: 'Film & Audio',
    alpine: 'Alpine',
    stunt: 'Stunt Park',
    coastal: 'Coastal'
};

const TRIGGER_LABELS: Readonly<Record<DiscoveryDef['trigger']['kind'], string>> = {
    proximity: 'Explore',
    horn: 'Honk (F)',
    park: 'Park & Wait',
    airtime: 'Big Air',
    speed: 'Top Speed'
};

interface ToastPayload {
    eyebrow: string;
    title: string;
    body: string;
    counter?: string;
    alloy?: DiscoveryAlloy;
}

const TOAST_MS = 5200;

let trackerRef: DiscoveryTracker = discoveryTracker;
let activeFilter: 'all' | DiscoveryAlloy = 'all';
let initialized = false;
let toastTimer = 0;
const toastQueue: ToastPayload[] = [];
let toastVisible = false;
let onProgressChanged: (() => void) | null = null;

function dialogEl(): HTMLDialogElement | null {
    return document.getElementById('codex-dialog') as HTMLDialogElement | null;
}

/** Optional callback fired whenever discovery counts change (used by menu cards). */
export function setCodexProgressListener(fn: (() => void) | null): void {
    onProgressChanged = fn;
}

/** Opens the Discovery Codex modal and pauses vehicle input. */
export function openCodex(): void {
    const target = dialogEl();
    if (!target || target.open) return;
    closeOpenDialog();
    renderCodex();
    target.showModal();
    state.isModalOpen = true;
    releaseKeyboardInputs();
    resetMobileControls();
}

/** Closes the Discovery Codex modal if open. */
export function closeCodex(): void {
    const target = dialogEl();
    if (target?.open) target.close();
}

/** Toggles the Discovery Codex modal. */
export function toggleCodex(): void {
    const target = dialogEl();
    if (!target) return;
    if (target.open) target.close();
    else openCodex();
}

/** Updates HUD badge, room-panel button, minimap markers, and 3D beacons. */
export function syncDiscoveryUi(): void {
    const defs = trackerRef.getDefinitions();
    const found = trackerRef.getFoundIds();
    const pinned = trackerRef.getPinnedId();
    const progress = trackerRef.getProgress();

    setMinimapDiscoveries(defs, found, pinned);
    syncWorldDiscoveries(found, pinned);

    const chip = document.getElementById('codex-chip');
    const chipCount = document.getElementById('codex-chip-count');
    if (chip) {
        chip.hidden = progress.total === 0;
        chip.setAttribute('aria-label', `Discoveries: ${progress.found} of ${progress.total}. Open codex (C)`);
    }
    if (chipCount) chipCount.textContent = `${progress.found}/${progress.total}`;

    const roomBtn = document.getElementById('room-codex');
    const roomCount = document.getElementById('room-codex-count');
    if (roomBtn) roomBtn.hidden = progress.total === 0;
    if (roomCount) roomCount.textContent = `${progress.found}/${progress.total}`;

    if (dialogEl()?.open) renderCodex();
    onProgressChanged?.();
}

function renderCodex(): void {
    const mapId = trackerRef.getMapId();
    const desc = mapDescriptor(mapId);
    const defs = trackerRef.getDefinitions();
    const found = trackerRef.getFoundIds();
    const pinnedId = trackerRef.getPinnedId();
    const progress = trackerRef.getProgress();

    const subtitle = document.getElementById('codex-map-subtitle');
    if (subtitle) subtitle.textContent = `${desc.name} · ${progress.found} / ${progress.total} discovered`;

    const fill = document.getElementById('codex-progress-fill');
    if (fill) {
        const ratio = progress.total > 0 ? progress.found / progress.total : 0;
        fill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    }

    // Build category filter tabs from alloys present in the active map
    const alloysPresent: DiscoveryAlloy[] = [];
    for (const def of defs) {
        if (!alloysPresent.includes(def.alloy)) alloysPresent.push(def.alloy);
    }
    if (activeFilter !== 'all' && !alloysPresent.includes(activeFilter)) {
        activeFilter = 'all';
    }

    const tabs = document.getElementById('codex-filters');
    if (tabs) {
        const items: Array<{ id: 'all' | DiscoveryAlloy; label: string }> = [
            { id: 'all', label: `All (${defs.length})` },
            ...alloysPresent.map(alloy => ({ id: alloy, label: ALLOY_LABELS[alloy] }))
        ];
        tabs.replaceChildren(...items.map(item => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'codex-filter';
            btn.dataset.alloy = item.id;
            btn.setAttribute('aria-pressed', String(activeFilter === item.id));
            btn.textContent = item.label;
            btn.addEventListener('click', () => {
                activeFilter = item.id;
                renderCodex();
            });
            return btn;
        }));
    }

    const list = document.getElementById('codex-list');
    if (!list) return;
    const filtered = activeFilter === 'all' ? defs : defs.filter(d => d.alloy === activeFilter);

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'codex-empty';
        empty.textContent = 'No discoveries registered on this map yet.';
        list.replaceChildren(empty);
        return;
    }

    list.replaceChildren(...filtered.map(def => {
        const isFound = found.has(def.id);
        const isPinned = pinnedId === def.id;

        const card = document.createElement('article');
        card.className = `codex-card${isFound ? ' found' : ''}${isPinned ? ' pinned' : ''}`;
        card.dataset.alloy = def.alloy;

        const head = document.createElement('div');
        head.className = 'codex-card-head';

        const meta = document.createElement('div');
        meta.className = 'codex-card-meta';

        const alloyBadge = document.createElement('span');
        alloyBadge.className = 'codex-badge';
        alloyBadge.textContent = ALLOY_LABELS[def.alloy];
        meta.appendChild(alloyBadge);

        const triggerBadge = document.createElement('span');
        triggerBadge.className = 'codex-trigger';
        triggerBadge.textContent = TRIGGER_LABELS[def.trigger.kind];
        meta.appendChild(triggerBadge);

        if (isFound) {
            const status = document.createElement('span');
            status.className = 'codex-status';
            status.textContent = 'DISCOVERED';
            meta.appendChild(status);
        }
        head.appendChild(meta);

        const title = document.createElement('h3');
        title.className = 'codex-card-title';
        title.textContent = isFound ? def.title : (def.secret ? 'Classified Secret' : def.title);
        head.appendChild(title);

        if (isFound && def.subtitle) {
            const sub = document.createElement('p');
            sub.className = 'codex-card-sub';
            sub.textContent = def.projectRef ? `${def.subtitle} · ${def.projectRef}` : def.subtitle;
            head.appendChild(sub);
        }

        const body = document.createElement('p');
        body.className = 'codex-card-body';
        body.textContent = isFound ? def.codexEntry : def.hint;

        const actions = document.createElement('div');
        actions.className = 'codex-card-actions';

        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'codex-pin-btn';
        pinBtn.setAttribute('aria-pressed', String(isPinned));
        pinBtn.textContent = isPinned ? 'Tracking on Radar' : 'Track on Radar';
        pinBtn.addEventListener('click', () => {
            trackerRef.pin(isPinned ? null : def.id);
        });
        actions.appendChild(pinBtn);

        card.append(head, body, actions);
        return card;
    }));
}

// ---- Celebratory Toast Banner ----

function enqueueToast(payload: ToastPayload): void {
    toastQueue.push(payload);
    if (!toastVisible) showNextToast();
}

function showNextToast(): void {
    const el = document.getElementById('discovery-toast');
    if (!el) {
        toastQueue.length = 0;
        toastVisible = false;
        return;
    }
    const next = toastQueue.shift();
    if (!next) {
        el.classList.remove('visible');
        el.hidden = true;
        toastVisible = false;
        return;
    }
    toastVisible = true;
    const eyebrow = document.getElementById('discovery-toast-eyebrow');
    const title = document.getElementById('discovery-toast-title');
    const body = document.getElementById('discovery-toast-body');
    const counter = document.getElementById('discovery-toast-count');
    if (eyebrow) eyebrow.textContent = next.eyebrow;
    if (title) title.textContent = next.title;
    if (body) body.textContent = next.body;
    if (counter) {
        counter.textContent = next.counter ?? '';
        counter.hidden = !next.counter;
    }
    if (next.alloy) el.dataset.alloy = next.alloy;
    else delete el.dataset.alloy;

    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('visible'));
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        el.classList.remove('visible');
        toastTimer = window.setTimeout(() => showNextToast(), 260);
    }, TOAST_MS);
}

/** Shows the celebratory banner for a local discovery unlock. */
export function showDiscoveryToast(def: DiscoveryDef, progress: DiscoveryProgress): void {
    enqueueToast({
        eyebrow: `${ALLOY_LABELS[def.alloy]} Discovery`,
        title: def.title,
        body: def.toast,
        counter: `${progress.found} / ${progress.total}`,
        alloy: def.alloy
    });
}

/** Shows a toast when another player in the same room discovers a secret. */
export function showFriendDiscoveryToast(playerName: string, discoveryId: string, mapId: MapId): void {
    const def = mapId === trackerRef.getMapId() ? trackerRef.getDefinition(discoveryId) : undefined;
    const mapName = isMapId(mapId) ? mapDescriptor(mapId).name : mapId;
    const label = def ? def.title : discoveryId.replace(/[-_]+/g, ' ');
    enqueueToast({
        eyebrow: `${mapName} · Crew Discovery`,
        title: `${playerName || 'A driver'} found ${label}`,
        body: def ? def.subtitle : 'Another driver uncovered a hidden landmark!',
        alloy: def?.alloy
    });
}

/** Wires the Codex dialog, HUD badge, `C` shortcut, and tracker callbacks (once). */
export function initCodex(tracker: DiscoveryTracker = discoveryTracker): void {
    trackerRef = tracker;
    if (initialized) {
        syncDiscoveryUi();
        return;
    }
    initialized = true;

    const dialog = dialogEl();
    if (dialog) {
        dialog.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => {
            if (!dialogOpen()) state.isModalOpen = false;
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const box = dialog.getBoundingClientRect();
            const e = event as MouseEvent;
            if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) {
                dialog.close();
            }
        });
    }

    document.getElementById('codex-chip')?.addEventListener('click', event => {
        (event.currentTarget as HTMLButtonElement).blur();
        toggleCodex();
    });

    window.addEventListener('keydown', event => {
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.toLowerCase() !== 'c') return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        if (state.inMenu) return;
        const target = dialogEl();
        if (!target) return;
        if (target.open) {
            event.preventDefault();
            target.close();
            return;
        }
        if (state.isModalOpen || dialogOpen()) return;
        if (trackerRef.getDefinitions().length === 0) return;
        event.preventDefault();
        openCodex();
    });

    trackerRef.onUnlock((def, progress) => {
        showDiscoveryToast(def, progress);
        triggerWorldDiscoveryFx(def.id, def.alloy);
        sendToServer({ type: 'discovery', discoveryId: def.id });
    });

    trackerRef.onChange(() => syncDiscoveryUi());
    syncDiscoveryUi();
}
