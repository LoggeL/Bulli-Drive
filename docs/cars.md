# Autos im Spiel (Grafik-Schritt G1 „Bulli T1“)

**Stand:** 2026-09-23 · Branch `gfx/g1-realistic`

Der Bulli fährt jetzt als realistisches Blender-Modell (VW T1 Samba 1963, 23 Fenster) aus `tools/models/vehicles/bulli.py`. Die anderen vier Typen (Käfer, T1-Pritsche, Porsche 356, Typ 181) bleiben vorerst prozedural. Ihre Materialien passen aber zum realistischen Look. Physik, Kollisionen und Netzwerk sind unverändert: Das Modell ist reine Optik.

## Bausteine

| Datei | Aufgabe |
|---|---|
| `src/client/vehicle/CarModel.ts` | Ein Auto: GLB-Körper oder prozeduraler Körper, Schild, Geister- und AFK-Look, Räder, Lampen. `updateCarModels(camera, dt)` läuft einmal pro Frame vor dem Rendern (`main.ts`) |
| `src/client/vehicle/GltfCarBody.ts` | Der GLB-Körper: eine Instanz pro geladenem LOD, Material-Kopien pro Auto, Rad-Pivots, Lampen-Uniforms, Maßstab |
| `src/client/assets/carMaterials.ts` | Shader-Patches (Fresnel-Glas, Lampen), Material-Klon, Spielerfarbe als Lack |
| `src/client/assets/ModelCache.ts` | Lädt die GLBs während des Splash-Screens, patcht die Vorlagen und kompiliert die Shader vor |

## Entscheidungen

**Maßstab 1,15 statt Sim-Hülle ändern.** Die Sim-Hülle der Klasse `bulli` (`shared/sim/vehicleClasses.ts`: zwei Kreise mit r = 1,3 m, 0,7 m vor und hinter der Mitte, also 2,6 × 4,0 m) stammt vom alten Cartoon-Kasten (2,8 × 4,0 m plus 0,4-m-Stoßstangen). Der echte T1 misst 1,80 × 4,28 × 1,94 m. Er wird im Spiel gleichmäßig um 1,15 skaliert (`MODEL_SCALE` in `GltfCarBody.ts`) auf 2,07 × 4,92 × 2,23 m, Radradius 0,38 m:
- Die Stoßstangen ragen 0,46 m über die Hüllenenden hinaus, wie früher die Kasten-Stoßstangen mit 0,4 m.
- Seitlich bleibt die Karosserie 0,27 m innerhalb der Hülle.
- Ein gleichmäßiger Faktor erhält die Proportionen. Ein breiter gezogener T1 hätte nicht mehr wie ein T1 ausgesehen.
- Die Hülle bleibt unverändert, dadurch auch Fahrgefühl, Kontakte, Golden-Tests und der Netzcode.

Im Verfolgerblick ist der Bulli damit etwas kleiner als der Kasten: 13 % statt 16 % der Bildbreite. Die Kamera bleibt, wie sie ist.

**LOD nach Kameraentfernung.** 0–25 m LOD0 (24 719 Dreiecke), 25–70 m LOD1 (7 965), darüber LOD2 (1 960), jeweils mit 2 m Hysterese. Mega-Autos zählen entsprechend näher. Alle geladenen LODs eines Autos werden beim Erzeugen instanziert (Geometrie geteilt, nur die Sichtbarkeit wechselt). So gelten Geister- und AFK-Look sofort für jede Stufe. Fehlt ein LOD (Software-Tier lädt kein LOD0), zeigt das Auto die nächstliegende geladene Stufe.

**Materialien pro Auto, Vorlagen nie verändern.** Jedes Auto klont die vier Materialien jeder LOD-Vorlage (`paint_primary`, `paint_secondary`, `glass`, Atlas). Texturen und Programme bleiben geteilt. Deshalb darf ein Auto die Lackfarbe, den Geister-Look (Transparenz), den AFK-Look (grau) und die Lampen-Uniforms frei setzen. `dispose()` gibt nur die Klone frei, Geometrie und Texturen gehören dem Cache. Der AFK-Look ist dafür von `main.ts` in `CarModel.setAfkVisual` gewandert. Vorher setzte `main.ts` `material.color` direkt auf den Mesh-Materialien.

**Spielerfarbe als Lack.** Der Server vergibt beliebige RGB-Farben. `carPaintColor` behält den Farbton, zieht aber Sättigung (höchstens 0,58) und Helligkeit (0,2–0,62) in den Bereich echter Autolacke. So gibt es keinen Neon-Bulli in der ruhigen Welt. `paint_secondary` bleibt das Creme der Vorlage (#D6CBB2). Minikarte und Namensschild behalten die Originalfarbe.

**Räder.** Die Pivots `wheel_fl/fr/rl/rr` drehen um die Achse (Winkel = gerollte Strecke / Radius) und lenken vorn um die Hochachse (`steerAngle` der Sim, + = links). Die Rotation wird mit der Grundrotation des Pivots verknüpft. LOD2 hat die Räder in den Körper gebacken, dort drehen sie nicht. Federung und Nicken bleiben wie gehabt auf `group` und `flipGroup` (`LocalVehicle`: Nicken beim Beschleunigen und Bremsen, Wanken in Kurven, Stauchen beim Landen).

**Fahrzustand.** Das eigene Auto (`LocalVehicle`) und die Sandbox-Dummies melden pro Frame Geschwindigkeit, Lenkwinkel und Bremse (`setDriveState`). Fremde Autos haben nur die 20-Hz-Positionen. Aus ihnen schätzt `CarModel` Geschwindigkeit und Gierrate (geglättet über die Update-Abstände), daraus den Lenkwinkel (Einspurmodell mit Radstand) und das Bremsen (Verzögerung über 3,5 m/s²).

**Lampen im Atlas-Shader.** Die Lampen sind emissive Zellen des Atlas. Der Shader-Patch erkennt die Lampenart am Farbton des Emissive-Texels: Rücklicht rot (g/r ≈ 0,02), Blinker bernstein (≈ 0,25), Scheinwerfer und Innenraum-Glühen hell (> 0,7). Zusätzliche UVs braucht es dafür nicht.
- Bremslicht: Rücklichter × 15, Abfall nach 0,25 s.
- Blinker: pro Seite (Seite aus der Weltposition und der Links-Achse des Autos), 1,4 Hz. Sie blinken beim Abbiegen unter 13 m/s ab 0,14 rad Lenkwinkel. Das ist Deko, es gibt kein eigenes Blinker-Signal.

Die prozeduralen Autos haben ein Bremslicht (Emissive des Rücklicht-Materials), aber keine Blinker.

**Glas.** Fresnel-Alpha aus dem Prototyp-Viewer: An streifenden Winkeln wird das Glas deckender, dadurch bleiben die Spiegelungen auf den Seitenscheiben kräftig. Das Glas wirft keinen Schatten. Der im Glas-Material eingebackene Boden-Blob wird im Shader verworfen, weil er beim Springen mit dem Auto hochfliegen würde. Den Kontaktschatten zeichnet weiter `render/lighting.ts`. Seine Größe kommt jetzt vom Modell (`CarModel.footprint`: Breite × 0,92 · Länge des skalierten T1), und er blendet in der Luft aus.

**Schild und Namensschild.** Beim GLB-Auto ist die Schild-Blase ein Ellipsoid um den skalierten Körper (Halbachsen Breite/2 + 0,7, Höhe/2 + 0,55, Länge/2 + 0,6 m) statt der 3,5-m-Kugel. Das Namensschild steht 0,35 m über dem Sockel `socket_nametag` (2,8 m über dem Boden statt 4 m).

**Nachladen.** Ist das Modell beim Erzeugen eines Bulli noch nicht geladen, startet er prozedural und tauscht den Körper, sobald der Cache fertig ist (`upgradeToGltf`). Geister- und AFK-Zustand sowie der Schild bleiben dabei erhalten. Fehlt das Modell ganz (Manifest 404), bleibt er prozedural. Das prüft ein E2E-Test.

**Prozedurale Autos im realistischen Look.**
- Lack mit Klarlack (`MeshPhysicalMaterial`, im Software-Tier `MeshStandardMaterial`), Spiegel-Chrom, dunkles Tönungsglas, fast schwarze Reifen.
- Abgerundete Karosserie-Kästen (`RoundedBoxGeometry`) und runde Chrom-Stoßstangen.
- Flache Scheinwerfer in Chromringen.
- **Keine Augen mehr** (Nutzerentscheidung), das VW-Rundzeichen in Chrom.

Größen und Hüllen bleiben unverändert, bis die Blender-Modelle kommen.

## Blender-Modell: Änderungen gegenüber dem Prototyp (v3)

- **Heckscheibe und Innenraum im Verfolgerblick:** Das Glas ist heller und weniger deckend getönt (#1C252C, Alpha 0,24 statt #141B20, 0,34). Der Innenraum ist heller (Wände #A69A86, Himmel #EFE8D6, Sitze #CFC2A4). Er bekommt ein schwaches Emissive-„Streulicht“ (10–16 % der Albedo) und nur noch 25 % statt 45 % Innenraum-AO. Durch die Heckscheibe sieht man jetzt Gepäckdeck und Sitzbank statt einer schwarzen Fläche.
- **V-Sicke vorn:** Die Kurve ist gerundet statt ein Polygonzug aus vier Punkten. Die Spitze ist verrundet (Radius 3,5 cm), die Schenkel sind gerade und laufen tangential in die Gürtellinie ein, wie beim echten T1. Vorher knickten sie an der Gürtellinie ab. Die Farbtrennung folgt der Kurve mit 12 (LOD0), 7 (LOD1) bzw. 4 (LOD2) Schnittebenen. Die Sicke ist mit 7,5 mm höher und hat einen schärferen Grat (vorher 5,5 mm), dazu kommt die Chromleiste auf dem Grat.
- **Budget:** LOD1 hatte nur noch 5 Dreiecke Luft. Die Räder von LOD1 haben deshalb 22 statt 24 Segmente.
- **Unverändert:** 4 Oberlichter je Seite, geschlossenes Faltdach, Chrom-Stoßstangen, Surfbrett als ausgeblendeter Node `accessory_surfboard` (`GltfCarBody.setSurfboard`).

## Car-Select-Icon

Die Bulli-Karte im Startbildschirm zeigt einen Eevee-Render des LOD0-Modells: freigestellt, von vorn links, im Sonnenuntergangslicht, als WebP mit Alpha, 156 × 96 px, 7 KB (`public/icons/car-bulli.webp`). Erzeugt wird es mit `node tools/models/build-all.mjs --only=bulli --icons` (Blender `--icon`, dann `sharp`: zuschneiden, einpassen, WebP). Die anderen Karten behalten ihre SVG-Zeichnungen, bis ihre Modelle da sind.

## Messwerte

Gemessen mit `npm run screenshots`, M5-GPU, inklusive Schatten-Pass:

| Ansicht | vorher (Kasten) | jetzt (T1) |
|---|---|---|
| street (Verfolger) | 146 Calls / 296k Dreiecke | 128 / 338k |
| car (Nahaufnahme) | 100 / 274k | 82 / 317k |
| car-plaza | 94 / 275k | 76 / 317k |
| drive (Fahrt) | 150 / 293k | 132 / 336k |
| corner | 122 / 290k | 104 / 332k |
| mobile-portrait (Tier low) | 106 / 183k | 88 / 225k |
| mobile-landscape (Tier low) | 137 / 195k | 119 / 237k |

Ein GLB-Auto kostet 9 Draw Calls (LOD0/1) bzw. 4 (LOD2), dazu den Schatten-Pass. Der prozedurale Kasten brauchte rund 25 Meshes. Pro Bild sind das 18 Calls weniger und etwa 42k Dreiecke mehr (LOD0 mit 24,7k im Haupt- und im Schatten-Pass). Das Handy-Budget (≤ 150 Calls, ≤ 500k Dreiecke) hält. Ein E2E-Test prüft es mit `?tier=low`.

SwiftShader (Software-Tier, `npm run perf:baseline -- --clients=1 --duration=15`, zwei Läufe mit zufälliger Route): 17,8 und 11,9 FPS bei 35 bzw. 79 Draw Calls im Schnitt. Der Vorgänger-Schritt maß 13,0 und 11,5 FPS bei 97 bzw. 107 Calls. Einen Rückschritt gibt es nicht, alle 28 E2E-Tests laufen stabil.

## Tests

- `tests/client/carMaterials.test.ts`: Patches überleben den Klon, eigene Lampen-Uniforms pro Auto bei gleichem Programm, Blob-Discard, Lack-Abbildung.
- `tests/e2e/models.spec.ts`: Das eigene Auto zeigt den GLB-Körper (Software-Tier: LOD1), kein Material ist eine geteilte Vorlage, Maßstab und Maße stimmen. Ein Auto 100 m entfernt wechselt auf LOD2. Die anderen Typen bleiben prozedural. Ohne Manifest bleibt der Bulli prozedural.
- Screenshots: neue Ansichten `car-rear` (Bremslicht, Blinker, Innenraum durch die Heckscheibe) und `showroom` (alle Typen nebeneinander, dazu ein Bulli mit Surfbrett).
