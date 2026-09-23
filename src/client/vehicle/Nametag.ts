import * as THREE from 'three';

// Floating name and health bar above a remote car, positioned in screen
// space every frame. Extracted from entities/Bulli.ts.

const _nametagPosition = new THREE.Vector3();

export class Nametag {
    readonly element: HTMLDivElement;
    readonly healthBarFill: HTMLDivElement;

    constructor(name: string) {
        this.element = document.createElement('div');
        this.element.className = 'nametag';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'nametag-name';
        nameSpan.textContent = name;
        this.element.appendChild(nameSpan);

        const hpBar = document.createElement('div');
        hpBar.className = 'nametag-hp';
        const hpFill = document.createElement('div');
        hpFill.className = 'nametag-hp-fill';
        hpBar.appendChild(hpFill);
        this.element.appendChild(hpBar);
        this.healthBarFill = hpFill;

        document.body.appendChild(this.element);
    }

    hide() {
        this.element.style.display = 'none';
    }

    // Places the tag `height` m above the car's origin (the car model's
    // nametag height), hidden behind the camera
    update(carPosition: THREE.Vector3, camera: THREE.Camera, height = 4) {
        const pos = _nametagPosition.copy(carPosition);
        pos.y += height;
        pos.project(camera);

        const x = (pos.x * .5 + .5) * window.innerWidth;
        const y = (pos.y * -.5 + .5) * window.innerHeight;
        // pos.z > 1 means the point is behind the camera; also guard against
        // non-finite projections (degenerate camera / off-screen NaN).
        if (pos.z > 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
            this.element.style.display = 'none';
        } else {
            this.element.style.display = 'block';
            this.element.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
        }
    }

    updateHealth(health: number) {
        const pct = Math.max(0, Math.min(100, health));
        this.healthBarFill.style.width = pct + '%';
        if (pct > 50) {
            this.healthBarFill.style.background = '#4CAF50';
        } else if (pct > 25) {
            this.healthBarFill.style.background = '#FF9800';
        } else {
            this.healthBarFill.style.background = '#f44336';
        }
    }

    remove() {
        this.element.remove();
    }
}
