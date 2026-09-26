# Phase 1a: Fahrphysik v2 – verbindliche Spezifikation

**Stand:** 2026-09-23 · **Branch:** `refactor/phase-1a-driving` · **Flag:** v2 ist seit dem Livegang Standard, `?physics=legacy` schaltet die alte Physik zurück (Abschnitt 25) · Bezug: [`refactor-plan.md`](refactor-plan.md) Abschnitt 0, 5 (Phase 1a) und 6 (Netcode) · Blindtest: [`phase-1a-playtest.md`](phase-1a-playtest.md)

Dieses Dokument ist die eine verbindliche Grundlage für die Umsetzung von Phase 1a. Es ersetzt die beiden Entwürfe, aus denen es entstanden ist. Zahlen sind Startwerte für das Tuning; Struktur, Konventionen, Zustandsfelder und die Reihenfolge im Tick sind verbindlich, weil Phase 1b (Server-Sim, Prediction, Replay) darauf aufbaut.

**Rahmen (nicht verhandelbar):**

- Ohne `?physics=v2` verhält sich das Spiel exakt wie heute. Die Legacy-Physik in `Bulli.ts` bleibt, bis der Nutzer im Blindtest entschieden hat. Ihr Löschen ist **nicht** Teil dieses Laufs. *Überholt durch den Livegang (Abschnitt 25):* v2 ist Standard, die alte Physik gibt es nur noch mit `?physics=legacy`.
- Das Protokoll bleibt in 1a unverändert: Der Client sendet weiter `update` mit seiner Position. Gemischte Sessions (Legacy- und v2-Clients) funktionieren.
- `src/shared` importiert weder three noch DOM (Scan `tests/shared/purity.test.ts`). In der Sim gibt es kein `Math.random` und kein `Date.now`. Die Sim läuft mit festem Takt `DT = 1/60 s`.
- Maßstab 1 u = 1 m. Basis-Topspeed je Karosse 45–55 m/s, mit Boost ~70 m/s. Turbo darf darüber, mit harter Obergrenze.
- Desktop, Mobile/Touch und Gamepad sind gleichwertig.

---

## 1. Entscheidung

**Gewählt: Entwurf A, ein 2,5D-Einspurmodell (Bicycle) mit normierter Reifenkennlinie und drei Fahrassists.** Aus Entwurf B (Velocity-Alignment-Arcade) werden gezielt Einzelideen übernommen (Abschnitt 2).

### 1.1 Bewertung

| Kriterium | A: Einspurmodell | B: Velocity-Alignment | Gewicht |
|---|---|---|---|
| **Spielgefühl** | Drift, Eindrehen beim Anbremsen und Lastwechsel entstehen aus dem Reifenmodell. Klassen unterscheiden sich über Masse, Schwerpunkt, Grip und Antrieb spürbar. Risiko: mehr Parameter, Tuning braucht Disziplin. | Sehr zugänglich, aber „auf Schienen“: Die betragserhaltende Drehung des Geschwindigkeitsvektors kostet in Kurven kein Tempo, der Drift ist ein Zustandsautomat mit Soll-Schwimmwinkel. Wirkt schnell geskriptet. | hoch |
| **Touch** | Gut, aber nur durch Assists: tempoabhängiger Lenkeinschlag (Vollausschlag ≈ Schräglauf-Peak), Auto-Gegenlenken, Spin Guard, eigenes Profil „touch“. | Sehr gut: Drift mit β-Regelung kann nicht kippen, „enger/weiter“ statt Gegenlenken. | hoch |
| **Numerik bei DT = 1/60 und 70–85 m/s** | Im Prototyp stabil (siehe 1.2). Schwachstelle: wenig Gierdämpfung bei 85 m/s, und bei 5–6 m/s mit `gripScale` 1,5 gedämpfte Vorzeichenwechsel (Sport). Beides beherrschbar. | Stabil per Konstruktion (nur Zeitkonstanten erster Ordnung). | mittel |
| **Prediction/Reconciliation mit Rempeln** | Stoßimpulse erzeugen echte Quergeschwindigkeit und Gierrate, die das Reifenmodell physikalisch abbaut. Fast alle Zustände sind stetig. Die einzigen diskreten Zustände (grounded, Drift-Flag) beeinflussen die Kinematik kaum bzw. gar nicht. Gemessen: 0,1° Yaw- + 5 cm/s Querfehler ergeben nach 2 s 4–12 cm. | Die Gierrate wird mit kYaw = 10/s auf einen kinematischen Sollwert gezogen, ein PIT-Stoß ist nach ~0,1 s „vergessen“. B braucht dafür einen Stun-Zustand als Workaround. Der Drift-Automat hat mehrere Schwellen (Einstieg > 11 m/s, \|steer\| > 0,25, Gegenlenk-Zähler), die die **Kinematik** umschalten; knapp verfehlte Schwellen erzeugen divergierende Zweige und damit große Korrekturen. | sehr hoch (Entscheidung 2: Rempeln) |
| **Aufwand** | Etwas höher (Reifen, Lastverlagerung, Assists), aber ein lauffähiger Prototyp mit Messszenarien existiert bereits. | Etwas niedriger im Kern, aber Drift-Automat, Blending, Stun und Mini-Turbo summieren sich; die geforderte deterministische Trigonometrie (`detMath`) wäre Zusatzaufwand ohne Nutzen (Plan Abschnitt 6: Bitgleichheit nicht nötig). | mittel |

**Begründung in einem Satz:** Rempeln ist der Kern der Nutzerentscheidungen, und nur ein Modell, in dem Stöße echte Dynamik erzeugen und diskrete Zustände die Kinematik nicht umschalten, verträgt Prediction mit Kontakt gut; die Touch-Schwäche von A lässt sich mit Assists schließen, die „Schienen“-Schwäche von B nicht ohne Umbau.

### 1.2 Prototyp-Nachweis

Wegwerf-Prototyp in `/tmp/bulli-proto/sim.mjs` (nicht im Repo, nicht Teil der Lieferung). Gemessen am 2026-09-23 mit den Klassenwerten aus Abschnitt 9, `gripScale` = 1:

| Klasse | 0–100 km/h | vtop erreicht | Bremsweg vtop → 0 | Vollausschlag 20 m/s | Handbremsen-Kick 25 m/s |
|---|---|---|---|---|---|
| bulli | 3,52 s | 50,0 | 2,38 s / 58,7 m | R 21,1 m, 1,95 g | β max 25°, kein Dreher |
| pickup | 3,80 s | 47,0 | 2,48 s / 57,6 m | R 20,7 m | 22° |
| sport | 2,80 s | 55,0 | 2,20 s / 59,3 m | R 16,9 m, 2,44 g | 35° |
| beetle | 2,75 s | 48,0 | 2,18 s / 51,7 m | R 19,8 m | 35° |
| jeep | 3,17 s | 49,0 | 2,45 s / 59,3 m | R 19,8 m | 25° |

Zusätzlich geprüft (für diese Spezifikation): Stoß mit 1 m/s quer + 0,8 rad/s Gierrate klingt bei 50 und 70 m/s in < 1 s ab, bei 85 m/s in ~2 s (Restpendeln ≤ 0,26 rad/s, nicht anwachsend). Bei 5,5–10 m/s kein Pendeln; nur Sport mit `gripScale` 1,5 zeigt bei 5,5–6 m/s 2–3 gedämpfte Vorzeichenwechsel.

**Wichtig:** Der Prototyp weicht in einigen Konstanten vom Text des Entwurfs A ab (K_CS 0,5 statt 0,6, Spin-Guard-Schwelle 35° statt 30°, Boost-Schub 10 statt 14 m/s², Handbremsen-Erholung 0,35 s statt 0,25 s, Lastverlagerung mit Faktor 0,5). **Die Startwerte in dieser Spezifikation sind die gemessenen Prototyp-Werte.**

---

## 2. Übernahmen aus Entwurf B und Korrekturen an A

**Übernommen aus B:**

1. **Kollider-Treffer nach Index sortiert.** Das Ergebnis einer Grid-Abfrage hängt dann nicht von Zellen-Traversierung oder Abfragegröße ab (Client und Server können verschieden große AABBs abfragen).
2. **`base` pro Collider** (Bodenhöhe am Mittelpunkt, vorberechnet). Der Überflug-Test vergleicht die Unterkante des Autos mit `base + top` statt mit dem Boden unter dem Auto; das ist auf Hängen korrekt.
3. **Ghost-Ende im Gebäude:** Endet der Party-Ghost, während das Auto in einem statischen Collider steckt, bleibt die Weltkollision aus, bis das Auto frei ist (höchstens 180 Ticks). Kein Plopp durch halbe Gebäude.
4. **Rückwärts-Wartezeit:** Rückwärts erst nach 8 Ticks Bremse im Stand, sonst rollt man beim Anhalten ungewollt zurück.
5. **Pulse-Latch im InputManager:** Eine Tastenflanke zwischen zwei Ticks geht nicht verloren; sie wird bis zum nächsten Tick gehalten.
6. **Weicher 1a-Kontakt gegen Remote-Proxies:** e = 0 und 70 % Stärke (Regler), gegen Zittern durch 20-Hz-Updates.
7. **Akkumulator-Kappe pro Auto und Tick:** Σ\|Δv\| aus Kontakten ≤ 30 m/s (zusätzlich zur Δω-Kappe).
8. **Renn-Kamera:** niedriger (Höhe 4,8 m, Abstand 11 m; ursprünglich 5,5 m, siehe 12.5), Yaw im Drift zur Geschwindigkeitsrichtung geblendet.
9. **Visuelle Feder im Renderer** (nicht in der Sim): Nicken aus Längsbeschleunigung ≤ 4°, Rollen aus Querbeschleunigung ≤ 5°, Stauchen bei der Landung.
10. **Mini-Turbo** nach längerem Drift als optionaler Regler (Standard aus), statt als fester Bestandteil.
11. **Paritätstest der Collider** über `window.__bulliDebug` – in 1a für den Adapter, in 1b für die Portierung nach shared.

**Bewusst nicht übernommen aus B:** Drift-Zustandsautomat mit Soll-β (schaltet die Kinematik, schlecht für Reconciliation), Stun-Zustand (bei A unnötig, Stöße wirken physikalisch), `detMath` mit Polynom-Trigonometrie (Plan: Bitgleichheit nicht nötig; die Terrain-Sinussumme bleibt ohnehin engine-abhängig bis Phase 3), Powerup-Timer im `VehicleState` (Timer bleiben Party-Regel; die Sim bekommt pro Tick Booleans, siehe Abschnitt 10), 2 statt 3 Substeps.

**Korrekturen an Entwurf A:**

- **Vorzeichenfehler im Wand-Impuls:** A schreibt `jn = −(vn + min(e·(−vn), 3))/K`. Richtig ist `jn = (−vn + bounce)/K` mit `bounce = min(e·(−vn), 3)`, sodass die Normalgeschwindigkeit nach dem Stoß `+bounce` ist (bei A korrekt nur im Auto-Auto-Teil).
- Sprung 11 m/s statt 10 m/s (3,0 m Scheitel, 1,1 s Flug), näher am heutigen Party-Gefühl.
- Gedämpftes Hochtempo-Pendeln (siehe 1.2) bekommt einen Regler `yawDampHigh` (Standard 0), falls es im Playtest stört.
- Autos werden mit `<`/`>` nach ID sortiert, **nicht** mit `localeCompare` (locale-abhängig).

---

## 3. Konventionen und Einheiten

- SI-Einheiten: m, s, kg, rad. Geschwindigkeiten in m/s.
- Weltachsen wie heute: x/z Ebene, y oben.
- **vorwärts** `f = (sin yaw, cos yaw)`, **links** `l = (cos yaw, −sin yaw)` (wie `Bulli.ts:837`).
- `steer > 0` heißt links (wie A heute); `yaw` wächst dabei, Gierrate `r > 0` heißt links.
- 2D-Kreuzprodukte: `ω × r = (ω·r_z, −ω·r_x)`, Drehmoment `r × J = r_z·J_x − r_x·J_z`. (Herleitung: `d f/d yaw = l`, also dreht +ω die Nase nach links.)
- `u = v·f` Längs-, `w = v·l` Quergeschwindigkeit, Schwimmwinkel `β = u > 1 ? atan2(w, u) : 0`.
- Autoposition `(x, z)` = Schwerpunkt = Mitte zwischen den beiden Kollisionskreisen. `y` = Unterkante (am Boden gleich `groundHeight`).
- Alle Timer in der Sim zählen in Ticks.

Pflicht-Unit-Tests vor allem anderen (Abschnitt 14.1): Links lenken lässt yaw steigen; ein Stoß von rechts gegen die Nase dreht nach links; Handbremse plus Links ergibt β < 0 (Heck schwenkt nach außen).

---

## 4. Modulaufteilung

### 4.1 `src/shared` (kein three, kein DOM)

| Datei | Inhalt |
|---|---|
| `sim/constants.ts` | `SIM_HZ`, `DT`, `SUBSTEPS = 3`, `V_ABS = 85`, `V_SAFE = 90`, Button-Bits, globale Konstanten aus Abschnitt 6.1 als ein mutierbares Objekt `SIM_TUNING` (lil-gui schreibt hinein; Server nutzt die Defaults) |
| `sim/types.ts` | `VehicleInput`, `VehicleState`, `VehicleParams`, `VehicleModifiers`, `StepEvents`, `SimCar`; `createVehicleState`, `copyVehicleState`, `resetStepEvents` |
| `sim/tire.ts` | Reifenkennlinie `tireCurve(alpha, peak, slide)` |
| `sim/vehicleClasses.ts` | Die 5 Parametersätze (`VEHICLE_CLASSES: Record<CarClassId, VehicleParams>`), Assist-Profile |
| `sim/modifiers.ts` | `applyModifiers(base, mods, scale, out)` ohne Allokation |
| `sim/vehicle.ts` | `integrateForces` (Tick-Schritte 0–3), `finishTick` (Schritte 5–6), `resetVehicle`, `createSimCar`, `placeVehicle` |
| `sim/collision.ts` | Auto gegen Welt (zwei Kreise gegen Kreise/AABBs/Weltrand), Impulsantwort |
| `sim/contact.ts` | Auto gegen Auto (Kreispaare, Impuls, Positionskorrektur) |
| `sim/world.ts` | `stepWorld(cars, world)`: Sortierung, Reihenfolge, Substeps, Events; `stepVehicle` für ein einzelnes Auto (hier statt in `vehicle.ts`, sonst Importzyklus) |
| `sim/scenarios.ts` | Golden-Szenarien (Input-Skripte), `runScenario`, `recordScenario`; gemeinsam für Node-Tests und später die Sandbox im Browser |
| `world/colliders.ts` | `Collider`, `ColliderInput`, `COLLIDER_TOPS` (Tabelle 7.1), `RampDef`, `SpatialGrid` (CSR), `SimWorld`, `createSimWorld` |

`src/shared/sim/*` darf `world/terrain.ts` importieren (`getTerrainHeight`), aber nichts aus `client`.

### 4.2 Client

| Datei | Inhalt |
|---|---|
| `client/flags.ts` | `PHYSICS_V2 = new URLSearchParams(location.search).get('physics') === 'v2'`, einmal ausgewertet; `TUNE_PANEL` (`?tune=1`) |
| `client/game/loop.ts` | `FixedStepLoop` (Akkumulator, Render-Alpha), rein, ohne DOM, in Node testbar |
| `client/input/InputManager.ts` | Tastatur, Touch, Gamepad → quantisierter `VehicleInput` pro Tick; Aktionen (Schuss, Hupe) als Events |
| `client/input/gamepad.ts` | Standard-Mapping, radiale Deadzone, Kurve (reine Funktionen + Polling) |
| `client/vehicle/CarModel.ts` | Aus `Bulli.ts` extrahiert: `buildCar` und die fünf `build*`, VW-Logo, Augen, Lichter, Stoßstangen, Räder, Schild-Mesh, Ghost-Visual, `dispose`; neu `applyPose(pose, visual)` inkl. visueller Feder |
| `client/vehicle/Nametag.ts` | Aus `Bulli.ts` extrahiert: `createNametag`, `updateNametag`, `updateHealthBar` |
| `client/vehicle/LocalVehicle.ts` | v2: `SimCar` des eigenen Autos, `prev`/`curr`-Zustand, Interpolation, Legacy-Adapter (Abschnitt 12.3) |
| `client/vehicle/remoteProxies.ts` | v2: kinematische `SimCar`-Proxies aus `update`-Nachrichten (Abschnitt 8.5) |
| `client/vehicle/simWorldClient.ts` | `obstaclesToColliders(state.obstacles)` und `createSimWorld` nach dem Weltaufbau |
| `client/camera/ChaseCamera.ts` | Aus `main.ts:187–237` extrahiert (reines Refactoring) + v2-Profil „race“ |
| `client/entities/Bulli.ts` | Bleibt als Fassade (öffentliche Felder unverändert, weil `main.ts`/`websocket.ts` sie nutzen). Setzt sich aus `CarModel` + `Nametag` zusammen. Legacy-`update` unverändert; mit `PHYSICS_V2` delegiert der Bewegungsblock (`Bulli.ts:746–950`) an `LocalVehicle` |
| `client/sandbox/main.ts` + `sandbox.html` | Offline-Sandbox (eigener Vite-Einstieg): Rampen, Kurven, Wände, Dummy-Autos, Tuning-Panel. **Umgesetzt als `client/sandbox/sandbox.ts` hinter `?sandbox=1` auf der normalen Seite (Abschnitt 21)** |
| `client/debug/tuningPanel.ts` | lil-gui-Panel (dynamischer Import; nur Sandbox oder `?physics=v2&tune=1`) |
| `client/game/hooks.ts` | (neu, Abschnitt 21) Erweiterungspunkte für Sandbox und Panel: Welt-Ersatz, zusätzliche Sim-Autos, Hooks vor und nach dem Tick und pro Frame |

Neue Abhängigkeit: `lil-gui` (nur dynamisch importiert → eigener Chunk). Umgesetzt als devDependency wie `three`, weil Vite sie in den Client bündelt und das Server-Image sie nicht braucht (Abschnitt 21).

---

## 5. TypeScript-Interfaces

```ts
// src/shared/sim/constants.ts
export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;
export const SUBSTEPS = 3;
export const V_ABS = 85;    // m/s, Obergrenze inkl. Turbo + Boost (306 km/h)
export const V_SAFE = 90;   // m/s, Sicherheitsklemme auf |v|

export const BTN_HANDBRAKE = 1;
export const BTN_BOOST = 2;
export const BTN_JUMP = 4;    // flankengetriggert über prevButtons
export const BTN_RESET = 8;   // RESET_HOLD_TICKS halten
```

```ts
// src/shared/sim/types.ts
export type CarClassId = 'bulli' | 'pickup' | 'sport' | 'beetle' | 'jeep';
export type DriveLayout = 'rear' | 'all';
export type AssistProfile = 'standard' | 'touch';

// Quantisiert schon in 1a, damit Client und Server in 1b identische Werte rechnen
export interface VehicleInput {
    steer: number;      // int −127..127, + = links
    throttle: number;   // int 0..255
    brake: number;      // int 0..255; bremst, im Stand nach REVERSE_HOLD_TICKS rückwärts
    buttons: number;    // BTN_*-Bitmaske (gehaltener Zustand)
}

export interface VehicleState {
    // Pose (m, rad)
    x: number; y: number; z: number;   // y = Unterkante
    yaw: number;
    // Geschwindigkeit (Welt, m/s) und Gierrate (rad/s, + = links)
    vx: number; vy: number; vz: number;
    yawRate: number;
    // Filterzustände – gehören in den 1b-Snapshot, sonst weicht das Replay ab
    steerAngle: number;    // Radeinschlag δ (rad), begrenzte Stellrate
    loadX: number;         // tiefpassgefilterte Längsbeschleunigung (m/s²)
    rearGrip: number;      // 0..1, Handbremsen-Blend
    betaPrev: number;      // Schwimmwinkel des Vortick
    // Boden
    grounded: boolean;
    airTicks: number;      // Ticks seit Bodenverlust (Coyote, Luft-Füllung)
    // Gameplay
    boostMeter: number;    // 0..1
    boosting: boolean;
    driftTicks: number;    // > 0 solange Drift (Hysterese), nur Gameplay
    driftLowTicks: number; // Ticks unter der Ausstiegsschwelle
    wallTicks: number;     // Ticks seit letztem Wandkontakt (gesättigt bei 255)
    flipAngle: number;     // Salto (rad), 0 = kein Salto
    flipRate: number;      // rad/s, beim Absprung festgelegt
    jumpCooldown: number;  // Ticks
    resetHold: number;     // Ticks, die Reset gehalten wurde
    reverseHold: number;   // Ticks Bremse im Stand
    ghostTicks: number;    // Kontakt-Ghost nach Reset/Respawn (nur kein Auto-Kontakt)
    ghostExit: number;     // Ticks Weltkollision aus nach Party-Ghost-Ende im Collider
    wasGhost: boolean;     // Party-Ghost im Vortick
    scale: number;         // 1..MEGA_SCALE, gleitet
    prevButtons: number;   // Flankenerkennung
}

export interface VehicleParams {
    mass: number;           // kg
    wheelbase: number;      // L (m)
    cgFront: number;        // a/L
    cgHeight: number;       // m
    yawRadius: number;      // rg (m), Iz = m·rg²
    drive: DriveLayout;
    topSpeed: number;       // vtop (m/s), exakt bei Vollgas
    accel: number;          // A (m/s²) im Stand
    brakeDecel: number;     // m/s²
    gripFront: number; gripRear: number;          // μ (g)
    aeroGrip: number;       // Grip-Bonus bei vtop (0.25 = +25 %)
    slipPeakFront: number; slipPeakRear: number;  // rad
    slideFront: number; slideRear: number;        // Restgrip ab 2·α_peak
    handbrakeGrip: number;  // Heckgrip-Faktor bei gezogener Handbremse
    steerLock: number;      // δ0 (rad)
    steerFalloff: number;   // vS (m/s)
    driftFill: number;      // Klassenfaktor der Boost-Füllung
    offroadGrip: number; offroadDrag: number;     // erst ab Phase 3 wirksam
    colliderRadius: number; // r der zwei Kreise
    colliderOffset: number; // c: Kreismitten bei ±c entlang f
    jumpSpeed: number;      // m/s
    counterSteer: number;   // K_CS (Assist-Profil)
    spinGuardAngle: number; // β0 (rad) (Assist-Profil)
    contactMass: number;    // effektive Kontaktmasse (Mega/Schild), von applyModifiers gesetzt
    massRatioCap: number;   // R (1,8; Mega 3,5)
    restitutionWall: number;
}

export interface VehicleModifiers {
    turbo: boolean;
    mega: boolean;
    superJump: boolean;
    ghost: boolean;   // Party-Ghost: kein Auto-Kontakt UND keine Welt-Collider (Weltrand gilt)
    shield: boolean;  // Powerup-Schild oder Respawn-Schild
}

// Pro Tick zurückgesetzt und in place beschrieben (keine Allokation)
export interface StepEvents {
    wallImpact: number;     // max. Normalgeschwindigkeit in die Wand (m/s)
    wallX: number; wallZ: number;  // Kontaktpunkt des stärksten Wandtreffers
    carImpact: number;      // max. |Δv| durch Auto-Kontakt (m/s)
    carImpactId: string;    // Gegner des stärksten Kontakts ('' = keiner)
    landedImpact: number;   // vertikale Aufprallgeschwindigkeit
    jumped: boolean;
    boostStarted: boolean;
    drifting: boolean;
    reset: boolean;
}

export interface SimCar {
    id: string;
    state: VehicleState;
    input: VehicleInput;
    base: VehicleParams;         // Klasse + Assist-Profil
    params: VehicleParams;       // effektiv (applyModifiers schreibt hinein)
    mods: VehicleModifiers;
    kinematic: boolean;          // 1a: Remote-Proxy; Pose/Geschwindigkeit extern gesetzt
    contactScale: number;        // 1 für echte Autos; 1a-Proxies: Impuls nur auf den Partner
    events: StepEvents;
    contactDv: number;           // Akkumulatoren der Kontakt-Kappen (Σ|Δv|, Σ|Δω|), von stepWorld pro Tick genullt
    contactDw: number;
}
```

```ts
// src/shared/sim/vehicle.ts / world.ts
export function stepWorld(cars: SimCar[] /* wird in place nach id sortiert */, world: SimWorld): void;
export function stepVehicle(car: SimCar, world: SimWorld): void; // = stepWorld([car], world), in world.ts
export function resetVehicle(s: VehicleState, p: VehicleParams, world: SimWorld): void;
```

Zustand und Params sind reine Objekte. Die Sim mutiert in place. Die Prediction-Historie (1b) und die Render-Interpolation kopieren mit `copyVehicleState(dst, src)`.

---

## 6. Algorithmus pro Tick

### 6.1 Globale Konstanten (Startwerte, alle im Tuning-Panel)

| Gruppe | Konstante | Wert |
|---|---|---|
| Gravitation | `GRAVITY` (Aufbau, am Boden und im Flug, Arcade ≈ 2 g; bis Abschnitt 26 `G_AIR`) / `G_SLOPE` (Hangabtrieb) / `G_TIRE` (für Fz) | 20 / 9,81 / 9,81 m/s² |
| Federung (26) | `SUSP_FREQ` / `SUSP_DAMPING` / `SUSP_TRAVEL` | 2 Hz / 0,8 / 0,25 m (bis Abschnitt 26: `STICK` 8 m/s², `AIR_GAP` 0,15 m, `COYOTE_TICKS` 6) |
| Niedriges Tempo | `V_LOW` (kinematische Überblendung und Slip-Nenner) | 5 m/s |
| Widerstand | `ROLL` / `C_AIR` / `ENGINE_BRAKE` / `OVERSPEED` | 0,4 m/s² / 0,0006 1/m / 1,5 m/s² / 0,5 1/s |
| Antrieb | `DRIVE_EXP` / `GRIP_CIRCLE` | 2,5 / 0,6 |
| Rückwärts | `REV_TOP` / `REV_ACCEL` / `REVERSE_HOLD_TICKS` | 15 m/s / 6 m/s² / 8 |
| Handbremse | `HB_DECEL` (nur ohne Gas) / Abfall / Erholung | 5 m/s² / 0,08 s / 0,35 s |
| Lastverlagerung | `LOAD_GAIN` / τ / max. hinten (Gas) / max. vorne (Bremse) | 0,5 / 0,08 s / +20 % Fz / 10 % Fz |
| Lenkung | `STEER_RATE_IN` / `STEER_RATE_OUT` | 3,5 / 5 rad/s |
| Assists | `K_SPIN` / `K_BD` / β-Dämpfung ab | 15 1/s² / 6 / 15° |
| Grenzen | `R_MAX` / `V_ABS` / `V_SAFE` | 6 rad/s / 85 / 90 m/s |
| Boost | `BOOST_ACCEL` / `BOOST_ADD` / Verbrauch / Startschwelle | 10 m/s² / +20 m/s / 0,45 /s / 0,15 |
| Drift-Füllung | `DRIFT_FILL` / `AIR_FILL` | 0,35 /s / 0,10 /s |
| Luft (26) | `AIR_YAW_RESPONSE` / `AIR_ALIGN` | 3 1/s / 2 1/s (bis Abschnitt 26: `AIR_YAW` 1,5 rad/s, Sprung-Cooldown 20 Ticks) |
| Reset | `RESET_HOLD_TICKS` / `RESET_GHOST_TICKS` | 30 / 120 |
| Global | `gripScale` / `yawDampHigh` / `driftReleaseKick` | 1,0 / 0 / 0 m/s |

Assist-Profile (in 1b Teil der serverseitig bekannten Spieler-Settings):

| Profil | `counterSteer` K_CS | `spinGuardAngle` β0 |
|---|---|---|
| standard | 0,5 | 35° |
| touch | 0,7 | 30° |

### 6.2 Reifenkennlinie

```
x = |α| / α_peak
f(α) = sign(α) · (x ≤ 1 ? x : 1 − (1 − slide) · min(x − 1, 1))
```

Linear bis zum Peak, danach leichter Abfall bis 2·α_peak, dann konstant. Kein Abfall auf 0, kein Vorzeichenwechsel.

### 6.3 `stepWorld(cars, world)`

```
sortiere cars in place nach id (Insertion-Sort mit <)
für jedes car (Reihenfolge = aufsteigende id):
    resetStepEvents(car.events); contactDv = contactDw = 0
    applyModifiers(car.base, car.mods, car.state.scale, car.params)
    wenn !car.kinematic: integrateForces(car, world)           // Schritte 0–3

für k in 1..SUBSTEPS:                                           // Schritt 4
    für jedes car: x += vx·DT/3; z += vz·DT/3; yaw += yawRate·DT/3
    für jedes nicht-kinematische car: resolveWorld(car, world)  // 7.3, 2 Iterationen
    2×: für alle Paare (i < j) in fester Reihenfolge: resolveContact(car_i, car_j)   // 8

für jedes nicht-kinematische car: finishTick(car, world)        // Schritte 5–6
```

### 6.4 `integrateForces` (Schritte 0–3)

```
0  Eingabe
   st = steer/127, th = throttle/255, br = brake/255
   pressed = buttons & ~prevButtons; prevButtons = buttons
   HB = buttons & BTN_HANDBRAKE
   Reset: resetHold = (buttons & BTN_RESET) ? resetHold + 1 : 0
          bei resetHold == RESET_HOLD_TICKS: resetVehicle(); ev.reset = true; return
   u = v·f, w = v·l (aus vx, vz); β = u > 1 ? atan2(w, u) : 0
   h, ∇h = ground(x, z), Zentraldifferenz ±0,5 m (world.groundHeight: max(Terrain, Rampen))

1  (Sprung: entfällt seit Abschnitt 26)

2  wenn grounded:
   2a Lenkung
       δmax = δ0 / (1 + |u| / vS)
       δT = st·δmax
       wenn u > 5 && |β| > 5°: δT += K_CS·β·(1 − 0,5·max(0, −st·sign β))    // Gegenlenk-Hilfe
       δT = clamp(δT, ±δ0); rate = |δT| < |δ| ? STEER_RATE_OUT : STEER_RATE_IN
       δ += clamp(δT − δ, ±rate·DT)
   2b Achslasten
       Fz = m·G_TIRE; a = L·cgFront; b = L − a
       dF = clamp(LOAD_GAIN·m·loadX·h_cg/L, −0,10·Fz, +0,20·Fz)
       FzF = Fz·b/L − dF; FzR = Fz·a/L + dF
   2c Längsrichtung
       vtopE = P.topSpeed; xs = |u| / vtopE; drag = ROLL + C_AIR·u²
       aDrive = (th > 0 && u > −0,5) ? th·(A·max(0, 1 − min(xs,1)^DRIVE_EXP) + (xs < 1 ? drag : 0)) : 0
                // Antrieb gleicht den Widerstand unter vtop aus: vtop ist exakt, halbes Gas = Reisetempo
       aBrake = 0
       wenn br > 0:
           wenn u > 0,5: aBrake = br·brakeDecel; reverseHold = 0
           sonst: reverseHold++;
                  wenn reverseHold ≥ REVERSE_HOLD_TICKS:
                      aDrive −= br·(REV_ACCEL·(1 − max(0, −u)/REV_TOP) + drag)
                  sonst aBrake = br·brakeDecel
       sonst reverseHold = 0
       vRef = boosting ? min(vtopE + BOOST_ADD, V_ABS) : vtopE
       wenn boosting && u > 0: aDrive += BOOST_ACCEL·clamp((vRef − u)/10, 0, 1) + (xs ≥ 1 && u < vRef ? drag : 0)
                // Umsetzung: Ziel vRef statt vtopE + BOOST_ADD und Widerstandsausgleich über vtop (Abschnitt 19)
       wenn th > 0 && u < −0,5: aBrake += th·brakeDecel           // Gas beim Rückwärtsrollen bremst (Abschnitt 19)
       aResist = drag + (th == 0 && br == 0 ? ENGINE_BRAKE : 0) + max(0, |u| − vRef)·OVERSPEED
       rearGrip = HB ? max(hbGrip, rearGrip − DT/0,08) : min(1, rearGrip + DT/0,35)
       wenn HB && th < 0,1: aBrake += HB_DECEL
       Fx = m·aDrive; FxR, FxF = (drive == 'rear') ? (Fx, 0) : (Fx/2, Fx/2)
       // Bremse und Handbremse gehen nicht in den Grip-Kreis ein; Übersteuern beim
       // Anbremsen kommt allein aus der Lastverlagerung
   2d Querrichtung
       aero = 1 + aeroGrip·min(1, (|v| / vtop_base)²)          // vtop_base = Klasse ohne Turbo
       capF = gripScale·gripFront·aero·FzF
       capR = gripScale·gripRear·aero·rearGrip·FzR
       circX = sqrt(max(0,1, 1 − (GRIP_CIRCLE·FxX/capX)²))
       uu = max(|u|, V_LOW); sgn = u < −0,5 ? −1 : 1
       αF = atan2(w + a·r, uu) − δ·sgn;  αR = atan2(w − b·r, uu)
       FyF = −capF·circF·f(αF);  FyR = −capR·circR·f(αR)
   2e Körperkräfte
       Fu = FxR + FxF·cosδ − FyF·sinδ;  Fw = FyR + FyF·cosδ + FxF·sinδ
       τ = a·(FyF·cosδ + FxF·sinδ) − b·FyR;  I = m·rg²
       wenn |β| > β0:            τ += K_SPIN·I·sign β·(|β| − β0)           // Spin Guard
       wenn u > 5 && |β| > 15°:  τ += K_BD·I·(β − betaPrev)/DT             // β-Dämpfung
       wenn yawDampHigh > 0 && u > 50: τ −= yawDampHigh·I·(r − u·tanδ/L)·(u − 50)/35
       betaPrev = β
       Hangabtrieb: au_s = −G_SLOPE·(∇h·f); aw_s = −G_SLOPE·(∇h·l)
   2f Integration im Fahrzeugsystem (semi-implizit)
       u' = u + (Fu/m + au_s)·DT
       u' −= sign(u')·min(|u'|, (aBrake + aResist)·DT)     // Bremse/Widerstand kehren nie um
       w' = w + (Fw/m + aw_s)·DT
       loadX += ((u' − u)/DT − loadX)·(1 − e^(−DT/0,08))
       r' = r + τ/I·DT
       k = clamp(1 − |(u', w')|/V_LOW, 0, 1)                // kinematische Überblendung (Gesamttempo, 23.2)
       r' += (u'·tanδ/L − r')·k;  w' −= w'·k·min(1, 10·DT)
       wenn |u'| < 0,05 && th == 0 && br == 0: u' = 0; wenn |w'| < 0,05: w' = 0
       yawRate = clamp(r', ±R_MAX); (vx, vz) = f·u' + l·w'; |v_xz| ≤ V_SAFE

3  sonst (Luft, Abschnitt 26):
       yawRate += (AIR_ALIGN·β − yawRate)·min(1, AIR_YAW_RESPONSE·DT)   // kein Lenken, Landehilfe
       v_xz ·= 1 − C_AIR·|v|·DT                                          // kein Antrieb, keine Bremse, kein Boost
       betaPrev = β; rearGrip wie in 2c (Abschnitt 19)
       airTicks++
       // Gravitation und Höhe: stepVertical in den Substeps (Abschnitt 26)
```

Der Handbremsen-Grip `hbGrip` ist `P.handbrakeGrip`. Die Drift-Release-Hilfe (`driftReleaseKick`, Standard 0) addiert beim Driftende nach ≥ 72 Ticks einmalig `+kick` auf u, höchstens bis vtopE.

### 6.5 Schritt 4: Bewegung

In `stepWorld`, 3 feste Substeps (6.3). Die Anzahl hängt weder vom Tempo noch von der Anzahl der Autos ab; Client-Replay und Server nehmen so denselben Weg.

### 6.6 `finishTick` (Schritte 5–6)

```
5  Boden und Vertikale: seit Abschnitt 26 in jedem Substep (`stepVertical`) mit Feder und
   Dämpfer statt des Einrastens auf den Boden. Die frühere Fassung (Einrasten, `STICK`,
   `AIR_GAP`, Abhebe-Deckel „vy des Bodens voraus + 2 m/s“, Salto) steht in Abschnitt 26.1.

6  Drift, Boost, Timer
   drift an: grounded && u > 8 && |β| > 10° → driftTicks++ , driftLowTicks = 0
   drift hält, solange |β| ≥ 6°; darunter driftLowTicks++; bei 10 → driftTicks = 0
   ev.drifting = driftTicks > 0
   fill = DRIFT_FILL·driftFill·clamp((|β| − 10°)/15°, 0, 1)·clamp((u − 8)/12, 0, 1)
   wenn wallTicks < 20: fill = 0                        // Schrubben an der Wand zählt nicht
   wenn !grounded && airTicks > 18: fill += AIR_FILL
   boostMeter = min(1, boostMeter + fill·DT)
   wasBoosting = boosting
   boosting = (buttons & BTN_BOOST) && u > 0 && (boosting ? boostMeter > 0 : boostMeter ≥ 0,15)
   ev.boostStarted = boosting && !wasBoosting
   wenn boosting: boostMeter = max(0, boostMeter − 0,45·DT)
   ghostTicks, ghostExit herunterzählen (≥ 0); wallTicks = min(255, wallTicks + 1)
   scale += ((mods.mega ? MEGA_SCALE : 1) − scale)·(1 − e^(−6·DT))
   wasGhost = mods.ghost
```

### 6.7 Reset

`resetVehicle` (ersetzt die tote Recovery-Logik `canRecover`):

1. `vx = vy = vz = yawRate = steerAngle = loadX = 0`, `rearGrip = 1`, `betaPrev = 0`, `flipAngle = flipRate = 0`, `driftTicks = 0`, `boosting = false`. Yaw bleibt.
2. `y = groundHeight(x, z)`, `grounded = true`.
3. Aus allen statischen Collidern schieben (bis 8 Iterationen der Positionskorrektur aus 7.3, ohne Impuls).
4. `ghostTicks = RESET_GHOST_TICKS` (2 s kein Auto-Kontakt).

Der Client zeigt den HUD-Hinweis „R halten zum Zurücksetzen“, wenn seit 60 Ticks durchgehend `th > 0,5`, `|u| < 1` und Wandkontakt (`wallTicks < 2`) gelten. Ein Teleport durch den Server (Respawn im Party-Modus) ruft `LocalVehicle.teleport(x, z, yaw)` auf, das ebenfalls `resetVehicle` nutzt.

---

## 7. Weltkollision

### 7.1 Daten (`src/shared/world/colliders.ts`)

```ts
export type Collider =
    | { kind: 'circle'; x: number; z: number; r: number; base: number; top: number }
    | { kind: 'box'; x: number; z: number; hw: number; hd: number; base: number; top: number }; // achsparallel

export interface RampDef { x: number; z: number; yaw: number; width: number; length: number; height: number }

export interface SimWorld {
    terrain: TerrainConfig;
    colliders: Collider[];       // Index = deterministische Reihenfolge
    grid: SpatialGrid;
    ramps: RampDef[];
    bound: number;               // terrain.size/2 − 2 = 498 (wie Bulli.ts:888)
    groundHeight(x: number, z: number): number;   // max(getTerrainHeight, Rampen)
}

export function createSimWorld(terrain: TerrainConfig, colliders: ColliderInput[], ramps: RampDef[]): SimWorld;
```

`base` berechnet `createSimWorld` aus `groundHeight` am Mittelpunkt. `top` ist die Höhe der Oberkante über `base`. Ein Collider wird übersprungen, wenn die Unterkante des Autos `y ≥ base + top` ist. Das ersetzt das heutige „airborne > 1 m ignoriert alles“ (`Bulli.ts:844`). Auf niedrigen Collidern (endliches `top`, keine Rampenwand) kann man landen: War die Unterkante zu Tickbeginn auf oder über der Oberkante und überlappt ein Kreis den Collider, ist dessen Oberkante der Boden. *Geändert nach dem Review (23.1);* vorher hieß es hier „man kann nicht auf Collidern landen, die Auflösung schiebt das Auto seitlich heraus“, und dieser Push-out versetzte das Auto um bis zu 8 m in einem Tick.

| Collider (Quelle) | Form | top |
|---|---|---|
| Gebäude (`city.ts:738`) | box | ∞ |
| Bank (`city.ts:837`, r 1,7) | circle | 1,2 m |
| Parkteich mit Steinrand (`city.ts:874`, r 5,7) | circle | 0,8 m |
| Parkbaum, Palme (`city.ts:904/937`) | circle | ∞ |
| Laterne (`city.ts:973`) | circle | 5,5 m |
| Schilderpfosten (`city.ts:1043`, r 0,35) | circle | 3,3 m |
| Pflanzkübel (`city.ts:1184`) | circle | 1,0 m |
| Sonnenschirm (`city.ts:1204`) | circle | 2,8 m |
| Brunnen (`city.ts:1208`, r 5) | circle | 1,5 m |
| Baum außerhalb (`environment.ts:134`) | circle | ∞ |
| Fels (`environment.ts:170`) | circle | 0,9 × rockSize |

### 7.2 Herkunft in 1a

- `Obstacle` in `client/types.ts` bekommt ein optionales Feld `top`. Die `push`-Stellen in `city.ts` und `environment.ts` setzen es nach der Tabelle. Legacy ignoriert das Feld (verhaltensneutral).
- `client/vehicle/simWorldClient.ts` baut nach dem Weltaufbau (`init`) einmal `createSimWorld(state.terrainConfig, obstaclesToColliders(state.obstacles), [])`.
- In 1b braucht der Server dieselben Collider. Die Platzierung ist schon deterministisch (cityGen, `mulberry32(SCENERY_SEED)`, `positionHash`) und wird dann nach `shared/world` verschoben, abgesichert durch einen Paritätstest gegen `window.__bulliDebug.obstacles()`. **Nicht Teil von 1a.** Zwei Punkte dafür aus dem Review (Abschnitt 18): Die Felsen ziehen Position und Größe aus demselben Zufallsstrom wie ihre rein optischen Werte, und die Reihenfolge der Collider ist ergebnisrelevant.
- Rampen gibt es nur in der Sandbox. Seiten und Rückseite jeder Rampe bekommen Box-Collider mit `top` = Rampenhöhe an dieser Kante, damit man nicht von hinten „hochpoppt“. Der Überflug-Test nutzt eine Höhe für das ganze Auto (Unterkante am Schwerpunkt); ein Collider direkt an der Absprungkante würde abspringende Autos streifen. **Gelöst im Sandbox-Schritt** mit `rampEdgeColliders` und einer eigenen Regel für Rampenwände (Abschnitt 21, Punkt 3). `createSimWorld` selbst legt keine Wände an; die Sandbox gibt sie als Collider mit.

### 7.3 SpatialGrid und Auflösung

**Grid:** Zellen 16 m, Ursprung −512, 64 × 64 Zellen, CSR-Aufbau (`cellStart: Int32Array`, `items: Int32Array`), einmal gebaut, statisch. `query(minX, minZ, maxX, maxZ, out: Int32Array): number` dedupliziert über ein Stamp-Array und **sortiert die Treffer aufsteigend nach Index** (Insertion-Sort, typisch < 20). Keine Allokation.

**Auto-Form:** zwei Kreise mit Mitte `p ± c·f`, Radius `r` (Klasse, ×scale bei Mega). Abfrage-AABB: `p ± (c + r)·scale + 0,5`.

**Tunneling:** Bei 85 m/s sind es 0,47 m pro Substep. Kleinster Collider (Pfosten, r 0,35) plus kleinster Autokreis (Käfer, r 1,1) = 1,45 m. Die Eindringtiefe bleibt immer kleiner als der Radius, der Push-out geht nie zur falschen Seite. Kein Swept-Test nötig. Bedingung für Sandbox-Wände: halbe Dicke ≥ 0,25 m. Das gilt für die horizontale Annäherung; von oben auf einen niedrigen Collider landet das Auto (7.1, 23.1).

**Pro Substep und Auto, 2 Iterationen** (Party-Ghost oder `ghostExit > 0`: nur Weltrand):

1. Für jeden Kandidaten (Indexreihenfolge) den tieferen der beiden Autokreise bestimmen:
   - Kreis–Kreis: `n = (p − c_o)/|…|`, `pen = r + r_o − d`.
   - Kreis–Box: `q = clamp(p, min, max)`, `d = p − q`; bei `|d| > 0`: `n = d/|d|`, `pen = r − |d|`. Liegt der Mittelpunkt in der Box (Spawn, wachsendes Mega): Achse mit der kleinsten Eindringtiefe, bei Gleichstand x vor z.
2. Positionskorrektur: `p += n·(pen + 0,001)`.
3. Impulsantwort (Wand unendlich schwer), Kontaktpunkt `p_c = Kreismitte − n·r`, Hebel `r_c = p_c − p_cg`:
   ```
   v_p = v + ω × r_c;  vn = v_p·n;  nur wenn vn < 0:
   K = 1/m + (r_c × n)²/I
   bounce = min(e·(−vn), 3 m/s)          // e = restitutionWall: 0,15, Schild 0
   jn = (−vn + bounce)/K
   t = normalize(v_p − vn·n); Kt = 1/m + (r_c × t)²/I
   jt = −min(|v_p·t|/Kt, μw·jn)          // μw = 0,15
   J = jn·n + jt·t
   v += J/m;  ω += clamp((r_c × J)/I, ±2,5 rad/s)
   ev.wallImpact = max(ev.wallImpact, −vn); wallTicks = 0
   ```
4. Weltrand ±498: vier Ebenen mit demselben Impuls-Code.
5. **Ghost-Ende:** Wird `mods.ghost` falsch, während `wasGhost` wahr ist und ein Collider überlappt, setzt die Sim `ghostExit = 180`; solange `ghostExit > 0` bleibt die Weltkollision aus, und sobald keine Überlappung mehr besteht, wird `ghostExit = 0`.

**Wirkung (statt `speed × −0,5`):** Streifschuss mit 10° bei 50 m/s: vn ≈ 8,7 wird zu +1,3, Tangentialverlust ≤ ~1,5 m/s; das Auto gleitet mit ~48 m/s weiter, und der Hebel am vorderen Kreis dreht die Nase zur Wand parallel. Frontal mit 50 m/s: Rückprall 3 m/s, kaum Drehung.

**Sound und Partikel:** Die heutigen Schwellen 0,125 bzw. 0,2 u/Tick entsprechen `wallImpact` > 7,5 bzw. 12 m/s; Partikel am Punkt `ev.wallX/wallZ`.

---

## 8. Auto-Auto-Kontakt (`sim/contact.ts`)

### 8.1 Paarsuche

Alle Paare `i < j` in der nach ID sortierten Liste. Grobfilter über Hüllkreise `|p_i − p_j| < (c_i + r_i)·s_i + (c_j + r_j)·s_j`. Bei 32 Autos sind das 496 billige Tests; ein Grid erst bei Bedarf. Übersprungen wird ein Paar, wenn

- eines der Autos `mods.ghost` oder `ghostTicks > 0` hat,
- beide kinematisch sind,
- `|y_i − y_j| > 1,4·max(scale_i, scale_j)` (über ein Auto drüberspringen).

### 8.2 Engphase und Impuls

Die 4 Kreispaare in fester Reihenfolge `(i0,j0), (i0,j1), (i1,j0), (i1,j1)` testen und das tiefste nehmen. `n` zeigt von j nach i, `pen = r_i + r_j − d`, Kontaktpunkt `p_c` auf der Verbindungslinie am Rand von j plus `pen/2`.

```
rA = p_c − p_i, rB = p_c − p_j
v_rel = (v_i + ω_i × rA) − (v_j + ω_j × rB);  vn = v_rel·n;  nur wenn vn < 0
m_i', m_j' = contactMass (Mega ×3, Schild ×2), dann Verhältnis gedeckelt:
             m_schwer' = min(m_schwer', R·m_leicht'), R = max(massRatioCap_i, massRatioCap_j)  (1,8; Mega 3,5)
I = m'·rg²
K = 1/m_i' + 1/m_j' + (rA × n)²/I_i + (rB × n)²/I_j
bounce = min(e·(−vn), 4 m/s), e = 0,25
jn = (−vn + bounce)/K                 // Stoppen ungedeckelt, nur der Rückprall ist begrenzt
t = normalize(v_rel − vn·n); Kt analog mit t
jt = −min(|v_rel·t|/Kt, μc·jn), μc = 0,3
J = jn·n + jt·t
v_i += J/m_i';  v_j −= J/m_j'
ω_i += (rA × J)/I_i;  ω_j −= (rB × J)/I_j
```

**Kappen pro Auto und Tick** (Akkumulatoren, pro Tick zurückgesetzt): Σ\|Δω\| ≤ 2,5 rad/s, danach \|ω\| ≤ R_MAX; Σ\|Δv\| ≤ 30 m/s. Der Impuls hat **keine Vertikalkomponente**, `y` und `vy` werden nie berührt: kein Wegschleudern in die Luft.

**Positionskorrektur:** `corr = max(0, pen − 0,01)·0,8`, aufgeteilt proportional zu `1/m'`, je Auto und Substep höchstens 0,5 m.

`ev.carImpact = max(…, |J|/m')`, `ev.carImpactId` = Gegner. Daraus werden Sound und Partikel, in 1b der Party-Schaden (Mega-Ram aus dem Impuls).

### 8.3 Reihenfolge und Determinismus

Pro Substep: erst alle Weltkollisionen in ID-Reihenfolge, dann alle Paare in (i, j)-Reihenfolge, 2 Iterationen. Kein Iterieren über `Set`/`Map` mit Netz-Einfügereihenfolge. Sortierung der IDs mit `<`, nicht `localeCompare`.

### 8.4 Plausibilitätsbeispiele (Bulli 1500 kg, rg 1,35 m → I = 2734 kg·m²)

- **Frontal**, beide 50 m/s: vn = −100 → beide stoppen und prallen mit je ~2 m/s zurück. Weil jedes Auto 52 m/s Δv braucht, verteilt die Σ\|Δv\|-Kappe (30 m/s) das auf zwei Ticks (gemessen: 50 → 20 → −2 m/s).
- **Auffahren** 45 gegen 40 m/s: bounce 1,25 → der Vordere wird ~3,1 m/s schneller.
- **PIT** am Heck mit 1,5 m Hebel: Der Getroffene bekommt ≤ 2,5 rad/s Drehung und bricht aus; Spin Guard und Gegenlenk-Hilfe fangen ihn in ~1 s wieder, wenn der Spieler mitlenkt.
- **Pickup (2000 kg) gegen Käfer (900 kg)**: Verhältnis 2,2 → gedeckelt auf 1,8. Schwere Klassen schieben mehr, aber nicht beliebig.

### 8.5 1a mit echten Mitspielern: kinematische Proxies

Protokoll unverändert, deshalb halbseitiger Kontakt:

- `remoteProxies.ts` hält pro Remote-Spieler ein `SimCar` mit `kinematic = true`.
- **Pose:** letzte `update`-Position, extrapoliert mit der geschätzten Geschwindigkeit um höchstens 100 ms. `y` = Terrainhöhe + gemeldetes `y`.
- **Geschwindigkeit:** aus den letzten zwei `update`s (Δt aus Empfangszeit, mindestens 30 ms), EMA 0,5, \|v\| ≤ V_SAFE; Gierrate analog, \|ω\| ≤ R_MAX.
- **Masse** aus `carType`, Mega aus `scale > 1,5`, Schild aus `shieldActive`, `ghostActive` → kein Kontakt.
- Der Impuls wird voll berechnet, als wären beide dynamisch, aber **nur auf das lokale Auto** angewendet, mit `e = 0` und Stärke `proxyContactScale = 0,7`. Die Positionskorrektur trägt zu 100 % das lokale Auto (≤ 0,5 m pro Substep).
- Legacy-Clients kollidieren nicht mit Autos; v2-Clients prallen von ihnen ab. Der andere v2-Client rechnet dasselbe aus seiner Sicht: annähernd symmetrisches Rempeln.
- Die Darstellung der Remote-Autos bleibt in 1a wie heute (`websocket.ts:442`). Interpolation und Extrapolation im Kontaktradius kommen in 1b.
- Der Legacy-Mega-Ram (`main.ts:295–315`, Abstandstest → `shoot`) bleibt unverändert; der physische Schub kommt zusätzlich aus dem Kontakt.

**Dummy-Autos in der Sandbox** sind volle Sim-Autos (`kinematic = false`) mit geskriptetem Input (stehen, geradeaus, Kreis). Daran hängen die Golden-Tests.

---

## 9. Parametertabelle der fünf Karossen

Maße aus `Bulli.ts` (`const width/length`; Radstand = 2·wheelZ aus `addWheels`). Kollisionskreise `r = B/2 − 0,1`, `c = L/2 − r`.

| Parameter | bulli | pickup | sport | beetle | jeep |
|---|---|---|---|---|---|
| Karosse B × L (m) | 2,8 × 4,0 | 3,0 × 5,0 | 2,6 × 4,5 | 2,4 × 3,5 | 3,0 × 4,2 |
| Masse (kg) | 1500 | 2000 | 1200 | 900 | 1750 |
| Radstand L (m) | 2,4 | 3,2 | 2,8 | 2,0 | 2,8 |
| cgFront a/L | 0,55 | 0,45 | 0,52 | 0,58 | 0,48 |
| cgHeight (m) | 0,9 | 0,8 | 0,5 | 0,6 | 0,9 |
| Trägheitsradius rg (m) | 1,35 | 1,6 | 1,3 | 1,05 | 1,4 |
| Antrieb | hinten | hinten | hinten | hinten | Allrad 50/50 |
| **vtop (m/s / km/h)** | **50 / 180** | **47 / 169** | **55 / 198** | **48 / 173** | **49 / 176** |
| Boost-Ziel vtop + 20 (m/s) | 70 | 67 | 75 | 68 | 69 |
| accel A (m/s²) | 8,5 | 8,0 | 10,5 | 11,0 | 9,5 |
| brakeDecel (m/s²) | 20 | 18 | 24 | 21 | 19 |
| grip vorne / hinten (g) | 2,1 / 2,2 | 2,0 / 2,3 | 2,5 / 2,6 | 2,3 / 2,3 | 2,1 / 2,2 |
| aeroGrip bei vtop | +25 % | +20 % | +35 % | +25 % | +20 % |
| α_peak vorne / hinten (°) | 7 / 6 | 7,5 / 6 | 6 / 5,5 | 7 / 6 | 9 / 8 |
| Restgrip vorne / hinten | 0,92 / 0,80 | 0,92 / 0,85 | 0,92 / 0,80 | 0,92 / 0,75 | 0,94 / 0,85 |
| handbrakeGrip | 0,45 | 0,50 | 0,42 | 0,42 | 0,50 |
| steerLock δ0 (°) | 32 | 30 | 31 | 34 | 32 |
| steerFalloff vS (m/s) | 16 | 16 | 17 | 15 | 16 |
| driftFill | 1,0 | 0,9 | 1,0 | 1,15 | 0,9 |
| offroad Grip / +Roll (ab Phase 3) | 0,90 / +0,8 | 0,92 / +0,6 | 0,85 / +1,0 | 0,90 / +0,8 | 1,00 / +0,2 |
| Kollision r / c (m) | 1,3 / 0,7 | 1,4 / 1,1 | 1,2 / 1,05 | 1,1 / 0,65 | 1,4 / 0,7 |

Mittelwert vtop 49,8 m/s (179 km/h). (`jumpSpeed` 11 m/s für alle Klassen entfiel mit dem Sprung, Abschnitt 26.) Stabilitätskennzahl α_peak/μ ist vorne größer als hinten: alle Klassen untersteuern im Grenzbereich leicht (Bulli 3,33 gegen 2,73 °/g).

**Charakter:** Bulli ausgewogen, durch Heckmotor leicht verspielt · Pickup schwer und stabil, schiebt am meisten · Sport schnell und griffig, driftet tief · Käfer leicht, beschleunigt am besten, driftfreudig, wird weggeschubst · Jeep Allrad, driftet flach, kaum Offroad-Nachteil (falls zu zahm: handbrakeGrip 0,45).

---

## 10. Powerup-Modifikatoren (`sim/modifiers.ts`)

`applyModifiers(base, mods, scale, out)` schreibt die effektiven Params in ein wiederverwendetes Objekt. Die Timer bleiben Party-Regel: In 1a zählt der Client `Bulli.powerups[*].timer` im v2-Pfad **pro Sim-Tick um DT** herunter (nicht pro Frame), und während die Sim eingefroren ist (12.1) pro Frame, damit sie wie bei Legacy auch dann ablaufen (23.3); in 1b macht das der Server (Dauer in Ticks = `POWERUP_DURATIONS_MS/1000·60`). Die Sim bekommt pro Tick nur `VehicleModifiers`; in 1b gehören die Mods deshalb pro Tick in die Input-Historie.

| Powerup | heute (Legacy) | v2 |
|---|---|---|
| **Turbo** (`speed`) | Beschleunigung und Topspeed ×1,8 (108 m/s) | `topSpeed ×1,3`, `accel ×1,5`. Mit Boost: `min(vtop·1,3 + 20, V_ABS = 85 m/s = 306 km/h)`. Bulli 65 / 85, Sport 71,5 / 85. `aeroGrip` bezieht sich auf das Basis-vtop und ist bei 1 gedeckelt: Turbo schenkt keinen Grip. Nach dem Ende baut `OVERSPEED` die Überspeed sanft ab. |
| **Mega** (`size`) | Skala 2,5 (Lerp 0,1/Frame), Kollisionskreis 3,75, Ram per Abstandstest | `scale` gleitet mit `1 − e^(−6·DT)` auf `MEGA_SCALE` (optisch wie heute). Kreise r, c ×scale (Bulli r 3,25). Kontaktmasse ×3, Massenverhältnis-Deckel 3,5. Fahrverhalten unverändert (Grip normiert, rg nicht skaliert). Kontakt-Höhenfenster 1,4·scale. Legacy-Ram bleibt in 1a. |
| **Super-Jump** (`jump`) | Salto langsamer, Hubhöhe 24 m | **Entfernt** (Abschnitt 26): kein Sprung, also auch kein Super-Jump. Das Powerup ist nicht mehr im Pool der Party. |
| **Ghost** | keine Hindernis-Kollision, transparent | `mods.ghost`: kein Auto-Kontakt **und** keine Welt-Collider, nur Weltrand. Ende im Collider → `ghostExit` (7.3). Getrennt davon verhindert `state.ghostTicks` nur den Auto-Kontakt. |
| **Schild** (+ Respawn-Schild) | Hindernistreffer `speed ×0,1` | Wand `e = 0` (kein Rückprall, Gleiten bleibt), Kontaktmasse ×2. Schaden regelt die Party-Logik. |
| **Magnet** | Coin-Radius (`coins.ts`) | keine Sim-Wirkung |

**Speedometer** im v2-Modus bis 320 km/h (`speedoScale.ts` bekommt die Skala abhängig vom Flag).

---

## 11. Eingabe (`InputManager`)

### 11.1 Ablauf

- Quellen: Tastatur (`keyboard.ts` meldet im v2-Modus gehaltene Tasten statt Legacy-Pulse), Touch (`mobile.ts`), Gamepad (`navigator.getGamepads()`, einmal pro Frame gepollt).
- `sampleTick(): VehicleInput` wird **einmal pro Sim-Tick** aufgerufen. Achsen werden quantisiert (`steer = round(s·127)`, `throttle/brake = round(t·255)`).
- **Pulse-Latch:** Tastenflanken (Sprung, Reset-Beginn) werden zwischen Frames gesammelt und im nächsten Tick als gehaltenes Bit ausgeliefert, auch wenn die Taste schon wieder losgelassen ist. Nach dem Tick wird der Latch gelöscht.
- Schuss und Hupe sind keine Sim-Inputs, sondern Events wie heute (`state.inputs.e/f`).
- Vorrang: aktive Touch-Eingabe vor Gamepad vor Tastatur (pro Achse der betragsgrößte Wert der aktiven Quelle).
- Legacy-Modus: `keyboard.ts`, `mobile.ts` und `state.inputs` bleiben exakt wie heute; Pfeiltasten und Gamepad nur mit Flag.

### 11.2 Belegung

| Plattform | Belegung |
|---|---|
| **Tastatur** | W/S bzw. ↑/↓ Gas und Bremse/rückwärts · A/D bzw. ←/→ lenken · **Leertaste Handbremse/Drift** · Shift Boost · R halten Reset · E Schuss · F Hupe (Q Sprung/Salto entfiel, Abschnitt 26) |
| **Gamepad** (Standard-Mapping) | RT Gas, LT Bremse/rückwärts (analog), linker Stick lenken (radiale Deadzone 0,12, Kurve \|x\|^1,6, `steer = −x`) · A Handbremse · B Boost · X Schuss · LB Hupe · View/Back halten Reset (Y Sprung entfiel, Abschnitt 26) |
| **Touch** | Auto-Gas standardmäßig an (Umschalter im Touch-HUD, gemerkt in `localStorage`) · Joystick-x lenkt · Joystick-y > 0,45 nach unten bremst bzw. fährt rückwärts (`brake = (y − 0,45)/0,55`, Gas dann 0) · ohne Auto-Gas gibt Joystick-y nach oben Gas · rechts **großer DRIFT-Button** (Handbremse halten) und BOOST · `btn-flip` 0,5 s halten = Reset (kurz = Sprung entfiel, Abschnitt 26) · Schuss, Hupe wie heute · Assist-Profil „touch“ · Joystickfilter im v2-Modus 30/s statt 18/s (der Radeinschlag glättet schon) |

Die Leertaste als Handbremse folgt dem Genre-Standard: Drift ist die Kernmechanik, der Sprung ist im Rennen später ohnehin aus (offene Entscheidung 4). Party-Spieler lernen im v2-Modus Q für den Sprung; die Hilfe im About-Modal wird im v2-Modus angepasst.

---

## 12. Client-Integration

### 12.1 Fixed-Step-Loop (`game/loop.ts`)

```ts
export class FixedStepLoop {
    acc = 0;
    advance(frameDt: number, tick: () => void): number {   // gibt alpha zurück
        this.acc += Math.min(frameDt, 0.25);
        let n = 0;
        while (this.acc >= DT && n < 8) { tick(); this.acc -= DT; n++; }
        if (n === 8 && this.acc >= DT) this.acc = 0;         // Rest verwerfen (Hitch)
        return this.acc / DT;
    }
    reset(): void { this.acc = 0; }
}
```

Während Modal, Tod oder Kontextverlust läuft kein Tick, und der Akkumulator wird zurückgesetzt (wie die heutige Legacy-Semantik „Auto eingefroren“). Nur die Powerup-Timer laufen mit der Frame-Zeit weiter (10, 23.3). Für 1b ist das Einfrieren eine offene Regel (Abschnitt 18).

### 12.2 Render-Interpolation

`LocalVehicle` hält `prev` und `curr` (`copyVehicleState` vor jedem Tick). Gerendert wird mit `alpha`: Position linear, Yaw über den kürzesten Bogen, `flipAngle` linear (Sprung bei 2π beachten). Kamera, Nametag, Partikel-Emitter und Schatten-Licht nutzen die interpolierte Pose.

### 12.3 `LocalVehicle` und Legacy-Adapter

Pro Frame im v2-Pfad von `Bulli.update`:

1. Powerup-Timer werden pro Tick heruntergezählt (im Tick-Callback), daraus `mods`.
2. `loop.advance(dt, tick)`, wobei `tick` = `input = inputManager.sampleTick()`, Proxies aktualisieren, `stepWorld([local, ...proxies] sortiert, world)`, Events sammeln.
3. Pose schreiben: `group.position.x/z` = interpoliert, `group.position.y` = `groundHeight` an der interpolierten Position, `flipGroup.position.y = y_interp − groundHeight`, `group.rotation.y = yaw`, `flipGroup.rotation.x = flipAngle`, Nicken/Rollen = Geländenormale + visuelle Feder (≤ 4°/5°).
4. Adapter-Felder für unveränderte Verbraucher (HUD, Motorsound, Partikel, Kamera, Mega-Ram, Coin-Check): `bulli.speed = u/60`, `bulli.maxSpeed = vtopE/60` (Legacy-Einheit u/Tick), `bulli.angle = yaw`, `bulli.isFlipping = flipAngle > 0`.
5. Events → Effekte: `wallImpact`/`carImpact` → `playCollisionSound` und Partikel (Schwellen 7,5 / 12 m/s), `jumped` → `playJumpSound`, `drifting` → Drift-Rauch, `boostStarted` → Boost-Feuer.
6. `sendMovementSnapshot` unverändert: `x`, `z`, `angle = yaw`, `y = state.y − getTerrainHeight(x, z)` (gleiche Semantik wie heute der `flipGroup`-Versatz, liegt in `Y_MIN..Y_MAX`), `flipAngle`, `isFlipping`, `scale = state.scale`, Ghost/Schild/Mega-Flags.

`Bulli.ts:746–950` läuft im v2-Pfad nicht. Ohne Flag läuft exakt der heutige Code; `LocalVehicle` wird dann gar nicht erzeugt.

### 12.4 Zerlegung von `Bulli.ts`

Reihenfolge, jeweils eigener Commit, Legacy-E2E danach grün:

1. `CarModel` extrahieren (Mesh-Aufbau, VW-Logo `Bulli.ts:23–89`, `addVWLogo`, Räder, Schild-Mesh, Ghost-Visual, `dispose`). `Bulli` delegiert; öffentliche Felder (`group`, `flipGroup`, `wheels`, `shieldMesh`, `setGhostVisual`) bleiben als Durchreichung.
2. `Nametag` extrahieren.
3. `ChaseCamera` aus `main.ts` extrahieren (reines Refactoring).
4. Erst danach der v2-Pfad.

Nach dem Blindtest (nicht in diesem Lauf) schrumpft `Bulli` auf eine dünne Fassade oder verschwindet.

### 12.5 Kamera

`ChaseCamera` bekommt ein Profil. `legacy` = heutige Werte (`CONFIG.camera*`). `race` (Standard im v2-Modus):

| Wert | race | Mobile-Faktor |
|---|---|---|
| Höhe | 4,8 m | ×1 (Hochformat ×1,5) |
| Abstand | 11 m (+12 % bei vtop) | ×1 (Hochformat ×1,5) |
| LookAt-Höhe | 1,5 m | |
| FOV | 60° + 10°·speedRatio + 4° Boost, max 80° | Basis 62° |
| Yaw-Ziel | `yaw + 0,5·β·clamp(u/10, 0, 1)` | |

*Angepasst beim Livegang von v2 (Abschnitt 25):* Ursprünglich 5,5 m Höhe, FOV 64°/66° und Mobile-Faktor 0,9. Mit `npm run screenshots` gemessen (Anteil des Autos an der Bildbreite, `carWidth` in `stats.json`): Die Legacy-Kamera zeigt den Bulli mit 4 % der Bildbreite, die ursprüngliche Renn-Kamera mit 14 %, die jetzige mit 16 % im Stand und 12 % bei 70 km/h (1600 × 900). Auf dem Handy quer 16 %. Im Hochformat füllte der Bulli mit 47 % die halbe Bildbreite; dort rückt die Kamera jetzt um den Faktor 1,5 weiter weg und höher (28 %). Straßen in Kurven und Kreuzungen bleiben lesbar (Ansicht `corner`).

Ein Profilwechsel ist im Tuning-Panel möglich (für den Blindtest: v2 auch mit Legacy-Kamera fahrbar).

### 12.6 HUD

- Tacho-Skala 320 km/h im v2-Modus.
- Boost-Leiste (0..1, Markierung bei 0,15) und Drift-Anzeige, nur im v2-Modus, Desktop und Mobile.
- Reset-Hinweis (6.7).

### 12.7 Sandbox (`sandbox.html`)

*Umgesetzt hinter `?sandbox=1` auf der normalen Seite; Stand und Abweichungen in Abschnitt 21.*

Offline, ohne Server, eigener Vite-Einstieg (Multi-Page-Build). Flache Ebene 400 × 400 m mit:

- Rampen (10°, 15°, 20°; 8 m breit), eine Sprungschanze mit Landehügel,
- weite Kurven (R 40, 80 m) und eine 90°-Stadtecke mit 12-m-Straßen,
- eine lange Wand zum Streifen, Pfosten-Reihe (r 0,35) für Tunneling-Checks,
- Dummy-Autos (stehend, geradeaus, Kreis) aller Klassen, auf Knopfdruck zurücksetzbar,
- Klassenauswahl, Mods zum Anklicken, Tuning-Panel offen.

`?e2e=1` stellt `window.__bulliSim` bereit (Golden-Szenarien im Browser, 14.4).

---

## 13. Tuning-Parameter (lil-gui)

*Umgesetzt hinter `?tune=1`; Stand und Abweichungen in Abschnitt 21.*

Das Panel schreibt in `SIM_TUNING` (global) bzw. in die Klassen-Params des lokalen Autos. „Export“ kopiert die geänderten Werte als TS-Literal in die Zwischenablage.

| Ordner | Regler (Bereich) |
|---|---|
| Global | `gripScale` (0,8–1,6), `GRAVITY` (8–30), `assistProfile` (standard/touch), Kamera-Profil |
| Antrieb | `accel`, `topSpeed`, `brakeDecel`, `ENGINE_BRAKE`, `C_AIR`, `DRIVE_EXP` |
| Reifen | `gripFront/Rear`, `slipPeakFront/Rear` (3–12°), `slideFront/Rear`, `aeroGrip`, `GRIP_CIRCLE` |
| Lenkung | `steerLock` (25–40°), `steerFalloff` (10–25), `STEER_RATE_IN/OUT` |
| Drift | `handbrakeGrip` (0,3–0,7), `HB_DECEL`, Handbremsen-Erholung (0,1–0,6 s), `LOAD_GAIN`, `driftReleaseKick` (0–5) |
| Assists | `counterSteer` (0–1), `spinGuardAngle` (20–60°), `K_SPIN`, `K_BD`, `yawDampHigh` (0–5) |
| Boost | `BOOST_ACCEL` (6–16), `BOOST_ADD`, Verbrauch, `DRIFT_FILL`, `AIR_FILL` |
| Kollision | Wand e (0–0,5), μw, Auto e, μc, Massenverhältnis-Deckel, `proxyContactScale` (0–1), Δω-Kappe |
| Federung und Luft (26) | `SUSP_FREQ` (0,8–4 Hz), `SUSP_DAMPING` (0,2–1,5), `SUSP_TRAVEL` (0,05–0,5 m), `AIR_YAW_RESPONSE` (0–10), `AIR_ALIGN` (0–6) |
| Debug | Anzeige u, w, β, r, δ, αF/αR, FzF/FzR, Zustand grounded/drift/boost; Vektoren im 3D-View |

---

## 14. Testplan

Alle Sim-Tests laufen in Vitest (`tests/shared/sim/*.test.ts`, Node). Golden-Werte liegen als JSON unter `tests/shared/sim/golden/` und werden mit `UPDATE_GOLDEN=1 npm test` neu erzeugt (bewusste Änderung, im Commit sichtbar).

### 14.1 Konventionen (zuerst)

- Links lenken bei 20 m/s → yaw steigt, Position wandert in Richtung `l`.
- Stoß von rechts gegen die Nase (Kontaktpunkt vorn, Impuls nach links) → yawRate > 0.
- Handbremse + Links bei 25 m/s → β < 0.
- `ω × r` und `r × J` gegen Handrechnung.

### 14.2 Fahrdynamik (Bereiche statt exakter Werte)

Für jede Klasse: 0–100 km/h innerhalb ±15 % der Tabelle 1.2; vtop bei Vollgas nach 30 s `= vtop ± 0,5`; Bremsweg vtop → 0 in 45–65 m; Radius bei Vollausschlag und 20 m/s in 15–25 m; Handbremsen-Kick bei 25 m/s: β max 15–50°, nie > 90°; gehaltener Drift 3 s mit Gas: kein Dreher; Slalom bei 40 m/s mit Vollausschlag alle 0,5 s: kein Dreher; Vollbremsung in der Kurve: β < 60°; Boost 2,2 s ab vtop erreicht ≥ vtop + 12; Turbo + Boost nie über 85 m/s; beides für Assist-Profil `standard` und `touch`, `gripScale` 1,0 und 1,5.

### 14.3 Stabilität und Determinismus

- **Keine NaN/∞** in 10 000 Ticks Zufalls-Input (Input aus fest geseedetem `mulberry32` im Test, nicht in der Sim).
- **Störungsabbau:** 1 m/s quer + 0,8 rad/s bei 10, 50, 70, 85 m/s: \|r\| nach 3 s < 0,05 rad/s, keine wachsende Amplitude.
- **Empfindlichkeit** (für 1b): 0,1° Yaw- + 5 cm/s Querfehler → Positionsabweichung nach 120 Ticks < 15 cm in allen Szenarien und Klassen.
- **Bitgleiche Wiederholung:** zwei Läufe mit gleichem Input → identischer Zustand (`toStrictEqual`).
- **Replay aus Snapshot:** 120 Ticks laufen, bei Tick 60 `copyVehicleState` sichern, ab dort mit denselben Inputs neu rechnen → bitgleich zum Original. Beweist, dass alle Filterzustände im `VehicleState` liegen.
- **Flankenerkennung:** gehaltene Sprungtaste über 60 Ticks löst genau einen Sprung aus; Input-Repeat ändert nichts.

### 14.4 Golden-Szenarien (Node und Browser)

Je Szenario Input-Skript pro Tick, 180 Ticks (11–19: 240 bzw. 300), Endzustand und Zustand alle 30 Ticks als Golden:

1. Beschleunigen + Grip-Kurve (bulli)
2. Handbremsen-Drift mit Gegenlenken (sport)
3. Sprung über eine Rampe mit Landung (beetle)
4. Streifschuss 10° an Wand bei 49 m/s (knapp unter vtop des Bulli, siehe 24.2)
5. Kontakt frontal (2 × bulli, je 50 m/s)
6. Kontakt seitlich/T-Bone (pickup in stehenden beetle)
7. Kontakt Heck/PIT (sport trifft bulli mit 36 gegen 30 m/s unter 20° am rechten hinteren Viertel; ein gerader Auffahrer mit 1,5 m Versatz drückt fast durch den Schwerpunkt und dreht kaum, siehe Abschnitt 19)
8. Drei Autos in Reihe (Auffahrkette 45 → 40 → 35 m/s; das hintere Paar berührt sich zuerst)
9. Mega gegen Käfer
10. Ghost fährt durch Auto und Wand; Ghost endet im Gebäude
11. Boost ab knapp unter vtop, loslassen, Restboost, danach nur Handbremse ohne Gas über vtop (bulli; Boost, Overspeed, Handbremsverzögerung)
12. Über eine Bodenwelle (1 m hoch, 20 m lang) mit 30 m/s: Abheben an der Kuppe, Lenken in der Luft (ohne Wirkung), Landung auf der Federung, dann Reset halten bis er auslöst und weiter durch den Kontakt-Ghost (`crest-hop-reset-jeep`; bis Abschnitt 26 `jump-reset-jeep` mit der Sprungtaste)
13. Slalom mit Vollausschlag und Handbremsen-Tipp je Wechsel mit Assist-Profil `touch` (beetle, Schräglauf über 30°: Gegenlenken und Spin-Guard des Handy-Profils)
14. Rempler gegen einen kinematischen Proxy mit `PROXY_CONTACT_SCALE` (sport gegen bulli-Proxy, wie `remoteProxies.ts`)
15.–19. Je Klasse Vollgas geradeaus und in die Kurve, dann Bremse halten bis in den Rückwärtsgang (`launch-brake-reverse-<klasse>`)

Dazu ist die ausgelieferte Abstimmung selbst ein Golden (`tests/shared/sim/golden-tuning.json`: alle Werte aus `SIM_TUNING`, den fünf Klassen und beiden Assist-Profilen, exakt verglichen). Die Szenarien erreichen nicht jeden Wert (Offroad wirkt erst in Phase 3, Flug über eine Kuppe nur beim Jeep und an der Rampe, einige Schwellen); so braucht trotzdem jede Tuning-Änderung ein bewusstes `UPDATE_GOLDEN=1`.

Node und Browser (`tests/e2e/sim-golden.spec.ts`, Sandbox mit `?e2e=1`, `__bulliSim.runGolden(name)`) vergleichen mit dem JSON auf 1e-9 · max(1, |Wert|), Zähler und Flags exakt (`tests/shared/sim/goldenCompare.ts`, Begründung in 24.2). Bitgleich bleibt nur der Vergleich zweier Läufe im selben Prozess (14.3).

Zusätzliche Aussagen zu den Kontakt-Szenarien: frontal → beide \|v\| ≤ 4 m/s nach dem Stoß (wegen der Σ\|Δv\|-Kappe von 30 m/s nach zwei Ticks); Heck-Auffahren → Vorderer schneller; PIT → \|Δω\| ≤ 2,5 rad/s und Getroffener nach 90 Ticks mit Gegenlenken wieder |β| < 10°; drei Autos → nach 10 Ticks keine Überlappung > 5 cm; nie `vy ≠ 0` durch Kontakt; Summe der Impulse zweier dynamischer Autos ≈ 0 (Impulserhaltung bis auf Rückprall-Kappe).

### 14.5 Tunneling

- Alle Klassen, normal und Mega, mit 85 und 90 m/s auf: Pfosten (r 0,35), Box mit halber Dicke 0,25 m, Gebäudeecke; seitliche Versätze in 0,1-m-Schritten, Winkel 0–80° in 10°-Schritten → das Auto endet nie auf der anderen Seite.
- Auto gegen Auto frontal: 2 × Käfer (kleinste Kreise) mit je 85 m/s, Versätze wie oben, plus T-Bone mit 85 m/s → die Reihenfolge entlang der Annäherungsachse kippt nie.
- *Ergänzt nach dem Review (23.4):* Ob ein Auto durchtunnelt, entscheidet die Eindringtiefe im ersten Kontakt-Substep, also die Startphase innerhalb eines Ticks. Die Matrix variiert deshalb zusätzlich den Startabstand über eine Tick-Strecke in 0,05-m-Schritten; jeder Pfosten- und Wandlauf muss die Wand auch berühren.

### 14.6 FPS-Unabhängigkeit (`tests/client/loop.test.ts`)

Ein Input-Skript pro **Tick-Index**, `FixedStepLoop` mit Frame-Folgen 1/30, 1/60, 1/144 s und einer gejitterten Folge (feste Seeds) über dieselbe Gesamtzeit → identische Zustandsfolge pro Tick (bitgleich). Zusätzlich: Hitch von 0,5 s → höchstens 8 Ticks, Rest verworfen.

*Ergänzt um `tests/client/fpsIndependence.test.ts`: derselbe Nachweis für den ganzen Client-Tick über `LocalVehicle.update` (Abschnitt 22).*

### 14.7 Client-Einheiten

`InputManager`-Mapping (Quantisierung, Latch, Deadzone/Kurve, Touch-Brems-Schwelle, Vorrang der Quellen), `obstaclesToColliders` (Formen, `top`), Grid-Query (Dedup, Sortierung, keine Allokation nach dem Aufbau), Speedo-Skala v2.

### 14.8 E2E (Playwright)

- **Bestehende Suite ohne Flag grün** (Legacy unverändert, Desktop und Mobile).
- **Desktop v2:** W 2 s → Strecke in erwartetem Bereich, Tacho > 0; Q → Höhe steigt und fällt; R halten → Reset; Leertaste + A bei Tempo → β ≠ 0 (über `__bulliDebug`).
- **Mobile v2** (iPhone 13, Touch): Auto-Gas fährt an, Joystick lenkt, DRIFT-Button wirkt, `btn-flip` lang = Reset.
- **Multiplayer gemischt:** ein v2- und ein Legacy-Client sehen sich gegenseitig fahren; zwei v2-Clients rempeln sich (Positionen weichen nach Kontakt aus, keine Überlappung dauerhaft).
- **Sim-Golden im Browser** (14.4).

### 14.9 Leistung

Messung (geloggt, nicht als harte CI-Schranke): 32 Autos × 60 Ticks `stepWorld` in Node; Ziel < 2 ms pro Tick. `npm run perf:sim` (`scripts/sim-bench.ts`) misst das allein, die CI zeigt ein Ergebnis über dem Ziel als Warnung. Die frühere Schranke 60 Ticks < 120 ms im Unit-Lauf ist entfernt: In parallelen Workern auf geteilten Runnern war sie flaky-anfällig, und eine 6-mal langsamere Sim bestand sie trotzdem.

*Im Browser gemessen mit `npm run perf:baseline -- --physics=v2` bzw. `--sandbox` (Abschnitt 22, Werte in [`baseline.md`](baseline.md)).*

---

## 15. Umsetzungsreihenfolge

Kleine Commits, jeweils mit grünen Tests:

1. `shared/sim`: Typen, Konstanten, Reifenkurve, Konventionstests.
2. `stepVehicle` Längs-/Querdynamik ohne Welt + Fahrdynamik-Tests.
3. Boden, Gravitation, Sprung, Rampen-`groundHeight`.
4. `world/colliders.ts` + Grid + Weltkollision + Tunneling-Tests.
5. `contact.ts` + `stepWorld` + Kontakt-Golden.
6. Modifikatoren + Tests.
7. Refactoring: `CarModel`, `Nametag`, `ChaseCamera` (Legacy-E2E grün).
8. `FixedStepLoop` + Test; `InputManager` + Gamepad + Tests.
9. `LocalVehicle`, Adapter, Collider-Adapter (`top` an den push-Stellen), `?physics=v2` im Spiel.
10. Remote-Proxies (halbseitiger Kontakt).
11. HUD (Skala, Boost, Drift, Reset-Hinweis), Touch-Buttons, Race-Kamera.
12. Sandbox + lil-gui + Browser-Golden.
13. E2E v2 Desktop/Mobile/Multiplayer; Plan-Status aktualisieren. *Plan-Status erledigt im Schritt „fps-and-docs“ (Abschnitt 22).*

---

## 16. Risiken und Gegenmittel

| Risiko | Gegenmittel |
|---|---|
| Die Stadt ist für 50 m/s eng (12-m-Straßen, 52-m-Raster); 90°-Ecken nur mit ~15 m/s oder Drift. Legacy dreht bis 3 rad/s, v2 wirkt im Blindtest evtl. träge. | `gripScale` bis 1,5, δ0 bis 38°, Handbremsen-Wende, Race-Kamera; gridSize 6 in Phase 2 |
| Leertaste = Handbremse statt Sprung | Q für Sprung, About-Modal im v2-Modus, Legacy unverändert |
| Touch: kein Teilgas mit Auto-Gas, Drift braucht zweiten Daumen, Filter + Stellrate addieren Verzögerung | Filter 30/s, Profil „touch“, großer DRIFT-Button; Test auf echtem Handy (Exit-Kriterium) |
| Drift verliert viel Tempo bei hohem `gripScale` | `handbrakeGrip` und `gripScale` gemeinsam tunen; `driftReleaseKick` |
| Assists zu stark (geskriptet) oder zu schwach (Dreher) | alle als Regler; ohne β-Dämpfung pendelte der Prototyp zwischen 11° und 78° – nicht abschalten |
| Hochtempo-Pendeln nach Stoß bei 85 m/s (~2 s, gemessen) | `yawDampHigh` |
| Niedrigtempo bei `gripScale` 1,5 (Sport, 5,5–6 m/s: gedämpfte Vorzeichenwechsel) | Stabilitätstest in 14.3; falls sichtbar: `V_LOW` auf 6–7 m/s oder Querkraft je Achse auf `m_Achse·|v_quer|/DT` begrenzen |
| Chase-Cam zeigt im Drift seitwärts | Yaw-Blend mit β (12.5) auf interpolierter Pose |
| 60-Hz-Sim ruckelt auf 120/144-Hz-Displays | Render-Interpolation Pflicht (12.2) |
| Im Stand keine Drehung mehr, Festfahren in Ecken | Reset + HUD-Hinweis |
| Kuppen bei Boost/Turbo: kurzes Abheben ab ~63 m/s | `STICK` erhöhen, falls störend |
| Wand-Schrubben als Abkürzung | kein Boost-Füllen bei Wandkontakt; optional Scrape-Verzögerung 2 m/s² |
| 1a-Rempeln gegen 20-Hz-Proxies zittert | e = 0, 70 %, 0,5-m-Deckel, Geschwindigkeitsschätzung; richtig gut erst in 1b |
| Legacy-Verbraucher erwarten u/Tick | Adapter `speed = u/60`, `maxSpeed = vtopE/60` |

---

## 17. Nicht Teil dieses Laufs

- Löschen der Legacy-Physik (erst nach dem Blindtest des Nutzers).
- Protokolländerung (`input`-Uplink, Snapshots), Server-Sim, Prediction/Reconciliation (Phase 1b).
- Portierung der Collider-Platzierung nach `shared/world` (1b, mit Paritätstest).
- Offroad-Oberflächen (Phase 3), Bots, Rennen.

## 18. Hinweise für 1b (damit 1a nichts verbaut)

- Snapshot pro Auto: Pose und Geschwindigkeit (x, y, z, yaw, vx, vy, vz, yawRate), Filter (steerAngle, loadX, rearGrip, betaPrev), Flags (grounded, boosting, driftTicks > 0) als Bitfeld, Gameplay (boostMeter, flipAngle, flipRate, scale, ghostTicks, ghostExit, reverseHold, resetHold, jumpCooldown, airTicks, prevButtons), letzter Input und Mods.
- Assist-Profil und Klasse verändern die Sim; sie gehören in die serverseitig bekannten Spieler-Settings.
- `sin/cos/atan2/exp/sqrt/pow` können zwischen V8 und JSC im letzten Ulp abweichen; die Reconciliation fängt das ab (Plan Abschnitt 6).

*Ergänzt nach dem Review (Abschnitt 23):*

- **Globales Tuning:** Die Sim liest `SIM_TUNING`, `VEHICLE_CLASSES` und `ASSIST_PROFILES` als veränderliche Modul-Globals, und das Panel (`?physics=v2&tune=1`) ist in 1a auch online nutzbar. Mit Server-Sim sagt ein Client mit geändertem oder importiertem Tuning jeden Tick anders voraus als der Server, und die Reconciliation korrigiert dauernd (sieht aus wie Netz-Jitter). Regel für 1b: Online gilt nur das Default-Tuning. Das Panel ist online gesperrt (nur Sandbox/offline), oder der Client prüft beim Verbinden `tuningIsDefault()` und setzt sonst zurück. Langfristig wird das Tuning als Parameter an `stepWorld` übergeben bzw. hängt an `SimWorld`, statt als Global gelesen zu werden.
- **Einfrieren:** Modal, Tod und Kontextverlust halten in 1a nur die Client-Sim an (12.1), das Auto behält sein Tempo. Mit Server-Sim rechnet der Server weiter (letzter Input höchstens 250 ms, dann neutral mit Bremse), und beim Schließen springt das Auto per Reconciliation. 1b braucht eine serverseitige Regel: ein Input-Flag „eingefroren“, das der Server wie einen Stillstand behandelt (Auto hält an, wird Ghost), oder der Client tickt im eingefrorenen Zustand mit Null-Input weiter und sendet. Der Tod ist ohnehin Server-Zustand.
- **Collider-Parität:** Die Felsen (`environment.ts`) ziehen Position und Größe aus demselben `mulberry32(SCENERY_SEED)`-Strom wie Material, Rotationen, y-Skala und den optionalen zweiten Stein (7 oder 9 Ziehungen pro Fels). Bei der Portierung nach `shared/world` bekommen die Collider einen eigenen Strom (nur Position und Größe) und die Optik einen abgeleiteten Seed. Sonst verschiebt jede Änderung an der Optik alle folgenden Fels-Collider, nur auf dem Client. Eine Umstellung schon in 1a würde die Felsen verschieben und damit das Spiel ohne Flag verändern, deshalb erst mit der Portierung.
- **Collider-Reihenfolge:** `resolveColliders` schiebt das Auto nacheinander in Indexreihenfolge heraus, das Ergebnis hängt also von der Reihenfolge ab. Heute entsteht sie implizit: `createEnvironment` setzt `state.obstacles = []` und legt Bäume (aus `treeData` des Servers), dann Felsen an, danach hängt `createCity` die Stadt an (`websocket.ts`). Diese Reihenfolge (Bäume, Felsen, Stadt) ist Vertrag, und der Paritätstest vergleicht die **geordnete Liste Index für Index**, nicht als Menge.
- **NaN:** `stepWorld` setzt ein Auto mit nicht endlichem Zustand zurück, und die Kontakttests lassen NaN nicht durch (23.2). Die Validierung am Protokollrand bleibt trotzdem nötig.

## 19. Umsetzung des Sim-Kerns: Abweichungen und Messwerte

Stand nach dem Schritt „sim-core“ (`src/shared/sim/*`, `src/shared/world/colliders.ts`, Tests unter `tests/shared/sim/`). Die Werte aus 1.2 werden exakt reproduziert (0–100 km/h, vtop, Bremsweg, Radius, Handbremsen-Kick je Klasse). Begründete Abweichungen von den Abschnitten oben:

1. **Boost erreicht sein Ziel.** Mit der Formel aus 6.4 lag das Boost-Gleichgewicht bei ~67 m/s (Bulli) statt der vom Nutzer gewünschten ~70 m/s, weil über vtop niemand den Luftwiderstand ausgleicht. Der Boost übernimmt das jetzt oberhalb vtop (analog zum Antrieb darunter) und zielt auf `vRef = min(vtop + BOOST_ADD, V_ABS)`. Gemessen: Bulli 67 m/s nach 2,2 s, Ziel 70 m/s; Turbo + Boost nähert sich 85 m/s von unten und überschreitet es nie; mit der Zielformel aus 6.4 (`vtopE + BOOST_ADD` im Boost-Term) lag Sport mit Turbo + Boost bei ~86 m/s, also über `V_ABS`. Der Luft-Boost ist ebenso auf `vRef` begrenzt.
2. **Gas beim Rückwärtsrollen bremst** mit `th·brakeDecel`, spiegelbildlich zur Bremse vorwärts. Vorher bremste nur der Rollwiderstand (0,4 m/s²), der Wechsel von rückwärts auf vorwärts dauerte Sekunden.
3. **Handbremsen-Blend (`rearGrip`) und `betaPrev` laufen auch in der Luft.** Eine über die Landung gehaltene Handbremse startet so einen Drift, und die β-Dämpfung bekommt bei der Landung keinen Sprung in `(β − betaPrev)/DT`.
4. **Drift-Füllung nur am Boden;** in der Luft gilt nur `AIR_FILL`.
5. **Stillstand am Hang:** Der Snap `|u'| < 0,05 → 0` aus 2f lässt ein stehendes Auto an Hängen bis etwa 0,5 Steigung stehen (die Hangbeschleunigung pro Tick bleibt unter der Schwelle); rollende Autos werden bergab korrekt schneller. Die Stadt ist flach, das Gelände hat höchstens ~0,2 Steigung. Bewusst so belassen.
6. **Wandkontakt:** `wallTicks = 0` bei jeder Überlappung, nicht nur bei Impuls (`vn < 0`), damit Schrubben mit anliegendem Auto die Drift-Füllung sicher sperrt. Beim Weltrand bleiben die Kreise innerhalb von ±498 (Legacy klemmte den Mittelpunkt).
7. **Kontaktpunkt Auto–Auto** ist die Mitte der Überlappung auf der Verbindungslinie. Gegen einen kinematischen Proxy gilt `e = 0`; die Stärke ist das Produkt der `contactScale` beider Autos.
8. **Zähler sättigen** (`airTicks`, `reverseHold`, `wallTicks` bei 255, `driftTicks` bei 65535, `resetHold` bei `RESET_HOLD_TICKS + 1`), damit der 1b-Snapshot kompakte Felder bekommt.
9. **Szenarien:** PIT-Geometrie geändert (14.4, Punkt 7): Beim geraden Auffahren mit 1,5 m Versatz dreht die Reibung den Impuls fast durch den Schwerpunkt des Bulli (gemessen Δω 0,004 rad/s), das ist kein PIT. Unter 20° am hinteren Viertel: Δω ≈ 2,3 rad/s, β max 18°, nach 90 Ticks mit Gegenlenken wieder < 10°.
10. **Collider-Platzierung** bleibt wie in 7.2 und 17 festgelegt im Client (Portierung nach `shared/world` in 1b). Der Sim-Kern nimmt `ColliderInput[]` entgegen; die `top`-Werte der Tabelle 7.1 stehen als `COLLIDER_TOPS` in `shared/world/colliders.ts`, damit Client-Adapter und spätere Server-Portierung dieselben Zahlen nutzen.
11. **Kein Swept-Test:** Die Tunneling-Matrix aus 14.5 (alle Klassen, normal und Mega, 85 und 90 m/s, Pfosten r 0,35, Wand mit halber Dicke 0,25, Gebäudeecke, Versätze in 0,1-m-Schritten, 0–80°) und Auto gegen Auto (2 × Käfer frontal mit je 85 m/s, 0–30°, T-Bone mit 85 m/s) laufen mit den 3 festen Substeps ohne Durchtunneln. Die Prüfungen wurden gegengetestet: Mit abgeschalteter Kollision schlagen sie an. *Korrektur nach dem Review (23.4):* Diese Gegenprobe zeigte nicht, dass 3 Substeps nötig sind; mit `SUBSTEPS = 1` blieb die Matrix grün, weil sie immer mit derselben Startphase fuhr. Seit dem Sweep der Startphase schlägt sie mit `SUBSTEPS = 1` an und ist mit 3 grün.

**Messwerte:** 32 Autos × `stepWorld` in Node ≈ 0,17 ms pro Tick (Ziel < 2 ms). Störungsabbau (1 m/s quer + 0,8 rad/s) bei 10–85 m/s in allen Klassen, beiden Assist-Profilen und `gripScale` 1,0/1,5: \|r\| nach 3 s < 0,05 rad/s, keine wachsende Amplitude. Beim gehaltenen Handbremsen-Drift mit Vollgas und Volleinschlag verliert Sport bei `gripScale` 1,5 in 3 s fast alles Tempo (β ~60°), dreht sich aber nicht; das ist das Risiko „Drift verliert viel Tempo bei hohem `gripScale`“ aus Abschnitt 16.

## 20. Client-Integration: Stand, Abweichungen und Messwerte

Stand nach dem Schritt „client-integration“. Mit `?physics=v2` fährt das eigene Auto auf der Sim aus `src/shared/sim`. Ohne Flag läuft der bisherige Code: Die Legacy-E2E-Suite ist unverändert grün, und `LocalVehicle` wird gar nicht erzeugt.

**Module wie in 4.2:**

- `client/flags.ts`
- `game/loop.ts` (`FixedStepLoop`)
- `input/InputManager.ts` und `input/gamepad.ts`
- `vehicle/CarModel.ts`, `vehicle/Nametag.ts`, `vehicle/LocalVehicle.ts`, `vehicle/remoteProxies.ts` und `vehicle/simWorldClient.ts`
- `camera/ChaseCamera.ts` mit den Profilen `LEGACY_CAMERA` und `RACE_CAMERA`

Neu dazugekommen sind zwei Module:

- `vehicle/legacyPhysics.ts`: Der Bewegungsblock aus `Bulli.update` ist unverändert ausgelagert und lässt sich nach dem Blindtest in einem Schritt löschen. Hupen und Schießen stehen jetzt in `Bulli.handleActions`, damit beide Pfade sie nutzen.
- `vehicle/v2Driver.ts`: der Frame im v2-Pfad mit Gamepad-Abfrage, Einfrieren, Ticks, Effekten aus den Sim-Events und dem Positions-Update.

`Bulli` ist eine Fassade: Die öffentlichen Felder bleiben, `group`, `flipGroup`, `wheels` und `shieldMesh` sind Objekte des `CarModel`.

**Begründete Abweichungen und Ergänzungen:**

1. **Reset auf die nächste Straße.** Der Auftrag verlangt den Reset auf die Straße statt an Ort und Stelle wie in 6.7. Das ist deterministisch in shared umgesetzt, damit 1b es übernehmen kann:
   - `SimWorld.roads` (`RoadGrid`) kommt von `cityRoadGrid()` in `cityGen.ts`.
   - `moveToRoad` in `vehicle.ts` setzt das Auto auf die nächste Mittellinie in höchstens 40 m Entfernung und richtet es längs der Straße aus, in der Richtung, die seinem Yaw am nächsten ist. Danach folgt `resetVehicle` wie bisher.
   - Das gilt nur für den gehaltenen Reset. Teleport und Respawn rufen `resetVehicle` direkt auf.
   - Weiter als 40 m von einer Straße entfernt bleibt der Reset an Ort und Stelle.
   - Die Golden-Szenarien haben `roads = null` und bleiben unverändert.
2. **Touch, Flip-Button:** Ein kurzer Druck springt beim Loslassen. Hält man den Button 30 Ticks (0,5 s), setzt er zurück, und es gibt keinen Sprung. Der Sprung kommt dadurch um die Tippdauer später. Die Alternative, beim Drücken zu springen und bei längerem Halten zusätzlich zurückzusetzen, würde vor jedem Reset einen Hopser erzeugen.
3. **Auto-Gas startet erst mit der ersten Berührung des Sticks** nach Spawn, Respawn oder Tod. Sonst fährt das Auto schon beim Beitreten los. Der Umschalter AUTO wird unter `localStorage['bulli-auto-gas']` gespeichert.
4. **Vorrang der Quellen (11.1):** Die Achsen kommen aus der aktiven Quelle mit dem höchsten Rang, also Touch vor Gamepad vor Tastatur. Die Buttons aller Quellen werden per ODER zusammengefasst. Touch gilt als aktiv, solange der Stick berührt wird oder Auto-Gas läuft. Das Gamepad gilt als aktiv, sobald Stick oder Trigger außerhalb der Deadzone sind. *Nach dem Review (23.3):* Auto-Gas allein (Stick losgelassen) weicht einem benutzten Gamepad oder einer gedrückten Fahrtaste, z. B. einem Controller am Tablet.
5. **Race-Kamera:**
   - Position gedämpft mit 12/s, Yaw mit 7/s (Legacy: 6,5/s und 6/s). Mit den Legacy-Werten hinge die Kamera bei 50 m/s rund 8 m weiter hinten.
   - Look-ahead 4 m + 6 m · Tempoverhältnis.
   - Die Höhe wächst nicht mit dem Tempo.
   - Das Tempoverhältnis ist u / effektives vtop. Boost und Turbo weiten das FOV.
6. **HUD:**
   - Die Boost-Leiste mit Marke bei 0,15 und das Drift-Licht stehen auf dem Desktop über dem Tacho. Auf Phones stehen sie oben in der Mitte, weil der Tacho dort ausgeblendet ist. Dazu kommt ein Füllring um den BOOST-Button.
   - Während des Drift-Boosts zeigt der Tacho „BOOST“. Motorsound und Boost-Feuer verhalten sich dann wie beim Turbo.
   - Der Reset-Hinweis nach 6.7 erscheint als Einblendung. Der Flip-Button wechselt dabei auf das Recover-Symbol.
7. **Remote-Proxies (8.5):**
   - Eine geschätzte Geschwindigkeit gilt nur 250 ms lang. Stehende Autos senden nur einmal pro Sekunde, danach ist die Geschwindigkeit 0.
   - Ein Sprung von mehr als 20 m zwischen zwei Updates gilt als Teleport und setzt die Geschwindigkeit auf 0.
   - Mitspieler ohne Update werden an ihrer `init`-Position geführt.
   - Tote Mitspieler (ausgeblendet) nehmen nicht teil.
8. **Powerups:** Im v2-Pfad werden die Timer pro Tick heruntergezählt, bei eingefrorener Sim pro Frame (23.3). Das Respawn-Schild zählt als `mods.shield`. Der Legacy-Mega-Ram bleibt unverändert.
9. **Darstellung:**
   - Nicken aus `loadX` mit 0,2°/(m/s²), höchstens 4°.
   - Rollen aus u · r mit 0,26°/(m/s²), höchstens 5°.
   - Beides mit 10/s gedämpft, dazu die Geländeneigung wie bei Legacy.
   - Bei der Landung wird das Auto um höchstens 15 % gestaucht.
   - Die Vorderräder lenken sichtbar mit `steerAngle`.
   - Ein Salto, den die Landung abbricht, dreht in rund 6 Frames zu Ende.
10. **Assist-Profil:** Bei `(pointer: coarse)` gilt „touch“, sonst „standard“. Der Joystick-Filter liegt im v2-Modus bei 30/s.
11. **E2E-Hook:** `snapshot()` liefert zusätzlich `physics`, `camera`, `local.y` und `v2`. `v2` enthält die Sim-Pose, u, β, Gierrate, Input, Boost und Drift sowie Zähler für Ticks, Sprünge und Resets. `placeLocalCar` setzt auch das Sim-Auto.
12. **Noch offen, nicht Teil dieses Schritts:**
    - Offline-Sandbox mit lil-gui-Tuning-Panel, `?tune=1` und Browser-Golden `__bulliSim` (12.7, 13, 14.4). lil-gui ist deshalb noch keine Abhängigkeit. *Erledigt im Sandbox-Schritt, Abschnitt 21.*
    - Kanten-Collider der Rampen (7.2). *Erledigt im Sandbox-Schritt, Abschnitt 21.*
    - E2E für eine gemischte Session aus v2 und Legacy (14.8). Weil das Protokoll unverändert ist, funktioniert sie per Konstruktion. Der Test fehlt, weil drei Software-WebGL-Seiten gleichzeitig zu langsam laufen.

**Messwerte:**

- **Unit-Tests:** Die Zustandsfolge pro Tick ist bei Frames von 1/30, 1/60 und 1/144 s und bei zufällig schwankenden Frames bitgleich. Nach einem Hitch laufen höchstens 8 Ticks, der Rest wird verworfen.
- **E2E Desktop:** Handbremse + A bei etwa 15 m/s in der Stadt ergibt einen Driftwinkel von bis zu 33°.
- **E2E zwei Spieler:** Die Mitten beider Autos kommen sich beim Auffahren auf 3,99 m nahe. Das ist Kreis an Kreis (c + r je Bulli ≈ 2,0 m). Das Auto, das getroffen wird, schiebt die eigene Sim vorwärts.

## 21. Sandbox und Tuning-Werkzeug: Stand, Bedienung und Abweichungen

Stand nach dem Schritt „sandbox-tuning“. Die Sandbox und das Tuning-Panel laufen nur mit ihren URL-Flags. Ohne Flags lädt die Seite weder den Sandbox- noch den Panel-Code (eigene Chunks), und das Spiel verhält sich wie vorher.

### 21.1 Bedienung

| URL | Wirkung |
|---|---|
| `/?sandbox=1` | Offline-Testfläche statt der Stadt, impliziert `?physics=v2`, keine Server-Verbindung |
| `/?sandbox=1&tune=1` | dazu das lil-gui-Tuning-Panel mit Telemetrie |
| `/?physics=v2&tune=1` | Panel im normalen Spiel (Stadt, Multiplayer), ohne den Sandbox-Ordner |
| `&e2e=1` | zusätzlich `window.__bulliSim` (Sandbox: Dummies, Golden-Szenarien) und `window.__bulliTune` (Panel: Export, Import, Reset, Telemetrie) |

Lokal: `npm run dev`, dann `http://localhost:5173/?sandbox=1&tune=1`. Für die Sandbox allein reicht `npx vite`, weil sie keinen Server braucht. Nach `npm run build && npm start` gilt dieselbe URL auf Port 8000.

| Taste | Sandbox |
|---|---|
| W/S, A/D oder Pfeiltasten | Gas, Bremse/rückwärts, lenken |
| Leertaste / Shift / Q | Handbremse (Drift) / Boost / Sprung |
| R halten | Reset an Ort und Stelle (die Sandbox hat kein Straßennetz) |
| N | Dummies und Hütchen zurück auf ihre Plätze |
| C | nächste Karosse |

Dieselben Aktionen liegen als Knöpfe im SANDBOX-Kasten oben links, auch für Touch. Auf dem Handy liegt der Kasten dort, wo sonst das Radar ist (in der Sandbox ausgeblendet). Die Karosse wählt man außerdem im Splash-Screen oder im Panel.

**Panel (`?tune=1`):**

- *Telemetrie:* km/h, u, w, β (Drift), Gierrate r, Radeinschlag δ, Boost-Stand und -Zustand, Bodenkontakt, Drift, Luft-Ticks, Ticks seit Wandkontakt. Die Werte werden pro Sim-Tick geschrieben.
- *Verlauf 5 s:* Canvas-Plot der letzten 300 Ticks mit Tempo (km/h) und Driftwinkel (°). Die Skalen wachsen mit den Daten.
- *Global:* `gripScale`, `G_AIR`, `STICK`, das Assist-Profil des eigenen Autos, das Kameraprofil (race/legacy) und „Werte der Klasse“.
- *Antrieb, Reifen, Lenkung, Drift, Assists, Boost, Kollision, Sprung:* die Regler aus Tabelle 13, dazu der Ordner *Fahrwerk* (Masse, Radstand, Schwerpunkt, Trägheitsradius, driftFill) und *Alle globalen Werte* mit den übrigen `SIM_TUNING`-Werten. Mit `·K` markierte Regler ändern die in „Werte der Klasse“ gewählte Klasse (Standard: die eigene), `·P` das Assist-Profil des eigenen Autos, alle anderen gelten global. Winkel stehen in Grad.
- *Sandbox* (nur mit `?sandbox=1`): Powerup-Wirkungen zum Anklicken (Turbo, Mega, Super-Jump, Ghost, Schild), Karosse, Dummies zurücksetzen.
- *Export / Import:* „Export → Zwischenablage“ kopiert die geänderten Werte als JSON, „Import ← Zwischenablage“ lädt ein solches JSON, „Reset auf Defaults“ stellt alles zurück. Ist die Zwischenablage gesperrt, fragt ein Eingabedialog. „Golden gültig“ zeigt, ob die Golden-Dateien für die aktuellen Werte noch gelten.

Das Exportformat (`src/shared/sim/tuning.ts`):

```json
{
  "format": 1,
  "global": { "gripScale": 1.25 },
  "classes": { "sport": { "gripRear": 2.4 } },
  "profiles": { "touch": { "counterSteer": 0.8 } }
}
```

Es enthält nur die Werte, die von den Defaults abweichen. Winkel stehen darin in Radiant, wie in der Sim. Ein Import ersetzt das ganze Tuning: erst die Defaults, dann die Werte aus dem JSON. Er prüft vorher alles (bekannte Schlüssel, endliche Zahlen, `drive` nur `rear`/`all`) und ändert bei einem Fehler nichts. Übernehmen lassen sich Werte dauerhaft, indem man sie in `SIM_TUNING` (`sim/constants.ts`) bzw. `VEHICLE_CLASSES` (`sim/vehicleClasses.ts`) einträgt und die Golden-Dateien mit `UPDATE_GOLDEN=1 npm test` neu erzeugt.

### 21.2 Aufbau

**Shared (für Tests und Browser gleich):**

- `world/sandbox.ts`: `SANDBOX` (Layout), `sandboxColliders()`, `createSandboxWorld()`. Flache Welt der Standardgröße (Rand bei ±498), Fläche 400 × 400 m.
- `sim/dummies.ts`: `createDummy`, `resetDummy`, `driveDummy`. Die Dummies sind volle Sim-Autos (`kinematic = false`) im selben `stepWorld` wie das eigene Auto. Geparkte bekommen keinen Input. Kreisende folgen ihrem Kreis mit Pure Pursuit (Zielpunkt 14 m voraus, Volleinschlag ab 0,4 rad Kursfehler) und einem P-Regler auf das Tempo. Beides hängt nur vom Zustand ab, ein Lauf lässt sich also exakt wiederholen.
- `world/colliders.ts`: `rampEdgeColliders`, `insideRamp`, optionales Feld `ramp` an `Collider`/`ColliderInput`.
- `sim/tuning.ts`: `exportTuning`, `importTuning`, `resetTuning`, `tuningIsDefault` (prüft jetzt auch Klassen und Profile; `scenarios.ts` exportiert es weiter), `refreshCarParams`.

**Client:**

- `sandbox/sandbox.ts`: baut die Szene aus `SANDBOX`, hängt Welt und Dummies in die Hooks, rendert die Dummies interpoliert mit dem `alpha` des eigenen Autos, lässt Hütchen umfallen und stellt `__bulliSim` bereit.
- `debug/tuningPanel.ts`: das Panel, statisch mit lil-gui, selbst nur dynamisch importiert.
- `game/hooks.ts`: `world` (ersetzt die Stadt-Welt in `v2Driver`), `extraCars` (laufen im Tick von `LocalVehicle` mit), `beforeTick`/`afterTick` (Dummy-Fahrer, Telemetrie), `frame` (Dummy-Darstellung), `tuningChanged` (Klassen- und Profiländerungen erreichen bestehende Autos), `camera` (Profilwechsel). Ohne Flags bleiben alle Listen leer.

**Layout:**

| Element | Lage | Daten |
|---|---|---|
| Start | (0, −160), Blick +z | Startlinie |
| Kicker 10°, 15°, 20° | x = −25, 0, 25, z = −90 | 8 m breit, 16/14/12 m lang, 2,82/3,75/4,37 m hoch |
| Sprung mit Landehügel | x = 70 | Kicker 16 m/3 m, 16 m Lücke, Hügel aus steiler Vorderseite (6 m) und Landehang (24 m, 3 m) |
| Lange Wand | x = −60, z −190…30 | 1 m dick, 220 m lang |
| Pfostenreihe | z = 0, x −45…−15 | 13 Pfosten r 0,35 alle 2,5 m, zu eng für jedes Auto |
| Hütchen-Slalom | x = 0, z 20…140 | 9 Hütchen alle 15 m |
| Kurven | Mitte (110, 110) | aufgemalte Kreise R 40 und R 80 |
| Stadtecke | x −176…−56, z 68…176 | drei Blöcke, 12 m breite Straße mit 90°-Knick |
| Dummies | geparkt bei x = 40 (Pickup, Käfer, Jeep), kreisend Sport (R 40, 14 m/s) und Bulli (R 80, 20 m/s) | je eine Karosse, verschiedene Massen |

### 21.3 Abweichungen und Entscheidungen

1. **`?sandbox=1` statt eigenem Einstieg `sandbox.html`** (4.2, 12.7). Der Auftrag verlangt das Flag. Außerdem nutzt die Sandbox so genau den Client, den man später fährt: Renderer, HUD, Eingabe mit Touch und Gamepad, Kamera, Automodell und Effekte. Einen zweiten Bootstrap gibt es nicht. Der Sandbox-Code ist ein eigener, dynamisch geladener Chunk (~11 kB).
2. **Offline statt mit Server-Verbindung.** Das ist die robustere Wahl: Die Sandbox braucht keinen Server (auch nicht unter `npx vite`), es gibt keine Mitspieler, Respawns oder Party-Effekte, die dazwischenfunken, und der Ablauf ist reproduzierbar. Kontakt gegen echte Mitspieler bleibt im normalen Spiel testbar.
3. **Kanten-Collider der Rampen (7.2).** `rampEdgeColliders(ramp, index, front)` legt eine Wand an die hohe Vorderkante und Wandstücke von höchstens 4 m an beide Seiten. Jedes Stück ist so hoch wie die Rampe an seinem oberen Ende; Stücke unter 0,3 m fallen weg. Das geht nur für Rampen längs einer Achse, weil die Boxen achsparallel sind. Zusätzlich zum Überflug-Test überspringt die Kollision Rampenwände, wenn die Unterkante des Autos mehr als 0,3 m über dem Boden an der Wand liegt oder der Schwerpunkt über der Rampe steht. Nur so streift die Vorderwand ein abspringendes Auto nicht, dessen Unterkante im Absprung noch knapp unter der Kante liegt. *Geändert nach dem Review (23.1):* Die 0,3-m-Regel ließ fliegende Autos durch die Wand, die dann per Landung auf die Rampe gehoben wurden. Jetzt lässt eine Wand ein Auto durch, das auf der Rampe steht, sich von ihr weg bewegt (> 0,1 m/s nach außen) oder höchstens 0,35 m unter der Rampenfläche an der nächsten Stelle des Grundrisses ist. `createSimWorld` legt selbst keine Wände an, die Golden-Dateien bleiben unverändert.
4. **Landehügel aus zwei Rampen** (Flag `hill`, ohne Wand an der gemeinsamen Kante). Eine einzelne, zum Kicker gewandte Rampe hätte eine senkrechte Stirnfläche im Höhenfeld. Landete ein Auto genau auf deren Kante, maß die Zentraldifferenz einen riesigen Gradienten; gemessen wurde ein Landeaufprall von 94 m/s. *Seit 23.1 nimmt der Gradient die exakte Rampensteigung bzw. nur das Terrain; der Hügel bleibt trotzdem so.*
5. **Flache Kurven statt Steilkurven.** Der Boden der Sim ist ein Höhenfeld aus Terrain und Keilrampen. Eine Steilkurve bräuchte eine neue Flächenart in shared, und das 2,5D-Modell hat kein Rollen; nur der Hangabtrieb würde wirken. Die aufgemalten Kreise R 40 und R 80 zeigen den Kurvenradius, die kreisenden Dummies nutzen sie. Steilkurven sind möglich, sobald der Blindtest sie verlangt.
6. **Hütchen nur optisch.** Ein statischer Collider mit r 0,35 wäre ein Pfosten, an dem man mit 50 m/s hängen bleibt. Die Hütchen kippen um, wenn ein Auto sie berührt, und stehen mit N wieder.
7. **Dummies geparkt oder kreisend.** Die Spezifikation nannte zusätzlich „geradeaus“. Auf einer 400-m-Fläche wäre ein geradeaus fahrender Dummy nach wenigen Sekunden am Rand; die kreisenden decken bewegte Ziele ab.
8. **Panel nur mit `?tune=1`**, auch in der Sandbox (12.7 sah es dort offen vor). So verlangt es der Auftrag; auf dem Handy startet es eingeklappt und liegt unter der Punkteanzeige.
9. **Export als JSON statt als TS-Literal** (13), wie im Auftrag. Das JSON lässt sich trotzdem direkt in TS einfügen.
10. **Telemetrie ohne αF/αR, FzF/FzR und ohne Vektoren im 3D-View** (13, Ordner Debug). Die Größen sind Zwischenwerte in `integrateForces` und liegen nicht im Zustand. Für die Anzeige müsste man die Formeln doppeln oder die Sim um Debug-Ausgaben erweitern. Beides lohnt erst, wenn das Tuning es braucht.
11. **lil-gui als devDependency** (4.2 sagte dependency), wie `three`: Vite bündelt sie in den Client, und das Server-Image (`npm ci --omit=dev`) braucht sie nicht.
12. **`LocalVehicle.profile` ist veränderbar**, damit das Panel das Assist-Profil umschalten kann (danach `refreshCarParams`).
13. **E2E-Test `v2-desktop`**: Das Bremsen bis zum Stillstand wird jetzt pro Frame im Browser geprüft. Die Abfrage per Poll konnte den kurzen Stillstand verpassen. Die Bremse geht nach 8 Ticks im Stand in Rückwärtsfahrt über, und der Test sah dann nur noch ein Auto, das mit 15 m/s rückwärts fuhr (einmal im vollen Lauf aufgetreten).

### 21.4 Tests und Messwerte

- **Vitest** (`tests/shared/sim/sandbox.test.ts`, `tuning.test.ts`):
  - Alle Collider liegen auf der Fläche; Pfosten haben r ≥ 0,35, Wände mindestens 0,25 m halbe Dicke.
  - Start und Dummy-Plätze sind frei, liegen nicht auf Rampen und mindestens 10 m auseinander.
  - Die Welt wird bei jedem Aufbau gleich gebaut.
  - Form der Rampenwände, auch für gedrehte Rampen und mit `front = false`.
  - Alle 5 Klassen springen mit 28 m/s von allen drei Kickern ohne Wandkontakt ab.
  - Von hinten und von der Seite mit 20 m/s: Das Auto wird gestoppt (Aufprall > 15 m/s) und hebt nicht ab (y < 5 cm).
  - Sprung mit 30 m/s: landet auf dem Landehang mit einem Aufprall unter 10 m/s (gemessen 4,2 m/s), ohne Wandkontakt.
  - Gleiten an der langen Wand unter 10° mit 40 m/s: nach 2 s noch über 35 m/s.
  - Alle Klassen mit 85 m/s auf die Pfostenreihe, auf einen Pfosten und mittig dazwischen: Keine kommt durch.
  - Kreisende Dummies nach 10 s: Abstand zum Kreis höchstens 1,33 m (Sport, R 40) bzw. 0,36 m (Bulli, R 80), Tempoabweichung ≤ 0,35 m/s. Geparkte bleiben ohne Kontakt exakt stehen.
  - Ein Rammstoß mit 20 m/s schiebt einen geparkten Dummy über 2 m weg; der Reset stellt ihn exakt zurück.
  - Ein Sandbox-Lauf über 900 Ticks lässt sich bitgleich wiederholen.
  - Tuning: Export nur der Änderungen, Rundreise über JSON, Import ersetzt alles, 14 Arten fehlerhafter Eingaben werden abgelehnt, ohne etwas zu ändern, und bestehende Autos übernehmen Änderungen.
- **Playwright:**
  - `sandbox.spec.ts` (Desktop): Die Sandbox lädt ohne WebSocket, und ohne `?tune=1` lädt weder das Panel noch lil-gui. Es gibt 5 Dummies mit 5 Karossen, die kreisenden fahren. Das Auto rammt den geparkten Käfer und schiebt ihn weg (in Rammrichtung). N setzt ihn zurück, C wechselt die Karosse.
  - Zweiter Test dort: Das Panel lädt mit `?tune=1`, die Telemetrie läuft beim Fahren mit, ein importierter Wert (`topSpeed` 61) erreicht das Sim-Auto, und Reset stellt es zurück.
  - `v2-sandbox-mobile.spec.ts` (iPhone 13): Der Sandbox-Kasten überdeckt keine Touch-Bedienelemente, Auto-Gas fährt, und der Knopf zum Karossenwechsel funktioniert per Tippen.
  - `sim-golden.spec.ts`: Alle 19 Golden-Szenarien laufen im Browser über `__bulliSim.runGolden` und stimmen mit den JSON-Dateien überein (14.4; ursprünglich auf 1 mm bzw. 1e-4 rad, seit 24.2 mit derselben Toleranz wie Node).
- **Bundle:** Ohne Flags lädt die Seite nur `index` und `three`. Die Sandbox (~11 kB), das Panel mit lil-gui (~39 kB) und das gemeinsame Tuning-Modul (~2 kB) sind eigene Chunks.

## 22. Absicherung und Doku: FPS-Test, Leistung, Blindtest

Stand nach dem Schritt „fps-and-docs“. Damit ist Phase 1a umgesetzt und wartet auf den Blindtest durch den Nutzer. Danach folgt das Löschen der Legacy-Physik; beides ist nicht Teil dieses Laufs.

### 22.1 FPS-Unabhängigkeit des ganzen Client-Ticks

`tests/client/loop.test.ts` (14.6) prüft den `FixedStepLoop` mit `stepVehicle`. Neu ist `tests/client/fpsIndependence.test.ts`: Er fährt den echten Client-Pfad, also `LocalVehicle.update` einmal pro Frame, in Node mit:

- Tastatur über den `InputManager`, einschließlich eines Sprungs, der zwischen zwei Ticks gedrückt und wieder losgelassen wird (Pulse-Latch)
- Powerup-Timer, die pro Tick zählen (Turbo läuft nach 1 s aus)
- Sandbox-Welt mit Rampen und Wänden und die fünf Dummy-Autos im selben `stepWorld` (über `gameHooks`)
- Rammstoß gegen den geparkten Käfer, Handbremsen-Drift, Sprung und Boost

Frames von 1/30, 1/60 und 1/144 s und zwei unregelmäßige Folgen (4–45 ms, feste Seeds) über 5 s ergeben pro Tick bitgleiche Zustände aller sechs Autos, dieselben Inputs, dieselben Turbo-Zustände und genau einen Sprung. Die Zahl der Ticks weicht um höchstens einen ab, weil die Summe der Frame-Zeiten in Gleitkomma knapp unter oder über 300 Ticks landen kann.

**Gegenprobe:** Zwei typische Fehler testweise eingebaut, beide schlagen an: die Render-Pose schreibt den interpolierten Yaw in die Sim zurück, und die Powerup-Timer zählen mit der Frame-Zeit statt mit `DT`.

**Remote-Proxies (nach dem Review, 23.3):** Früher bekamen alle Ticks eines Frames dieselbe Zeit für `collectRemoteProxies`. Bei 30 FPS setzte der zweite Tick eines Frames einen fahrenden Proxy um v·DT zurück, und das Rempeln eines fahrenden Mitspielers hing von der Framerate ab. Jetzt sagt `FixedStepLoop.advance` jedem Tick, wie weit sein Zeitpunkt vor dem Frame-Ende liegt, und ein Test rammt einen Proxy bei 30, 60, 144 FPS und unregelmäßigen Frames mit bitgleichem Ergebnis.

**Warum pro Tick-Index:** Eine Taste, die zu einer Wanduhr-Zeit gedrückt wird, erreicht die Sim mit dem nächsten Tick nach dem Frame, der sie sieht. Bei anderer Framerate kann das ein Tick später sein. Das ist die Eingabelatenz des Frames, keine Abhängigkeit der Sim von der Framerate.

**Abweichung:** Den Akkumulator als Funktion zu extrahieren war nicht nötig. `FixedStepLoop` ist schon eine Klasse ohne DOM, und `LocalVehicle` lässt sich mit einem `VehicleHost` aus `THREE.Group`s in Node betreiben.

### 22.2 Sim-Kosten pro Frame

- `LocalVehicle` summiert die CPU-Zeit aller Ticks (`simMsTotal`) und merkt sich die Zahl der Autos im letzten `stepWorld` (`simCars`). Das sind zwei Aufrufe von `performance.now()` pro Frame, auch ohne Flag.
- `?debug=perf` zeigt daraus die Zeile `sim` (ms pro Frame, Autos). `__bulliPerf.stopRecording()` liefert `sim` mit Ticks, Ticks pro Frame, ms pro Frame (Verteilung, auf 0,001 ms), ms pro Tick und Autos. Mit der Legacy-Physik ist `sim` `null`.
- `npm run perf:baseline` hat die Optionen `--physics=v2` und `--sandbox` (impliziert v2; jeder Client fährt seine eigene Offline-Sandbox).
- E2E (`perf-overlay.spec.ts`): Legacy ohne `sim`; Sandbox mit `sim`, 6 Autos und gezählten Ticks.

**Messwerte** (M5 Pro, Headless-Chromium, Einzelheiten in [`baseline.md`](baseline.md)):

- Im Spiel pro Frame im Mittel 0,044 ms in der Stadt (eigenes Auto + 1 Proxy) und 0,087–0,089 ms in der Sandbox (eigenes Auto + 5 Dummies), Desktop wie iPhone-Viewport. Das ist gut 0,5 % eines 60-FPS-Frames.
- Im heißen Loop kosten dieselben 6 Autos 0,019 ms pro Tick (Chromium) bzw. 0,009 ms (Node). Im Spiel kostet ein Tick 4–5-mal so viel, weil zwischen zwei Ticks gerendert wird.
- Bei ~10 FPS (SwiftShader) laufen 5 Ticks pro Frame, die Sim hält 83–89 % der Echtzeit (Frames über 133 ms werden gekappt, 12.1). Die Legacy-Physik schafft bei 10 FPS nur ein Drittel.

### 22.3 Doku und Blindtest

- [`phase-1a-playtest.md`](phase-1a-playtest.md): Anleitung für den Blindtest auf Deutsch mit URLs, Blindschaltung per Münzwurf, Fragebogen, Beobachtungspunkten, einer Tabelle „Eindruck → Regler“ und der Rückmeldung als JSON-Export aus dem Panel.
- [`refactor-plan.md`](refactor-plan.md): Phase-1a-Status mit Deliverables und Exit-Stand; die Topspeed-Entscheidung steht als Entscheidung 7 in Abschnitt 0.
- [`baseline.md`](baseline.md): Abschnitt Phase 1a mit den Sim-Kosten, Rohdaten unter `docs/baseline/2026-09-23-1a-*.json`.

**Außerhalb des Auftrags, für den Blindtest nötig:** Der Startbildschirm zeigte auch mit `?physics=v2` „SPACE jump“. Mit v2 steht dort jetzt „SPACE drift · Q jump“ (`.v2-only`); „F honk“ entfällt in v2, damit die Zeile wie bei Legacy vier Einträge hat. Die Hupe steht weiter im ABOUT-Fenster. Ohne Flag ist der Startbildschirm unverändert.

### 22.4 Offen nach Phase 1a

1. **Blindtest durch den Nutzer** (4 von 5, auch auf dem Handy), getunte Werte als JSON übernehmen und die Golden-Dateien neu erzeugen.
2. **Legacy-Physik löschen**, wenn v2 gewinnt: `vehicle/legacyPhysics.ts`, die Legacy-Zweige in `controls/keyboard.ts`, `controls/mobile.ts` und `main.ts`, die `.legacy-only`-Elemente in `index.html`; `?physics=v2` wird Standard.
3. E2E-Test für eine gemischte Session aus v2 und Legacy (20.12).
4. Messung auf dem Referenz-Handy (FPS, Sim-Zeit, Touch-Gefühl) und Feinschliff von Renn-Kamera und visueller Feder auf echten Geräten.

## 23. Review nach Phase 1a: Korrekturen und bewusst offene Punkte

Ein adversarielles Review (Sim-Korrektheit, Netcode-Tauglichkeit, Client-Parität und Mobile, Tests und Doku) hat 21 Befunde bestätigt. Alle Korrekturen gelten nur mit `?physics=v2` bzw. nur für v2-Elemente; ohne Flag verhält sich das Spiel wie vorher.

### 23.1 Bodenkontakt

- **Knick im Stadt-Übergangsring** *(ersetzt durch die Federung, 26; die alte Stadt ist seit Phase 3 keine Spielwelt mehr)*: Das Terrain wird mit `t²` eingeblendet, an der Außenkante (d ≈ 204 m) springt die Steigung. Früher warf dieser Knick das Auto mit der vollen Steigungsgeschwindigkeit ab (bis 25 m/s, 7–12 m Flughöhe bei 45 m/s). Jetzt behält ein Auto, das von Terrain auf Terrain fährt, beim Abheben höchstens die Vertikalgeschwindigkeit des Bodens voraus plus 2 m/s. Rampen behalten ihre Absprunggeschwindigkeit. Test: Überfahrt des Rings alle 15°, hinein und hinaus, Bulli mit 45 m/s und Vollgas → höchstens 0,3 m über dem Boden. Den Blend auf Smoothstep umzustellen hätte auch Legacy und die Optik verändert und bleibt deshalb aus.
- **Gradient:** Statt der Zentraldifferenz über `groundHeight` (±0,5 m über Rampenkanten hinweg, bis 4,4 Scheinsteigung) nimmt die Sim die exakte Steigung der Rampe unter dem Auto, sonst die Zentraldifferenz des Terrains allein. Kein Vorwärtsstoß mehr vor der Absprungkante, und eine Landung neben oder auf der Rampenkante hat den Aufprall ihrer Vertikalgeschwindigkeit (Test: 4–7 m/s bei vy = −5).
- **Rampenwände:** Neue Regel siehe 21.3, Punkt 3. Ein Sprung gegen Front oder Seite wird von der Wand gestoppt, statt das Auto in einem Tick auf die Rampe zu heben, und wer seitlich von der Rampe rollt, bewegt sich pro Tick höchstens um |v|·DT + 5 cm.
- **Niedrige Collider** (Brunnen, Teich, Bank, Kübel, Fels): Man landet auf ihrer Oberkante (7.1) und fährt wieder herunter, statt um bis zu 8 m in einem Tick herausgeschoben zu werden. `SimWorld` hat dafür `terrainHeight` und `rampAt`. Ein Party-Ghost steht auf nichts. Test: Sprung auf Brunnen und Teich über viele Absprungpunkte, der Versatz pro Tick bleibt ≤ |v|·DT + 0,5 m.

### 23.2 Dynamik und Robustheit

- **Kinematische Überblendung am Gesamttempo** (6.4): `k` hing an |u|. Ein Auto, das mit hohem Tempo quer rutscht (u ≈ 0), verlor 1/6 seiner Quergeschwindigkeit pro Tick. Ein von der Seite gerammter Käfer blieb nach 2 m kleben, unter 60° rutschte er 60 m. Jetzt bremsen die Reifen das Querrutschen. Die Golden-Datei `contact-t-bone` ist neu erzeugt.
- **NaN:** Nicht endliche oder nicht numerische Eingabeachsen zählen als 0. Die Kontakttests in `contact.ts` sind so formuliert, dass NaN sie nicht besteht. `stepWorld` setzt ein Auto mit nicht endlichem Zustand zurück (Event `reset`). Vorher machte ein NaN-Lenkwert in zwei Ticks jedes Auto der Welt zu NaN, egal wie weit entfernt.
- **Kontaktmasse:** `contactMass` wird in `applyModifiers` aus `base.mass` abgeleitet (×3 Mega, ×2 Schild). Vorher wirkten der Masse-Regler des Panels und importierte Tunings nicht auf das Rempeln.

### 23.3 Client

- **Gehaltene Tasten:** Fahrtasten, Leertaste und Shift nehmen auch Tastenwiederholungen an, sodass eine über Respawn, Modal oder Fokuswechsel gehaltene Taste sofort wieder wirkt (wie bei Legacy). Sprung und Reset bleiben flankengesteuert.
- **Gamepad am Touch-Gerät:** Auto-Gas bei losgelassenem Stick weicht einem benutzten Gamepad oder einer Fahrtaste (20, Punkt 4).
- **Powerup-Timer bei eingefrorener Sim** zählen pro Frame weiter (10, 12.1). Vorher überdauerten Ghost, Turbo und Super-Jump ein offenes Modal oder den Respawn-Countdown.
- **Remote-Proxies pro Tick** (22.1).
- **Touch-HUD:** Der Hinweis „HOLD JUMP TO RESET“ und die Powerup-Meldungen lagen unten mittig unter DRIFT und dem Joystick. Mit v2 stehen sie auf Touch-Geräten jetzt über den Fahrbuttons, im Querformat unten zwischen Stick und DRIFT (umbrechend, wo die Lücke schmal ist). Auf 320 px breiten Phones sind Stick, DRIFT, BOOST und Boost-Leiste etwas kleiner, damit DRIFT den Stick und die Leiste die Minimap nicht mehr überdeckt. Der E2E-Test `v2-mobile.spec.ts` prüft das ganze Touch-HUD mit Hinweis auf 320, 360 und 390 px, im Querformat und auf dem Tablet.

### 23.4 Tests

- **Tunneling-Matrix mit Startphase** (14.5, 19.11): Gegenprobe mit `SUBSTEPS = 1` schlägt jetzt an.
- **Schild an der Wand:** Der Test verlangt einen Treffer und dass das Auto vor der Wand bleibt. Vorher lief ohne Treffer keine einzige Prüfung, und ein Schild, der Wände ganz abschaltet, blieb grün.
- **Drift-Hysterese:** Der Test setzt β und prüft das Ende genau am zehnten Tick unter 6° sowie eine kurze Senke, die den Drift hält.
- **`sandbox.spec.ts`:** Vor dem Reset der Dummies wird das eigene Auto weggesetzt. Es konnte noch direkt hinter dem Käfer rollen und ihn nach dem Reset wieder wegschieben (flaky, etwa 1 von 13 Läufen).

### 23.5 Nur dokumentiert, nicht im Code geändert

- **Felsen-RNG und Collider-Reihenfolge:** Eine eigene Zufallsfolge für die Fels-Collider würde die Felsen verschieben und damit das Spiel ohne Flag ändern. Beides steht als Vorgabe für die Portierung in Abschnitt 18.
- **Globales Tuning und Einfrieren** betreffen erst die Server-Sim von 1b; die Regeln stehen in Abschnitt 18.
- **Sim-Kosten:** Der Plan nennt jetzt wie `baseline.md` den Mittelwert ≤ 0,09 ms pro Frame, p95 0,2 ms, Spitzen bis 0,4 ms.

## 24. Integration auf main: Grafik G0 und plattformrobuste Goldens

### 24.1 Rebase auf G0

Phase 1a liegt jetzt auf `main` mit Phase 0 (Squash) und Grafik G0 (`render/lighting.ts`, Himmel, Nebel, ACES, Schatten, Kontaktschatten, Rauch-Sprites). Die alten Lichter aus `main.ts` sind weg, `setupLighting`/`updateLighting` bleiben an ihrer Stelle im zerlegten `main.ts`. Beides hängt an Feldern, die `LocalVehicle` bei v2 ohnehin schreibt: Schattenkamera und Kontaktschatten lesen `group.position`/`quaternion` und `flipGroup.position.y` direkt vor dem Rendern, also die interpolierte Pose; der Rauch liest `speed` und `angle`. Neu: Die Sandbox-Dummies (reine `CarModel`, nicht in `state.remotePlayers`) melden sich über `gameHooks.extraModels` an und bekommen ebenfalls Kontaktschatten. Der e2e-Hook hat beide Erweiterungen: `setCameraOverride` für die Screenshots und `placeLocalCar`, das bei v2 das Sim-Auto versetzt.

### 24.2 Goldens über Plattformen

Die Golden-Dateien entstehen auf macOS arm64 (Node 24), CI prüft auf Linux x64 (Node 22). `Math.sin/cos/tan/atan2/exp/pow/hypot` sind nicht korrekt gerundet und dürfen dort im letzten Bit abweichen (der Terrain-Golden aus Phase 0 brach genau daran). `scripts/sim-golden-drift.ts` misst beide Seiten:

- **Rauschen:** Jedes nicht exakte Ergebnis dieser Funktionen um ±1, 2 oder 16 ulp verschoben (alle zugleich, zufällig je Aufruf oder nur 1 % der Aufrufe) verschiebt die Goldens nach 180 Ticks um höchstens 7e-12 · max(1, |Wert|) (1 und 2 ulp: 5e-13 bzw. 7e-13). Kein Zähler und kein Flag ändert sich.
- **Echte Änderungen:** Jeder der 52 Werte in `SIM_TUNING` einzeln um den Faktor 1 + 1e-6 geändert: Die 26, die in den Szenarien überhaupt wirken, verschieben die Goldens um 1,4e-9 bis 1e-4, die übrigen gar nicht.

Die Toleranz 1e-9 · max(1, |Wert|) liegt damit drei Größenordnungen über dem Rauschen und fängt noch Änderungen von einem Millionstel. Ein Test in `golden.test.ts` hält das fest (`G_TIRE` × (1 + 1e-6) muss auffallen).

Nachtrag Abdeckung: Die ersten zehn Szenarien nutzten weder den Jeep noch das Profil `touch` (seit v2 Standard auf jedem Handy) noch Boost, Rückwärtsgang, Sprungtaste, Reset oder Proxy-Kontakte; eine Änderung von jeep.topSpeed um 0,1 % blieb grün. Mit den Szenarien 11–19 fallen bei × 1,001 beide Assist-Profile, vtop, Beschleunigung, Bremse und Grip aller Klassen in mindestens einem Szenario auf. Ohne Szenario-Treffer bleiben Offroad (noch ohne Wirkung), die Sprunghöhe außer beim Jeep, Massen und Kollisionsmaße von Klassen ohne passendes Kontaktszenario, einige Rutsch- und Handbremswerte von pickup und jeep sowie Schwellen wie `BOOST_MIN`, `COYOTE_TICKS` oder `R_MAX`. Die Messung mit 1 + 1e-6 fängt 41 von 41 wirksamen `SIM_TUNING`-Werten. Den Rest deckt das Tuning-Golden ab. Das stärkste Rauschen liefert jetzt der Slalom (16 ulp: 7,3e-12), die Toleranz bleibt damit gut zwei Größenordnungen darüber.

Die Messung fand einen echten Kipppunkt: `wall-graze-10deg` startete den Bulli genau mit seinem vtop von 50 m/s bei Vollgas. Dort springt der Antrieb zwischen „deckt den Fahrwiderstand“ (xs < 1) und „nichts“ (xs ≥ 1), und ob u = 50·(sin²+cos²) auf 50 oder knapp darunter rundet, hing vom letzten Bit von sin/cos(10°) ab: 5 cm Unterschied nach 3 s, bei jeder Toleranz ein Fehlschlag. Das Szenario startet jetzt mit 49 m/s, die Datei ist neu erzeugt. Die Unstetigkeit in der Sim selbst bleibt (sie betrifft nur Autos, die exakt auf vtop gesetzt werden; mit Vollgas von unten bleibt der Bulli nach 100 s rund 5e-13 m/s unter vtop stehen); für 1b ist sie ein Kandidat, wenn Server und Client auf verschiedenen Plattformen rechnen.

## 25. Livegang: v2 ist Standard

Auf Wunsch des Nutzers gehen neue Features direkt live statt hinter Flags. Der Blindtest entfällt deshalb als Gate; v2 ist ohne URL-Parameter aktiv.

- **Flags (`client/flags.ts`):** `PHYSICS_V2` ist wahr, außer bei `?physics=legacy` (Notausgang). `?physics=v2` bleibt gültig und ändert nichts. `?sandbox=1` läuft immer mit v2, auch zusammen mit `?physics=legacy`.
- **HUD und Hinweise:** `index.html` startet mit `body.physics-v2`, `main.ts` entfernt die Klasse bei `?physics=legacy`. So zeigt die Seite schon vor dem ersten Skript die v2-Elemente (`.v2-only`), und „SPACE jump“ erscheint nur noch im Legacy-Modus. Startbildschirm v2: „WASD drive · SPACE drift · SHIFT boost · Q jump · E shoot“, auf Touch-Geräten stattdessen „STICK steer · AUTO gas · DRIFT · BOOST“. Das ABOUT-Fenster listet mit v2 zusätzlich die Touch-Steuerung.
- **Kamera:** Die Renn-Kamera sitzt niedriger (4,8 m, FOV 60°) und im Hochformat weiter weg (12.5).
- **Werkzeuge:** `npm run perf:baseline` misst ohne Option v2 (`--physics=legacy` für die alte Physik). `npm run screenshots` nimmt v2 auf, `--physics=legacy` die alte Physik, und schreibt für die Ansichten der Verfolgerkamera den Anteil des Autos am Bild in `stats.json` (`__bulliDebug.localCarScreenBox()`). Neue Ansicht `corner`: das Auto schräg an einer Kreuzung.
- **E2E:** Die v2-Tests laufen ohne Parameter. Die bisherigen Tests der alten Physik (Desktop mit Tempo-Messung, Touch, zwei Spieler, Perf-Overlay ohne `sim`) öffnen die Seite mit `?physics=legacy`. `physics-default.spec.ts` prüft, dass ohne Parameter und mit `?physics=v2` v2 aktiv ist (Startbildschirm, ABOUT, Sim-Auto, Kamera) und dass `?physics=legacy` die alte Physik mit ihren Hinweisen und ihrer Kamera einschaltet. Das Perf-Overlay in der Stadt zählt jetzt die Sim-Ticks des eigenen Autos.
- **Aufräumen:** Wenn v2 einige Tage ohne Probleme live läuft, wird die Legacy-Physik gelöscht (`vehicle/legacyPhysics.ts`, die Legacy-Zweige in `controls/keyboard.ts`, `controls/mobile.ts`, `main.ts`, `ui/hud.ts`, `.legacy-only` in `index.html`, `LEGACY_CAMERA`, die Legacy-E2E-Tests und `?physics=legacy`).

## 26. Vertikaldynamik mit Federung, kein Sprung

Auftrag: Das Auto klebte am Boden, auch über Bodenwellen mit hohem Tempo. Das System wird ersetzt, der Sprung entfällt.

### 26.1 Warum das Auto klebte

Gemessen mit `scripts/sim-airtime.ts` (26.6): Selbst eine Bodenwelle von 1,5 m Höhe auf 12 m Länge warf das Auto bei 55 m/s nicht ab (0,00 s in der Luft, obwohl der Boden mit 21 m/s steigt). Ursachen, alle in `finishTick` (6.6 in der alten Fassung):

1. **Einrasten auf den Boden:** Am Boden wurde `y = hN` gesetzt und `vy = clamp((hN − y)/DT, −30, 25)`. Die Höhe folgte jeder Oberfläche exakt, auch über eine Kuppe weg.
2. **Abheben nur mit Zusatz-Gravitation:** Abheben nur, wenn die Wurfbahn mit `G_AIR + STICK` (20 + 8 = 28 m/s², 2,9 g) über `hN + AIR_GAP` (0,15 m) lag. Eine Kuppe musste also v²·κ > 28 m/s² fordern und das Auto dabei noch 15 cm über den Boden tragen.
3. **Abhebe-Deckel „Terrain-Knick“ (23.1):** Von Terrain auf Terrain wurde `vy` beim Abheben auf die Vertikalgeschwindigkeit des Bodens voraus plus 2 m/s gedeckelt. Hinter einer Kuppe fällt der Boden voraus, der Deckel nahm dem Auto also genau den Schwung, mit dem es hätte fliegen sollen. Nur Rampen (eigene Steigung, kein Deckel) warfen noch ab.
4. **Gravitation nur in der Luft**, keine Vertikalgeschwindigkeit am Boden jenseits der Bodengeschwindigkeit, keine Federung: Senken und Landungen rasteten hart ein (`vy = 0`).

Der Sprung (`BTN_JUMP`, `jumpSpeed` 11 m/s, Coyote-Zeit 6 Ticks, Cooldown 20 Ticks, Salto über `flipAngle`/`flipRate`) war die einzige Art, von ebenem Gelände abzuheben.

### 26.2 Das neue Modell (`stepVertical` in `vehicle.ts`)

Ein Aufbau auf einer Feder mit Dämpfer über masselosen Rädern, pro Substep (3 je Tick, Δt = 1/180 s) nach der xz-Bewegung, der Welt-Kollision und dem Auto-Kontakt:

- **Zustand:** `y` bleibt die Unterkante an den Rädern (am Boden gleich der Bodenhöhe, damit alle Collider-, Rampenwand-, Wasser- und Kontakt-Regeln unverändert gelten). Neu ist `susp`: die Lage des Aufbaus über seiner Ruhelage (+ ausgefedert, − eingefedert). `vy` ist die Vertikalgeschwindigkeit des Aufbaus.
- **Am Boden:** Der Aufbau behält seine Höhe, während der Boden unter den Rädern wechselt (`susp += y − hN; y = hN`). Kraft je Masse `F = g − k·susp + c·(v_Boden − vy)` mit `k = (2π·SUSP_FREQ)²`, `c = 2·SUSP_DAMPING·√k`, `v_Boden = ∇h·v_xz` (exakte Rampensteigung bzw. Terrain, wie der Aufprall in 23.1). Die Räder können nicht ziehen: `F ≥ 0`. Semi-implizit: `vy += (F − g)·Δt; susp += vy·Δt`. In Ruhe ist `susp = 0` exakt (F = g), auf ebenem Boden bleibt alles bitgleich wie vorher (alle Goldens auf ebenem Boden unverändert, 26.5).
- **Abheben:** Die Feder ist bei `susp = g/k` (12,7 cm) entspannt. Steigt der Aufbau darüber, verlassen die Räder den Boden. Quasistatisch folgt das Auto einer Kuppe, solange v²·κ ≤ g (die Feder entlastet um v²·κ/k), darüber hebt es ab. Kein Deckel, kein Zusatzzug.
- **Senken, Rampenfuß, harte Landung:** Die Feder federt ein. Bei `susp = −SUSP_TRAVEL` (0,25 m) sitzt der Aufbau auf dem Anschlag: Er bewegt sich mit dem Boden (`vy = max(vy, v_Boden)`), unelastisch, kein Abprall.
- **In der Luft:** `vy −= g·Δt; y += vy·Δt`, Landung sobald `y ≤ hN` (in jedem Substep, auch bei 85 m/s nie unter den Boden). Aufprall und Tempoverlust über 10 m/s wie bisher (23.1). Danach übernimmt die Feder mit dem voll ausgefederten Aufbau.

**Parameter:** `GRAVITY` 20 m/s² (bisher `G_AIR`), `SUSP_FREQ` 2 Hz, `SUSP_DAMPING` 0,8, `SUSP_TRAVEL` 0,25 m. Stabil: ω·Δt = 0,07, c·Δt = 0,11 je Substep.

**Warum `GRAVITY` bei 20 bleibt (entschieden, gemessen):** Die Abhebe-Schwelle ist v²·κ > `GRAVITY`, 1 g würde also mehr Kuppen abheben lassen. Mit 14 m/s² und 16 m/s² fliegen aber alle Rampen 1,2- bis 1,4-mal so weit; Strecken, Landezonen (`JUMP_LANDING`) und die Landeprüfung des Validators sind auf 20 m/s² ausgelegt. Gemessen mit den Bots (`driveTrack`, alle Strecken und Klassen): bei 14 m/s² landet der Sport-Bot auf der Ridge Climb nach der Canyon-Rampe zu schnell vor der Kurve (27 m neben der Linie) und ein Bulli-Bot auf der Grand Tour braucht einen Reset; bei 16 m/s² verpasst der Sport eine Rampe. Bei 20 m/s² bleiben alle Rampen und Flugweiten wie bisher. Die Straßenkuppen der Karte sind mit R ≥ 150 m ausgerundet (phase-3-design A5); sie heben erst ab etwa 55 m/s ab (Boost, Turbo). Scharfe Kuppen, Knicke und Bodenwellen werfen dagegen schon bei normalem Tempo ab (26.6). `GRAVITY` ist ein Regler im Tuning-Panel.

**Reifenlast:** `G_TIRE` bleibt konstant; die Federkraft geht (noch) nicht in den Grip ein. Sonst verlören Bots auf Kuppen vor Kurven Grip, den ihr Geschwindigkeitsprofil nicht kennt. Kann später kommen.

### 26.3 In der Luft: kein Antrieb, keine Lenkung, Landehilfe (entschieden)

Ohne Reifenkontakt wirken weder Gas, Bremse, Boost noch Lenkung (bisher: halber Boost und Gierziel `st·AIR_YAW` mit 1,5 rad/s). Die Gierrate läuft mit `AIR_YAW_RESPONSE` (3/s) auf `AIR_ALIGN·β` (2/s mal Schräglaufwinkel): Die Nase dreht sich in die Flugrichtung, das Auto landet gerade und ohne Rutschen. Begründung: Mit Luftlenkung (erst 1,5 rad/s², bis 1 rad/s) hielten Bots im Hüpfer über eine Kuppe in der Kurve voll eingeschlagen, drehten in der Luft und landeten quer in der Wand (Grand Tour, gemessen). Ohne Landehilfe landete der Sport-Bot nach der Canyon-Rampe mit 10° Schräglauf und schaukelte sich auf 34° auf. Die Landehilfe ist wie Gegenlenk-Hilfe und Spin-Guard eine Arcade-Hilfe, keine Physik. Nick und Rollen zur Landung sind Sache der Darstellung: Die Sim hat keinen Nick-/Rollwinkel (es gibt also auch keinen Überschlag), die Darstellung neigt das Auto nach der Geländenormalen unter ihm (12.3), also nach der Landefläche.

### 26.4 Sprung entfernt

- **Sim:** `BTN_JUMP` (Bit 4), `jumpSpeed`, `COYOTE_TICKS`, `JUMP_COOLDOWN`, `jumpCooldown`, `flipAngle`, `flipRate`, `prevButtons` (nur für die Sprung-Flanke), `ev.jumped`, `STICK`, `AIR_GAP`, `AIR_YAW` und der Abhebe-Deckel sind weg. `clampInput` behält nur `BTN_MASK` (Handbremse, Boost, Reset); die Sim ignoriert Bit 4 ohnehin (Test).
- **Super-Jump:** entfernt, nicht umgewidmet (ein Aufwärtsimpuls wäre wieder ein Sprung). Der Powerup-Pool der Party hat fünf Typen (Turbo, Mega, Schild, Magnet, Ghost); die Items der Karte verteilen sich reihum darauf.
- **Protokoll v5:** Self-Block ohne `flipAngle`, `flipRate` (f64), `jumpCooldown`, `prevButtons` (u8), mit `susp` (f64): 148 statt 158 Byte. Im Compact-Record steht statt des Flip-Winkels die Federung (i8 in 5 mm). Car-Flags `1 << 5` (Super-Jump) und `1 << 11` (Flip) und Mod-Bit 4 sind frei. Die Geister-Spur behält 13 Byte je Probe, der Flip-Byte ist jetzt Reserve (neue Tuning-Werte ergeben einen neuen `simHash`, alte Geister werden ohnehin nicht mehr angeboten).
- **Rennregel E4** (kein Sprung im Rennen): Der Eingabefilter lässt im Rennen alles durch, es gibt nichts mehr zu entfernen.
- **Client:** Q und Gamepad-Y belegen nichts mehr, kein Sprung-Sound, kein Salto. Der Touch-Button „tippen = Sprung, halten = Reset“ heißt jetzt `btn-reset` (Klasse `.reset`, Symbol `#icon-recover`, „Hold to reset onto the road“) und setzt nur noch Bit 8, solange er gehalten wird (`InputManager.touchButton`, wie DRIFT und BOOST; `flipDown`/`flipUp` sind weg). Entfernt: `#icon-jump`, die Q-Zeilen auf Startbildschirm, ABOUT und Tastenhinweis (`.hint-row.jump-hint`), der Jump-Powerup-Eintrag, `updateJumpControl`/`JumpControlMode` (jetzt `updateResetControl`), der Hinweis heißt bei Touch „HOLD RESET BUTTON“. `flipGroup` heißt `bodyGroup` (Darstellung, 26.8).

### 26.5 Tests

Unit (`tests/shared/sim/ground.test.ts`, `vehicleEdges.test.ts`), Erwartungen aus Handrechnung:

- Parabel-Kuppe R = 60 m: bei 0,5 und 0,9·v* (v* = √(g·R) = 34,6 m/s) nie in der Luft, bei 1,1·v* abgehoben. Bei 0,7·v* hebt sich der Aufbau um (v²/R)/ω² (±20 %).
- Knick der Steigung bei 45 m/s: 2 % bleibt am Boden, 8 % hebt ab (Grenze (v·Δs)²/(2g) = g/ω², also 5 %).
- 85 m/s über drei Bodenwellen in einen 60-%-Hang: nie unter dem Boden, alle Werte endlich, Landung erkannt.
- Wurfparabel: 8 m/s aufwärts → Scheitel 1,6 m (semi-implizit 2,2 cm darunter), 0,8 s Flug, 16 m weit.
- Landung aus 3 m und 10 m: danach nie mehr in der Luft (kein Abprall), eine Sekunde später |susp| < 5 mm, |vy| < 2 cm/s, am Ende |susp| < 0,1 mm.
- Rampe 12 m × 2 m bei 30 m/s: Absprung 5 m/s ±10 %, Weite 22,9 m ±10 % (t = (5 + √(25 + 80))/20).
- Determinismus über Kuppe, Flug und Landung; Replay aus kopiertem Zustand bitgleich, die Kopie mitten auf einer Bodenwelle mit eingefederter Feder (`stability.test.ts`).
- Luft: kein Gas, keine Bremse, kein Boost (nur Luftwiderstand), Lenkung ohne Wirkung, Landehilfe 2·β·5 % je Tick; Aufprall `12 + g·Δt/3`.
- Bit 4 wirkt nicht (Regressions-Lock), `clampInput` streicht es, Codec mit `susp`, Protokoll v5.

Goldens neu erzeugt: Alle Szenarien auf ebenem Boden sind in jedem Zahlenwert gleich geblieben (Vergleich mit dem alten Stand ohne die entfernten und das neue Feld); nur die Felder änderten sich (`susp` neu; `flipAngle`, `flipRate`, `jumpCooldown`, `prevButtons` weg). `ramp-jump-beetle` fliegt anders (Federung am Rampenfuß und an der Lippe). `jump-reset-jeep` ist durch `crest-hop-reset-jeep` ersetzt.

Mutationsprobe je neuem oder geändertem Test: Federkraft ziehen lassen, Abheben erst bei doppelter/dreifacher Ausfederung, doppelte Federsteife, kein Dämpfer, Landung 0,5 m unter dem Boden, 10 % weniger Gravitation im Flug, Anschlag mit Abprall, Dämpfung 0,1, Bodengeschwindigkeit ignoriert, Zufallsrauschen, Antrieb/Lenkung in der Luft, Vorzeichen der Landehilfe, kein Tempoverlust bei harter Landung, `susp`/`vy` nicht kopiert, Bit 4 wirksam, `BTN_MASK` mit Bit 4, Codec-Schritt und -Decodierung, Latch ohne Löschen, Flip-Taste mit Bit 4, Rennfilter, Geister-Reservebyte, Validator-Gravitation, Bot-Reset vor verpasstem Tor, Schätzung der Fahrzeit: jeweils rot. Äquivalent für den jeweils einzelnen Test (von der Gesamtsuite gefangen): Kraft-Klammer und doppelte Ausfederung für die Kuppen-Schwelle (die Schwelle v²κ = g hängt nicht davon ab), Dämpfer für den Knick-Test, stärkere Gravitation am Boden für die Rampenweite.

### 26.6 Messung vorher/nachher (`npx tsx scripts/sim-airtime.ts`)

Konstantes Tempo, Bulli; „Luft“ Summe der Ticks in der Luft, „Höhe“ größte Höhe der Unterkante über dem Boden.

| Szenario | v (m/s) | vorher Luft / Höhe | nachher Luft / Höhe |
| --- | ---: | ---: | ---: |
| Bodenwelle 1,5 m / 12 m | 25 | 0,00 s / 0,00 m | 1,07 s / 3,61 m |
| Bodenwelle 1,5 m / 12 m | 40 | 0,00 s / 0,00 m | 1,62 s / 7,24 m |
| Bodenwelle 1,5 m / 12 m | 55 | 0,00 s / 0,00 m | 2,17 s / 12,52 m |
| Kuppe R 150 m | 40 | 0,00 s / 0,00 m | 0,00 s / 0,00 m |
| Kuppe R 150 m | 55 | 0,00 s / 0,00 m | 0,52 s / 0,20 m |
| Grand Tour (841, 579), κ 0,0044/m, gerade | 55 | 0,00 s / 0,00 m | 0,10 s / 0,02 m |
| Knick Ridge Climb (−120, −14), 8 % → 0 % | 40 | 0,00 s / 0,00 m | 0,18 s / 0,07 m |
| Knick Ridge Climb (−120, −14), 8 % → 0 % | 55 | 0,00 s / 0,00 m | 0,33 s / 0,30 m |

Die drei stärksten Kuppen auf geraden Streckenabschnitten haben R ≈ 220–250 m und heben bis 55 m/s kaum oder nicht ab (Schwelle 67–71 m/s); vorher auch mit Boost nie.

Bots (mittel, Seed 1, alle Strecken und Klassen): Zeiten wie vorher (±0,7 s) außer Ridge Climb Sport 60,5 → 65,4 s (landet von der Canyon-Rampe auf dem Knick bei x −120, hüpft und rutscht in der folgenden Kurve), Dune Rally Käfer 76,9 → 70,2 s, Grand Tour Käfer 160,6 s mit Reset → 156,4 s ohne. Alle Rampen werfen ab wie vorher, 0 Resets. Kurze Hüpfer auf Gelände: Ridge Climb 1–3 je Rennen (≤ 0,32 s), Grand Tour bis 7 (≤ 0,45 s), Dune Rally Käfer 1 (0,52 s).

Bot-Rennen im RaceRoom (`trackRaces`, 30 Seeds × 6 Strecken × 5 Bots = 900): vorher 3 Bots länger als 10 s ohne Fortschritt, nachher 5 (Massenkarambolagen an Kehren, ein Käfer, der auf den Dünen neben der Strecke hüpft). Einer davon (Coast Sprint Seed 1, im CI-Satz) fuhr nach dem Zurücksetzen verkehrt herum weiter, weil Pure Pursuit ein Ziel hinter dem Auto mit sin α ≈ 0 ansteuert. `LineDriver` lenkt deshalb voll ein, wenn das Auto gegen die Linie zeigt und das Ziel hinter ihm liegt (Test in `lineDriver.test.ts`).

Angepasste Bot-Tests (`tests/tools/map/driveTrack.test.ts`): „Gelände wirft nie ab“ ist ersetzt durch „Hüpfer auf Gelände unter 0,5 s“; die Fahrzeit gegen die Schätzung ist der Median dreier Seeds (Seed 1 des Sport auf der Ridge Climb 1,17 wegen des Knicks, Seeds 2 und 3 1,085 wie vorher); der Regressions-Lock für ein verpasstes Tor nimmt Seed 11 statt 7.

Sim-Kosten (`npm run perf:sim`): 32 Autos eben 0,105 statt 0,092 ms/Tick, Bulli Bay p99 0,149 statt 0,128 ms (Budget 2 bzw. 4 ms).

### 26.7 Offen

- **Knick am oberen Ende des Canyon (Ridge Climb, x −120, z −14):** 8 % auf 0 % innerhalb von 4 m, genau in der Landezone der Canyon-Rampe. Ein Fall für die Ausrundung im Bake (phase-3-design A5), nicht für die Sim.
- **Stufe am Querweg bei x −564, z 300:** Die Straße steigt dort in 4 m um 0,8 m; ostwärts ab etwa 30 m/s hebt jedes Auto 0,8–1,1 s ab (2,4–3,7 m hoch). Der Mobile-E2E-Test nutzt sie als bekannte Bodenwelle (26.8). Wird sie im Bake ausgerundet, muss der Test eine andere Stelle bekommen (Suche: Wegwerf-Skript aus 26.8).
- Reifenlast aus der Federkraft (26.2), Nicken aus zwei Achsen in der Sim: bewusst nicht.
- `phase-3-design.md` A31 („die v2-Sim hebt auf Gelände nicht ab“) gilt seit diesem Abschnitt nicht mehr.

### 26.8 Darstellung, Kamera, Mobile-Test

**Aufbau auf dem Bildschirm (`src/client/vehicle/bodyMotion.ts`, nur Renderer):** Die Sim hat einen vertikalen Freiheitsgrad (`susp`) und keinen Nick-/Rollwinkel; `BodyMotion` leitet daraus pro Frame ab:

- **`group`** (Position am Boden, Gier, Mega-Skala) trägt nur noch die geglättete **Bodenneigung** unter dem Auto (±2 m, Rate 6/s). Der Kontaktschatten liegt in dieser Ebene, auch im Flug.
- **`bodyGroup`** (bisher `flipGroup`) trägt den Aufbau: Höhe = Höhe der Radunterkante über dem Gelände + `susp`·0,6 (entschieden: 60 % des Federwegs, höchstens 15 cm Einfedern, damit die Räder in den Radkästen bleiben), dazu Nicken und Rollen relativ zur Bodenneigung. Am Boden: Gelände plus die Beschleunigungsfeder wie bisher (4°/5°). In der Luft dreht die Nase mit Rate 2,5/s in die Flugbahn (−atan(vy/v), höchstens 25°: steigend Nase hoch, fallend Nase runter), das Rollen läuft mit 1,5/s aus; nach der Landung legt sich der Aufbau mit 12/s auf den Boden. Die Beschleunigungsfeder wirkt in der Luft nicht.
- **Räder:** Die Pivots `wheel_*` des GLB (bzw. die prozeduralen Räder) werden um denselben Federweg gegenläufig verschoben (`GltfCarBody.setWheelDrop`): Am Boden bleiben die Räder auf dem Boden, während der Aufbau ein- und ausfedert; in der Luft hängen sie 7,6 cm (0,6 · g/k) unter der Ruhelage.
- Das alte Stauchen per `scale.y` beim Landen ist weg; das Einfedern zeigt jetzt die Federung selbst. Die Höhe im Flug wird durch die Mega-Skala geteilt (vorher flog ein Mega-Auto doppelt so hoch, wie es war).
- **Andere Autos** (`net/remotes.ts`) bekommen dasselbe `BodyMotion`: `RemoteTrack` interpoliert `susp` und `vy` jetzt linear zwischen den Snapshots (vorher sprang `susp` mit 20 Hz), im Kontakt-Set aus der Prediction. Neu dabei: Auch entfernte Autos neigen sich mit dem Gelände (vorher nur Gier). Sandbox-Dummies ebenso; der Zeitfahr-Geist nur mit Höhe.
- **Kontaktschatten** (`contactShadowLook`): blasser und kleiner mit der Höhe (Deckkraft 1/(1 + 0,6h + 0,05h²), Größe 1 − 0,4·h/(h+3)); bei 0,5 m noch > 70 %, bei 10 m < 10 %. Vorher wuchs er in der Luft. Die Höhe kommt aus `CarModel.airHeight`, nicht mehr aus der Position der Gruppe.
- **Motorsound:** dreht in der Luft mit der Höhe hoch wie vorher mit der Sprunghöhe (`airHeight`).

**Kamera (`ChaseCamera`):** Das Ziel der Kamera war die Bodenhöhe unter dem Auto, ein fliegendes Auto lief also nach oben aus dem Bild. Jetzt folgt sie der Radunterkante (Boden + Flughöhe, ohne das Federn). Vertikal: Die Folgehöhe bewegt sich mit einer gefilterten Vertikalgeschwindigkeit (`verticalSpeedDamping` 10/s) und schließt den Rest mit 5/s (`verticalDamping`). Kein Nachhängen an einer gleichmäßigen Steigung (Test: 6 m/s aufwärts, nur die bisherige Positionsdämpfung bleibt), und Abheben/Landen (Sprung der Vertikalgeschwindigkeit um 8 m/s) ändern die Kamera-Vertikalgeschwindigkeit um höchstens 0,8 m/s je Frame (direkt gefolgt: 1,45 m/s; Test in `chaseCamera.test.ts`).

**E2E-Hook:** `placeLocalCar(x, z, yaw, speed)` setzt das Auto mit Tempo ab (Server: `debugPlace.speed`, nur mit E2E=1, höchstens 60 m/s). `V2Snapshot.flights` zählt Flüge und hält den letzten (Ticks, größte Höhe, Landestoß), `V2Snapshot.body` die gezeichnete Höhe und Neigung.

**Mobile-E2E (`tests/e2e/mobile.spec.ts`, bestehender Test erweitert, iPhone 13 in Chromium):** Nach Stick und Lenken setzt der Server das Auto 30 m vor die Stufe bei x −564, z 300 (ostwärts, 38 m/s, Auto-Gas); geprüft: gezeichneter Aufbau > 1 m über dem Boden (per rAF), Flug ≥ 30 Ticks und > 1 m hoch, Landestoß < 15 m/s, danach am Boden, kein Reset, weiter > 25 m/s; kein Button mit „jump“/„flip“, RESET halten setzt zurück. Mutationsprobe: Federkraft darf ziehen (klebt wieder) → rot; gezeichnete Flughöhe 0 → rot. Laufzeit des Mobile-Tests +2 s.

**Emulator-Belege (Wegwerf-Skript `mobile-air.mts`, nicht im Repo), Produktions-Build, Free Roam:**

| Lauf | Flug (Ticks / Höhe / Landestoß) | nach Landung | gezeichnet max. / Nicken | Kamera über Boden | Korrekturen am Hügel |
| --- | --- | --- | --- | --- | --- |
| WebKit iPhone 13 (390×664) | 65 / 3,36 m / 11,6 m/s | am Boden, 44 m/s, 0 Resets | 3,36 m / −7,0° … +6,0° | 4,4 … 8,5 m | 0 |
| WebKit iPhone SE quer (568×320) | 61 / 3,00 m / 11,0 m/s | am Boden, 44 m/s, 0 Resets | 3,00 m / −6,5° … +5,4° | 4,2 … 7,9 m | 1, Versatz 0 |
| Chromium Pixel 7 (412×839) | 61 / 2,92 m / 10,8 m/s | am Boden, 43,6 m/s, 0 Resets | 2,88 m / −6,8° … +4,3° | 4,5 … 7,9 m | 2, Versatz ≤ 3 cm |
| Pixel 7, `?netsim=150,30,3` (7 Läufe) | 59–70 / 2,8–3,7 m / 10,8–13,6 m/s | am Boden, 44 m/s, 0 Resets | wie oben | folgt (z. B. 4,4 … 7,2 m) | 0–4, Versatz ≤ 15 cm, 0 Bildsprünge (`renderSnaps`) |

Alle Läufe: kein Sprung-Button (`getByRole('button', /jump|flip/)` = 0), RESET sichtbar mit `#icon-recover`, Halten setzt zurück, kurzes Tippen nicht, keine Konsolen- oder Seitenfehler. Unter Netsim kommt das Abheben aus der Prediction (Server und Client rechnen dieselbe Sim); am Hügel gab es nur kleine Korrekturen, die als Render-Versatz auslaufen. Zweimal sprang der Lead-Regler (ein `resync`, bis 20 Ticks nach vorn) während des Anlaufs: ein Uhr-Sprung des Netzcodes, nicht des Flugs. Große Frame-Sprünge in den Messreihen sind Aussetzer von SwiftShader bzw. des headless WebKit (bis 300 ms), keine Korrekturen. Einschränkung WebKit: Playwright kann dort nur tippen; Druck und Ziehen am Stick und das Halten von RESET liefen über Maus-Pointer-Events, Taps (Modus, Start) über echte Touch-Events. In Chromium alles über CDP-Touch. Ein weiterer Netsim-Lauf brach im Skript ab (das Warten auf den Anlauf verpasste das Fenster nach einem Frame-Aussetzer) und wurde wiederholt.

Screenshots vor, während und nach dem Flug (alle Läufe) zeigen das Auto über der Kreuzung mit dem blassen Schatten darunter und die Kamera mit dem Auto in der Luft.
