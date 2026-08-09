import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { playJumpSound, playCollisionSound, playHonkSound, playShootSound } from '../effects/sounds.js';
import { createProjectile } from '../world/projectiles.js';
import { spawnParticles } from '../effects/particles.js';
import { getTerrainHeight } from '../world/environment.js';
import { MEGA_SCALE, SPEED_BOOST_FACTOR } from '../../shared/constants.js';

// Reusable vectors to avoid per-frame allocations
const _scaleBig = new THREE.Vector3(MEGA_SCALE, MEGA_SCALE, MEGA_SCALE);
const _scaleNormal = new THREE.Vector3(1, 1, 1);
// Half-extent (XZ) of the car's collision footprint at normal scale.
const CAR_HALF = 1.5;
// Muzzle distance for mega shots - just past the enlarged nose.
const MEGA_PROJECTILE_FRONT_OFFSET = 6.5;

// Cached VW logo texture
let _vwLogoTexture: THREE.CanvasTexture | null = null;

function createVWLogoTexture(): THREE.CanvasTexture {
    if (_vwLogoTexture) return _vwLogoTexture;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.45;

    // Transparent background
    ctx.clearRect(0, 0, size, size);

    // Circle background - chrome/silver
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#C0C0C0';
    ctx.fill();

    // Outer ring border
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = size * 0.04;
    ctx.strokeStyle = '#888888';
    ctx.stroke();

    // Inner ring
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
    ctx.lineWidth = size * 0.025;
    ctx.strokeStyle = '#888888';
    ctx.stroke();

    // Draw VW letters
    ctx.fillStyle = '#333333';
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = size * 0.045;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const s = r * 0.65; // scale factor

    // V shape (upper part)
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.55, cy - s * 0.7);
    ctx.lineTo(cx, cy + s * 0.15);
    ctx.lineTo(cx + s * 0.55, cy - s * 0.7);
    ctx.stroke();

    // W shape (lower part - two V's joined)
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.7, cy - s * 0.15);
    ctx.lineTo(cx - s * 0.28, cy + s * 0.75);
    ctx.lineTo(cx, cy + s * 0.2);
    ctx.lineTo(cx + s * 0.28, cy + s * 0.75);
    ctx.lineTo(cx + s * 0.7, cy - s * 0.15);
    ctx.stroke();

    _vwLogoTexture = new THREE.CanvasTexture(canvas);
    _vwLogoTexture.colorSpace = THREE.SRGBColorSpace;
    return _vwLogoTexture;
}

// Car types with different visual profiles
export type CarType = 'bulli' | 'pickup' | 'sport' | 'beetle' | 'jeep';
const CAR_TYPES: CarType[] = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

export function randomCarType(): CarType {
    return CAR_TYPES[Math.floor(Math.random() * CAR_TYPES.length)];
}

interface GhostMaterialState {
    opacity: number;
    transparent: boolean;
    depthWrite: boolean;
}

interface GhostMeshState {
    castShadow: boolean;
    receiveShadow: boolean;
}

export class Bulli {
    group: THREE.Group;
    flipGroup: THREE.Group;
    isLocal: boolean;
    colorCode: number;
    carType: CarType;
    name: string = "Unknown";
    pitchOffset: number;
    speed: number = 0;
    angle: number = 0;
    acceleration: number = 0.015;
    maxSpeed: number = 1.0;
    friction: number = 0.96;
    isFlipping: boolean = false;
    canRecover: boolean = false;
    flipVelocity: number = 0;
    nextHonkTime: number = 0;
    lastShootTime: number = 0;
    powerups = {
        speed: { active: false, timer: 0 },
        size: { active: false, timer: 0 },
        jump: { active: false, timer: 0 },
        shield: { active: false, timer: 0 },
        magnet: { active: false, timer: 0 },
        ghost: { active: false, timer: 0 }
    };
    health: number = 100;
    private _ghostVisualOn: boolean = false;
    private _ghostMaterialStates = new Map<THREE.Material, GhostMaterialState>();
    private _ghostMeshStates = new Map<THREE.Mesh, GhostMeshState>();
    private _recoveryTimer: number = 0;
    shieldMesh?: THREE.Mesh;
    wheels: THREE.Group[] = [];
    nametag?: HTMLDivElement;
    healthBarFill?: HTMLDivElement;

    constructor(colorCode = 0xD32F2F, isLocal = false, carType?: CarType) {
        this.group = new THREE.Group();
        this.flipGroup = new THREE.Group();
        this.group.add(this.flipGroup);

        this.isLocal = isLocal;
        this.colorCode = colorCode;
        this.carType = carType || randomCarType();
        this.pitchOffset = 0.8 + Math.random() * 0.7;

        this.buildCar();
    }

    createNametag(name: string, isLocal: boolean) {
        this.name = name;
        // The local player is already anchored by the chase camera and HUD;
        // hiding its duplicate label keeps the road and vehicle unobstructed.
        if (isLocal) return;

        this.nametag = document.createElement('div');
        this.nametag.className = 'nametag';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'nametag-name';
        nameSpan.textContent = name;
        this.nametag.appendChild(nameSpan);

        const hpBar = document.createElement('div');
        hpBar.className = 'nametag-hp';
        const hpFill = document.createElement('div');
        hpFill.className = 'nametag-hp-fill';
        hpBar.appendChild(hpFill);
        this.nametag.appendChild(hpBar);
        this.healthBarFill = hpFill;

        document.body.appendChild(this.nametag);
    }

    updateHealthBar() {
        if (!this.healthBarFill) return;
        const pct = Math.max(0, Math.min(100, this.health));
        this.healthBarFill.style.width = pct + '%';
        if (pct > 50) {
            this.healthBarFill.style.background = '#4CAF50';
        } else if (pct > 25) {
            this.healthBarFill.style.background = '#FF9800';
        } else {
            this.healthBarFill.style.background = '#f44336';
        }
    }

    setGhostVisual(active: boolean) {
        if (active === this._ghostVisualOn) return;
        this._ghostVisualOn = active;

        if (active) {
            this.flipGroup.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh || mesh === this.shieldMesh) return;

                if (!this._ghostMeshStates.has(mesh)) {
                    this._ghostMeshStates.set(mesh, {
                        castShadow: mesh.castShadow,
                        receiveShadow: mesh.receiveShadow
                    });
                }
                mesh.castShadow = false;
                mesh.receiveShadow = false;

                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach((mat) => {
                    if (!this._ghostMaterialStates.has(mat)) {
                        this._ghostMaterialStates.set(mat, {
                            opacity: mat.opacity,
                            transparent: mat.transparent,
                            depthWrite: mat.depthWrite
                        });
                        mat.transparent = true;
                        // Transparent vehicle parts must not occlude one another
                        // through the depth buffer. That was the source of the
                        // angle-dependent "half a Bulli" artifact.
                        mat.depthWrite = false;
                        mat.opacity = Math.min(0.12, mat.opacity * 0.2);
                        mat.needsUpdate = true;
                    }
                });
            });
            if (this.nametag) this.nametag.style.display = 'none';
        } else {
            this._ghostMaterialStates.forEach((original, mat) => {
                mat.opacity = original.opacity;
                mat.transparent = original.transparent;
                mat.depthWrite = original.depthWrite;
                mat.needsUpdate = true;
            });
            this._ghostMaterialStates.clear();

            this._ghostMeshStates.forEach((original, mesh) => {
                mesh.castShadow = original.castShadow;
                mesh.receiveShadow = original.receiveShadow;
            });
            this._ghostMeshStates.clear();
            // nametag display restored by updateNametag
        }
    }

    updateNametag() {
        if (!this.nametag || !state.camera) return;
        if (this.powerups.ghost.active) {
            this.nametag.style.display = 'none';
            return;
        }

        const pos = this.group.position.clone();
        pos.y += 4;
        pos.project(state.camera);

        const x = (pos.x * .5 + .5) * window.innerWidth;
        const y = (pos.y * -.5 + .5) * window.innerHeight;
        // pos.z > 1 means the point is behind the camera; also guard against
        // non-finite projections (degenerate camera / off-screen NaN).
        if (pos.z > 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
            this.nametag.style.display = 'none';
        } else {
            this.nametag.style.display = 'block';
            this.nametag.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
        }
    }

    buildCar() {
        // Shared materials
        const bodyMat = new THREE.MeshStandardMaterial({ color: this.colorCode, roughness: 0.2, metalness: 0.1 });
        const whiteMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.2, metalness: 0.1 });
        const chromeMat = new THREE.MeshStandardMaterial({ color: 0xEEEEEE, roughness: 0.0, metalness: 1.0 });
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x88BBDD, roughness: 0.0, metalness: 0.3, transparent: true, opacity: 0.6
        });
        const rubberMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
        const headlightMat = new THREE.MeshStandardMaterial({
            color: 0xFFFFCC, emissive: 0xFFFFCC, emissiveIntensity: 0.8, roughness: 0.1, metalness: 0.0
        });
        const taillightMat = new THREE.MeshStandardMaterial({
            color: 0xFF2222, emissive: 0xFF0000, emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.0
        });

        switch (this.carType) {
            case 'pickup': this.buildPickup(bodyMat, chromeMat, glassMat, rubberMat, headlightMat, taillightMat); break;
            case 'sport': this.buildSport(bodyMat, chromeMat, glassMat, rubberMat, headlightMat, taillightMat); break;
            case 'beetle': this.buildBeetle(bodyMat, chromeMat, glassMat, rubberMat, headlightMat, taillightMat); break;
            case 'jeep': this.buildJeep(bodyMat, chromeMat, glassMat, rubberMat, headlightMat, taillightMat); break;
            default: this.buildBulli(bodyMat, whiteMat, chromeMat, glassMat, rubberMat, headlightMat, taillightMat); break;
        }

        // Shield bubble (hidden by default)
        const shieldGeo = new THREE.SphereGeometry(3.5, 16, 12);
        const shieldMat = new THREE.MeshStandardMaterial({
            color: 0x00BFFF,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            emissive: 0x00BFFF,
            emissiveIntensity: 0,
            side: THREE.DoubleSide
        });
        this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
        this.shieldMesh.position.y = 1.5;
        // An opacity-zero mesh still writes depth unless disabled above. Keep it
        // out of the render list entirely until a shield effect needs it.
        this.shieldMesh.visible = false;
        this.flipGroup.add(this.shieldMesh);
    }

    // ---- ORIGINAL VW BULLI ----
    buildBulli(bodyMat: THREE.MeshStandardMaterial, whiteMat: THREE.MeshStandardMaterial, chromeMat: THREE.MeshStandardMaterial, glassMat: THREE.MeshStandardMaterial, rubberMat: THREE.MeshStandardMaterial, headlightMat: THREE.MeshStandardMaterial, taillightMat: THREE.MeshStandardMaterial) {
        const width = 2.8, length = 4.0, heightLower = 1.4, heightUpper = 1.2;
        const chassisY = 0.8;

        const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(width, heightLower, length), bodyMat);
        lowerBody.position.y = chassisY + heightLower / 2;
        lowerBody.castShadow = true; lowerBody.receiveShadow = true;
        this.flipGroup.add(lowerBody);

        const upperBody = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, heightUpper, length - 0.2), whiteMat);
        upperBody.position.y = chassisY + heightLower + heightUpper / 2;
        upperBody.castShadow = true; upperBody.receiveShadow = true;
        this.flipGroup.add(upperBody);

        // Windshield
        const windshieldW = width - 0.6, windshieldH = 0.8;
        const windshield = new THREE.Mesh(new THREE.PlaneGeometry(windshieldW, windshieldH), glassMat);
        windshield.position.set(0, upperBody.position.y, length / 2 + 0.02 - 0.05);
        windshield.rotation.x = -Math.PI / 12;
        this.flipGroup.add(windshield);

        // Side windows
        const sideWinGeo = new THREE.PlaneGeometry(length * 0.35, windshieldH * 0.85);
        const leftSideWin = new THREE.Mesh(sideWinGeo, glassMat);
        leftSideWin.position.set(-width / 2 - 0.01, upperBody.position.y, length * 0.1);
        leftSideWin.rotation.y = -Math.PI / 2;
        this.flipGroup.add(leftSideWin);
        const rightSideWin = new THREE.Mesh(sideWinGeo, glassMat);
        rightSideWin.position.set(width / 2 + 0.01, upperBody.position.y, length * 0.1);
        rightSideWin.rotation.y = Math.PI / 2;
        this.flipGroup.add(rightSideWin);

        // Rear window
        const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(windshieldW * 0.7, windshieldH * 0.7), glassMat);
        rearWin.position.set(0, upperBody.position.y, -length / 2 + 0.21);
        rearWin.rotation.y = Math.PI;
        this.flipGroup.add(rearWin);

        // Eyes
        this.addEyes(lowerBody.position.y + 0.15, length / 2 + 0.05, 0.45);

        // VW Logo (canvas-textured disc)
        this.addVWLogo(lowerBody.position.y + 0.3, length / 2 + 0.03, 0.5);

        // Headlights & taillights
        this.addLights(width, lowerBody.position.y, length, headlightMat, taillightMat);
        // Bumpers
        this.addBumpers(width, length, chromeMat);
        // Wheels
        this.addWheels(width, 0.65, 0.4, 1.2, rubberMat, chromeMat);
    }

    // ---- PICKUP TRUCK ----
    buildPickup(bodyMat: THREE.MeshStandardMaterial, chromeMat: THREE.MeshStandardMaterial, glassMat: THREE.MeshStandardMaterial, rubberMat: THREE.MeshStandardMaterial, headlightMat: THREE.MeshStandardMaterial, taillightMat: THREE.MeshStandardMaterial) {
        const width = 3.0, length = 5.0, cabHeight = 1.8, bedHeight = 0.8;
        const chassisY = 1.0;

        // Cab (front half)
        const cab = new THREE.Mesh(new THREE.BoxGeometry(width, cabHeight, length * 0.4), bodyMat);
        cab.position.set(0, chassisY + cabHeight / 2, length * 0.2);
        cab.castShadow = true; cab.receiveShadow = true;
        this.flipGroup.add(cab);

        // Truck bed (rear half, open top)
        const bedFloor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, length * 0.5), bodyMat);
        bedFloor.position.set(0, chassisY + 0.15, -length * 0.15);
        bedFloor.castShadow = true;
        this.flipGroup.add(bedFloor);

        // Bed sides
        const bedSideMat = new THREE.MeshStandardMaterial({ color: this.colorCode, roughness: 0.3, metalness: 0.1 });
        const sideGeo = new THREE.BoxGeometry(0.15, bedHeight, length * 0.5);
        const leftSide = new THREE.Mesh(sideGeo, bedSideMat);
        leftSide.position.set(-width / 2 + 0.075, chassisY + bedHeight / 2, -length * 0.15);
        leftSide.castShadow = true;
        this.flipGroup.add(leftSide);
        const rightSide = new THREE.Mesh(sideGeo, bedSideMat);
        rightSide.position.set(width / 2 - 0.075, chassisY + bedHeight / 2, -length * 0.15);
        rightSide.castShadow = true;
        this.flipGroup.add(rightSide);
        // Tailgate
        const tailgate = new THREE.Mesh(new THREE.BoxGeometry(width, bedHeight, 0.15), bedSideMat);
        tailgate.position.set(0, chassisY + bedHeight / 2, -length * 0.4 - 0.075);
        tailgate.castShadow = true;
        this.flipGroup.add(tailgate);

        // Windshield
        const windshield = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.6, 1.0), glassMat);
        windshield.position.set(0, cab.position.y + 0.2, length * 0.4 + 0.02);
        windshield.rotation.x = -Math.PI / 10;
        this.flipGroup.add(windshield);

        // Eyes
        this.addEyes(chassisY + cabHeight * 0.4, length * 0.4 + 0.05, 0.5);

        // Lights, bumpers, wheels
        this.addLights(width, chassisY + cabHeight * 0.3, length * 0.8, headlightMat, taillightMat);
        this.addBumpers(width, length * 0.8, chromeMat);
        this.addWheels(width, 0.75, 0.5, 1.6, rubberMat, chromeMat); // Bigger wheels
    }

    // ---- SPORTS CAR ----
    buildSport(bodyMat: THREE.MeshStandardMaterial, chromeMat: THREE.MeshStandardMaterial, glassMat: THREE.MeshStandardMaterial, rubberMat: THREE.MeshStandardMaterial, headlightMat: THREE.MeshStandardMaterial, taillightMat: THREE.MeshStandardMaterial) {
        const width = 2.6, length = 4.5, bodyHeight = 0.9;
        const chassisY = 0.5;

        // Low sleek body
        const body = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, length), bodyMat);
        body.position.y = chassisY + bodyHeight / 2;
        body.castShadow = true; body.receiveShadow = true;
        this.flipGroup.add(body);

        // Sloped cabin (smaller, set back)
        const cabinGeo = new THREE.BoxGeometry(width - 0.4, 0.7, length * 0.35);
        const cabin = new THREE.Mesh(cabinGeo, bodyMat);
        cabin.position.set(0, chassisY + bodyHeight + 0.35, -length * 0.05);
        cabin.castShadow = true;
        this.flipGroup.add(cabin);

        // Windshield (angled)
        const windshield = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.8, 0.8), glassMat);
        windshield.position.set(0, cabin.position.y + 0.1, cabin.position.z + length * 0.175 + 0.02);
        windshield.rotation.x = -Math.PI / 6;
        this.flipGroup.add(windshield);

        // Rear window
        const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(width - 1.0, 0.5), glassMat);
        rearWin.position.set(0, cabin.position.y, cabin.position.z - length * 0.175 - 0.02);
        rearWin.rotation.y = Math.PI;
        rearWin.rotation.x = Math.PI / 8;
        this.flipGroup.add(rearWin);

        // Spoiler
        const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, 0.08, 0.6), chromeMat);
        spoilerWing.position.set(0, chassisY + bodyHeight + 0.8, -length / 2 + 0.3);
        this.flipGroup.add(spoilerWing);
        const spoilerPost1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.12), chromeMat);
        spoilerPost1.position.set(-width / 2 + 0.3, chassisY + bodyHeight + 0.6, -length / 2 + 0.3);
        this.flipGroup.add(spoilerPost1);
        const spoilerPost2 = spoilerPost1.clone();
        spoilerPost2.position.x = width / 2 - 0.3;
        this.flipGroup.add(spoilerPost2);

        // Eyes (smaller, angrier)
        this.addEyes(chassisY + bodyHeight * 0.6, length / 2 + 0.05, 0.35);

        this.addLights(width, chassisY + bodyHeight * 0.4, length, headlightMat, taillightMat);
        this.addBumpers(width, length, chromeMat);
        this.addWheels(width, 0.5, 0.45, 1.4, rubberMat, chromeMat);
    }

    // ---- VW BEETLE ----
    buildBeetle(bodyMat: THREE.MeshStandardMaterial, chromeMat: THREE.MeshStandardMaterial, glassMat: THREE.MeshStandardMaterial, rubberMat: THREE.MeshStandardMaterial, headlightMat: THREE.MeshStandardMaterial, taillightMat: THREE.MeshStandardMaterial) {
        const width = 2.4, length = 3.5, bodyHeight = 1.2;
        const chassisY = 0.7;

        // Rounded lower body
        const body = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, length), bodyMat);
        body.position.y = chassisY + bodyHeight / 2;
        body.castShadow = true; body.receiveShadow = true;
        this.flipGroup.add(body);

        // Domed roof (sphere slice)
        const roofGeo = new THREE.SphereGeometry(1.5, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
        const roof = new THREE.Mesh(roofGeo, bodyMat);
        roof.position.set(0, chassisY + bodyHeight, 0);
        roof.scale.set(1, 0.7, 1.1);
        roof.castShadow = true;
        this.flipGroup.add(roof);

        // Windshield
        const windshield = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.8, 0.9), glassMat);
        windshield.position.set(0, chassisY + bodyHeight + 0.3, length * 0.3);
        windshield.rotation.x = -Math.PI / 7;
        this.flipGroup.add(windshield);

        // Rear window (round-ish)
        const rearWin = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), glassMat);
        rearWin.position.set(0, chassisY + bodyHeight + 0.2, -length * 0.3);
        rearWin.rotation.y = Math.PI;
        this.flipGroup.add(rearWin);

        // Big cute eyes
        this.addEyes(chassisY + bodyHeight * 0.5, length / 2 + 0.05, 0.55);

        // VW Logo on front
        this.addVWLogo(chassisY + bodyHeight * 0.5, length / 2 + 0.03, 0.4);

        this.addLights(width, chassisY + bodyHeight * 0.3, length, headlightMat, taillightMat);
        this.addBumpers(width, length, chromeMat);
        this.addWheels(width, 0.6, 0.35, 1.0, rubberMat, chromeMat);
    }

    // ---- JEEP / OFF-ROAD ----
    buildJeep(bodyMat: THREE.MeshStandardMaterial, chromeMat: THREE.MeshStandardMaterial, glassMat: THREE.MeshStandardMaterial, rubberMat: THREE.MeshStandardMaterial, headlightMat: THREE.MeshStandardMaterial, taillightMat: THREE.MeshStandardMaterial) {
        const width = 3.0, length = 4.2, bodyHeight = 1.5;
        const chassisY = 1.1; // Higher ground clearance

        // Boxy body
        const body = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, length), bodyMat);
        body.position.y = chassisY + bodyHeight / 2;
        body.castShadow = true; body.receiveShadow = true;
        this.flipGroup.add(body);

        // Flat roof with rack
        const roofGeo = new THREE.BoxGeometry(width + 0.2, 0.15, length + 0.2);
        const roof = new THREE.Mesh(roofGeo, bodyMat);
        roof.position.y = chassisY + bodyHeight + 0.075;
        roof.castShadow = true;
        this.flipGroup.add(roof);

        // Roof rack bars
        const rackBarMat = chromeMat;
        for (let i = -1; i <= 1; i++) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, 0.08, 0.08), rackBarMat);
            bar.position.set(0, chassisY + bodyHeight + 0.25, i * length * 0.3);
            this.flipGroup.add(bar);
        }
        // Side rack bars
        [-1, 1].forEach(side => {
            const sideBar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, length + 0.4), rackBarMat);
            sideBar.position.set(side * (width / 2 + 0.15), chassisY + bodyHeight + 0.25, 0);
            this.flipGroup.add(sideBar);
        });

        // Big flat windshield
        const windshield = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.4, 1.0), glassMat);
        windshield.position.set(0, chassisY + bodyHeight * 0.7, length / 2 + 0.02);
        windshield.rotation.x = -Math.PI / 20;
        this.flipGroup.add(windshield);

        // Spare tire on back
        const spareTire = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.3, 8, 16), rubberMat);
        spareTire.position.set(0, chassisY + bodyHeight * 0.5, -length / 2 - 0.35);
        this.flipGroup.add(spareTire);

        // Eyes (tough looking)
        this.addEyes(chassisY + bodyHeight * 0.5, length / 2 + 0.05, 0.4);

        this.addLights(width, chassisY + bodyHeight * 0.3, length, headlightMat, taillightMat);
        this.addBumpers(width, length, chromeMat);
        this.addWheels(width, 0.8, 0.55, 1.4, rubberMat, chromeMat); // Big off-road wheels
    }

    // ---- SHARED HELPERS ----
    addVWLogo(logoY: number, logoZ: number, radius: number) {
        const logoTexture = createVWLogoTexture();
        const logoMat = new THREE.MeshStandardMaterial({
            map: logoTexture,
            transparent: true,
            roughness: 0.1,
            metalness: 0.6
        });
        const logoGeo = new THREE.CircleGeometry(radius, 32);
        const logo = new THREE.Mesh(logoGeo, logoMat);
        logo.position.set(0, logoY, logoZ);
        this.flipGroup.add(logo);
    }

    addEyes(eyeY: number, eyeZ: number, radius: number) {
        const eyeGeo = new THREE.SphereGeometry(radius, 32, 16);
        const eyeMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.1 });
        const pupilGeo = new THREE.SphereGeometry(radius * 0.6, 32, 16);
        const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111 });

        const leftEyeGroup = new THREE.Group();
        leftEyeGroup.add(new THREE.Mesh(eyeGeo, eyeMat));
        const lp = new THREE.Mesh(pupilGeo, pupilMat);
        lp.position.z = radius - 0.1;
        leftEyeGroup.add(lp);
        leftEyeGroup.position.set(-0.8, eyeY, eyeZ);
        this.flipGroup.add(leftEyeGroup);

        const rightEyeGroup = leftEyeGroup.clone();
        rightEyeGroup.position.set(0.8, eyeY, eyeZ);
        this.flipGroup.add(rightEyeGroup);
    }

    addLights(width: number, bodyY: number, length: number, headlightMat: THREE.MeshStandardMaterial, taillightMat: THREE.MeshStandardMaterial) {
        const headlightGeo = new THREE.SphereGeometry(0.25, 16, 8);
        const lh = new THREE.Mesh(headlightGeo, headlightMat);
        lh.position.set(-width / 2 + 0.3, bodyY - 0.2, length / 2 + 0.05);
        lh.scale.z = 0.5;
        this.flipGroup.add(lh);
        const rh = new THREE.Mesh(headlightGeo, headlightMat);
        rh.position.set(width / 2 - 0.3, bodyY - 0.2, length / 2 + 0.05);
        rh.scale.z = 0.5;
        this.flipGroup.add(rh);

        const taillightGeo = new THREE.BoxGeometry(0.4, 0.3, 0.1);
        const lt = new THREE.Mesh(taillightGeo, taillightMat);
        lt.position.set(-width / 2 + 0.3, bodyY - 0.1, -length / 2 - 0.05);
        this.flipGroup.add(lt);
        const rt = new THREE.Mesh(taillightGeo, taillightMat);
        rt.position.set(width / 2 - 0.3, bodyY - 0.1, -length / 2 - 0.05);
        this.flipGroup.add(rt);
    }

    addBumpers(width: number, length: number, chromeMat: THREE.MeshStandardMaterial) {
        const bumperGeo = new THREE.BoxGeometry(width + 0.2, 0.3, 0.4);
        const fb = new THREE.Mesh(bumperGeo, chromeMat);
        fb.position.set(0, 0.5, length / 2 + 0.2);
        fb.castShadow = true;
        this.flipGroup.add(fb);
        const rb = new THREE.Mesh(bumperGeo, chromeMat);
        rb.position.set(0, 0.5, -length / 2 - 0.2);
        rb.castShadow = true;
        this.flipGroup.add(rb);
    }

    addWheels(width: number, wheelRadius: number, wheelWidth: number, wheelZ: number, rubberMat: THREE.MeshStandardMaterial, chromeMat: THREE.MeshStandardMaterial) {
        this.wheels = [];
        const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 32);
        wheelGeo.rotateZ(Math.PI / 2);
        const capGeo = new THREE.CylinderGeometry(wheelRadius * 0.55, wheelRadius * 0.55, wheelWidth + 0.05, 16);
        capGeo.rotateZ(Math.PI / 2);

        const wheelGroup = new THREE.Group();
        const tire = new THREE.Mesh(wheelGeo, rubberMat);
        const cap = new THREE.Mesh(capGeo, chromeMat);
        tire.castShadow = true;
        wheelGroup.add(tire);
        wheelGroup.add(cap);

        const wheelX = width / 2 - 0.2;
        const wheelY = wheelRadius;
        const positions = [
            { x: -wheelX, z: wheelZ },
            { x: wheelX, z: wheelZ },
            { x: -wheelX, z: -wheelZ },
            { x: wheelX, z: -wheelZ }
        ];
        positions.forEach(p => {
            const w = wheelGroup.clone();
            w.position.set(p.x, wheelY, p.z);
            this.flipGroup.add(w);
            this.wheels.push(w);
        });
    }

    honk(): number {
        return playHonkSound(this.pitchOffset);
    }

    shoot() {
        const now = Date.now();
        if (now - this.lastShootTime < 500) return;
        this.lastShootTime = now;

        playShootSound();

        const megaActive = this.powerups.size.active;
        // Fire from the front of the car (account for jump height)
        const frontOffset = megaActive ? MEGA_PROJECTILE_FRONT_OFFSET : 3.5;
        const startX = this.group.position.x + Math.sin(this.angle) * frontOffset;
        const startZ = this.group.position.z + Math.cos(this.angle) * frontOffset;
        const startY = this.group.position.y + this.flipGroup.position.y;

        createProjectile(startX, startY, startZ, this.angle, this.colorCode, state.myId || '', megaActive);
    }

    update(dt: number) {
        this.updateNametag();

        Object.keys(this.powerups).forEach(key => {
            const p = this.powerups[key as keyof typeof this.powerups];
            if (p.active) {
                p.timer -= dt;
                if (p.timer <= 0) {
                    p.active = false;
                    if (key === 'size') this.group.scale.set(1, 1, 1);
                    // ghost visuals are restored centrally by the _ghostVisualOn sync below
                }
            }
        });

        // Update shield visual
        if (this.shieldMesh) {
            if (this.powerups.shield.active) {
                this.shieldMesh.visible = true;
                const shieldMat = this.shieldMesh.material as THREE.MeshStandardMaterial;
                shieldMat.opacity = 0.25 + Math.sin(Date.now() * 0.005) * 0.1;
                shieldMat.emissiveIntensity = 0.4 + Math.sin(Date.now() * 0.008) * 0.2;
                this.shieldMesh.rotation.y += dt * 2;
            } else {
                this.shieldMesh.visible = false;
            }
        }

        // Ghost transparency: apply/remove exactly once on state change instead
        // of re-traversing every frame (setGhostVisual is idempotent).
        if (this.powerups.ghost.active !== this._ghostVisualOn) {
            this.setGhostVisual(this.powerups.ghost.active);
        }

        if (!this.isLocal) return;
        if (state.isModalOpen) return;
        if (state.dead) return;

        // Clamp the timestep so a frame hitch (tab refocus, GC pause) can't let
        // the car move far enough in one step to tunnel/fling through an
        // obstacle's push-out resolution. Max displacement stays below the
        // smallest building's collision half-extent.
        const frame = Math.min(dt, 1 / 30) * 60;

        let currentAccel = this.acceleration;
        let currentMaxSpeed = this.maxSpeed;
        if (this.powerups.speed.active) {
            // Constant boost for the whole duration (used to decay with the timer).
            currentAccel *= SPEED_BOOST_FACTOR;
            currentMaxSpeed *= SPEED_BOOST_FACTOR;
        }

        if (this.powerups.size.active) {
            this.group.scale.lerp(_scaleBig, 0.1);
        } else {
            this.group.scale.lerp(_scaleNormal, 0.1);
        }

        const throttle = Math.max(-1, Math.min(1, state.inputs.throttle));
        if (Math.abs(throttle) > 0.001) {
            // Analog input controls the requested road speed, not just how long
            // it takes to eventually reach full speed. This makes half-stick a
            // stable, useful cruising speed while preserving full-speed WASD.
            const targetSpeed = throttle >= 0
                ? throttle * currentMaxSpeed
                : throttle * currentMaxSpeed * 0.5;
            const changingDirection = Math.sign(targetSpeed) !== Math.sign(this.speed) && Math.abs(this.speed) > 0.01;
            const slowingDown = Math.abs(targetSpeed) < Math.abs(this.speed);
            const response = changingDirection ? 2.5 : (slowingDown ? 1.8 : 1);
            const maxDelta = currentAccel * response * frame;
            const delta = Math.max(-maxDelta, Math.min(maxDelta, targetSpeed - this.speed));
            this.speed += delta;
        } else {
            this.speed *= Math.pow(this.friction, frame);
        }

        const recoveryRequested = state.inputs.space;
        state.inputs.space = false;
        if (recoveryRequested && !this.isFlipping && (this.canRecover || this.powerups.jump.active)) {
            this.isFlipping = true;
            this.flipVelocity = this.powerups.jump.active ? 0.12 : 0.25;
            this.canRecover = false;
            this._recoveryTimer = 0;
            playJumpSound();
        }

        if (state.inputs.f) {
            const now = Date.now();
            if (now >= this.nextHonkTime) {
                const duration = this.honk();
                this.nextHonkTime = now + (duration * 1000) + 500;

                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'honk'
                    }));
                }
            }
            state.inputs.f = false;
        }

        if (state.inputs.e) {
            this.shoot();
            state.inputs.e = false;
        }

        if (this.isFlipping) {
            this.flipGroup.rotation.x += this.flipVelocity * frame;
            if (this.flipGroup.rotation.x >= Math.PI * 2) {
                this.flipGroup.rotation.x = 0;
                this.isFlipping = false;
            }
        }

        this.speed = Math.max(Math.min(this.speed, currentMaxSpeed), -currentMaxSpeed / 2);
        if (Math.abs(this.speed) < 0.001) this.speed = 0;

        if (!this.isFlipping) {
            // Keep a little steering authority at a standstill, peak around
            // city speed, then taper it at top speed so touch steering is calm.
            const turnDir = this.speed < -0.01 ? -1 : 1;
            const steer = Math.max(-1, Math.min(1, state.inputs.steer));
            const speedRatio = Math.min(1, Math.abs(this.speed) / Math.max(0.001, currentMaxSpeed));
            const lowSpeedAuthority = 0.28 + 0.72 * Math.min(1, Math.abs(this.speed) / 0.35);
            const highSpeedTaper = 1 - speedRatio * 0.35;
            this.angle += CONFIG.carTurnSpeed * steer * turnDir * lowSpeedAuthority * highSpeedTaper * frame;
        }

        let nextX = this.group.position.x + Math.sin(this.angle) * this.speed * frame;
        let nextZ = this.group.position.z + Math.cos(this.angle) * this.speed * frame;

        // Collision is skipped only when ghosting or genuinely airborne (a flip
        // or super-jump lifts the car above ground obstacles). The car is treated
        // as a circle of radius carR; buildings are AABBs, everything else is a
        // circle. On contact we push the car back out so it can never get stuck.
        const airborne = this.flipGroup.position.y > 1.0;
        let collided = false;
        let hitX = 0, hitZ = 0;
        if (!this.powerups.ghost.active && !airborne) {
            const carR = CAR_HALF * (this.powerups.size.active ? MEGA_SCALE : (this.group.scale.x || 1));
            for (const obs of state.obstacles) {
                let hit = false;
                if (obs.type === 'rect') {
                    const minX = obs.x - obs.halfWidth - carR;
                    const maxX = obs.x + obs.halfWidth + carR;
                    const minZ = obs.z - obs.halfDepth - carR;
                    const maxZ = obs.z + obs.halfDepth + carR;
                    if (nextX > minX && nextX < maxX && nextZ > minZ && nextZ < maxZ) {
                        // Push out along the axis of least penetration.
                        const penL = nextX - minX, penR = maxX - nextX;
                        const penN = nextZ - minZ, penF = maxZ - nextZ;
                        const minPen = Math.min(penL, penR, penN, penF);
                        if (minPen === penL) nextX = minX;
                        else if (minPen === penR) nextX = maxX;
                        else if (minPen === penN) nextZ = minZ;
                        else nextZ = maxZ;
                        hit = true;
                    }
                } else {
                    const dx = nextX - obs.x, dz = nextZ - obs.z;
                    const minDist = obs.radius + carR;
                    if (dx * dx + dz * dz < minDist * minDist) {
                        const dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
                        nextX = obs.x + (dx / dist) * minDist;
                        nextZ = obs.z + (dz / dist) * minDist;
                        hit = true;
                    }
                }
                if (hit && !collided) {
                    collided = true;
                    hitX = obs.x;
                    hitZ = obs.z;
                }
            }
        }

        // Move to the (possibly pushed-out) position, then keep it on the terrain plane.
        this.group.position.x = nextX;
        this.group.position.z = nextZ;
        const bound = (state.terrainConfig?.size ?? 1000) / 2 - 2;
        this.group.position.x = Math.max(-bound, Math.min(bound, this.group.position.x));
        this.group.position.z = Math.max(-bound, Math.min(bound, this.group.position.z));

        if (collided) {
            if (this.powerups.shield.active) {
                // Shielded: plough to a near-stop instead of bouncing.
                this.speed *= 0.1;
            } else {
                this.speed *= -0.5;
                if (Math.abs(this.speed) > 0.125) {
                    playCollisionSound(Math.abs(this.speed) * 2);
                    const fxHeight = getTerrainHeight(hitX, hitZ) + 4;
                    const particleCount = Math.min(16, Math.floor(Math.abs(this.speed) * 30));
                    spawnParticles(hitX, fxHeight, hitZ, 0x228B22, particleCount, 0.5, 2.5, 0.4);
                    if (Math.abs(this.speed) > 0.2) {
                        spawnParticles(hitX, fxHeight - 2, hitZ, 0x8B4513, 4, 0.3, 1.5, 0.3);
                    }
                }
            }
        }

        const isOverturned = Math.abs(this.group.rotation.x) > 1.15 || Math.abs(this.group.rotation.z) > 1.15;
        const pushingIntoObstacle = Math.abs(throttle) > 0.55 && collided && !this.isFlipping;
        if (isOverturned || pushingIntoObstacle) {
            this._recoveryTimer += Math.min(dt, 0.1);
        } else {
            this._recoveryTimer = Math.max(0, this._recoveryTimer - Math.min(dt, 0.1) * 2);
        }
        this.canRecover = !this.isFlipping && (isOverturned || this._recoveryTimer >= 0.85);

        // Ease the car up/down to the terrain height (no per-frame snapping) and
        // tilt it to follow the slope while preserving steering yaw.
        const targetY = getTerrainHeight(this.group.position.x, this.group.position.z);
        this.group.position.y += (targetY - this.group.position.y) * Math.min(1, 0.15 * frame);

        this.group.rotation.order = 'YXZ';
        this.group.rotation.y = this.angle;
        const slopeStep = 2.0;
        const fwdX = Math.sin(this.angle), fwdZ = Math.cos(this.angle);
        const hFwd = getTerrainHeight(this.group.position.x + fwdX * slopeStep, this.group.position.z + fwdZ * slopeStep);
        const hBack = getTerrainHeight(this.group.position.x - fwdX * slopeStep, this.group.position.z - fwdZ * slopeStep);
        const hRight = getTerrainHeight(this.group.position.x + fwdZ * slopeStep, this.group.position.z - fwdX * slopeStep);
        const hLeft = getTerrainHeight(this.group.position.x - fwdZ * slopeStep, this.group.position.z + fwdX * slopeStep);
        const targetPitch = Math.atan2(hBack - hFwd, slopeStep * 2);
        const targetRoll = Math.atan2(hRight - hLeft, slopeStep * 2);
        const tiltLerp = Math.min(1, 0.1 * frame);
        this.group.rotation.x += (targetPitch - this.group.rotation.x) * tiltLerp;
        this.group.rotation.z += (targetRoll - this.group.rotation.z) * tiltLerp;

        this.wheels.forEach(w => {
            w.rotation.x -= this.speed * 0.5 * frame;
        });

        if (Math.abs(this.speed) > 0.1 && !this.isFlipping) {
            this.flipGroup.position.y = Math.sin(Date.now() * 0.01) * 0.05;
        } else if (!this.isFlipping) {
            this.flipGroup.position.y = 0;
        } else {
            const normRot = this.flipGroup.rotation.x;
            const lift = Math.sin(normRot / 2);
            const jumpHeightFactor = this.powerups.jump.active ? 24 : 8;
            this.flipGroup.position.y = lift * jumpHeightFactor;
        }

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'update',
                x: this.group.position.x,
                z: this.group.position.z,
                y: this.flipGroup.position.y,
                angle: this.angle,
                flipAngle: this.flipGroup.rotation.x,
                isFlipping: this.isFlipping,
                scale: this.group.scale.x,
                ghostActive: this.powerups.ghost.active,
                shieldActive: this.powerups.shield.active,
                megaActive: this.powerups.size.active
            }));
        }
    }
}
