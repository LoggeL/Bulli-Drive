# Phase 1a: Fahrphysik v2 – verbindliche Spezifikation

**Stand:** 2026-09-23 · **Branch:** `refactor/phase-1a-driving` · **Flag:** `?physics=v2` · Bezug: [`refactor-plan.md`](refactor-plan.md) Abschnitt 0, 5 (Phase 1a) und 6 (Netcode)

Dieses Dokument ist die eine verbindliche Grundlage für die Umsetzung von Phase 1a. Es ersetzt die beiden Entwürfe, aus denen es entstanden ist. Zahlen sind Startwerte für das Tuning; Struktur, Konventionen, Zustandsfelder und die Reihenfolge im Tick sind verbindlich, weil Phase 1b (Server-Sim, Prediction, Replay) darauf aufbaut.

**Rahmen (nicht verhandelbar):**

- Ohne `?physics=v2` verhält sich das Spiel exakt wie heute. Die Legacy-Physik in `Bulli.ts` bleibt, bis der Nutzer im Blindtest entschieden hat. Ihr Löschen ist **nicht** Teil dieses Laufs.
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
8. **Renn-Kamera:** niedriger (Höhe 5,5 m, Abstand 11 m), Yaw im Drift zur Geschwindigkeitsrichtung geblendet.
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
| `sim/vehicle.ts` | `integrateForces` (Tick-Schritte 0–3), `finishTick` (Schritte 5–6), `resetVehicle`, Hilfsfunktion `stepVehicle` für ein einzelnes Auto |
| `sim/collision.ts` | Auto gegen Welt (zwei Kreise gegen Kreise/AABBs/Weltrand), Impulsantwort |
| `sim/contact.ts` | Auto gegen Auto (Kreispaare, Impuls, Positionskorrektur) |
| `sim/world.ts` | `stepWorld(cars, world)`: Reihenfolge, Substeps, Events |
| `world/colliders.ts` | `Collider`, `RampDef`, `SpatialGrid` (CSR), `SimWorld`, `createSimWorld` |

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
| `client/sandbox/main.ts` + `sandbox.html` | Offline-Sandbox (eigener Vite-Einstieg): Rampen, Kurven, Wände, Dummy-Autos, Tuning-Panel |
| `client/debug/tuningPanel.ts` | lil-gui-Panel (dynamischer Import; nur Sandbox oder `?physics=v2&tune=1`) |

Neue Abhängigkeit: `lil-gui` (dependency, nur dynamisch importiert → eigener Chunk).

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
}
```

```ts
// src/shared/sim/vehicle.ts / world.ts
export function stepWorld(cars: SimCar[] /* nach id aufsteigend sortiert */, world: SimWorld): void;
export function stepVehicle(car: SimCar, world: SimWorld): void; // = stepWorld([car], world)
export function resetVehicle(s: VehicleState, p: VehicleParams, world: SimWorld): void;
```

Zustand und Params sind reine Objekte. Die Sim mutiert in place. Die Prediction-Historie (1b) und die Render-Interpolation kopieren mit `copyVehicleState(dst, src)`.

---

## 6. Algorithmus pro Tick

### 6.1 Globale Konstanten (Startwerte, alle im Tuning-Panel)

| Gruppe | Konstante | Wert |
|---|---|---|
| Gravitation | `G_AIR` (Flug, Arcade ≈ 2 g) / `G_SLOPE` (Hangabtrieb) / `G_TIRE` (für Fz) | 20 / 9,81 / 9,81 m/s² |
| Bodenkontakt | `STICK` / `AIR_GAP` / `COYOTE_TICKS` | 8 m/s² / 0,15 m / 6 |
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
| Luft | `AIR_YAW` | 1,5 rad/s |
| Sprung | `JUMP_COOLDOWN` | 20 Ticks |
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
für jedes car (Reihenfolge = aufsteigende id):
    resetStepEvents(car.events)
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

1  Sprung: wenn (pressed & BTN_JUMP) && jumpCooldown == 0 && (grounded || airTicks ≤ COYOTE_TICKS):
       vy = max(vy, 0) + P.jumpSpeed; grounded = false; jumpCooldown = JUMP_COOLDOWN
       flipRate = 2π / (2·P.jumpSpeed / G_AIR); flipAngle = 1e-6; ev.jumped = true

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
       wenn boosting && u > 0: aDrive += BOOST_ACCEL·clamp((vtopE + BOOST_ADD − u)/10, 0, 1)
       vRef = boosting ? min(vtopE + BOOST_ADD, V_ABS) : vtopE
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
       k = clamp(1 − |u'|/V_LOW, 0, 1)                      // kinematische Überblendung
       r' += (u'·tanδ/L − r')·k;  w' −= w'·k·min(1, 10·DT)
       wenn |u'| < 0,05 && th == 0 && br == 0: u' = 0; wenn |w'| < 0,05: w' = 0
       yawRate = clamp(r', ±R_MAX); (vx, vz) = f·u' + l·w'; |v_xz| ≤ V_SAFE

3  sonst (Luft):
       vy −= G_AIR·DT
       yawRate += (st·AIR_YAW − yawRate)·min(1, 3·DT)
       v_xz ·= 1 − C_AIR·|v|·DT
       wenn boosting: v_xz += f·BOOST_ACCEL·0,5·DT
       airTicks++
```

Der Handbremsen-Grip `hbGrip` ist `P.handbrakeGrip`. Die Drift-Release-Hilfe (`driftReleaseKick`, Standard 0) addiert beim Driftende nach ≥ 72 Ticks einmalig `+kick` auf u, höchstens bis vtopE.

### 6.5 Schritt 4: Bewegung

In `stepWorld`, 3 feste Substeps (6.3). Die Anzahl hängt weder vom Tempo noch von der Anzahl der Autos ab; Client-Replay und Server nehmen so denselben Weg.

### 6.6 `finishTick` (Schritte 5–6)

```
5  Boden und Vertikale (mit finaler xz-Position)
   hN = ground(x, z)
   wenn grounded:
       yBall = y + vy·DT − ½·(G_AIR + STICK)·DT²
       wenn yBall > hN + AIR_GAP:                       // Rampenkante, Kuppe
           grounded = false; airTicks = 0
           y += vy·DT − ½·G_AIR·DT²; vy −= G_AIR·DT
       sonst:
           vy = clamp((hN − y)/DT, −30, 25); y = hN
   sonst:
       y += vy·DT                                         // vy wurde in Schritt 3 schon integriert
       wenn y ≤ hN:
           ev.landedImpact = −(vy − ∇h·v_xz); y = hN; grounded = true; airTicks = 0
           wenn landedImpact > 10: v_xz ·= 1 − 0,15·clamp((landedImpact − 10)/15, 0, 1)
           vy = 0; flipAngle = 0   // Darstellung dreht den Rest über 6 Frames zu Ende
   wenn flipAngle > 0: flipAngle += flipRate·DT; bei ≥ 2π: flipAngle = 0

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
   jumpCooldown, ghostTicks, ghostExit herunterzählen (≥ 0); wallTicks = min(255, wallTicks + 1)
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

`base` berechnet `createSimWorld` aus `groundHeight` am Mittelpunkt. `top` ist die Höhe der Oberkante über `base`. Ein Collider wird übersprungen, wenn die Unterkante des Autos `y ≥ base + top` ist. Das ersetzt das heutige „airborne > 1 m ignoriert alles“ (`Bulli.ts:844`). Man kann nicht auf Collidern landen: Sinkt das Auto über einem Collider unter dessen Oberkante, schiebt die normale Auflösung es seitlich heraus.

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
- In 1b braucht der Server dieselben Collider. Die Platzierung ist schon deterministisch (cityGen, `mulberry32(SCENERY_SEED)`, `positionHash`) und wird dann nach `shared/world` verschoben, abgesichert durch einen Paritätstest gegen `window.__bulliDebug.obstacles()`. **Nicht Teil von 1a.**
- Rampen gibt es nur in der Sandbox. Seiten und Rückseite jeder Rampe bekommen Box-Collider mit `top` = Rampenhöhe an dieser Kante, damit man nicht von hinten „hochpoppt“.

### 7.3 SpatialGrid und Auflösung

**Grid:** Zellen 16 m, Ursprung −512, 64 × 64 Zellen, CSR-Aufbau (`cellStart: Int32Array`, `items: Int32Array`), einmal gebaut, statisch. `query(minX, minZ, maxX, maxZ, out: Int32Array): number` dedupliziert über ein Stamp-Array und **sortiert die Treffer aufsteigend nach Index** (Insertion-Sort, typisch < 20). Keine Allokation.

**Auto-Form:** zwei Kreise mit Mitte `p ± c·f`, Radius `r` (Klasse, ×scale bei Mega). Abfrage-AABB: `p ± (c + r)·scale + 0,5`.

**Tunneling:** Bei 85 m/s sind es 0,47 m pro Substep. Kleinster Collider (Pfosten, r 0,35) plus kleinster Autokreis (Käfer, r 1,1) = 1,45 m. Die Eindringtiefe bleibt immer kleiner als der Radius, der Push-out geht nie zur falschen Seite. Kein Swept-Test nötig. Bedingung für Sandbox-Wände: halbe Dicke ≥ 0,25 m.

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

- **Frontal**, beide 50 m/s: vn = −100 → beide stoppen und prallen mit je ~2 m/s zurück.
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
| jumpSpeed (m/s) | 11 | 11 | 11 | 11 | 11 |

Mittelwert vtop 49,8 m/s (179 km/h). Der Sprung ist für alle Klassen gleich (fair): 3,0 m Scheitel, 1,1 s Flug. Stabilitätskennzahl α_peak/μ ist vorne größer als hinten: alle Klassen untersteuern im Grenzbereich leicht (Bulli 3,33 gegen 2,73 °/g).

**Charakter:** Bulli ausgewogen, durch Heckmotor leicht verspielt · Pickup schwer und stabil, schiebt am meisten · Sport schnell und griffig, driftet tief · Käfer leicht, beschleunigt am besten, driftfreudig, wird weggeschubst · Jeep Allrad, driftet flach, kaum Offroad-Nachteil (falls zu zahm: handbrakeGrip 0,45).

---

## 10. Powerup-Modifikatoren (`sim/modifiers.ts`)

`applyModifiers(base, mods, scale, out)` schreibt die effektiven Params in ein wiederverwendetes Objekt. Die Timer bleiben Party-Regel: In 1a zählt der Client `Bulli.powerups[*].timer` im v2-Pfad **pro Sim-Tick um DT** herunter (nicht pro Frame); in 1b macht das der Server (Dauer in Ticks = `POWERUP_DURATIONS_MS/1000·60`). Die Sim bekommt pro Tick nur `VehicleModifiers`; in 1b gehören die Mods deshalb pro Tick in die Input-Historie.

| Powerup | heute (Legacy) | v2 |
|---|---|---|
| **Turbo** (`speed`) | Beschleunigung und Topspeed ×1,8 (108 m/s) | `topSpeed ×1,3`, `accel ×1,5`. Mit Boost: `min(vtop·1,3 + 20, V_ABS = 85 m/s = 306 km/h)`. Bulli 65 / 85, Sport 71,5 / 85. `aeroGrip` bezieht sich auf das Basis-vtop und ist bei 1 gedeckelt: Turbo schenkt keinen Grip. Nach dem Ende baut `OVERSPEED` die Überspeed sanft ab. |
| **Mega** (`size`) | Skala 2,5 (Lerp 0,1/Frame), Kollisionskreis 3,75, Ram per Abstandstest | `scale` gleitet mit `1 − e^(−6·DT)` auf `MEGA_SCALE` (optisch wie heute). Kreise r, c ×scale (Bulli r 3,25). Kontaktmasse ×3, Massenverhältnis-Deckel 3,5. Fahrverhalten unverändert (Grip normiert, rg nicht skaliert). Kontakt-Höhenfenster 1,4·scale. Legacy-Ram bleibt in 1a. |
| **Super-Jump** (`jump`) | Salto langsamer, Hubhöhe 24 m | `jumpSpeed = 20`: Scheitel 10 m, Flug 2,0 s, ein Salto (`flipRate = 2π/Flugzeit`). Beim Absprung festgelegt; Ablauf in der Luft ändert die Bahn nicht. Überspringt Laternen, Schilder, Autos, aber keine Bäume oder Gebäude. |
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
| **Tastatur** | W/S bzw. ↑/↓ Gas und Bremse/rückwärts · A/D bzw. ←/→ lenken · **Leertaste Handbremse/Drift** · Shift Boost · Q Sprung/Salto · R halten Reset · E Schuss · F Hupe |
| **Gamepad** (Standard-Mapping) | RT Gas, LT Bremse/rückwärts (analog), linker Stick lenken (radiale Deadzone 0,12, Kurve \|x\|^1,6, `steer = −x`) · A Handbremse · B Boost · Y Sprung · X Schuss · LB Hupe · View/Back halten Reset |
| **Touch** | Auto-Gas standardmäßig an (Umschalter im Touch-HUD, gemerkt in `localStorage`) · Joystick-x lenkt · Joystick-y > 0,45 nach unten bremst bzw. fährt rückwärts (`brake = (y − 0,45)/0,55`, Gas dann 0) · ohne Auto-Gas gibt Joystick-y nach oben Gas · rechts **großer DRIFT-Button** (Handbremse halten) und BOOST · `btn-flip` kurz = Sprung, 0,5 s halten = Reset · Schuss, Hupe wie heute · Assist-Profil „touch“ · Joystickfilter im v2-Modus 30/s statt 18/s (der Radeinschlag glättet schon) |

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

Während Modal, Tod oder Kontextverlust läuft kein Tick, und der Akkumulator wird zurückgesetzt (wie die heutige Legacy-Semantik „Auto eingefroren“).

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
| Höhe | 5,5 m | ×0,9 |
| Abstand | 11 m (+12 % bei vtop) | ×0,9 |
| LookAt-Höhe | 1,5 m | |
| FOV | 64° + 10°·speedRatio + 4° Boost, max 80° | Basis 66° |
| Yaw-Ziel | `yaw + 0,5·β·clamp(u/10, 0, 1)` | |

Ein Profilwechsel ist im Tuning-Panel möglich (für den Blindtest: v2 auch mit Legacy-Kamera fahrbar).

### 12.6 HUD

- Tacho-Skala 320 km/h im v2-Modus.
- Boost-Leiste (0..1, Markierung bei 0,15) und Drift-Anzeige, nur im v2-Modus, Desktop und Mobile.
- Reset-Hinweis (6.7).

### 12.7 Sandbox (`sandbox.html`)

Offline, ohne Server, eigener Vite-Einstieg (Multi-Page-Build). Flache Ebene 400 × 400 m mit:

- Rampen (10°, 15°, 20°; 8 m breit), eine Sprungschanze mit Landehügel,
- weite Kurven (R 40, 80 m) und eine 90°-Stadtecke mit 12-m-Straßen,
- eine lange Wand zum Streifen, Pfosten-Reihe (r 0,35) für Tunneling-Checks,
- Dummy-Autos (stehend, geradeaus, Kreis) aller Klassen, auf Knopfdruck zurücksetzbar,
- Klassenauswahl, Mods zum Anklicken, Tuning-Panel offen.

`?e2e=1` stellt `window.__bulliSim` bereit (Golden-Szenarien im Browser, 14.4).

---

## 13. Tuning-Parameter (lil-gui)

Das Panel schreibt in `SIM_TUNING` (global) bzw. in die Klassen-Params des lokalen Autos. „Export“ kopiert die geänderten Werte als TS-Literal in die Zwischenablage.

| Ordner | Regler (Bereich) |
|---|---|
| Global | `gripScale` (0,8–1,6), `G_AIR` (10–30), `STICK` (0–20), `assistProfile` (standard/touch), Kamera-Profil |
| Antrieb | `accel`, `topSpeed`, `brakeDecel`, `ENGINE_BRAKE`, `C_AIR`, `DRIVE_EXP` |
| Reifen | `gripFront/Rear`, `slipPeakFront/Rear` (3–12°), `slideFront/Rear`, `aeroGrip`, `GRIP_CIRCLE` |
| Lenkung | `steerLock` (25–40°), `steerFalloff` (10–25), `STEER_RATE_IN/OUT` |
| Drift | `handbrakeGrip` (0,3–0,7), `HB_DECEL`, Handbremsen-Erholung (0,1–0,6 s), `LOAD_GAIN`, `driftReleaseKick` (0–5) |
| Assists | `counterSteer` (0–1), `spinGuardAngle` (20–60°), `K_SPIN`, `K_BD`, `yawDampHigh` (0–5) |
| Boost | `BOOST_ACCEL` (6–16), `BOOST_ADD`, Verbrauch, `DRIFT_FILL`, `AIR_FILL` |
| Kollision | Wand e (0–0,5), μw, Auto e, μc, Massenverhältnis-Deckel, `proxyContactScale` (0–1), Δω-Kappe |
| Sprung | `jumpSpeed` (6–16), `JUMP_COOLDOWN` |
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

Je Szenario Input-Skript pro Tick, 180 Ticks, Endzustand und Zustand alle 30 Ticks als Golden:

1. Beschleunigen + Grip-Kurve (bulli)
2. Handbremsen-Drift mit Gegenlenken (sport)
3. Sprung über eine Rampe mit Landung (beetle)
4. Streifschuss 10° an Wand bei 50 m/s
5. Kontakt frontal (2 × bulli, je 50 m/s)
6. Kontakt seitlich/T-Bone (pickup in stehenden beetle)
7. Kontakt Heck/PIT (sport trifft bulli am Heck, 1,5 m Versatz)
8. Drei Autos in Reihe (Auffahrkette 45 → 40 → 35 m/s)
9. Mega gegen Käfer
10. Ghost fährt durch Auto und Wand; Ghost endet im Gebäude

Node vergleicht exakt mit dem JSON. Der Browser (`tests/e2e/sim-golden.spec.ts`, Sandbox mit `?e2e=1`, `__bulliSim.runGolden(name)`) vergleicht mit Toleranz 1 mm bzw. 1e-4 rad.

Zusätzliche Aussagen zu den Kontakt-Szenarien: frontal → beide \|v\| ≤ 4 m/s nach dem Stoß; Heck-Auffahren → Vorderer schneller; PIT → \|Δω\| ≤ 2,5 rad/s und Getroffener nach 90 Ticks mit Gegenlenken wieder |β| < 10°; drei Autos → nach 10 Ticks keine Überlappung > 5 cm; nie `vy ≠ 0` durch Kontakt; Summe der Impulse zweier dynamischer Autos ≈ 0 (Impulserhaltung bis auf Rückprall-Kappe).

### 14.5 Tunneling

- Alle Klassen, normal und Mega, mit 85 und 90 m/s auf: Pfosten (r 0,35), Box mit halber Dicke 0,25 m, Gebäudeecke; seitliche Versätze in 0,1-m-Schritten, Winkel 0–80° in 10°-Schritten → das Auto endet nie auf der anderen Seite.
- Auto gegen Auto frontal: 2 × Käfer (kleinste Kreise) mit je 85 m/s, Versätze wie oben, plus T-Bone mit 85 m/s → die Reihenfolge entlang der Annäherungsachse kippt nie.

### 14.6 FPS-Unabhängigkeit (`tests/client/loop.test.ts`)

Ein Input-Skript pro **Tick-Index**, `FixedStepLoop` mit Frame-Folgen 1/30, 1/60, 1/144 s und einer gejitterten Folge (feste Seeds) über dieselbe Gesamtzeit → identische Zustandsfolge pro Tick (bitgleich). Zusätzlich: Hitch von 0,5 s → höchstens 8 Ticks, Rest verworfen.

### 14.7 Client-Einheiten

`InputManager`-Mapping (Quantisierung, Latch, Deadzone/Kurve, Touch-Brems-Schwelle, Vorrang der Quellen), `obstaclesToColliders` (Formen, `top`), Grid-Query (Dedup, Sortierung, keine Allokation nach dem Aufbau), Speedo-Skala v2.

### 14.8 E2E (Playwright)

- **Bestehende Suite ohne Flag grün** (Legacy unverändert, Desktop und Mobile).
- **Desktop v2:** W 2 s → Strecke in erwartetem Bereich, Tacho > 0; Q → Höhe steigt und fällt; R halten → Reset; Leertaste + A bei Tempo → β ≠ 0 (über `__bulliDebug`).
- **Mobile v2** (iPhone 13, Touch): Auto-Gas fährt an, Joystick lenkt, DRIFT-Button wirkt, `btn-flip` lang = Reset.
- **Multiplayer gemischt:** ein v2- und ein Legacy-Client sehen sich gegenseitig fahren; zwei v2-Clients rempeln sich (Positionen weichen nach Kontakt aus, keine Überlappung dauerhaft).
- **Sim-Golden im Browser** (14.4).

### 14.9 Leistung

Messung (geloggt, nicht als harte CI-Schranke): 32 Autos × 60 Ticks `stepWorld` in Node; Ziel < 2 ms pro Tick. Harte, großzügige Schranke gegen Ausreißer: 60 Ticks < 120 ms.

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
13. E2E v2 Desktop/Mobile/Multiplayer; Plan-Status aktualisieren.

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
