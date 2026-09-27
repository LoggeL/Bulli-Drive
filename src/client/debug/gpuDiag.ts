import * as THREE from 'three';
import { sendClientReport } from '../net/clientReport.js';

// GPU bisect (?gpudiag=1): some phone GPUs lose the WebGL context on a
// particular shader or feature. This mode hides the whole scene once the
// game is loaded, then turns it back on one part at a time (each part of
// the map, each other scene object, then shadows and the environment map),
// reporting every step to /api/client-reports. The last step before a
// 'context-lost' report is the culprit.

export const GPU_DIAG_STEP_MS = 3000;

let currentStep = '';

/** The part the diagnosis turned on last ('' outside the diagnosis). */
export function gpuDiagStep(): string {
    return currentStep;
}

export function isGpuDiag(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
    return new URLSearchParams(search).get('gpudiag') === '1';
}

export interface DiagStep {
    label: string;
    enable: () => void;
}

function describe(object: THREE.Object3D): string {
    const kinds = new Set<string>();
    let meshes = 0;
    object.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh && !(child as THREE.Points).isPoints && !(child as THREE.Line).isLine) return;
        meshes++;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (material) kinds.add(material.type + (material.userData?.patched ? '*' : ''));
        }
    });
    const name = object.name || object.type;
    return `${name} (${meshes} draws: ${[...kinds].join(',')})`;
}

/**
 * The parts of the scene in the order they come back: the children of every
 * group with more than a handful of children (the map) one by one, other
 * objects as a whole.
 */
export function planSteps(scene: THREE.Scene, renderer: THREE.WebGLRenderer): DiagStep[] {
    const steps: DiagStep[] = [];
    const parts: THREE.Object3D[] = [];
    for (const child of scene.children) {
        if (!child.visible) continue;
        if (child.children.length > 4 && !(child as THREE.Mesh).isMesh) {
            for (const part of child.children) if (part.visible) parts.push(part);
            continue;
        }
        parts.push(child);
    }
    for (const part of parts) {
        part.visible = false;
        steps.push({ label: describe(part), enable: () => { part.visible = true; } });
    }

    const touchMaterials = () => scene.traverse(child => {
        const mesh = child as THREE.Mesh;
        for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
            material.needsUpdate = true;
        }
    });
    if (renderer.shadowMap.enabled) {
        renderer.shadowMap.enabled = false;
        touchMaterials();
        steps.push({ label: 'shadows', enable: () => { renderer.shadowMap.enabled = true; touchMaterials(); } });
    }
    const environment = scene.environment;
    if (environment) {
        scene.environment = null;
        touchMaterials();
        steps.push({ label: 'environment map', enable: () => { scene.environment = environment; touchMaterials(); } });
    }
    return steps;
}

function overlay(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'gpu-diag';
    el.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:20000;padding:8px 10px;' +
        'background:rgba(0,0,0,.75);color:#fff;font:13px/1.35 system-ui,sans-serif;border-radius:8px;pointer-events:none';
    document.body.appendChild(el);
    return el;
}

/** Runs the bisect once the loader is gone. */
export function startGpuDiag(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
    currentStep = 'loading, scene not hidden yet';
    sendClientReport('diag-step', currentStep);
    const waitForGame = window.setInterval(() => {
        if (document.getElementById('loading-screen') || scene.children.length < 3) return;
        window.clearInterval(waitForGame);
        const steps = planSteps(scene, renderer);
        currentStep = 'scene hidden';
        const box = overlay();
        let index = 0;
        const next = () => {
            if (index >= steps.length) {
                currentStep = 'done';
                box.textContent = `GPU test finished: all ${steps.length} parts on without a crash.`;
                sendClientReport('diag-step', `done ${steps.length}`);
                return;
            }
            const step = steps[index++];
            currentStep = `${index}/${steps.length} ${step.label}`;
            box.textContent = `GPU test ${currentStep}`;
            sendClientReport('diag-step', currentStep);
            step.enable();
            window.setTimeout(next, GPU_DIAG_STEP_MS);
        };
        sendClientReport('diag-step', `start ${steps.length} steps`);
        box.textContent = `GPU test: ${steps.length} parts, one every ${GPU_DIAG_STEP_MS / 1000} s`;
        window.setTimeout(next, GPU_DIAG_STEP_MS);
    }, 500);
}
