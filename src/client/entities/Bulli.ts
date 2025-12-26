import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { playJumpSound, playCollisionSound } from '../effects/sounds.js';
import { spawnParticles } from '../effects/particles.js';
import { getTerrainHeight } from '../world/environment.js';

export class Bulli {
    group: THREE.Group;
    flipGroup: THREE.Group;
    isLocal: boolean;
    colorCode: number;
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
    lastHonkTime: number = 0;
    powerups = {
        speed: { active: false, timer: 0 },
        size: { active: false, timer: 0 },
        jump: { active: false, timer: 0 }
    };
    wheels: THREE.Group[] = [];
    nametag?: HTMLDivElement;

    constructor(colorCode = 0xD32F2F, isLocal = false) {
        this.group = new THREE.Group();
        this.flipGroup = new THREE.Group();
        this.group.add(this.flipGroup);

        this.isLocal = isLocal;
        this.colorCode = colorCode;
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
        const width = 2.8;
        const length = 4.0;
        const heightLower = 1.4;
        const heightUpper = 1.2;

        const redMat = new THREE.MeshStandardMaterial({ color: this.colorCode, roughness: 0.2, metalness: 0.1 });
        const whiteMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.2, metalness: 0.1 });
        const chromeMat = new THREE.MeshStandardMaterial({ color: 0xEEEEEE, roughness: 0.0, metalness: 1.0 });
        const glassMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.0, metalness: 0.9 });
        const rubberMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

        const chassisY = 0.8;

        const lowerBodyGeo = new THREE.BoxGeometry(width, heightLower, length);
        const lowerBody = new THREE.Mesh(lowerBodyGeo, redMat);
        lowerBody.position.y = chassisY + heightLower / 2;
        lowerBody.castShadow = true;
        this.flipGroup.add(lowerBody);

        const upperBodyGeo = new THREE.BoxGeometry(width - 0.1, heightUpper, length - 0.2);
        const upperBody = new THREE.Mesh(upperBodyGeo, whiteMat);
        upperBody.position.y = chassisY + heightLower + heightUpper / 2;
        upperBody.castShadow = true;
        this.flipGroup.add(upperBody);

        const winW = (width / 2) - 0.3;
        const winH = 0.7;
        const leftWinGeo = new THREE.PlaneGeometry(winW, winH);
        const leftWin = new THREE.Mesh(leftWinGeo, glassMat);
        leftWin.position.set(-winW / 2 - 0.05, upperBody.position.y, length / 2 - 0.1);
        leftWin.rotation.x = -Math.PI / 12;
        leftWin.position.z += 0.02;
        this.flipGroup.add(leftWin);

        const rightWin = new THREE.Mesh(leftWinGeo, glassMat);
        rightWin.position.set(winW / 2 + 0.05, upperBody.position.y, length / 2 - 0.1);
        rightWin.rotation.x = -Math.PI / 12;
        rightWin.position.z += 0.02;
        this.flipGroup.add(rightWin);

        const eyeRadius = 0.45;
        const eyeGeo = new THREE.SphereGeometry(eyeRadius, 32, 16);
        const eyeMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.1 });
        const pupilGeo = new THREE.SphereGeometry(eyeRadius * 0.6, 32, 16);
        const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111 });

        const leftEyeGroup = new THREE.Group();
        const leMesh = new THREE.Mesh(eyeGeo, eyeMat);
        const lpMesh = new THREE.Mesh(pupilGeo, pupilMat);
        lpMesh.position.z = eyeRadius - 0.1;
        leftEyeGroup.add(leMesh);
        leftEyeGroup.add(lpMesh);
        leftEyeGroup.position.set(-1, lowerBody.position.y + 0.1, length / 2);
        this.flipGroup.add(leftEyeGroup);

        const rightEyeGroup = leftEyeGroup.clone();
        rightEyeGroup.position.set(1, lowerBody.position.y + 0.1, length / 2);
        this.flipGroup.add(rightEyeGroup);

        const logoGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.05, 32);
        const logo = new THREE.Mesh(logoGeo, chromeMat);
        logo.rotation.x = Math.PI / 2;
        logo.position.set(0, lowerBody.position.y + 0.3, length / 2 + 0.02);
        this.flipGroup.add(logo);

        const bumperGeo = new THREE.BoxGeometry(width + 0.2, 0.3, 0.4);
        const frontBumper = new THREE.Mesh(bumperGeo, whiteMat);
        frontBumper.position.set(0, 0.5, length / 2 + 0.2);
        frontBumper.castShadow = true;
        this.flipGroup.add(frontBumper);

        const rearBumper = new THREE.Mesh(bumperGeo, whiteMat);
        rearBumper.position.set(0, 0.5, -length / 2 - 0.2);
        rearBumper.castShadow = true;
        this.flipGroup.add(rearBumper);

        this.wheels = [];
        const wheelRadius = 0.65;
        const wheelWidth = 0.4;
        const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 32);
        wheelGeo.rotateZ(Math.PI / 2);

        const capGeo = new THREE.CylinderGeometry(0.35, 0.35, wheelWidth + 0.05, 16);
        capGeo.rotateZ(Math.PI / 2);

        const wheelGroup = new THREE.Group();
        const tire = new THREE.Mesh(wheelGeo, rubberMat);
        const cap = new THREE.Mesh(capGeo, chromeMat);
        tire.castShadow = true;
        wheelGroup.add(tire);
        wheelGroup.add(cap);

        const wheelX = width / 2 - 0.2;
        const wheelY = wheelRadius;
        const wheelZ = 1.2;

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

    honk() {
        if (!state.audioCtx) return;
        if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

        const curTime = state.audioCtx.currentTime;
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();

        osc.connect(gain);
        gain.connect(state.audioCtx.destination);

        osc.type = 'sawtooth';
        const pitch = this.pitchOffset || 1.0;
        const startFreq = 300 * pitch;
        const endFreq = 350 * pitch;

        osc.frequency.setValueAtTime(startFreq, curTime);
        osc.frequency.linearRampToValueAtTime(endFreq, curTime + 0.1);

        gain.gain.setValueAtTime(0.2, curTime);
        gain.gain.exponentialRampToValueAtTime(0.01, curTime + 0.2);

        osc.start(curTime);
        osc.stop(curTime + 0.25);
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
                }
            }
        });

        if (!this.isLocal) return; 
        if (state.isModalOpen) return;

        const frame = dt * 60;

        let currentAccel = this.acceleration;
        let currentMaxSpeed = this.maxSpeed;
        if (this.powerups.speed.active) {
            currentAccel *= 2;
            currentMaxSpeed *= 1.8;
        }

        if (this.powerups.size.active) {
            this.group.scale.lerp(new THREE.Vector3(2.5, 2.5, 2.5), 0.1);
        } else {
            this.group.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
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
            this.flipVelocity = this.powerups.jump.active ? 0.4 : 0.25;
            playJumpSound();
        }

        // Honk logic handled in main loop or input handler generally, 
        // but keeping it here for consistency with original script.
        // Wait, the original script has a check for inputs.f here.
        if ((state.inputs as any).f) {
            const now = Date.now();
            if (now - this.lastHonkTime > 500) {
                this.honk();
                this.lastHonkTime = now;

                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'honk'
                    }));
                }
            }
            (state.inputs as any).f = false;
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
        for (const obs of state.obstacles as any[]) {
            const dx = nextX - obs.x;
            const dz = nextZ - obs.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < obs.radius * (this.group.scale.x || 1)) {
                collision = true;
                this.speed *= -0.5;
                
                if (Math.abs(this.speed) > 0.125) { // Original was 0.25 but impactSpeed was abs(this.speed) before bounce
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
            this.flipGroup.position.y = lift * 8;
        }

        if (state.inputs.arrowleft) this.cameraOrbit += 0.03 * frame;
        if (state.inputs.arrowright) this.cameraOrbit -= 0.03 * frame;

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'update',
                x: this.group.position.x,
                z: this.group.position.z,
                angle: this.angle,
                flipAngle: this.flipGroup.rotation.x,
                isFlipping: this.isFlipping,
                scale: this.group.scale.x
            }));
        }
    }
}
