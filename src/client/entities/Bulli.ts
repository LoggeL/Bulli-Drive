import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { playJumpSound, playCollisionSound, playHonkSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { getTerrainHeight } from '../world/environment.js';

// Reusable vectors to avoid per-frame allocations
const _scaleBig = new THREE.Vector3(2.5, 2.5, 2.5);
const _scaleNormal = new THREE.Vector3(1, 1, 1);

// Car types with different visual profiles
export type CarType = 'bulli' | 'pickup' | 'sport' | 'beetle' | 'jeep';
const CAR_TYPES: CarType[] = ['bulli', 'pickup', 'sport', 'beetle', 'jeep'];

export function randomCarType(): CarType {
    return CAR_TYPES[Math.floor(Math.random() * CAR_TYPES.length)];
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
    cameraOrbit: number = 0;
    acceleration: number = 0.015;
    maxSpeed: number = 1.0;
    friction: number = 0.96;
    isFlipping: boolean = false;
    flipVelocity: number = 0;
    nextHonkTime: number = 0;
    powerups = {
        speed: { active: false, timer: 0 },
        size: { active: false, timer: 0 },
        jump: { active: false, timer: 0 },
        shield: { active: false, timer: 0 },
        magnet: { active: false, timer: 0 },
        ghost: { active: false, timer: 0 }
    };
    shieldMesh?: THREE.Mesh;
    wheels: THREE.Group[] = [];
    nametag?: HTMLDivElement;

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
        this.nametag = document.createElement('div');
        this.nametag.className = 'nametag' + (isLocal ? ' local' : '');
        this.nametag.innerText = name;
        document.body.appendChild(this.nametag);
    }

    updateNametag() {
        if (!this.nametag || !state.camera) return;

        const pos = this.group.position.clone();
        pos.y += 4;
        pos.project(state.camera);

        if (pos.z > 1) {
            this.nametag.style.display = 'none';
        } else {
            this.nametag.style.display = 'block';
            const x = (pos.x * .5 + .5) * window.innerWidth;
            const y = (pos.y * -.5 + .5) * window.innerHeight;
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
            color: 0x00BFFF, transparent: true, opacity: 0, emissive: 0x00BFFF, emissiveIntensity: 0, side: THREE.DoubleSide
        });
        this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
        this.shieldMesh.position.y = 1.5;
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

        // VW Logo
        const logo = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 32), chromeMat);
        logo.rotation.x = Math.PI / 2;
        logo.position.set(0, lowerBody.position.y + 0.3, length / 2 + 0.02);
        this.flipGroup.add(logo);

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

    update(dt: number) {
        this.updateNametag();

        Object.keys(this.powerups).forEach(key => {
            const p = this.powerups[key as keyof typeof this.powerups];
            if (p.active) {
                p.timer -= dt;
                if (p.timer <= 0) {
                    p.active = false;
                    if (key === 'size') this.group.scale.set(1, 1, 1);
                    if (key === 'ghost') {
                        // Restore opacity
                        this.flipGroup.traverse((child) => {
                            if ((child as THREE.Mesh).material && child !== this.shieldMesh) {
                                const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
                                if (mat.transparent && mat.userData?.originalOpacity !== undefined) {
                                    mat.opacity = mat.userData.originalOpacity;
                                }
                            }
                        });
                    }
                }
            }
        });

        // Update shield visual
        if (this.shieldMesh) {
            const shieldMat = this.shieldMesh.material as THREE.MeshStandardMaterial;
            if (this.powerups.shield.active) {
                shieldMat.opacity = 0.25 + Math.sin(Date.now() * 0.005) * 0.1;
                shieldMat.emissiveIntensity = 0.4 + Math.sin(Date.now() * 0.008) * 0.2;
                this.shieldMesh.rotation.y += dt * 2;
            } else {
                shieldMat.opacity = 0;
                shieldMat.emissiveIntensity = 0;
            }
        }

        // Ghost transparency effect
        if (this.powerups.ghost.active) {
            this.flipGroup.traverse((child) => {
                if ((child as THREE.Mesh).material && child !== this.shieldMesh) {
                    const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
                    if (mat.transparent) {
                        if (mat.userData?.originalOpacity === undefined) {
                            mat.userData = mat.userData || {};
                            mat.userData.originalOpacity = mat.opacity;
                        }
                        mat.opacity = 0.3 + Math.sin(Date.now() * 0.003) * 0.1;
                    }
                }
            });
        }

        if (!this.isLocal) return;
        if (state.isModalOpen) return;

        const frame = dt * 60;

        let currentAccel = this.acceleration;
        let currentMaxSpeed = this.maxSpeed;
        if (this.powerups.speed.active) {
            const t = Math.max(0, this.powerups.speed.timer);
            const factor = 1 + (t / 5) * 2;
            currentAccel *= factor;
            currentMaxSpeed *= factor;
        }

        if (this.powerups.size.active) {
            this.group.scale.lerp(_scaleBig, 0.1);
        } else {
            this.group.scale.lerp(_scaleNormal, 0.1);
        }

        if (state.inputs.w) {
            this.speed += currentAccel * frame;
        } else if (state.inputs.s) {
            this.speed -= currentAccel * frame;
        } else {
            this.speed *= Math.pow(this.friction, frame);
        }

        if (state.inputs.space && !this.isFlipping) {
            this.isFlipping = true;
            this.flipVelocity = this.powerups.jump.active ? 0.12 : 0.25;
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

        if (this.isFlipping) {
            this.flipGroup.rotation.x += this.flipVelocity * frame;
            if (this.flipGroup.rotation.x >= Math.PI * 2) {
                this.flipGroup.rotation.x = 0;
                this.isFlipping = false;
            }
        }

        this.speed = Math.max(Math.min(this.speed, currentMaxSpeed), -currentMaxSpeed / 2);
        if (Math.abs(this.speed) < 0.001) this.speed = 0;

        if (Math.abs(this.speed) > 0.01 && !this.isFlipping) {
            if (state.inputs.a) this.angle += CONFIG.carTurnSpeed * Math.sign(this.speed) * frame;
            if (state.inputs.d) this.angle -= CONFIG.carTurnSpeed * Math.sign(this.speed) * frame;
        }

        const nextX = this.group.position.x + Math.sin(this.angle) * this.speed * frame;
        const nextZ = this.group.position.z + Math.cos(this.angle) * this.speed * frame;

        let collision = false;
        // Ghost powerup = pass through obstacles
        if (!this.isFlipping && !this.powerups.ghost.active) {
            for (const obs of state.obstacles as any[]) {
                const dx = nextX - obs.x;
                const dz = nextZ - obs.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                if (dist < obs.radius * (this.group.scale.x || 1)) {
                    // Shield powerup = no bounce, just stop
                    if (this.powerups.shield.active) {
                        collision = true;
                        this.speed *= 0.1;
                        break;
                    }
                    collision = true;
                    this.speed *= -0.5;

                    if (Math.abs(this.speed) > 0.125) {
                        playCollisionSound(Math.abs(this.speed) * 2);
                        const treeHeight = getTerrainHeight(obs.x, obs.z) + 4;
                        const particleCount = Math.min(16, Math.floor(Math.abs(this.speed) * 30));
                        spawnParticles(obs.x, treeHeight, obs.z, 0x228B22, particleCount, 0.5, 2.5, 0.4);
                        if (Math.abs(this.speed) > 0.2) {
                            spawnParticles(obs.x, treeHeight - 2, obs.z, 0x8B4513, 4, 0.3, 1.5, 0.3);
                        }
                    }
                    break;
                }
            }
        }

        if (!collision) {
            this.group.position.x = nextX;
            this.group.position.z = nextZ;
        }

        this.group.position.y = getTerrainHeight(this.group.position.x, this.group.position.z);
        this.group.rotation.y = this.angle;

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

        if (state.inputs.arrowleft) this.cameraOrbit += 0.03 * frame;
        if (state.inputs.arrowright) this.cameraOrbit -= 0.03 * frame;

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'update',
                x: this.group.position.x,
                z: this.group.position.z,
                y: this.flipGroup.position.y,
                angle: this.angle,
                flipAngle: this.flipGroup.rotation.x,
                isFlipping: this.isFlipping,
                scale: this.group.scale.x
            }));
        }
    }
}
