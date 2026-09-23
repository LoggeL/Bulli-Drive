# Phase 1a: Playtest der Fahrphysik v2 und Vergleich mit Legacy

**Stand:** 2026-09-23 · **Branch:** `refactor/phase-1a-driving` · Bezug: [`refactor-plan.md`](refactor-plan.md) (Phase 1a, Exit-Kriterium), [`phase-1a-design.md`](phase-1a-design.md)

Die neue Fahrphysik v2 ist live und ohne URL-Parameter Standard. Auf Wunsch des Nutzers gehen neue Features direkt live, deshalb ist der Blindtest kein Gate mehr. Die alte Physik (`?physics=legacy`) ist mit Phase 1b gelöscht (Server-Sim, [phase-1b-design.md](phase-1b-design.md) Abschnitt 10); der Vergleich unten ist damit nur noch historisch.

Der Vergleich unten ist freiwillig. Er hilft beim Tuning und zeigt, ob v2 irgendwo schlechter ist als die alte Physik. Die Anleitung für einen blinden Vergleich bleibt stehen, falls er sich lohnt. Läuft v2 einige Tage ohne Probleme, wird die Legacy-Physik gelöscht (Abschnitt 6).

## 1. Vorbereitung

Für den Vergleich am besten den Produktions-Build nehmen (oder direkt https://bulli.logge.top). Er ist schneller als der Dev-Server und entspricht dem, was später läuft:

```bash
npm run build && npm start        # Port 8000, auch im LAN erreichbar
```

Handys im selben WLAN öffnen `http://<LAN-IP-des-Macs>:8000/…`. Zum Tunen mit Hot Reload reicht `npm run dev` (Port 5173); für Handys dann `npm run dev:lan` und die angezeigte `Network:`-Adresse.

| Zweck | URL |
|---|---|
| Variante „neu“ (v2, Standard) | `/` |
| Variante „alt“ (Legacy) | `/?physics=legacy` |
| Neu mit Tuning-Panel und Telemetrie | `/?tune=1` |
| Sandbox (offline, Rampen, Wand, Pfosten, 5 Dummy-Autos) | `/?sandbox=1` bzw. `/?sandbox=1&tune=1` |
| Leistung ablesen (FPS, Draw Calls, Sim-Zeit) | zusätzlich `&debug=perf` |

**Blind machen:** Zwei Lesezeichen oder QR-Codes „A“ und „B“ anlegen und pro Tester per Münzwurf festlegen, welches die neue Variante ist. Das auf dem Bogen notieren, dem Tester aber nicht sagen. Die Reihenfolge wechseln (mal A zuerst, mal B). Ganz blind ist es nicht: v2 hat eine Boost-Leiste, andere Tastenhinweise und eine tiefere Kamera. Den Testern also nur sagen, dass es zwei Varianten gibt, nicht welche neu ist.

**Steuerung erklären** (die wichtigsten Tasten stehen im Startbildschirm, alle unter ABOUT):

| | alt | neu (v2) |
|---|---|---|
| Fahren, lenken | W/S, A/D | W/S, A/D oder Pfeiltasten |
| Leertaste | Sprung/Salto | Handbremse (Drift) |
| Boost | – | Shift (füllt sich beim Driften) |
| Sprung | Leertaste | Q |
| Zurücksetzen | Leertaste, wenn festgefahren | R halten (auf die nächste Straße im Umkreis von 40 m, sonst an Ort und Stelle) |
| Schießen / Hupen | E / F | E / F |
| Touch | Joystick, Buttons | Auto-Gas startet mit der ersten Stick-Berührung, großer DRIFT-Button, BOOST, AUTO schaltet Auto-Gas um; Flip-Button kurz = Sprung, lang = Reset |
| Gamepad | – | RT Gas, LT Bremse, linker Stick lenkt, A Drift, B Boost, Y Sprung, Back Reset, X Schießen, LB Hupe |

## 2. Ablauf pro Tester

1. Variante 1 etwa 5 Minuten frei durch die Stadt fahren. Ein paar Aufgaben helfen: einmal um den Block, eine 90°-Kreuzung mit Tempo, an einer Wand entlangschrammen, springen, einen Mitspieler anrempeln.
2. Variante 2 genauso lange, mit denselben Aufgaben.
3. Fragebogen (unten) ausfüllen lassen, erst danach auflösen.
4. Das Handy zählt genauso wie der Desktop. Am besten fährt jeder Tester beide Varianten zusätzlich auf dem Handy und beantwortet die erste Frage für beide Geräte getrennt.

Rempeln braucht zwei Geräte am selben Server, beide mit derselben Variante. Gemischte Sessions (einer alt, einer neu) funktionieren auch, sind für den Vergleich aber ungeeignet.

**Fragebogen:**

- Welche Variante fährt sich besser? A / B / egal (getrennt für Desktop und Handy)
- Je Variante 1 (schlecht) bis 5 (sehr gut): Lenken, Tempogefühl, Driften, Springen, Rempeln, Kamera, auf dem Handy die Touch-Steuerung
- Was hat gestört? Was hat Spaß gemacht? (frei)
- Gerät: Desktop mit Tastatur, Gamepad oder Handy (welches?)

## 3. Worauf achten (als Beobachter)

- **Tempo:** Topspeed je Karosse 47–55 m/s (169–198 km/h), mit Boost 20 m/s mehr (Bulli 70 m/s = 252 km/h), mit Turbo-Powerup höchstens 85 m/s (306 km/h). Fühlt sich das in der Stadt zu schnell oder zu langsam an?
- **Kurven in der Stadt:** Kommt man mit Bremsen oder Handbremse um 90°-Ecken, ohne an der Wand zu kleben? Wirkt das Auto träge oder nervös?
- **Drift:** Lässt er sich mit der Handbremse einleiten, mit Gas halten und sauber beenden? Dreht sich das Auto ungewollt? Füllt der Drift den Boost spürbar?
- **Wände:** Gleitet das Auto an der Wand entlang, statt hängen zu bleiben? Hilft „R halten“, wenn man doch feststeckt?
- **Sprung und Kuppen:** Sprunghöhe (etwa 3 m), Landung; hebt das Auto über Kuppen ungewollt ab?
- **Rempeln:** Weicht das eigene Auto nachvollziehbar aus? In 1a ist der Kontakt gegen Mitspieler absichtlich weich und einseitig (nur das eigene Auto wird geschoben, 70 % Stärke), und die Mitspieler kommen nur 20-mal pro Sekunde. Leichtes Zittern ist bekannt und wird in Phase 1b gelöst; ein völlig falsches Gefühl ist dagegen wichtig.
- **Kamera:** Die Renn-Kamera ist tiefer und näher. Zu unruhig, zu nah, zu wenig Übersicht? (Im Panel lässt sich zum Vergleich die alte Kamera einschalten.)
- **Handy:** Kommt man mit Auto-Gas, Joystick und DRIFT-Button zurecht? Verdeckt der Daumen etwas? Ruckelt es (dann mit `&debug=perf` die FPS notieren)?
- **Party-Modus:** Powerups (Turbo, Mega, Super-Jump, Ghost, Schild), Schießen und Respawn funktionieren auch mit v2. Fällt dabei etwas auf?

## 4. Werte anpassen (Tuning-Panel)

Das Panel erscheint mit `&tune=1` am rechten Rand (auf dem Handy eingeklappt unter der Punkteanzeige). Oben steht die Telemetrie (km/h, Driftwinkel β, Gierrate, Radeinschlag, Boost) und ein Verlauf der letzten 5 s. Darunter liegen die Regler. `·K` gilt für die Karosse, die unter „Werte der Klasse“ gewählt ist (Standard: die eigene), `·P` für das Assist-Profil des eigenen Autos (Handy: „touch“, sonst „standard“), alles andere für alle Autos. Änderungen wirken sofort, gehen beim Neuladen der Seite aber verloren: vorher exportieren.

Zum Ausprobieren eignet sich die Sandbox (`/?sandbox=1&tune=1`) mit Rampen, Wand, Pfostenreihe, Kurven mit R 40 und R 80 m und Dummy-Autos zum Rammen (N stellt sie zurück, C wechselt die Karosse).

| Eindruck | Regler (Ordner) | Richtung | Standard |
|---|---|---|---|
| Kurven zu weit, Auto zu träge | `gripScale` (Global) | höher, z. B. 1,2–1,5 | 1,0 |
| | `steerLock ·K` (Lenkung) | höher | 30–34° |
| | `steerFalloff ·K` (Lenkung): Lenkeinschlag bei Tempo | höher = mehr Einschlag bei Tempo | 15–17 |
| Lenkung reagiert zu langsam | `STEER_RATE_IN` (Lenkung) | höher | 3,5 |
| Heck bricht zu leicht aus, Dreher | `gripRear ·K` (Reifen) | höher | 2,2–2,6 |
| | `counterSteer ·P` (Assists) | höher | 0,5 (touch 0,7) |
| | `spinGuardAngle ·P` (Assists) | niedriger | 35° (touch 30°) |
| Drift schwer einzuleiten | `handbrakeGrip ·K` (Drift) | niedriger | 0,42–0,50 |
| Drift kostet zu viel Tempo | `handbrakeGrip ·K` höher, `driftReleaseKick` (Drift, Mini-Turbo nach langem Drift) höher | | 0 = aus |
| Drift hört zu schnell auf | `HB_RECOVER_TIME` (Drift) | höher | 0,35 s |
| Zu langsam / zu schnell | `topSpeed ·K`, `accel ·K` (Antrieb) | | 47–55 m/s, 8–11 m/s² |
| Boost zu schwach / zu stark | `BOOST_ADD` (Boost, Tempo über vtop), `BOOST_ACCEL` | | 20 m/s, 10 m/s² |
| Boost füllt zu langsam | `DRIFT_FILL` (Boost) | höher | 0,35 |
| Pendeln bei sehr hohem Tempo | `yawDampHigh` (Assists) | höher, z. B. 1–2 | 0 |
| Auto hebt über Kuppen ab | `STICK` (Global) | höher | 8 |
| Sprung zu hoch / zu niedrig | `jumpSpeed ·K` (Sprung) | | 11 m/s |
| Rempeln gegen Mitspieler zu stark / zu schwach | `PROXY_CONTACT_SCALE` (Kollision) | | 0,7 |
| Autos prallen zu stark voneinander ab | `CAR_RESTITUTION` (Kollision) | niedriger | 0,25 |

Regler, die hier nicht stehen, besser erst einmal lassen. Immer nur einen oder zwei Werte gleichzeitig ändern und danach dieselbe Kurve noch einmal fahren. „Reset auf Defaults“ stellt alles zurück, am besten vor jedem neuen Tester.

## 5. Werte zurückmelden

1. Im Panel unter „Export / Import“ auf **„Export → Zwischenablage“** klicken. Ist die Zwischenablage gesperrt (manche Handys, Seiten ohne HTTPS im LAN), erscheint ein Dialog mit dem JSON zum Kopieren.
2. Das JSON in die Rückmeldung einfügen, dazu drei Zeilen Kontext: Gerät (Desktop/Handy/Gamepad), Karosse, und was sich damit besser anfühlt.

So sieht ein Export aus. Er enthält nur Werte, die vom Standard abweichen; Winkel stehen in Radiant:

```json
{
  "format": 1,
  "global": { "gripScale": 1.25 },
  "classes": { "sport": { "gripRear": 2.4 } },
  "profiles": { "touch": { "counterSteer": 0.8 } }
}
```

Mit „Import ← Zwischenablage“ lässt sich ein solches JSON auf einem anderen Gerät wieder laden, zum Beispiel um Desktop-Werte auf dem Handy zu prüfen. Ein Import ersetzt das ganze Tuning und ändert nichts, wenn das JSON fehlerhaft ist.

Die zurückgemeldeten Werte werden danach fest in `SIM_TUNING` (`src/shared/sim/constants.ts`), `VEHICLE_CLASSES` bzw. `ASSIST_PROFILES` (`src/shared/sim/vehicleClasses.ts`) eingetragen, und die Golden-Dateien werden mit `UPDATE_GOLDEN=1 npm test` neu erzeugt.

## 6. Nach dem Vergleich

- **Rückmeldungen einarbeiten:** getunte Werte übernehmen (Abschnitt 5). Zeigt der Vergleich, dass v2 irgendwo schlechter ist (Tuning, Kamera, Touch, Rempeln), wird nachgetunt; v2 bleibt dabei Standard.
- **Legacy löschen:** Wenn v2 einige Tage ohne Probleme live läuft, fliegen `src/client/vehicle/legacyPhysics.ts`, die Legacy-Zweige in `src/client/controls/keyboard.ts`, `src/client/controls/mobile.ts`, `src/client/main.ts` und `src/client/ui/hud.ts`, die `.legacy-only`-Elemente in `index.html`, `LEGACY_CAMERA`, die Legacy-E2E-Tests und der Parameter `?physics=legacy` raus. Danach beginnt Phase 1b.
