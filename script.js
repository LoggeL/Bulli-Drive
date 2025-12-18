import * as THREE from 'three';

// --- Configuration ---
const CONFIG = {
    carSpeed: 0.5,
    carTurnSpeed: 0.05,
    cameraHeight: 25,
    cameraDistance: 35,
    cameraLookAtY: 0,
    shadowMapSize: 2048,
    // Dynamic WS URL: Use current hostname/port
    serverUrl: window.location.origin.replace(/^http/, 'ws')
};

// --- Globals ---
let scene, camera, renderer;
let bulli; // Local car
let remotePlayers = {}; // id -> { group, targetX, targetZ, targetAngle... }
let inputs = { w: false, a: false, s: false, d: false, space: false, arrowleft: false, arrowright: false };
let projects = [];
let activeProject = null;
let isModalOpen = false;
let audioCtx;
let ws;
let obstacles = [];
let terrainConfig = null;
let myId = null;
let myColor = null;
let myName = "Player";
const clock = new THREE.Clock();

// --- Initialization ---
function init() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky blue
    scene.fog = new THREE.Fog(0x87CEEB, 20, 120);

    // Camera
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, CONFIG.cameraHeight, CONFIG.cameraDistance);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.SoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // Audio Context
    try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
    } catch (e) { /* ignore */ }

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(50, 100, 50);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = CONFIG.shadowMapSize;
    dirLight.shadow.mapSize.height = CONFIG.shadowMapSize;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.camera.left = -100;
    dirLight.shadow.camera.right = 100;
    dirLight.shadow.camera.top = 100;
    dirLight.shadow.camera.bottom = -100;
    scene.add(dirLight);

    // Init WebSocket
    initWebSocket();

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('keyup', onKeyUp, false);

    // Rename UI
    const nameSubmit = document.getElementById('name-submit');
    const nameInput = document.getElementById('name-input');
    if (nameSubmit && nameInput) {
        nameSubmit.addEventListener('click', () => {
            const newName = nameInput.value.trim();
            if (newName && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'rename',
                    name: newName
                }));
                nameInput.value = '';
            }
        });
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') nameSubmit.click();
        });
    }

    // Start Loop
    animate();
}

function initWebSocket() {
    ws = new WebSocket(CONFIG.serverUrl);

    ws.onopen = () => {
        console.log('Connected to server');
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
    };

    ws.onerror = (e) => {
        console.warn('WebSocket error, offline mode?', e);
        // If offline, create local player anyway
        if (!bulli) {
            // Fallback terrain for offline mode
            terrainConfig = {
                size: 1000,
                segments: 64,
                frequency1: 0.02,
                amplitude1: 0,
                frequency2: 0.05,
                amplitude2: 0
            };
            createEnvironment(); 
            
            createLocalPlayer(0xD32F2F, "Offline");
            const loader = document.getElementById('loading-screen');
            if (loader) loader.style.opacity = 0;
            setTimeout(() => { if (loader) loader.remove(); }, 500);
        }
    };
}

function handleServerMessage(data) {
    if (data.type === 'init') {
        myId = data.id;
        myColor = data.color;
        myName = data.name;

        // Init server-side terrain
        if (data.terrain) {
            terrainConfig = data.terrain;
            createEnvironment(data.trees);
        }

        createLocalPlayer(myColor, myName);

        // Remove Loader
        const loader = document.getElementById('loading-screen');
        if (loader) loader.style.opacity = 0;
        setTimeout(() => { if (loader) loader.remove(); }, 500);

        // Init existing players
        for (const pid in data.players) {
            if (pid !== myId) {
                addRemotePlayer(data.players[pid]);
            }
        }

        // Init server-side powerups
        if (data.powerups) {
            projects = data.powerups;
            projects.forEach(p => {
                createPowerupMarker(p);
                if (p.collected) {
                    p.mesh.visible = false;
                }
            });
        }

        updatePlayerListUI();
    } else if (data.type === 'newPlayer') {
        if (data.player.id !== myId) {
            addRemotePlayer(data.player);
            updatePlayerListUI();
        }
    } else if (data.type === 'removePlayer') {
        removeRemotePlayer(data.id);
        updatePlayerListUI();
    } else if (data.type === 'update') {
        updateRemotePlayer(data);
    } else if (data.type === 'powerupCollected') {
        const p = projects.find(item => item.id === data.powerupId);
        if (p) {
            p.collected = true;
            if (p.mesh) p.mesh.visible = false;
            
            // If I collected it, apply effect (already done in collectPowerup for local, but good for sync)
            if (data.playerId === myId) {
                applyPowerupEffect(p);
            }
        }
    } else if (data.type === 'powerupReset') {
        const p = projects.find(item => item.id === data.powerupId);
        if (p) {
            p.collected = false;
            if (p.mesh) p.mesh.visible = true;
        }
    } else if (data.type === 'honk') {
        const p = remotePlayers[data.id];
        if (p) {
            // Remote players are just Bulli instances? 
            // Wait, remotePlayers stores { group, ... } OR Bulli instance?
            // addRemotePlayer creates a new Bulli().
            // So remotePlayers[id] IS a Bulli instance.
            p.honk();
        }
    } else if (data.type === 'playerRenamed') {
        if (data.id === myId) {
            myName = data.name;
            if (bulli) {
                bulli.name = data.name;
                if (bulli.nametag) bulli.nametag.innerText = data.name;
            }
        } else {
            const remote = remotePlayers[data.id];
            if (remote) {
                remote.name = data.name;
                if (remote.nametag) remote.nametag.innerText = data.name;
            }
        }
        updatePlayerListUI();
    }
}

function createLocalPlayer(color, name) {
    myColor = color;
    myName = name;
    bulli = new Bulli(color, true);
    bulli.createNametag(name, true);
    scene.add(bulli.group);
    updatePlayerListUI();
}

function addRemotePlayer(p) {
    if (remotePlayers[p.id]) return;

    const remote = new Bulli(p.color, false);
    remote.group.position.set(p.x || 0, 0, p.z || 0);
    remote.group.rotation.y = p.angle || 0;
    remote.createNametag(p.name, false);

    scene.add(remote.group);
    remotePlayers[p.id] = remote;
}

function removeRemotePlayer(id) {
    if (remotePlayers[id]) {
        scene.remove(remotePlayers[id].group);
        if (remotePlayers[id].nametag) remotePlayers[id].nametag.remove();
        delete remotePlayers[id];
    }
}

function updateRemotePlayer(data) {
    const remote = remotePlayers[data.id];
    if (remote) {
        // Direct sync (could interpret for smoothness)
        remote.group.position.set(data.x, 0, data.z);
        remote.group.rotation.y = data.angle;
        remote.flipGroup.rotation.x = data.flipAngle;
        if (data.scale) remote.group.scale.set(data.scale, data.scale, data.scale);

        // Handle flip Y interaction simply
        if (data.isFlipping) {
            const normRot = data.flipAngle;
            if (normRot > 0) {
                const lift = Math.sin(normRot / 2);
                remote.flipGroup.position.y = lift * 8;
            }
        } else {
            // Simple Bobbing approximation if moving
            // We don't have speed, but we can assume if pos changes... 
            // meh, leave static or simple
            remote.flipGroup.position.y = 0;
        }

        remote.updateNametag();
    }
}

function updatePlayerListUI() {
    const list = document.getElementById('players-ul');
    if (!list) return;
    list.innerHTML = '';

    // Add me
    if (bulli) {
        addPlayerToList(list, myName, myColor, true);
    }

    // Add others
    for (const id in remotePlayers) {
        const p = remotePlayers[id];
        // We need to look up name/color from the object we stored
        // Wait, remotePlayer object is a Bulli instance, does it have name?
        // We didn't store name on the Bulli instance directly easily accessible?
        // Actually we passed it to createNametag. Let's store it on the instance.
        // Or we can just read the nametag text? 
        // Let's rely on the fact that we should probably store "metadata" on the Bulli.
        addPlayerToList(list, p.name, p.colorCode, false);
    }
}

function addPlayerToList(list, name, color, isMe) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.backgroundColor = '#' + new THREE.Color(color).getHexString();

    li.appendChild(dot);
    li.appendChild(document.createTextNode(name + (isMe ? ' (You)' : '')));
    list.appendChild(li);
}

function getTerrainHeight(x, z) {
    if (!terrainConfig) return 0;
    const { frequency1, amplitude1, frequency2, amplitude2 } = terrainConfig;
    return Math.sin(x * frequency1) * amplitude1 + 
           Math.cos(z * frequency1) * amplitude1 + 
           Math.sin(x * frequency2 + z * frequency2) * amplitude2;
}

// --- Environment ---
function createEnvironment(treeData) {
    if (!terrainConfig) return;

    // Ground - Hilly
    const size = terrainConfig.size || 1000;
    const segments = terrainConfig.segments || 64;
    const groundGeo = new THREE.PlaneGeometry(size, size, segments, segments);
    
    // Displace vertices for hills
    const posAttr = groundGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const y = posAttr.getY(i);
        const height = getTerrainHeight(x, y);
        posAttr.setZ(i, height);
    }
    groundGeo.computeVertexNormals();

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x90EE90, roughness: 0.8 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Trees & Obstacles
    obstacles = [];
    if (treeData) {
        treeData.forEach(t => {
            const h = t.height || 5;
            const treeGeo = new THREE.ConeGeometry(1.5, h, 8);
            const treeMat = new THREE.MeshStandardMaterial({ color: 0x228B22 });
            const tree = new THREE.Mesh(treeGeo, treeMat);

            const terrainY = getTerrainHeight(t.x, t.z);

            tree.position.set(t.x, terrainY + h / 2 - 0.5, t.z);
            tree.castShadow = true;
            tree.receiveShadow = true;
            scene.add(tree);

            // Add to obstacles for collision
            obstacles.push({
                x: t.x,
                z: t.z,
                radius: 2.5
            });
        });
    }
}

function createPowerupMarker(p) {
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const mat = new THREE.MeshStandardMaterial({
        color: p.color,
        emissive: p.color,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.9
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x, 2, p.z);
    mesh.castShadow = true;

    mesh.userData = {
        powerup: p,
        initialY: 2,
        timeOffset: Math.random() * 100
    };

    scene.add(mesh);
    p.mesh = mesh;
}

function checkPowerupCollection() {
    if (!bulli) return;

    projects.forEach((p, index) => {
        if (!p.collected) {
            const dx = bulli.group.position.x - p.x;
            const dz = bulli.group.position.z - p.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            
            // Floating animation
            if (p.mesh) {
                p.mesh.rotation.y += 0.05;
                p.mesh.rotation.z += 0.02;
                p.mesh.position.y = p.mesh.userData.initialY + Math.sin(Date.now() * 0.005 + p.mesh.userData.timeOffset) * 0.5;
            }

            if (dist < 4) {
                requestPowerupCollection(p);
            }
        }
    });
}

function requestPowerupCollection(p) {
    // Optimistically hide locally if we want, but server should confirm
    // Let's just send request
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'collectPowerup',
            powerupId: p.id
        }));
    }
}

function applyPowerupEffect(p) {
    // Apply effect
    bulli.powerups[p.type].active = true;
    bulli.powerups[p.type].timer = 10; // 10 seconds

    // Show feedback
    const prompt = document.getElementById('interaction-prompt');
    prompt.innerHTML = `POWERUP: ${p.label.toUpperCase()}!`;
    prompt.classList.remove('hidden');
    setTimeout(() => {
        prompt.classList.add('hidden');
    }, 2000);

    // Audio feedback (honk slightly different)
    bulli.honk();
}
class Bulli {
    constructor(colorCode = 0xD32F2F, isLocal = false) {
        this.group = new THREE.Group();
        this.flipGroup = new THREE.Group();
        this.group.add(this.flipGroup);

        this.isLocal = isLocal;
        this.colorCode = colorCode;
        this.name = "Unknown";

        // Random pitch
        this.pitchOffset = 0.8 + Math.random() * 0.7; // Store name

        // Physics vars
        this.speed = 0;
        this.angle = 0;
        this.cameraOrbit = 0; // Camera orbit angle
        this.acceleration = 0.015;
        this.maxSpeed = 1.0;
        this.friction = 0.96;

        this.isFlipping = false;
        this.flipVelocity = 0;
        this.lastHonkTime = 0;

        // Powerup states
        this.powerups = {
            speed: { active: false, timer: 0 },
            size: { active: false, timer: 0 },
            jump: { active: false, timer: 0 }
        };

        this.buildCar();
    }

    createNametag(name, isLocal) {
        this.name = name;
        this.nametag = document.createElement('div');
        this.nametag.className = 'nametag' + (isLocal ? ' local' : '');
        this.nametag.innerText = name;
        document.body.appendChild(this.nametag);
    }

    updateNametag() {
        if (!this.nametag) return;

        // Project 3D pos to 2D
        const pos = this.group.position.clone();
        pos.y += 4; // Above car
        pos.project(camera);

        if (pos.z > 1) { // Behind camera
            this.nametag.style.display = 'none';
        } else {
            this.nametag.style.display = 'block';
            const x = (pos.x * .5 + .5) * window.innerWidth;
            const y = (pos.y * -.5 + .5) * window.innerHeight;
            this.nametag.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
        }
    }

    buildCar() {
        // Chibi Dimensions
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

        // --- Lower Body (Colored) ---
        const lowerBodyGeo = new THREE.BoxGeometry(width, heightLower, length);
        const lowerBody = new THREE.Mesh(lowerBodyGeo, redMat);
        lowerBody.position.y = chassisY + heightLower / 2;
        lowerBody.castShadow = true;
        this.flipGroup.add(lowerBody);

        // --- Upper Body (White) ---
        const upperBodyGeo = new THREE.BoxGeometry(width - 0.1, heightUpper, length - 0.2);
        const upperBody = new THREE.Mesh(upperBodyGeo, whiteMat);
        upperBody.position.y = chassisY + heightLower + heightUpper / 2;
        upperBody.castShadow = true;
        this.flipGroup.add(upperBody);

        // --- The "V" Shape Front ---
        const vShapeWidth = width - 0.2;
        const vShapeHeight = heightLower * 0.9;
        const vShapeGeo = new THREE.ConeGeometry(vShapeWidth / 2, vShapeHeight, 32, 1, true, 0, Math.PI);
        const vMesh = new THREE.Mesh(vShapeGeo, whiteMat);
        vMesh.rotation.z = Math.PI;
        vMesh.position.set(0, chassisY + heightLower - vShapeHeight / 2, length / 2 + 0.01);
        vMesh.scale.z = 0.5;
        this.flipGroup.add(vMesh);

        const vPlaneShape = new THREE.Shape();
        vPlaneShape.moveTo(-width / 2 + 0.1, 0);
        vPlaneShape.lineTo(width / 2 - 0.1, 0);
        vPlaneShape.lineTo(0, -heightLower + 0.2);
        vPlaneShape.lineTo(-width / 2 + 0.1, 0);
        const vPlaneGeo = new THREE.ShapeGeometry(vPlaneShape);
        const vPlane = new THREE.Mesh(vPlaneGeo, whiteMat);
        vPlane.position.set(0, chassisY + heightLower, length / 2 + 0.01);
        this.flipGroup.add(vPlane);

        // --- Windows ---
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

        // --- Big Eyes (Headlights) ---
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


        // --- VW Logo ---
        const logoGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.05, 32);
        const logo = new THREE.Mesh(logoGeo, chromeMat);
        logo.rotation.x = Math.PI / 2;
        logo.position.set(0, lowerBody.position.y + 0.3, length / 2 + 0.02);
        this.flipGroup.add(logo);

        // --- Bumpers ---
        const bumperGeo = new THREE.BoxGeometry(width + 0.2, 0.3, 0.4);
        const frontBumper = new THREE.Mesh(bumperGeo, whiteMat);
        frontBumper.position.set(0, 0.5, length / 2 + 0.2);
        frontBumper.castShadow = true;
        this.flipGroup.add(frontBumper);

        const rearBumper = new THREE.Mesh(bumperGeo, whiteMat);
        rearBumper.position.set(0, 0.5, -length / 2 - 0.2);
        rearBumper.castShadow = true;
        this.flipGroup.add(rearBumper);


        // --- Wheels ---
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
        if (!audioCtx) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const curTime = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'sawtooth';
        // Base freq 300 * pitch
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

    update(dt) {
        this.updateNametag();

        // Update powerup timers
        Object.keys(this.powerups).forEach(key => {
            if (this.powerups[key].active) {
                this.powerups[key].timer -= dt;
                if (this.powerups[key].timer <= 0) {
                    this.powerups[key].active = false;
                    if (key === 'size') this.group.scale.set(1, 1, 1);
                }
            }
        });

        if (!this.isLocal) return; 

        if (isModalOpen) return;

        const frame = dt * 60;

        // Apply Powerup Effects
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

        // Input Handling
        if (inputs.w) {
            this.speed += currentAccel * frame;
        } else if (inputs.s) {
            this.speed -= currentAccel * frame;
        } else {
            this.speed *= Math.pow(this.friction, frame);
        }

        // Frontflip Logic
        if (inputs.space && !this.isFlipping) {
            this.isFlipping = true;
            this.flipVelocity = this.powerups.jump.active ? 0.4 : 0.25;
        }

        // Honk Logic (F)
        if (inputs.f) {
            const now = Date.now();
            if (now - this.lastHonkTime > 500) {
                this.honk();
                this.lastHonkTime = now;

                // Send honk to server
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'honk'
                    }));
                }
            }
            inputs.f = false;
        }

        if (this.isFlipping) {
            // Rotate flipGroup around X axis
            this.flipGroup.rotation.x += this.flipVelocity * frame;

            // Check if full circle
            if (this.flipGroup.rotation.x >= Math.PI * 2) {
                this.flipGroup.rotation.x = 0;
                this.isFlipping = false;
            }
        }

        // Cap speed
        this.speed = Math.max(Math.min(this.speed, this.maxSpeed), -this.maxSpeed / 2);
        if (Math.abs(this.speed) < 0.001) this.speed = 0;

        // Turning
        if (Math.abs(this.speed) > 0.01 && !this.isFlipping) {
            if (inputs.a) this.angle += CONFIG.carTurnSpeed * Math.sign(this.speed) * frame;
            if (inputs.d) this.angle -= CONFIG.carTurnSpeed * Math.sign(this.speed) * frame;
        }

        // Apply movement (to the main group)
        const nextX = this.group.position.x + Math.sin(this.angle) * this.speed * frame;
        const nextZ = this.group.position.z + Math.cos(this.angle) * this.speed * frame;

        // Collision detection
        let collision = false;
        for (const obs of obstacles) {
            const dx = nextX - obs.x;
            const dz = nextZ - obs.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < obs.radius * (this.group.scale.x || 1)) {
                collision = true;
                this.speed *= -0.5; // Bounce back
                break;
            }
        }

        if (!collision) {
            this.group.position.x = nextX;
            this.group.position.z = nextZ;
        }

        // Adjust Y to terrain height
        const tx = this.group.position.x;
        const tz = this.group.position.z;
        const terrainY = getTerrainHeight(tx, tz);
        this.group.position.y = terrainY;

        this.group.rotation.y = this.angle;

        // Wheel animation
        this.wheels.forEach(w => {
            w.rotation.x -= this.speed * 0.5 * frame;
        });

        // Bobbing animation
        if (Math.abs(this.speed) > 0.1 && !this.isFlipping) {
            this.flipGroup.position.y = Math.sin(Date.now() * 0.01) * 0.05;
        } else if (!this.isFlipping) {
            this.flipGroup.position.y = 0;
        } else {
            const normRot = this.flipGroup.rotation.x;
            const lift = Math.sin(normRot / 2);
            this.flipGroup.position.y = lift * 8;
        }

        // Camera Orbit Input
        if (inputs.arrowleft) this.cameraOrbit += 0.03 * frame;
        if (inputs.arrowright) this.cameraOrbit -= 0.03 * frame;

        // Network Sync
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'update',
                x: this.group.position.x,
                z: this.group.position.z,
                angle: this.angle,
                flipAngle: this.flipGroup.rotation.x,
                isFlipping: this.isFlipping,
                scale: this.group.scale.x // Sync scale
            }));
        }
    }
}

// --- Logic ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(e) {
    if (document.activeElement.tagName === 'INPUT') return;

    const key = e.key.toLowerCase();
    if (key === ' ') inputs.space = true;
    if (key === 'arrowleft') inputs.arrowleft = true;
    if (key === 'arrowright') inputs.arrowright = true;
    if (inputs.hasOwnProperty(key)) inputs[key] = true;
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function onKeyUp(e) {
    if (document.activeElement.tagName === 'INPUT') return;

    const key = e.key.toLowerCase();
    if (key === ' ') inputs.space = false;
    if (key === 'f') inputs.f = true;
    if (key === 'arrowleft') inputs.arrowleft = false;
    if (key === 'arrowright') inputs.arrowright = false;
    if (inputs.hasOwnProperty(key)) inputs[key] = false;
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();

    if (bulli) {
        bulli.update(dt);
        checkPowerupCollection();

        // Camera Follow
        const relativeCameraOffset = new THREE.Vector3(0, CONFIG.cameraHeight, -CONFIG.cameraDistance);

        // Apply only the Y rotation of the car group PLUS the orbit angle
        const cameraOffset = relativeCameraOffset.clone();
        cameraOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), bulli.angle + bulli.cameraOrbit);
        cameraOffset.add(bulli.group.position);

        camera.position.lerp(cameraOffset, 0.1);

        // Look at car position + offset
        camera.lookAt(
            bulli.group.position.x,
            bulli.group.position.y + CONFIG.cameraLookAtY,
            bulli.group.position.z
        );
    }

    renderer.render(scene, camera);
}

init();
