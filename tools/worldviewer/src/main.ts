// Worldviewer: map viewer and spline editor for the curated map
// (docs/phase-3-design.md, 5 and 16). Loads the baked heightfield and the
// map sources, shows terrain, roads, zones, POIs and tracks, edits
// roads.json (nodes, support points, width, surface, guard rails), exports
// it and re-bakes the heightfield in the browser with the shared modules.
//
// The edit logic lives in ../logic (pure, unit-tested); this file holds the
// state, the pointer and keyboard handling and the panel.

import roadsText from '../../../src/shared/maps/bulli-bay/roads.json?raw';
import mapText from '../../../src/shared/maps/bulli-bay/map.json?raw';
import zonesText from '../../../src/shared/maps/bulli-bay/zones.json?raw';
import poisText from '../../../src/shared/maps/bulli-bay/pois.json?raw';
import tracksText from '../../../src/shared/maps/bulli-bay/tracks.json?raw';
import baseText from '../../../src/shared/maps/bulli-bay/base.json?raw';
import terrainUrl from '../../../public/maps/bulli-bay/terrain.bhf?url';
import { BULLI_BAY_GRID, decodeHeightfield, heightAt, surfaceAt, zoneAt, type Heightfield } from '../../../src/shared/map/heightfield.js';
import { parseMapFile, parsePoisFile, parseTracksFile, parseZonesFile, type TrackRoute } from '../../../src/shared/map/mapFiles.js';
import { buildRoadNetwork, junctionRadius, nearestRoad, type RoadHit, type RoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import { parseRoadNetwork, RAIL_KINDS, ROAD_SURFACES, type ParseResult, type RailKind, type RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import { resolveRoute, type ResolvedRoute } from '../../../src/shared/map/trackRoute.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import { validateMap, type Finding } from '../../map/validateMap.js';
import { changeCount, summarizeChanges, tracksUsing } from '../logic/changes.js';
import {
    addEdge, commitEdit, deleteSelection, insertPoint, moveHandle, moveNode, movePoint, removeRail, reverseEdge,
    setEdgeProps, setNodeProps, setSideRail, sideRail, splitEdge, type EditResult, type Endpoint, type Selection
} from '../logic/editOps.js';
import { formatMapJson } from '../logic/format.js';
import { createHistory, pushHistory, redo, undo, type History } from '../logic/history.js';
import { minRadius, pickNearest, rayTerrain } from '../logic/viewGeometry.js';
import type { BakeRequest, BakeResponse, BakeSummary } from '../logic/bakeRequest.js';
import { checkbox, copyText, download, dropdown, el, numberInput, row } from './dom.js';
import { WorldScene, type ColorMode, type Handle, type Layers } from './scene.js';

const MAP_ID = 'bulli-bay';
const DRAFT_KEY = `bulli-worldviewer-draft:${MAP_ID}`;
// Pointer travel (px) below which a press counts as a click, not a drag
const CLICK_SLOP = 4;
// Handle pick radius (px)
const PICK_RADIUS = 10;

type Tool = 'select' | 'draw' | 'point' | 'split';

const TOOL_HELP: Record<Tool, string> = {
    select: 'Click a road or node to select it, drag nodes and support points. Del deletes, a deleted joint joins its two roads.',
    draw: 'Click to start a road, click again to add the next node. Clicking a road joins it there, clicking a node connects to it. Esc ends the road.',
    point: 'Click a road to add a support point there (the selected road first), then drag it with the select tool.',
    split: 'Click a road to split it with a new joint.'
};

function parsed<T>(name: string, result: ParseResult<T>): T {
    if (!result.ok) throw new Error(`${name}:\n${result.errors.join('\n')}`);
    return result.value;
}

// ---- Sources ----

// roads.json is kept as parsed JSON (not the schema's output), so its key
// order and with it the exported text stay as written
const loadedRoads = JSON.parse(roadsText) as RoadNetworkFile;
parsed('roads.json', parseRoadNetwork(loadedRoads));
const mapFile = parsed('map.json', parseMapFile(JSON.parse(mapText)));
const zonesFile = parsed('zones.json', parseZonesFile(JSON.parse(zonesText)));
const poisFile = parsed('pois.json', parsePoisFile(JSON.parse(poisText)));
const tracksFile = parsed('tracks.json', parseTracksFile(JSON.parse(tracksText)));

const SURFACE_NAMES = Object.fromEntries(Object.entries(SURFACE).map(([name, id]) => [id, name]));
const ZONE_NAMES = Object.fromEntries(Object.entries(ZONE).map(([name, id]) => [id, name]));

// ---- State ----

let history: History<RoadNetworkFile> = createHistory(loadedRoads);
let file = loadedRoads;
let net: RoadNetwork = buildRoadNetwork(file);
let hf: Heightfield;
let terrainBytes: Uint8Array;
// roads.json text the current heightfield was baked from
let bakedRoadsText = roadsText;
let selection: Selection = null;
let tool: Tool = 'select';
let drawFrom: Endpoint | null = null;
// Profile of drawn roads; '' = like the road at the start node (else the
// file's first profile)
let drawProfile = '';
let trackId = '';
let route: ResolvedRoute | null = null;
let routeErrors: string[] = [];
let showGrid = true;
let brokenTracks: { id: string; error: string }[] = [];
const layers: Layers = { roads: true, rails: true, nodes: true, zones: true, pois: true, water: true };
let colorMode: ColorMode = 'surface';
let detail = 2;
let findings: Finding[] | null = null;
let bakeRunning = false;
let bakeSummary: (BakeSummary & { ms: number }) | null = null;
let draft: string | null = null;

const viewport = document.getElementById('viewport')!;
const panel = document.getElementById('panel')!;
const statusBox = document.getElementById('status')!;
const scene = new WorldScene(viewport, document.getElementById('labels')!);

// ---- Status line ----

const cursorLine = el('div', { class: 'mono' });
const messageLine = el('div');
statusBox.append(messageLine, cursorLine);
messageLine.hidden = true;
let messageTimer = 0;

function message(text: string, kind: 'info' | 'error' | 'note' = 'info'): void {
    messageLine.textContent = text;
    messageLine.className = kind;
    messageLine.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => { messageLine.hidden = true; }, kind === 'error' ? 8000 : 4000);
}

// ---- Applying edits ----

function lengthOf(edgeId: string): number {
    const edge = net.edgeById.get(edgeId);
    if (!edge) throw new Error(`unknown edge ${edgeId}`);
    return edge.length;
}

function roadsChanged(next: RoadNetworkFile): void {
    net = buildRoadNetwork(next);
    scene.setRoads(net);
    scene.setSelection(net, next, selection);
}

// The edited file becomes the present state (one undo step)
function setFile(next: RoadNetworkFile, push = true): void {
    if (push) history = pushHistory(history, next);
    file = next;
    if (selection && !selectionExists(selection)) selection = null;
    roadsChanged(file);
    updateTrack();
    saveDraft();
    renderPanel();
}

function selectionExists(s: NonNullable<Selection>): boolean {
    switch (s.kind) {
        case 'node': return file.nodes.some(n => n.id === s.id);
        case 'edge': return file.edges.some(e => e.id === s.id);
        case 'point': {
            const edge = file.edges.find(e => e.id === s.edge);
            return edge?.curve.type === 'catmullRom' && s.index < edge.curve.points.length;
        }
        case 'handle': return file.edges.some(e => e.id === s.edge && e.curve.type === 'bezier');
    }
}

// Runs an operation; keeps the result only if it is a valid network
function apply(op: (f: RoadNetworkFile) => EditResult, onDone?: (result: EditResult) => void): boolean {
    const result = commitEdit(file, op);
    if (!result.ok) {
        message(result.errors.join('\n'), 'error');
        return false;
    }
    if (result.result.select !== undefined) selection = result.result.select;
    setFile(result.result.file);
    if (result.result.notes.length) message(result.result.notes.join('\n'), 'note');
    onDone?.(result.result);
    return true;
}

function selectObject(next: Selection): void {
    selection = next;
    scene.setSelection(net, file, selection);
    renderPanel();
}

function saveDraft(): void {
    try {
        if (file === loadedRoads || formatMapJson(file) === roadsText) localStorage.removeItem(DRAFT_KEY);
        else localStorage.setItem(DRAFT_KEY, formatMapJson(file));
    } catch {
        // Storage blocked: the draft is only a convenience
    }
}

function loadDraft(): string | null {
    try {
        const text = localStorage.getItem(DRAFT_KEY);
        return text && text !== roadsText ? text : null;
    } catch {
        return null;
    }
}

function loadRoadsText(text: string, what: string): void {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        message(`${what}: ${(error as Error).message}`, 'error');
        return;
    }
    const result = parseRoadNetwork(value);
    if (!result.ok) {
        message(`${what}:\n${result.errors.slice(0, 8).join('\n')}`, 'error');
        return;
    }
    selection = null;
    drawFrom = null;
    setFile(value as RoadNetworkFile);
    message(`Loaded ${what}`);
}

// ---- Track ----

function updateTrack(): void {
    brokenTracks = tracksFile.tracks.flatMap(track => {
        const result = resolveRoute(net, track);
        return result.ok ? [] : [{ id: track.id, error: result.errors[0] }];
    });
    const track = tracksFile.tracks.find(t => t.id === trackId);
    route = null;
    routeErrors = [];
    if (track) {
        const result = resolveRoute(net, track);
        if (result.ok) route = result.route;
        else routeErrors = result.errors;
    }
    scene.setTrack(route, showGrid);
}

// ---- Terrain ----

function setHeightfield(bytes: Uint8Array): void {
    terrainBytes = bytes;
    hf = decodeHeightfield(bytes, BULLI_BAY_GRID);
    scene.setTerrain(hf, colorMode, detail);
    // Everything draped on the terrain follows it
    scene.setRoads(net);
    scene.setSelection(net, file, selection);
    scene.setZones(zonesFile);
    scene.setPois(poisFile);
    scene.setLayers(layers);
    updateTrack();
}

let worker: Worker | null = null;

function rebake(): void {
    if (bakeRunning) return;
    bakeRunning = true;
    renderPanel();
    worker ??= new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
    const roads = formatMapJson(file);
    const request: BakeRequest = { mapId: MAP_ID, sources: { roads, map: mapText, zones: zonesText, base: baseText } };
    worker.onmessage = (event: MessageEvent<BakeResponse & { ms: number }>) => {
        bakeRunning = false;
        const response = event.data;
        if (!response.ok) {
            message(`Bake failed: ${response.error}`, 'error');
        } else {
            bakedRoadsText = roads;
            bakeSummary = { ...response.summary, ms: response.ms };
            setHeightfield(response.bytes);
            findings = null;
            message(`Baked in ${(response.ms / 1000).toFixed(1)} s`);
        }
        renderPanel();
    };
    worker.onerror = event => {
        bakeRunning = false;
        message(`Bake worker: ${event.message}`, 'error');
        renderPanel();
    };
    worker.postMessage(request);
}

// ---- Pointer ----

interface Drag { handle: Handle; base: RoadNetworkFile; preview: RoadNetworkFile | null }

let down: { x: number; y: number; moved: boolean } | null = null;
let drag: Drag | null = null;
let pendingMove: { x: number; y: number } | null = null;

function local(event: PointerEvent): { x: number; y: number } {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function groundAt(px: number, py: number): [number, number] | null {
    const ray = scene.rayAt(px, py);
    const t = rayTerrain(ray, (x, z) => heightAt(hf, x, z), 12000, 1);
    return t === null ? null : [ray.ox + ray.dx * t, ray.oz + ray.dz * t];
}

function pickHandle(px: number, py: number): Handle | null {
    const candidates = [];
    for (const handle of scene.getHandles()) {
        const screen = scene.toScreen(handle.x, handle.y, handle.z);
        if (screen) candidates.push({ ...screen, item: handle });
    }
    return pickNearest(candidates, px, py, PICK_RADIUS);
}

// The road under a ground point: the selected edge first, then the nearest
function pickRoad(x: number, z: number, preferSelected = false): RoadHit | null {
    const hit = nearestRoad(net, x, z, 40);
    if (preferSelected && selection && (selection.kind === 'edge' || selection.kind === 'point')) {
        const id = selection.kind === 'edge' ? selection.id : selection.edge;
        const edge = net.edgeById.get(id);
        if (edge) {
            let best: RoadHit | null = null;
            for (let k = 0; k < edge.samples.length; k++) {
                const s = edge.samples[k];
                const d = Math.hypot(s.x - x, s.z - z);
                if (!best || d < best.distance) best = { edge, s: s.s, x: s.x, z: s.z, tx: s.tx, tz: s.tz, distance: d, lateral: 0 };
            }
            if (best && best.distance <= edge.halfWidth + 3) return best;
        }
    }
    return hit && hit.distance <= hit.edge.halfWidth + 3 ? hit : null;
}

function dragTo(px: number, py: number): void {
    if (!drag) return;
    const ground = groundAt(px, py);
    if (!ground) return;
    const [x, z] = ground;
    const s = drag.handle.selection;
    const op = (f: RoadNetworkFile): EditResult => {
        switch (s.kind) {
            case 'node': return moveNode(f, s.id, x, z);
            case 'point': return movePoint(f, s.edge, s.index, x, z);
            case 'handle': return moveHandle(f, s.edge, s.segment, s.handle, x, z);
            case 'edge': throw new Error('edges are not dragged');
        }
    };
    const result = commitEdit(drag.base, op);
    if (!result.ok) {
        message(result.errors[0], 'error');
        return;
    }
    drag.preview = result.result.file;
    file = drag.preview;
    roadsChanged(file);
}

function showCursor(px: number, py: number): void {
    const ground = groundAt(px, py);
    if (!ground) {
        cursorLine.textContent = '';
        return;
    }
    const [x, z] = ground;
    const road = nearestRoad(net, x, z, 20);
    const onRoad = road && road.distance <= road.edge.halfWidth ? `  road ${road.edge.id} s=${road.s.toFixed(1)}` : '';
    cursorLine.textContent = `x ${x.toFixed(1)}  z ${z.toFixed(1)}  y ${heightAt(hf, x, z).toFixed(2)}  ` +
        `${SURFACE_NAMES[surfaceAt(hf, x, z)]} / ${ZONE_NAMES[zoneAt(hf, x, z)]}${onRoad}`;
    if (tool === 'draw' && drawFrom) scene.setDraft(endpointPosition(drawFrom), ground);
    viewport.style.cursor = tool === 'select' && pickHandle(px, py) ? 'grab' : tool === 'select' ? '' : 'crosshair';
}

function endpointPosition(end: Endpoint): [number, number] | null {
    if ('at' in end) return end.at;
    const node = file.nodes.find(n => n.id === end.node);
    return node ? [node.x, node.z] : null;
}

viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const p = local(event);
    down = { ...p, moved: false };
    if (tool !== 'select') return;
    const handle = pickHandle(p.x, p.y);
    if (!handle) return;
    // Our drag, not the camera's pan
    event.stopPropagation();
    selection = handle.selection;
    drag = { handle, base: file, preview: null };
    scene.setSelection(net, file, selection);
    viewport.style.cursor = 'grabbing';
}, { capture: true });

window.addEventListener('pointermove', event => {
    const p = local(event);
    if (down && Math.hypot(p.x - down.x, p.y - down.y) > CLICK_SLOP) down.moved = true;
    if (!pendingMove) requestAnimationFrame(() => {
        const move = pendingMove;
        pendingMove = null;
        if (!move) return;
        if (drag && down?.moved) dragTo(move.x, move.y);
        else if (!down) showCursor(move.x, move.y);
    });
    pendingMove = p;
});

window.addEventListener('pointerup', event => {
    const p = local(event);
    const wasDown = down;
    down = null;
    if (drag) {
        const { preview } = drag;
        drag = null;
        viewport.style.cursor = 'grab';
        if (preview && wasDown?.moved) setFile(preview);
        else renderPanel();
        return;
    }
    if (wasDown && !wasDown.moved && event.button === 0 && event.target instanceof HTMLCanvasElement) click(p.x, p.y);
});

function click(px: number, py: number): void {
    const ground = groundAt(px, py);
    if (tool === 'select') {
        const handle = pickHandle(px, py);
        if (handle) return selectObject(handle.selection);
        const road = ground && pickRoad(ground[0], ground[1]);
        return selectObject(road ? { kind: 'edge', id: road.edge.id } : null);
    }
    if (!ground) return;
    const [x, z] = ground;
    if (tool === 'point' || tool === 'split') {
        const road = pickRoad(x, z, tool === 'point');
        if (!road) return message('No road here', 'error');
        if (tool === 'point') apply(f => insertPoint(f, road.edge.id, road.x, road.z));
        else apply(f => splitEdge(f, road.edge.id, road));
        return;
    }
    // Draw: a node, a road (joined with a new joint) or open ground
    const handle = pickHandle(px, py);
    const target: Endpoint | 'split' | null = handle?.selection.kind === 'node' ? { node: handle.selection.id }
        : pickRoad(x, z) ? 'split' : null;
    const from = drawFrom;
    const options = drawProfile ? { profile: drawProfile } : {};
    if (target === 'split') {
        const road = pickRoad(x, z)!;
        apply(f => {
            const split = splitEdge(f, road.edge.id, road);
            const joint = (split.select as { id: string }).id;
            return from ? addEdge(split.file, from, { node: joint }, options) : split;
        }, result => { drawFrom = { node: (result.select as { id: string }).id }; });
    } else if (target) {
        if (!from) {
            drawFrom = target;
            selectObject({ kind: 'node', id: target.node });
        } else {
            apply(f => addEdge(f, from, target, options), () => { drawFrom = target; });
        }
    } else if (!from) {
        drawFrom = { at: [x, z] };
        message('Road started: click the next point');
    } else {
        apply(f => addEdge(f, from, { at: [x, z] }, options), result => { drawFrom = { node: (result.select as { id: string }).id }; });
    }
    scene.setDraft(drawFrom ? endpointPosition(drawFrom) : null, null);
    renderPanel();
}

// ---- Keyboard ----

function setTool(next: Tool): void {
    tool = next;
    drawFrom = null;
    scene.setDraft(null, null);
    viewport.style.cursor = tool === 'select' ? '' : 'crosshair';
    renderPanel();
}

function doUndo(): void {
    history = undo(history);
    drawFrom = null;
    scene.setDraft(null, null);
    setFile(history.present, false);
}

function doRedo(): void {
    history = redo(history);
    setFile(history.present, false);
}

function deleteSelected(): void {
    if (!selection) return;
    const current = selection;
    apply(f => deleteSelection(f, current, lengthOf));
}

function focusSelection(): void {
    if (!selection) return;
    if (selection.kind === 'node') {
        const node = net.nodeById.get(selection.id);
        if (node) scene.focus(node.x, node.z);
    } else {
        const id = selection.kind === 'edge' ? selection.id : selection.edge;
        const edge = net.edgeById.get(id);
        if (edge) {
            const mid = edge.samples[Math.floor(edge.samples.length / 2)];
            scene.focus(mid.x, mid.z, Math.max(150, edge.length * 1.2));
        }
    }
}

window.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea')) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) doRedo(); else doUndo();
    } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        doRedo();
    } else if (mod) {
        return;
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
    } else if (event.key === 'Escape') {
        if (drawFrom) {
            drawFrom = null;
            scene.setDraft(null, null);
        } else {
            selectObject(null);
        }
    } else if (event.key === 'v') setTool('select');
    else if (event.key === 'n') setTool('draw');
    else if (event.key === 'p') setTool('point');
    else if (event.key === 's') setTool('split');
    else if (event.key === 'f') focusSelection();
});

// ---- Panel ----

function section(title: string, ...children: (Node | string | null | false | undefined)[]): HTMLElement[] {
    return [el('h2', {}, title), ...children.filter((c): c is Node | string => !!c).map(c => typeof c === 'string' ? el('div', {}, c) : c as HTMLElement)];
}

function renderHeader(): HTMLElement[] {
    const changes = summarizeChanges(loadedRoads, file);
    const count = changeCount(changes);
    const stale = formatMapJson(file) !== bakedRoadsText;
    const lines: (HTMLElement | null)[] = [
        el('h1', {}, `${mapFile.name} worldviewer`),
        el('div', { class: 'small muted' }, `mapVersion ${mapFile.mapVersion} · ${file.nodes.length} nodes · ${file.edges.length} edges · ` +
            `${(net.edges.reduce((s, e) => s + e.length, 0) / 1000).toFixed(2)} km`),
        el('div', { class: count ? 'warn small' : 'small muted' }, count
            ? `${count} change${count === 1 ? '' : 's'} against roads.json` +
              ` (edges +${changes.edges.added.length} −${changes.edges.removed.length} ~${changes.edges.changed.length}, ` +
              `nodes +${changes.nodes.added.length} −${changes.nodes.removed.length} ~${changes.nodes.changed.length})`
            : 'No changes against roads.json'),
        stale ? el('div', { class: 'warn small' }, 'The terrain is from an older road network: rebake to see the new corridors.') : null,
        ...brokenTracks.map(t => el('div', { class: 'error small' }, `Track ${t.id}: ${t.error}`))
    ];
    return lines.filter((n): n is HTMLElement => n !== null);
}

function renderTools(): HTMLElement[] {
    const button = (t: Tool, text: string, key: string) =>
        el('button', { class: tool === t ? 'active' : '', title: `${text} (${key})`, onclick: () => setTool(t) }, text, ' ', el('kbd', {}, key));
    return section('Tools',
        el('div', { class: 'tools' }, button('select', 'Select', 'V'), button('draw', 'Draw', 'N'), button('point', 'Point', 'P'), button('split', 'Split', 'S')),
        el('div', { class: 'small muted' }, TOOL_HELP[tool]),
        tool === 'draw' ? row('New roads', dropdown(drawProfile, [['', 'profile of the start road'], ...Object.keys(file.profiles)],
            v => { drawProfile = v; })) : null,
        el('div', { class: 'row' },
            el('button', { disabled: history.past.length === 0, onclick: doUndo }, `Undo (${history.past.length})`),
            el('button', { disabled: history.future.length === 0, onclick: doRedo }, `Redo (${history.future.length})`),
            el('button', { disabled: !selection, onclick: focusSelection }, 'Focus ', el('kbd', {}, 'F')))
    );
}

function renderNode(id: string): HTMLElement[] {
    const node = file.nodes.find(n => n.id === id);
    const data = net.nodeById.get(id);
    if (!node || !data) return [];
    const roads = data.ends.map(end => net.edges[end.edge].id);
    return section(`Node ${id}`,
        el('div', { class: 'small muted' }, `${node.kind} · ${roads.length} road end${roads.length === 1 ? '' : 's'}: ${roads.join(', ')}` +
            (node.kind === 'junction' ? ` · trim radius ${junctionRadius(net, data).toFixed(1)} m` : '')),
        row('x / z',
            numberInput(node.x, v => v !== null && apply(f => moveNode(f, id, v, node.z))),
            numberInput(node.z, v => v !== null && apply(f => moveNode(f, id, node.x, v)))),
        row('Fixed height', numberInput(node.y, v => apply(f => setNodeProps(f, id, { y: v })), { step: 0.01, placeholder: `terrain (${heightAt(hf, node.x, node.z).toFixed(2)})` })),
        node.kind === 'junction' ? row('Control', dropdown(node.junction?.control ?? 'none', ['signal', 'stop', 'yield', 'none'] as const,
            v => apply(f => setNodeProps(f, id, { control: v })))) : null,
        el('div', { class: 'row' },
            el('button', { onclick: () => { setTool('draw'); drawFrom = { node: id }; scene.setDraft([node.x, node.z], null); } }, 'Draw from here'),
            el('button', { onclick: deleteSelected }, node.kind === 'joint' ? 'Delete (join roads)' : 'Delete with roads'))
    );
}

function renderEdge(id: string): HTMLElement[] {
    const edge = file.edges.find(e => e.id === id);
    const data = net.edgeById.get(id);
    if (!edge || !data) return [];
    const profile = file.profiles[edge.profile];
    const tracks = tracksUsing(tracksFile.tracks, [id]);
    const railSelect = (side: 'left' | 'right') => {
        const state = sideRail(edge, side);
        return dropdown(state, ['none', ...RAIL_KINDS, 'mixed'] as const,
            v => v !== 'mixed' && apply(f => setSideRail(f, id, side, v === 'none' ? null : v as RailKind)), state === 'mixed' ? [] : ['mixed']);
    };
    const rails = (edge.rails ?? []).map((rail, i) => el('div', { class: 'row small' },
        el('span', { class: 'mono' }, `${rail.side} ${rail.kind} ${rail.from}…${rail.to === -1 ? 'end' : rail.to} m`),
        el('button', { onclick: () => apply(f => removeRail(f, id, i)) }, 'Remove')));
    return section(`Road ${id}`,
        el('div', { class: 'small muted' }, `${edge.from} → ${edge.to} · ${data.length.toFixed(1)} m · ` +
            `min radius ${Number.isFinite(minRadius(data.samples)) ? minRadius(data.samples).toFixed(1) + ' m' : 'straight'} · ` +
            `${edge.curve.type === 'catmullRom' ? `${edge.curve.points.length} support points` : `${edge.curve.segments.length} Bézier segments`}`),
        tracks.length ? el('div', { class: 'small warn' }, `Used by ${tracks.join(', ')} (tracks.json is not edited here)`) : null,
        row('Name', el('input', { type: 'text', value: edge.name ?? '', onchange: (e: Event) => apply(f => setEdgeProps(f, id, { name: (e.target as HTMLInputElement).value })) })),
        row('Profile', dropdown(edge.profile, Object.keys(file.profiles), v => apply(f => setEdgeProps(f, id, { profile: v })))),
        row('Width', numberInput(edge.overrides?.width, v => apply(f => setEdgeProps(f, id, { width: v })), { placeholder: `${profile.width} (profile)` })),
        row('Surface', dropdown(edge.overrides?.surface ?? '', [['', `${profile.surface} (profile)`], ...ROAD_SURFACES] as const,
            v => apply(f => setEdgeProps(f, id, { surface: v === '' ? null : v })))),
        row('Max grade', numberInput(edge.maxGrade, v => apply(f => setEdgeProps(f, id, { maxGrade: v })), { step: 0.01, placeholder: '0.08 (default)' })),
        row('One-way', checkbox('', edge.oneWay ?? false, v => apply(f => setEdgeProps(f, id, { oneWay: v })))),
        row('Rail left', railSelect('left')),
        row('Rail right', railSelect('right')),
        ...rails,
        el('div', { class: 'row' },
            el('button', { onclick: () => apply(f => reverseEdge(f, id, data.length)) }, 'Reverse'),
            el('button', { onclick: deleteSelected }, 'Delete road'))
    );
}

function renderPoint(s: Extract<Selection, { kind: 'point' | 'handle' }>): HTMLElement[] {
    const edge = file.edges.find(e => e.id === s.edge);
    if (!edge) return [];
    let p: [number, number] | undefined;
    if (s.kind === 'point' && edge.curve.type === 'catmullRom') p = edge.curve.points[s.index];
    if (s.kind === 'handle' && edge.curve.type === 'bezier') p = edge.curve.segments[s.segment]?.[s.handle];
    if (!p) return [];
    const [px, pz] = p;
    const move = (x: number, z: number) => apply(f => s.kind === 'point' ? movePoint(f, s.edge, s.index, x, z) : moveHandle(f, s.edge, s.segment, s.handle, x, z));
    return section(s.kind === 'point' ? `Support point ${s.index} of ${s.edge}` : `Handle ${s.handle} of segment ${s.segment} of ${s.edge}`,
        row('x / z',
            numberInput(px, v => v !== null && move(v, pz)),
            numberInput(pz, v => v !== null && move(px, v))),
        el('div', { class: 'row' },
            el('button', { onclick: () => selectObject({ kind: 'edge', id: s.edge }) }, 'Select road'),
            s.kind === 'point' ? el('button', { onclick: deleteSelected }, 'Delete point') : null)
    );
}

function renderSelection(): HTMLElement[] {
    if (!selection) return section('Selection', el('div', { class: 'small muted' }, 'Nothing selected.'));
    switch (selection.kind) {
        case 'node': return renderNode(selection.id);
        case 'edge': return renderEdge(selection.id);
        default: return renderPoint(selection);
    }
}

function renderTrack(): HTMLElement[] {
    const options: [string, string][] = [['', 'none'], ...tracksFile.tracks.map((t: TrackRoute) => [t.id, `${t.name}${t.bonus ? ' (bonus)' : ''}`] as [string, string])];
    const info = route ? el('div', { class: 'small muted' },
        `${route.track.kind}, ${route.track.laps} lap${route.track.laps === 1 ? '' : 's'} · ${(route.length / 1000).toFixed(2)} km · ` +
        `${route.gates.length} gates · ${route.grid.length} grid slots`) : null;
    return section('Track',
        row('Show', dropdown(trackId, options, v => { trackId = v; updateTrack(); renderPanel(); if (route) scene.focus(route.points[0].x, route.points[0].z, 900); })),
        row('', checkbox('Starting grid', showGrid, v => { showGrid = v; updateTrack(); })),
        info,
        ...routeErrors.map(e => el('div', { class: 'error small' }, e))
    );
}

function renderView(): HTMLElement[] {
    const layer = (key: keyof Layers, text: string) => checkbox(text, layers[key], v => { layers[key] = v; scene.setLayers(layers); });
    return section('View',
        row('Terrain', dropdown(colorMode, [['surface', 'surface'], ['relief', 'relief'], ['zones', 'zones']] as const, v => { colorMode = v; scene.setTerrain(hf, colorMode, detail); })),
        row('Detail', dropdown(String(detail), [['1', '2 m grid'], ['2', '4 m grid'], ['4', '8 m grid']] as const, v => { detail = Number(v); scene.setTerrain(hf, colorMode, detail); })),
        el('div', { class: 'checks' }, layer('roads', 'Roads'), layer('rails', 'Guard rails'), layer('nodes', 'Nodes'),
            layer('zones', 'Zones'), layer('pois', 'POIs, spawns'), layer('water', 'Sea')),
        el('div', { class: 'small muted' }, 'Left drag pans, right drag turns, wheel zooms.')
    );
}

function renderTerrain(): HTMLElement[] {
    const s = bakeSummary;
    return section('Heightfield',
        el('div', { class: 'row' },
            el('button', { disabled: bakeRunning, onclick: rebake }, bakeRunning ? 'Baking…' : 'Rebake heightfield'),
            el('button', { onclick: () => download('terrain.bhf', terrainBytes.slice(), 'application/octet-stream') }, 'Download terrain.bhf')),
        el('div', { class: 'small muted' }, 'Bakes the edited roads with tools/map/bakeTerrain.ts in a worker. ' +
            'For the repository, export roads.json and run npx tsx tools/map/bake.ts.'),
        s ? el('div', { class: s.conflicts || s.infeasibleChains.length ? 'small warn' : 'small ok' },
            `${(s.ms / 1000).toFixed(1)} s · ${s.conflicts} corridor conflicts (worst ${s.maxConflictGap.toFixed(2)} m) · ` +
            `${s.infeasibleChains.length} unmet pins · steepest road ${(s.maxBakedGrade.grade * 100).toFixed(1)} % (${s.maxBakedGrade.edge}) · ` +
            `heights ${s.minHeight.toFixed(1)}…${s.maxHeight.toFixed(1)} m`) : null,
        ...(s?.infeasibleChains ?? []).map(c => el('div', { class: 'small warn' }, `${c.edges.join(' → ')}: pins miss the grade limit by ${c.infeasible.toFixed(2)} m`)),
        ...(s?.networkIssues ?? []).map(issue => el('div', { class: 'small warn' }, issue))
    );
}

function renderCheck(): HTMLElement[] {
    const list = findings === null ? null : findings.length === 0
        ? el('div', { class: 'small ok' }, 'No findings.')
        : el('ul', { class: 'findings' }, ...findings.map(f => el('li', {
            class: f.severity === 'error' ? 'error' : 'warn',
            title: 'Click to look there',
            onclick: () => { if (f.x !== undefined && f.z !== undefined) scene.focus(f.x, f.z); }
        }, `${f.check}: ${f.message}`)));
    return section('Check',
        el('button', {
            onclick: () => {
                findings = validateMap({ net, map: mapFile, zones: zonesFile, pois: poisFile, tracks: tracksFile, hf }).findings;
                renderPanel();
            }
        }, 'Validate map'),
        el('div', { class: 'small muted' }, 'Runs tools/map/validateMap.ts on the edited roads and the current heightfield.'),
        list
    );
}

function renderExport(): HTMLElement[] {
    const fileInput = el('input', {
        type: 'file', accept: '.json,application/json', hidden: true,
        onchange: async () => {
            const chosen = fileInput.files?.[0];
            if (chosen) loadRoadsText(await chosen.text(), chosen.name);
            fileInput.value = '';
        }
    });
    return section('Export roads.json',
        el('div', { class: 'row' },
            el('button', { onclick: () => download('roads.json', formatMapJson(file), 'application/json') }, 'Download'),
            el('button', {
                onclick: () => copyText(formatMapJson(file)).then(() => message('roads.json copied to the clipboard'), error => message(String(error), 'error'))
            }, 'Copy to clipboard'),
            el('button', { onclick: () => fileInput.click() }, 'Open…'),
            fileInput),
        el('div', { class: 'small muted' }, 'Save as src/shared/maps/bulli-bay/roads.json. Unchanged lines stay byte for byte as they are.'),
        el('div', { class: 'row' },
            el('button', { disabled: file === loadedRoads, onclick: () => { selection = null; setFile(loadedRoads); } }, 'Back to the repository version'),
            draft ? el('button', { onclick: () => { const text = draft!; draft = null; loadRoadsText(text, 'the unsaved draft'); } }, 'Restore unsaved draft') : null)
    );
}

function renderPanel(): void {
    panel.replaceChildren(...renderHeader(), ...renderTools(), ...renderSelection(), ...renderTrack(),
        ...renderView(), ...renderTerrain(), ...renderCheck(), ...renderExport());
}

// ---- Start ----

async function start(): Promise<void> {
    message('Loading terrain…');
    const response = await fetch(terrainUrl);
    if (!response.ok) throw new Error(`terrain.bhf: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    setHeightfield(bytes);
    draft = loadDraft();
    renderPanel();
    message(draft ? 'An unsaved draft of roads.json is there: Export → Restore unsaved draft' : 'Ready', draft ? 'note' : 'info');
}

start().catch(error => {
    console.error(error);
    message(`Could not load the map: ${(error as Error).message}`, 'error');
});

// Keep the state reachable from the console for debugging
Object.assign(window, { worldviewer: { scene, get file() { return file; }, get net() { return net; }, get hf() { return hf; }, get selection() { return selection; } } });
