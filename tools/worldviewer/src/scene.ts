// The worldviewer's three.js scene: terrain, sea, road ribbons, areas,
// guard rails, zone outlines, POIs, the selected edge's control points and
// the selected track. All geometry comes from the pure functions in
// ../logic/viewGeometry.ts and the shared map modules; this file only puts
// it into buffers, materials and HTML labels.

import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { heightAt, zoneCols, zoneRows, type Heightfield } from '../../../src/shared/map/heightfield.js';
import type { PoisFile, ZonesFile } from '../../../src/shared/map/mapFiles.js';
import { RAIL_TOPS, railLine } from '../../../src/shared/map/rails.js';
import type { RoadNetwork } from '../../../src/shared/map/roadNetwork.js';
import type { RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import type { ResolvedRoute } from '../../../src/shared/map/trackRoute.js';
import { SURFACE, ZONE } from '../../../src/shared/map/types.js';
import type { Selection } from '../logic/editOps.js';
import { gateEnds, ribbonArrays, terrainArrays, type Ray } from '../logic/viewGeometry.js';

export type ColorMode = 'surface' | 'relief' | 'zones';

export interface Layers {
    roads: boolean;
    rails: boolean;
    nodes: boolean;
    zones: boolean;
    pois: boolean;
    water: boolean;
}

// A pickable point on screen: a node, a support point or a Bézier handle
export interface Handle {
    selection: NonNullable<Selection>;
    x: number;
    y: number;
    z: number;
}

const SURFACE_COLORS: Record<number, number> = {
    [SURFACE.asphalt]: 0x3b3d40,
    [SURFACE.concrete]: 0x9a9892,
    [SURFACE.wood]: 0x8a6a45,
    [SURFACE.gravel]: 0x8c8378,
    [SURFACE.dirt]: 0x8a6f4e,
    [SURFACE.grass]: 0x6f8f4a,
    [SURFACE.sand]: 0xd9c79a,
    [SURFACE.wetSand]: 0xb3a27a,
    [SURFACE.rock]: 0x8b8680,
    [SURFACE.water]: 0x2e5f7a
};

export const ZONE_COLORS: Record<number, number> = {
    [ZONE.wild]: 0x7d8f63,
    [ZONE.downtown]: 0xc7654e,
    [ZONE.residential]: 0xe0a84f,
    [ZONE.industrial]: 0x7f7fa8,
    [ZONE.beach]: 0xf0dc8c,
    [ZONE.dunes]: 0xd4b876,
    [ZONE.hills]: 0x5f8a4a,
    [ZONE.cliffs]: 0x9a8f86,
    [ZONE.arena]: 0xd04ea0,
    [ZONE.park]: 0x4fb05a,
    [ZONE.ranch]: 0xb89a5c
};

const RAIL_COLORS: Record<string, number> = { wbeam: 0xd8dde2, concrete: 0xbdb7ad, wood: 0x9a7248, fence: 0x6d7a70 };
const NODE_COLORS = { junction: 0xffc93c, joint: 0x7fd1ff, end: 0xff7b7b };

// Lift of the draped overlays over the terrain (m), against z-fighting
const RIBBON_LIFT = 0.2;
const SELECTED_LIFT = 0.45;

function disposeObject(object: THREE.Object3D): void {
    object.traverse(child => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach(m => m.dispose());
        else material?.dispose();
    });
}

function lineSegments(positions: number[], color: number, opacity = 1, depthTest = true): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest });
    const lines = new THREE.LineSegments(geometry, material);
    if (!depthTest) lines.renderOrder = 10;
    return lines;
}

interface Label { element: HTMLElement; position: THREE.Vector3 }

export class WorldScene {
    readonly renderer: THREE.WebGLRenderer;
    readonly camera: THREE.PerspectiveCamera;
    readonly controls: MapControls;
    private readonly scene = new THREE.Scene();
    private readonly groups = {
        terrain: new THREE.Group(),
        water: new THREE.Group(),
        roads: new THREE.Group(),
        rails: new THREE.Group(),
        nodes: new THREE.Group(),
        selection: new THREE.Group(),
        track: new THREE.Group(),
        zones: new THREE.Group(),
        pois: new THREE.Group(),
        draft: new THREE.Group()
    };
    private labels: { zones: Label[]; pois: Label[] } = { zones: [], pois: [] };
    private handles: Handle[] = [];
    private hf: Heightfield | null = null;

    constructor(private readonly container: HTMLElement, private readonly labelLayer: HTMLElement) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0xbfd4e6);
        container.prepend(this.renderer.domElement);

        this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 12000);
        this.camera.position.set(0, 1500, 1300);
        this.controls = new MapControls(this.camera, this.renderer.domElement);
        this.controls.maxPolarAngle = Math.PI * 0.47;
        this.controls.minDistance = 10;
        this.controls.maxDistance = 5000;
        this.controls.zoomToCursor = true;
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x6a5a45, 1.1));
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(-600, 900, 400);
        this.scene.add(sun);
        for (const group of Object.values(this.groups)) this.scene.add(group);

        const water = new THREE.Mesh(
            new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
            new THREE.MeshLambertMaterial({ color: 0x2f6f96, transparent: true, opacity: 0.72 })
        );
        this.groups.water.add(water);

        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();
        this.renderer.setAnimationLoop(() => this.frame());
    }

    private resize(): void {
        const { clientWidth: w, clientHeight: h } = this.container;
        if (w === 0 || h === 0) return;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    private frame(): void {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.placeLabels();
    }

    private clear(group: THREE.Group): void {
        for (const child of [...group.children]) {
            disposeObject(child);
            group.remove(child);
        }
    }

    height(x: number, z: number): number {
        return this.hf ? heightAt(this.hf, x, z) : 0;
    }

    setLayers(layers: Layers): void {
        this.groups.roads.visible = layers.roads;
        this.groups.rails.visible = layers.rails;
        this.groups.nodes.visible = layers.nodes;
        this.groups.zones.visible = layers.zones;
        this.groups.pois.visible = layers.pois;
        this.groups.water.visible = layers.water;
        for (const label of this.labels.zones) label.element.hidden = !layers.zones;
        for (const label of this.labels.pois) label.element.hidden = !layers.pois;
    }

    // ---- Terrain ----

    setTerrain(hf: Heightfield, mode: ColorMode, step: number): void {
        this.hf = hf;
        this.clear(this.groups.terrain);
        const { positions, indices, gridIndex } = terrainArrays(hf, step);
        const colors = new Float32Array(positions.length);
        const color = new THREE.Color();
        const low = new THREE.Color(0x5d8a4e), high = new THREE.Color(0xe8e0cc), sea = new THREE.Color(0x24506b);
        const zc = zoneCols(hf.spec), zr = zoneRows(hf.spec);
        for (let v = 0; v < gridIndex.length; v++) {
            const k = gridIndex[v];
            if (mode === 'surface') {
                color.setHex(SURFACE_COLORS[hf.surface[k]] ?? 0xff00ff);
            } else if (mode === 'relief') {
                const y = positions[v * 3 + 1];
                if (y < 0) color.copy(sea);
                else color.copy(low).lerp(high, Math.min(1, y / 160));
            } else {
                const x = positions[v * 3], z = positions[v * 3 + 2];
                const i = Math.min(zc - 1, Math.max(0, Math.floor((x - hf.spec.originX) / hf.spec.zoneCell)));
                const j = Math.min(zr - 1, Math.max(0, Math.floor((z - hf.spec.originZ) / hf.spec.zoneCell)));
                color.setHex(ZONE_COLORS[hf.zones[j * zc + i]] ?? 0xff00ff);
            }
            color.toArray(colors, v * 3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
        this.groups.terrain.add(mesh);
    }

    // ---- Roads ----

    setRoads(net: RoadNetwork): void {
        this.clear(this.groups.roads);
        this.clear(this.groups.rails);
        this.clear(this.groups.nodes);
        const h = (x: number, z: number) => this.height(x, z);

        // One mesh for all ribbons, coloured by surface
        const positions: number[] = [], colors: number[] = [], indices: number[] = [];
        const color = new THREE.Color();
        for (const edge of net.edges) {
            const ribbon = ribbonArrays(edge.samples, edge.halfWidth, h, RIBBON_LIFT);
            const base = positions.length / 3;
            color.setHex(SURFACE_COLORS[SURFACE[edge.profile.surface]]);
            for (let i = 0; i < ribbon.positions.length; i += 3) {
                positions.push(ribbon.positions[i], ribbon.positions[i + 1], ribbon.positions[i + 2]);
                colors.push(color.r, color.g, color.b);
            }
            for (const index of ribbon.indices) indices.push(base + index);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        const material = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
        this.groups.roads.add(new THREE.Mesh(geometry, material));

        // Areas (plazas, lots, the pier) as flat polygons
        for (const area of net.areas) {
            const contour = area.polygon.map(([x, z]) => new THREE.Vector2(x, z));
            const faces = THREE.ShapeUtils.triangulateShape(contour, []);
            const cx = contour.reduce((s, p) => s + p.x, 0) / contour.length;
            const cz = contour.reduce((s, p) => s + p.y, 0) / contour.length;
            const y = (area.y ?? h(cx, cz)) + RIBBON_LIFT;
            const areaGeometry = new THREE.BufferGeometry();
            areaGeometry.setAttribute('position', new THREE.Float32BufferAttribute(contour.flatMap(p => [p.x, y, p.y]), 3));
            areaGeometry.setIndex(faces.flatMap(([a, b, c]) => [a, c, b]));
            const areaMaterial = new THREE.MeshBasicMaterial({
                color: SURFACE_COLORS[SURFACE[area.surface]], side: THREE.DoubleSide,
                polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
            });
            this.groups.roads.add(new THREE.Mesh(areaGeometry, areaMaterial));
        }

        // Guard rails at their top height
        const byKind = new Map<string, number[]>();
        for (const edge of net.edges) {
            for (const rail of edge.def.rails ?? []) {
                const line = railLine(edge, rail);
                const list = byKind.get(rail.kind) ?? [];
                for (let i = 0; i + 1 < line.length; i++) {
                    const [ax, az] = line[i], [bx, bz] = line[i + 1];
                    const top = RAIL_TOPS[rail.kind];
                    list.push(ax, h(ax, az) + top, az, bx, h(bx, bz) + top, bz);
                }
                byKind.set(rail.kind, list);
            }
        }
        for (const [kind, list] of byKind) this.groups.rails.add(lineSegments(list, RAIL_COLORS[kind]));

        // Nodes as screen-sized points on top
        const nodePositions: number[] = [], nodeColors: number[] = [];
        for (const node of net.nodes) {
            nodePositions.push(node.x, (node.def.y ?? h(node.x, node.z)) + 1, node.z);
            color.setHex(NODE_COLORS[node.def.kind]);
            nodeColors.push(color.r, color.g, color.b);
        }
        const nodeGeometry = new THREE.BufferGeometry();
        nodeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(nodePositions, 3));
        nodeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(nodeColors, 3));
        const points = new THREE.Points(nodeGeometry, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false }));
        points.renderOrder = 20;
        this.groups.nodes.add(points);
    }

    // The selected edge highlighted, with its control polygon and handles.
    // Returns the pickable handles (nodes always, the selected edge's
    // support points or Bézier handles on top).
    setSelection(net: RoadNetwork, file: RoadNetworkFile, selection: Selection): void {
        this.clear(this.groups.selection);
        const h = (x: number, z: number) => this.height(x, z);
        const handles: Handle[] = net.nodes.map(node => ({
            selection: { kind: 'node', id: node.id }, x: node.x, y: (node.def.y ?? h(node.x, node.z)) + 1, z: node.z
        }));
        const edgeId = selection?.kind === 'edge' ? selection.id
            : selection?.kind === 'point' || selection?.kind === 'handle' ? selection.edge : null;
        const edge = edgeId ? net.edgeById.get(edgeId) : undefined;
        if (edge) {
            const ribbon = ribbonArrays(edge.samples, edge.halfWidth + 0.6, h, SELECTED_LIFT);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
            this.groups.selection.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
                color: 0xffa640, transparent: true, opacity: 0.55, depthWrite: false,
                polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8
            })));
            const def = file.edges.find(e => e.id === edge.id)!;
            const from = net.nodes[edge.from], to = net.nodes[edge.to];
            const control: [number, number][] = [];
            const extra: Handle[] = [];
            if (def.curve.type === 'catmullRom') {
                control.push([from.x, from.z], ...def.curve.points, [to.x, to.z]);
                def.curve.points.forEach(([x, z], index) => extra.push({ selection: { kind: 'point', edge: edge.id, index }, x, y: h(x, z) + 1, z }));
            } else {
                let start: [number, number] = [from.x, from.z];
                def.curve.segments.forEach((segment, i) => {
                    const end: [number, number] = segment.to ?? [to.x, to.z];
                    control.push(start, segment.c1, segment.c2, end);
                    for (const handle of ['c1', 'c2', 'to'] as const) {
                        const p = segment[handle];
                        if (p) extra.push({ selection: { kind: 'handle', edge: edge.id, segment: i, handle }, x: p[0], y: h(p[0], p[1]) + 1, z: p[1] });
                    }
                    start = end;
                });
            }
            const polygon: number[] = [];
            for (let i = 0; i + 1 < control.length; i++) {
                const [ax, az] = control[i], [bx, bz] = control[i + 1];
                polygon.push(ax, h(ax, az) + 1, az, bx, h(bx, bz) + 1, bz);
            }
            this.groups.selection.add(lineSegments(polygon, 0xffe2a8, 0.9, false));
            const pointGeometry = new THREE.BufferGeometry();
            pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(extra.flatMap(p => [p.x, p.y, p.z]), 3));
            const pts = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ color: 0xff8c1a, size: 11, sizeAttenuation: false, depthTest: false }));
            pts.renderOrder = 30;
            this.groups.selection.add(pts);
            // Support points first: they win a tie against a node below them
            handles.unshift(...extra);
        }
        if (selection?.kind === 'node') {
            const node = net.nodeById.get(selection.id);
            if (node) {
                const y = (node.def.y ?? h(node.x, node.z)) + 1;
                const ring = new THREE.BufferGeometry();
                ring.setAttribute('position', new THREE.Float32BufferAttribute([node.x, y, node.z], 3));
                const marker = new THREE.Points(ring, new THREE.PointsMaterial({ color: 0xffffff, size: 16, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.8 }));
                marker.renderOrder = 15;
                this.groups.selection.add(marker);
            }
        }
        if (selection?.kind === 'point' || selection?.kind === 'handle') {
            const handle = handles.find(h2 => JSON.stringify(h2.selection) === JSON.stringify(selection));
            if (handle) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute([handle.x, handle.y, handle.z], 3));
                const marker = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 17, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.8 }));
                marker.renderOrder = 25;
                this.groups.selection.add(marker);
            }
        }
        this.handles = handles;
    }

    getHandles(): readonly Handle[] {
        return this.handles;
    }

    // The draw tool's rubber band from its start to the pointer
    setDraft(from: [number, number] | null, to: [number, number] | null): void {
        this.clear(this.groups.draft);
        if (!from) return;
        const h = (x: number, z: number) => this.height(x, z);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([from[0], h(from[0], from[1]) + 1, from[1]], 3));
        const start = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9dff7a, size: 12, sizeAttenuation: false, depthTest: false }));
        start.renderOrder = 30;
        this.groups.draft.add(start);
        if (to) {
            this.groups.draft.add(lineSegments([from[0], h(from[0], from[1]) + 1, from[1], to[0], h(to[0], to[1]) + 1, to[1]], 0x9dff7a, 1, false));
        }
    }

    // ---- Track ----

    setTrack(route: ResolvedRoute | null, showGrid: boolean): void {
        this.clear(this.groups.track);
        if (!route) return;
        const h = (x: number, z: number) => this.height(x, z);
        const line: number[] = [];
        const points = route.points;
        const count = route.closed ? points.length + 1 : points.length;
        for (let i = 0; i + 1 < count; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            line.push(a.x, h(a.x, a.z) + 0.8, a.z, b.x, h(b.x, b.z) + 0.8, b.z);
        }
        this.groups.track.add(lineSegments(line, 0x2d7dff, 1, false));

        const gates: number[] = [], start: number[] = [];
        for (const gate of route.gates) {
            const [[lx, lz], [rx, rz]] = gateEnds(gate);
            const ly = h(lx, lz), ry = h(rx, rz);
            const top = Math.max(ly, ry) + 5;
            const list = gate.visual === 'arch' ? gates : start;
            list.push(lx, ly, lz, lx, top, lz, rx, ry, rz, rx, top, rz, lx, top, lz, rx, top, rz, lx, ly + 0.3, lz, rx, ry + 0.3, rz);
        }
        this.groups.track.add(lineSegments(gates, 0x16e0ff, 1, false));
        this.groups.track.add(lineSegments(start, 0xffffff, 1, false));

        if (showGrid) {
            const grid: number[] = [];
            for (const slot of route.grid) {
                // A 2 × 4.5 m box per slot, nose in driving direction
                const fx = Math.sin(slot.yaw), fz = Math.cos(slot.yaw);
                const lx = fz, lz = -fx;
                const corners = [[2.25, 1], [2.25, -1], [-2.25, -1], [-2.25, 1]].map(([f, l]) =>
                    [slot.x + fx * f + lx * l, slot.z + fz * f + lz * l] as [number, number]);
                for (let i = 0; i < 4; i++) {
                    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
                    grid.push(ax, h(ax, az) + 0.5, az, bx, h(bx, bz) + 0.5, bz);
                }
            }
            this.groups.track.add(lineSegments(grid, 0xffe45c, 1, false));
        }
    }

    // ---- Zones and POIs ----

    private makeLabel(text: string, className: string): HTMLElement {
        const element = document.createElement('div');
        element.className = `label ${className}`;
        element.textContent = text;
        this.labelLayer.append(element);
        return element;
    }

    setZones(zones: ZonesFile): void {
        this.clear(this.groups.zones);
        for (const label of this.labels.zones) label.element.remove();
        this.labels.zones = [];
        const h = (x: number, z: number) => this.height(x, z);
        for (const zone of zones.zones) {
            const outline: number[] = [];
            const poly = zone.polygon;
            for (let i = 0; i < poly.length; i++) {
                const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
                const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 10));
                for (let k = 0; k < steps; k++) {
                    const t0 = k / steps, t1 = (k + 1) / steps;
                    const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0;
                    const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
                    outline.push(x0, Math.max(0, h(x0, z0)) + 1.5, z0, x1, Math.max(0, h(x1, z1)) + 1.5, z1);
                }
            }
            this.groups.zones.add(lineSegments(outline, ZONE_COLORS[ZONE[zone.zone]], 0.9));
            const [lx, lz] = zone.label ?? [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
            this.labels.zones.push({ element: this.makeLabel(zone.name ?? zone.id, 'zone'), position: new THREE.Vector3(lx, Math.max(0, h(lx, lz)) + 20, lz) });
        }
    }

    setPois(pois: PoisFile): void {
        this.clear(this.groups.pois);
        for (const label of this.labels.pois) label.element.remove();
        this.labels.pois = [];
        const h = (x: number, z: number) => this.height(x, z);
        const posts: number[] = [], arrows: number[] = [], party: number[] = [];
        for (const landmark of pois.landmarks) {
            const y = h(landmark.x, landmark.z);
            posts.push(landmark.x, y, landmark.z, landmark.x, y + 25, landmark.z);
            this.labels.pois.push({ element: this.makeLabel(landmark.name, 'poi'), position: new THREE.Vector3(landmark.x, y + 25, landmark.z) });
        }
        const arrow = (list: number[], x: number, z: number, yaw: number) => {
            const fx = Math.sin(yaw), fz = Math.cos(yaw), y = h(x, z) + 0.6;
            const tipX = x + fx * 3, tipZ = z + fz * 3;
            list.push(x - fx * 2, y, z - fz * 2, tipX, y, tipZ,
                tipX, y, tipZ, tipX - fx * 1.5 + fz * 1.2, y, tipZ - fz * 1.5 - fx * 1.2,
                tipX, y, tipZ, tipX - fx * 1.5 - fz * 1.2, y, tipZ - fz * 1.5 + fx * 1.2);
        };
        for (const spawn of pois.spawns.freeRoam) arrow(arrows, spawn.x, spawn.z, spawn.yaw);
        for (const spawn of pois.spawns.party) arrow(party, spawn.x, spawn.z, spawn.yaw);
        this.groups.pois.add(lineSegments(posts, 0xffffff, 0.8));
        this.groups.pois.add(lineSegments(arrows, 0x9dff7a, 1, false));
        this.groups.pois.add(lineSegments(party, 0xff6ad5, 1, false));
    }

    private placeLabels(): void {
        const { clientWidth: w, clientHeight: hgt } = this.container;
        const v = new THREE.Vector3();
        for (const label of [...this.labels.zones, ...this.labels.pois]) {
            if (label.element.hidden) continue;
            v.copy(label.position).project(this.camera);
            const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
            label.element.style.display = visible ? '' : 'none';
            if (visible) label.element.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * hgt}px) translate(-50%, -100%)`;
        }
    }

    // ---- Picking ----

    // Screen position (px, from the viewport's top left) of a world point,
    // null behind the camera
    toScreen(x: number, y: number, z: number): { sx: number; sy: number } | null {
        const v = new THREE.Vector3(x, y, z).project(this.camera);
        if (v.z >= 1) return null;
        return { sx: (v.x + 1) / 2 * this.container.clientWidth, sy: (1 - v.y) / 2 * this.container.clientHeight };
    }

    rayAt(px: number, py: number): Ray {
        const ndc = new THREE.Vector2(px / this.container.clientWidth * 2 - 1, -(py / this.container.clientHeight) * 2 + 1);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this.camera);
        const { origin: o, direction: d } = raycaster.ray;
        return { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z };
    }

    // Moves the view to look at (x, z) from the current direction
    focus(x: number, z: number, distance = 250): void {
        const target = new THREE.Vector3(x, this.height(x, z), z);
        const offset = this.camera.position.clone().sub(this.controls.target).setLength(distance);
        this.controls.target.copy(target);
        this.camera.position.copy(target).add(offset);
        this.controls.update();
    }
}
