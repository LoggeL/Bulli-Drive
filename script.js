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

    // Environment
    createEnvironment();

    // Init WebSocket
    initWebSocket();

    // Projects
    projects.push({
        position: new THREE.Vector3(25, 0, -25),
        title: "Project Alpha",
        description: "A revolutionary app that changed the way we think about toast.",
        color: 0xFF5757
    });
    projects.push({
        position: new THREE.Vector3(-35, 0, 15),
        title: "Blue Sky Initiative",
        description: "Leveraging cloud computing to actually make the sky bluer.",
        color: 0x4488FF
    });
    projects.forEach(p => createProjectMarker(p));

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('keyup', onKeyUp, false);

    // UI Helpers
    document.querySelector('.close-btn').addEventListener('click', closeModal);
    document.querySelector('.modal-backdrop').addEventListener('click', closeModal);

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
    } else if (data.type === 'honk') {
        const p = remotePlayers[data.id];
        if (p) {
            // Remote players are just Bulli instances? 
            // Wait, remotePlayers stores { group, ... } OR Bulli instance?
            // addRemotePlayer creates a new Bulli().
            // So remotePlayers[id] IS a Bulli instance.
            p.honk();
        }
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

// --- Environment ---
function createEnvironment() {
    // Ground
    const groundGeo = new THREE.PlaneGeometry(1000, 1000);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x90EE90 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Trees
    for (let i = 0; i < 80; i++) {
        const h = 3 + Math.random() * 4;
        const treeGeo = new THREE.ConeGeometry(1.5, h, 8);
        const treeMat = new THREE.MeshStandardMaterial({ color: 0x228B22 });
        const tree = new THREE.Mesh(treeGeo, treeMat);

        const x = (Math.random() - 0.5) * 600;
        const z = (Math.random() - 0.5) * 600;

        if (Math.abs(x) < 30 && Math.abs(z) < 30) continue;

        tree.position.set(x, h / 2, z);
        tree.castShadow = true;
        tree.receiveShadow = true;
        scene.add(tree);
    }
}

function createProjectMarker(p) {
    const geo = new THREE.OctahedronGeometry(1.5);
    const mat = new THREE.MeshStandardMaterial({
        color: p.color,
        emissive: p.color,
        emissiveIntensity: 0.6
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(p.position);
    mesh.position.y = 3;
    mesh.castShadow = true;

    mesh.userData = {
        project: p,
        initialY: 3,
        timeOffset: Math.random() * 100
    };

    scene.add(mesh);
    p.mesh = mesh;
}


// --- Class: Bulli ---
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
        if (!this.isLocal) return; // Remote players updated via server msg, NOT physics here (or minimal interplation)

        if (isModalOpen) return;

        // Convert to a 60fps-equivalent frame scalar so existing tuning values keep their feel.
        const frame = dt * 60;

        // Input Handling
        if (inputs.w) {
            this.speed += this.acceleration * frame;
        } else if (inputs.s) {
            this.speed -= this.acceleration * frame;
        } else {
            this.speed *= Math.pow(this.friction, frame);
        }

        // Frontflip Logic
        if (inputs.space && !this.isFlipping) {
            this.isFlipping = true;
            this.flipVelocity = 0.25;
            // Removed honk from space
        }

        // Honk Logic (F)
        if (inputs.f) {
            this.honk();
            inputs.f = false;

            // Send honk to server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'honk'
                }));
            }
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
        this.group.position.x += Math.sin(this.angle) * this.speed * frame;
        this.group.position.z += Math.cos(this.angle) * this.speed * frame;
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
                isFlipping: this.isFlipping
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
    const key = e.key.toLowerCase();
    if (key === ' ') inputs.space = true;
    if (key === 'arrowleft') inputs.arrowleft = true;
    if (key === 'arrowright') inputs.arrowright = true;
    if (inputs.hasOwnProperty(key)) inputs[key] = true;
    if (key === 'e' && activeProject && !isModalOpen) {
        openModal(activeProject);
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function onKeyUp(e) {
    const key = e.key.toLowerCase();
    if (key === ' ') inputs.space = false;
    if (key === 'f') inputs.f = true;
    if (key === 'arrowleft') inputs.arrowleft = false;
    if (key === 'arrowright') inputs.arrowright = false;
    if (inputs.hasOwnProperty(key)) inputs[key] = false;
}

function checkProjectDistance() {
    if (!bulli) return;

    let closest = null;
    let minDist = 6;

    projects.forEach(p => {
        const dist = bulli.group.position.distanceTo(p.position);
        if (dist < minDist) {
            closest = p;
        }

        if (p.mesh) {
            p.mesh.rotation.y += 0.02;
            p.mesh.rotation.z += 0.01;
            p.mesh.position.y = p.mesh.userData.initialY + Math.sin(Date.now() * 0.002 + p.mesh.userData.timeOffset) * 0.5;
        }
    });

    activeProject = closest;
    const prompt = document.getElementById('interaction-prompt');

    if (activeProject && !isModalOpen) {
        prompt.classList.remove('hidden');
    } else {
        prompt.classList.add('hidden');
    }
}

function openModal(project) {
    isModalOpen = true;
    const container = document.getElementById('modal-container');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerText = project.title;
    body.innerHTML = `<p>${project.description}</p>`;

    container.classList.remove('hidden');
}

function closeModal() {
    isModalOpen = false;
    document.getElementById('modal-container').classList.add('hidden');
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();

    if (bulli) {
        bulli.update(dt);
        checkProjectDistance();

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
