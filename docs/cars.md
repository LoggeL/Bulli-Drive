# Autos im Spiel (Grafik-Schritte G1 „Bulli T1“ und „vier Autos“)

**Stand:** 2026-09-24 · Branch `gfx/g1-realistic`

Alle fünf Autos fahren als realistische Blender-Modelle: VW T1 Samba 1963 (`bulli`, `tools/models/vehicles/bulli.py`), VW 1200 Käfer 1963 (`beetle`), VW T1 Pritsche (`pickup`), Porsche 356 B T6 Coupé (`sport`) und VW Typ 181 (`jeep`), die vier letzten auf der gemeinsamen Bibliothek `tools/models/lib/bd_car.py`. Die prozeduralen Kasten-Autos bleiben nur als Rückfall, falls die Modelle nicht laden. Physik, Kollisionen und Netzwerk sind unverändert: Die Modelle sind reine Optik.

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

**Maßstab der anderen vier.** Dieselbe Regel: ein gleichmäßiger Faktor, die Sim-Hülle bleibt. Pritsche, 356 und 181 nutzen denselben Faktor 1,15 wie der Bulli, damit die Größenverhältnisse der echten Autos untereinander erhalten bleiben. Nur der Käfer bekommt 1,10: Seine Hülle ist die kürzeste (3,5 m), bei 1,15 stünden die Stoßstangen 0,6 m über, bei 1,10 sind es 0,5 m wie beim Bulli.

| Auto | echt (B × L × H) | Faktor | im Spiel | Sim-Hülle (B × L) |
|---|---|---|---|---|
| bulli | 1,80 × 4,28 × 1,94 m | 1,15 | 2,07 × 4,92 × 2,23 m | 2,6 × 4,0 m |
| pickup | 1,75 × 4,29 × 1,92 m | 1,15 | 2,01 × 4,92 × 2,21 m | 2,8 × 5,0 m |
| sport | 1,67 × 4,01 × 1,31 m | 1,15 | 1,92 × 4,61 × 1,51 m | 2,4 × 4,5 m |
| jeep | 1,64 × 3,78 × 1,50 m (Scheibe oben, Verdeck offen) | 1,15 | 1,89 × 4,35 × 1,73 m | 2,8 × 4,2 m |
| beetle | 1,54 × 4,08 × 1,50 m | 1,10 | 1,69 × 4,49 × 1,65 m | 2,2 × 3,5 m |

Der Radstand für die Lenkschätzung fremder Autos kommt jetzt aus dem Modell (Manifest `dimensions.wheelbase` × Faktor), der 356 hat 2,10 statt 2,40 m.

**LOD nach Kameraentfernung.** 0–25 m LOD0 (24 719 Dreiecke), 25–70 m LOD1 (7 965), darüber LOD2 (1 960), jeweils mit 2 m Hysterese. Mega-Autos zählen entsprechend näher. Alle geladenen LODs eines Autos werden beim Erzeugen instanziert (Geometrie geteilt, nur die Sichtbarkeit wechselt). So gelten Geister- und AFK-Look sofort für jede Stufe. Fehlt ein LOD (Software-Tier lädt kein LOD0), zeigt das Auto die nächstliegende geladene Stufe.

**Materialien pro Auto, Vorlagen nie verändern.** Jedes Auto klont die vier Materialien jeder LOD-Vorlage (`paint_primary`, `paint_secondary`, `glass`, Atlas). Texturen und Programme bleiben geteilt. Deshalb darf ein Auto die Lackfarbe, den Geister-Look (Transparenz), den AFK-Look (grau) und die Lampen-Uniforms frei setzen. `dispose()` gibt nur die Klone frei, Geometrie und Texturen gehören dem Cache. Der AFK-Look ist dafür von `main.ts` in `CarModel.setAfkVisual` gewandert. Vorher setzte `main.ts` `material.color` direkt auf den Mesh-Materialien.

**Spielerfarbe als Lack.** Der Server vergibt beliebige RGB-Farben. `carPaintColor` behält den Farbton, zieht aber Sättigung (höchstens 0,58) und Helligkeit (0,2–0,62) in den Bereich echter Autolacke. So gibt es keinen Neon-Bulli in der ruhigen Welt. `paint_secondary` bleibt das Creme der Vorlage (#D6CBB2). Minikarte und Namensschild behalten die Originalfarbe.

**Räder.** Die Pivots `wheel_fl/fr/rl/rr` drehen um die Achse (Winkel = gerollte Strecke / Radius) und lenken vorn um die Hochachse (`steerAngle` der Sim, + = links). Die Rotation wird mit der Grundrotation des Pivots verknüpft. LOD2 hat die Räder in den Körper gebacken, dort drehen sie nicht. Federung und Nicken bleiben wie gehabt auf `group` und `bodyGroup` (`LocalVehicle`: Nicken beim Beschleunigen und Bremsen, Wanken in Kurven, Stauchen beim Landen).

**Fahrzustand.** Das eigene Auto (`LocalVehicle`) und die Sandbox-Dummies melden pro Frame Geschwindigkeit, Lenkwinkel und Bremse (`setDriveState`). Fremde Autos haben nur die 20-Hz-Positionen. Aus ihnen schätzt `CarModel` Geschwindigkeit und Gierrate (geglättet über die Update-Abstände), daraus den Lenkwinkel (Einspurmodell mit Radstand) und das Bremsen (Verzögerung über 3,5 m/s²).

**Lampen im Atlas-Shader.** Die Lampen sind emissive Zellen des Atlas. Der Shader-Patch erkennt die Lampenart am Farbton des Emissive-Texels: Rücklicht rot (g/r ≈ 0,02), Blinker bernstein (≈ 0,25), Scheinwerfer und Innenraum-Glühen hell (> 0,7). Zusätzliche UVs braucht es dafür nicht.
- Bremslicht: Rücklichter × 15, Abfall nach 0,25 s.
- Blinker: pro Seite (Seite aus der Weltposition und der Links-Achse des Autos), 1,4 Hz. Sie blinken beim Abbiegen unter 13 m/s ab 0,14 rad Lenkwinkel. Das ist Deko, es gibt kein eigenes Blinker-Signal.

Die prozeduralen Autos (nur noch Rückfall) haben ein Bremslicht (Emissive des Rücklicht-Materials), aber keine Blinker. Die vier neuen Modelle halten die Lampen-Konvention ein: Rücklichtzellen rot, Blinker bernstein, der Rückfahrscheinwerfer des 181 ist eine nicht leuchtende Zelle („ivory“), damit er nicht dauernd hell leuchtet.

**Glas.** Fresnel-Alpha aus dem Prototyp-Viewer: An streifenden Winkeln wird das Glas deckender, dadurch bleiben die Spiegelungen auf den Seitenscheiben kräftig. Das Glas wirft keinen Schatten. Der im Glas-Material eingebackene Boden-Blob wird im Shader verworfen, weil er beim Springen mit dem Auto hochfliegen würde. Den Kontaktschatten zeichnet weiter `render/lighting.ts`. Seine Größe kommt jetzt vom Modell (`CarModel.footprint`: Breite × 0,92 · Länge des skalierten T1), und er blendet in der Luft aus.

**Schild und Namensschild.** Beim GLB-Auto ist die Schild-Blase ein Ellipsoid um den skalierten Körper (Halbachsen Breite/2 + 0,7, Höhe/2 + 0,55, Länge/2 + 0,6 m) statt der 3,5-m-Kugel. Das Namensschild steht 0,35 m über dem Sockel `socket_nametag` (2,8 m über dem Boden statt 4 m).

**Nachladen.** Ist das Modell beim Erzeugen eines Autos noch nicht geladen, startet er prozedural und tauscht den Körper, sobald der Cache fertig ist (`upgradeToGltf`). Geister- und AFK-Zustand sowie der Schild bleiben dabei erhalten. Fehlt das Modell ganz (Manifest 404), bleibt er prozedural. Das prüft ein E2E-Test.

**Prozedurale Autos im realistischen Look (Rückfall).**
- Lack mit Klarlack (`MeshPhysicalMaterial`, im Software-Tier `MeshStandardMaterial`), Spiegel-Chrom, dunkles Tönungsglas, fast schwarze Reifen.
- Abgerundete Karosserie-Kästen (`RoundedBoxGeometry`) und runde Chrom-Stoßstangen.
- Flache Scheinwerfer in Chromringen.
- **Keine Augen mehr** (Nutzerentscheidung), das VW-Rundzeichen in Chrom.

Größen und Hüllen sind unverändert. Seit dem Schritt „vier Autos“ zeigt das Spiel sie nur noch, wenn die Modelle fehlen.

## Blender-Modell: Änderungen gegenüber dem Prototyp (v3)

- **Heckscheibe und Innenraum im Verfolgerblick:** Das Glas ist heller und weniger deckend getönt (#1C252C, Alpha 0,24 statt #141B20, 0,34). Der Innenraum ist heller (Wände #A69A86, Himmel #EFE8D6, Sitze #CFC2A4). Er bekommt ein schwaches Emissive-„Streulicht“ (10–16 % der Albedo) und nur noch 25 % statt 45 % Innenraum-AO. Durch die Heckscheibe sieht man jetzt Gepäckdeck und Sitzbank statt einer schwarzen Fläche.
- **V-Sicke vorn:** Die Kurve ist gerundet statt ein Polygonzug aus vier Punkten. Die Spitze ist verrundet (Radius 3,5 cm), die Schenkel sind gerade und laufen tangential in die Gürtellinie ein, wie beim echten T1. Vorher knickten sie an der Gürtellinie ab. Die Farbtrennung folgt der Kurve mit 12 (LOD0), 7 (LOD1) bzw. 4 (LOD2) Schnittebenen. Die Sicke ist mit 7,5 mm höher und hat einen schärferen Grat (vorher 5,5 mm), dazu kommt die Chromleiste auf dem Grat.
- **Budget:** LOD1 hatte nur noch 5 Dreiecke Luft. Die Räder von LOD1 haben deshalb 22 statt 24 Segmente.
- **Unverändert:** 4 Oberlichter je Seite, geschlossenes Faltdach, Chrom-Stoßstangen, Surfbrett als ausgeblendeter Node `accessory_surfboard` (`GltfCarBody.setSurfboard`).

## Die vier weiteren Autos (Schritt „vier Autos“)

Gemeinsamer Aufbau: `tools/models/lib/bd_car.py` (Material-Spezifikationen, Atlas mit Palette, Nummernschild, Reifenprofil, Radkappen-Relief und Wappen, Glas, Catmull-Rom-Lofts, Fenster mit Boolean-Schnitten und Innenschale, Lampen, Stoßstangen, Räder, Surfbrett, `assemble()` mit der Node-Konvention, `main()`). Jedes Auto hat dieselben Nodes, Sockets und Materialien wie der Bulli, `paint_primary` ist die Spielerfarbe, das Surfbrett ist ausgeblendet.

| Auto | Aufbau | Besonderheiten |
|---|---|---|
| **Käfer 1963** (`beetle.py`) | Karosserie als Loft aus 20 Halbschnitten, dazu vier Kotflügel als eigene geschlossene Lofts (Superellipsen-Schleifen), die in die Karosserie tauchen; Trittbretter; Radläufe als Boolean-Zylinder | Weißwandreifen, Felgen in Wagenfarbe, gewölbte Radkappen mit VW-Prägung, Torpedo-Blinker auf den Kotflügeln, Hauben-Zierleiste mit VW-Zeichen, Motordeckel mit Lüftungsschlitzen, „Pope's nose“-Kennzeichenleuchte, Doppelrohr-Auspuff, US-Stoßstangen mit Hörnern und Bügel |
| **T1-Pritsche** (`pickup.py`) | importiert `bulli.py` als Modul und nutzt die T1-Schale samt V-Front; ein Boolean-Prisma entfernt die Bus-Karosserie hinter dem Fahrerhaus und über der Ladefläche (0,94 m), mit runder Dachkante | Ladefläche 2,6 × 1,57 m mit Holzboden, drei Bordwänden aus Holz, lackierten Rungen und Oberkanten, „Tresor“-Klappe, kleine Heckscheibe im Fahrerhaus, Stoßstangen in Creme lackiert (wie die Blaupause), keine Weißwandreifen |
| **Porsche 356 B T6** (`sport.py`) | eine glatte Karosserie aus 18 Halbschnitten mit elf Punkten, die Kotflügel-Kronen und Hüften stecken in den Schnittpunkten | stilisiertes Wappen auf der Haube (prozedural gemalt, kein Markenlogo), Haubengriff, Doppel-Motorgitter, ovale Rückleuchten rot/bernstein, rundum laufende Stoßstangen mit hohen Hörnern, Silberfelgen mit Lüftungslöchern und Chrom-Domkappe |
| **Typ 181** (`jeep.py`) | lineare Lofts (ebene Bleche mit kleinen Fasen): Haube mit flachen Kotflügel-Oberseiten, offene Wanne mit Rand, Innenwänden und Boden (Stirnwand und Rückwand aus Doppelstationen), Heckdeck; aufgeschraubte Kotflügelbleche mit trapezförmigen Radausschnitten, Karosserie-Ausschnitte als Boolean-Prismen | Frontscheibe hochgeklappt (Rahmen in Wagenfarbe), Verdeck gefaltet auf dem Heckdeck, schwarze Stahl-Stoßstangen, Sicken auf Türen, Frontblech und Haube, Heckklappe mit drei Lüftungsgruppen, schwarze Stahlfelgen mit Löchern und kleiner VW-Nabenkappe, offener Innenraum mit Sitzen und Lenkrad |

**Maße und Blaupausen.** Längen, Breiten, Höhen, Radstände, Spurweiten und Reifengrößen stehen in `tools/models/ref/dimensions.json`. Für den 356 habe ich eine eigene orthografische Blaupause per Codex-imagegen erzeugt (`ref/sport_blueprint.jpg`, Prompt in `ref/blueprint_prompt.txt`) und die Maße der de.wikipedia übernommen: 4,01 × 1,67 × 1,31 m, Radstand 2,10 m, Spur 1,306/1,272 m, Reifen 165-15 (Ø 0,652 m). Der Eintrag `sport` enthielt vorher den Karmann Ghia. Die KI-Blaupausen sind nicht exakt maßstäblich. Längen, Höhen und Breiten sind deshalb je Ansicht getrennt auf die echten Maße gezogen (`ref/blueprints.json`, Overlay mit `compare_blueprint.py --car=<id>`).

**Iterationen** (Eevee-Renders und Ortho-Overlays, je Auto mindestens zwei Runden):
- Käfer: (1) Die Heckscheibe ließ den Fenster-Boolean die ganze Karosserie löschen. Der Schnitt nutzt jetzt EXACT mit Selbstüberschneidung. (2) Das Dach war im Querschnitt zu kastig („Limousine“): Es folgt jetzt einem Bogen mit etwa 0,9 m Radius. Front- und Heckscheibe lagen verkürzt auf der Ebene, jetzt sitzen ihre Ecken auf der Fläche. (3) Budget: LOD0 von 22,1k auf 18,8k Dreiecke, LOD2 ohne Radlauf-Booleans (die Kotflügelschleifen heben sich über die Räder).
- Pritsche: (1) Erster Stand mit geradem Schnitt hinter dem Fahrerhaus. (2) Die Dachkante hinten ist mit 16 cm Radius gerundet, das Holz etwas entsättigt.
- 356: (1) Die Nase stand zu steil und hoch. Sie ist jetzt tiefer und runder. (2) Die vordere Stoßstange steckte unter der Nase. Die Nasenspitze sitzt jetzt 5 cm hinter der Stoßstange. Motorgitter kleiner, hinterer Radausschnitt enger.
- Typ 181: (1) Das gefaltete Verdeck bestand aus drei Rohren. (2) Jetzt sind es zwei flachgedrückte Wülste mit Spriegeln.

**Blender-Warnung „Mesh body is not valid“.** Die Booleans ließen entartete Flächen zurück. `assemble()` ruft jetzt `mesh.validate()` vor dem AO-Bake auf, die Warnung ist weg.

## Car-Select-Icons

Alle fünf Karten im Startbildschirm zeigen einen Eevee-Render des LOD0-Modells: freigestellt, von vorn links, im Sonnenuntergangslicht, als WebP mit Alpha, 156 × 96 px, 5–7 KB (`public/icons/car-<id>.webp`). Erzeugt werden sie mit `node tools/models/build-all.mjs --only=<id> --icons` (Blender `--icon`, dann `sharp`: zuschneiden, einpassen, WebP). Die SVG-Zeichnungen sind entfernt.

## Messwerte

Schritt „vier Autos“ (M5-GPU, inklusive Schatten-Pass): Die Ansichten mit dem eigenen Bulli sind unverändert. Der Showroom (alle fünf Typen plus ein Bulli mit Surfbrett) sinkt von 241 auf 167 Draw Calls, die Dreiecke steigen von 404k auf 494k. Die neuen Nahansichten `car-beetle`, `car-pickup`, `car-sport` und `car-jeep` liegen bei 95–97 Calls und 298k–319k Dreiecken. Ausgeliefert werden jetzt 1,39 MB GLBs für alle fünf Autos (Software-Tier: nur LOD1 und LOD2, rund 0,62 MB; vorher nur der Bulli mit 0,34 MB bzw. 0,13 MB).

Schritt „Bulli T1“, gemessen mit `npm run screenshots`, M5-GPU, inklusive Schatten-Pass:

| Ansicht | vorher (Kasten) | jetzt (T1) |
|---|---|---|
| street (Verfolger) | 146 Calls / 296k Dreiecke | 128 / 338k |
| car (Nahaufnahme) | 100 / 274k | 82 / 317k |
| car-plaza | 94 / 275k | 76 / 317k |
| drive (Fahrt) | 150 / 293k | 132 / 336k |
| corner | 122 / 290k | 104 / 332k |
| mobile-portrait (Tier low) | 106 / 183k | 88 / 225k |
| mobile-landscape (Tier low) | 137 / 195k | 119 / 237k |

Ein GLB-Auto kostet 9 Draw Calls (LOD0/1) bzw. 4 (LOD2), dazu den Schatten-Pass. Der prozedurale Kasten brauchte rund 25 Meshes. Pro Bild sind das 18 Calls weniger und etwa 42k Dreiecke mehr (LOD0 mit 24,7k im Haupt- und im Schatten-Pass).

**Mitspieler auf dem Handy (G1-Nacharbeit).** Die Zahlen oben gelten für das eigene Auto allein. Jedes weitere Auto kostete auf Tier low rund 14 Calls (8 im Haupt-Pass, etwa 5 im Schatten-Pass): LOD1 hat so viele Primitives wie LOD0, weil die vier Räder einzeln gezeichnet werden. Mit drei Mitspielern im Bild war das Budget gerissen. Jetzt gilt auf Tier `mobile` für alle Autos außer dem eigenen (`CarModel` mit `local: false`, `PHONE_REMOTE_LOD_DISTANCES` in `GltfCarBody.ts`):

- nie LOD0; LOD1 bis 14 m Kameraabstand, danach LOD2,
- in LOD1 sind die Räder beim Laden in den Atlas-Teil der Karosserie gebacken (`ModelCache.staticWheelLods`, `staticWheelLodsForTier`), sie drehen und lenken dort nicht mehr (LOD2 hat die Räder schon im GLB verschmolzen),
- kein Schattenwurf, der Kontaktschatten bleibt.

Ein Mitspieler kostet damit 4 Calls (LOD1: Lack, Zweitlack, Atlas mit Rädern, Glas) bzw. 3 (LOD2). Gemessen auf dem Handy-Tier (GPU, iPhone-13-Hochformat, Straßenansicht): allein 88 Calls, mit sieben Autos 8–38 m voraus 105 Calls (vorher rund 190). Der E2E-Test `the phone tier stays within 150 draw calls including shadows` stellt jetzt zusätzlich sieben Autos aller Typen ins Bild. Desktop und Software-Tier bleiben unverändert.

LOD0 und LOD1 eines Autos betten dieselben Atlas-Bilder ein. `ModelCache` erkennt gleiche Texturen am Inhalt (Größe, Bytes, Sampling) und hängt die Materialien von LOD1 auf die Texturen von LOD0 um, so werden sie nur einmal hochgeladen (rund 0,8 MB GPU-Speicher je Auto). Der doppelte Download (rund 200 KB insgesamt) bleibt, bis `tools/models/pack.mjs` die Atlanten als gemeinsame KTX2 auslagert.

SwiftShader (Software-Tier, `npm run perf:baseline -- --clients=1 --duration=15`, zwei Läufe mit zufälliger Route): 17,8 und 11,9 FPS bei 35 bzw. 79 Draw Calls im Schnitt. Der Vorgänger-Schritt maß 13,0 und 11,5 FPS bei 97 bzw. 107 Calls. Einen Rückschritt gibt es nicht, alle 28 E2E-Tests laufen stabil.

## Tests

- `tests/client/carMaterials.test.ts`: Patches überleben den Klon, eigene Lampen-Uniforms pro Auto bei gleichem Programm, Blob-Discard, Lack-Abbildung.
- `tests/client/gltfCarBody.test.ts`: Alle fünf Typen werden gleichmäßig auf die Maße der Tabelle oben skaliert und bleiben in ihrer Sim-Hülle (Stoßstangen höchstens 0,5 m über). Jedes Auto hat eigene Materialklone, keines ist eine geteilte Vorlage. LOD nach Kameraentfernung mit 2 m Hysterese; fremde Autos auf dem Phone-Tier nur LOD1/LOD2 (LOD2 ab 14 m), ohne Schattenwurf.
- `tests/e2e/desktop.spec.ts`: Der Software-Tier lädt im Browser LOD1 und LOD2 aller fünf Autos über den gehashten Basis-Transcoder, das eigene Auto zeigt den GLB-Körper. `tests/e2e/asset-fallback.spec.ts`: Ohne Manifest bleibt der Bulli prozedural. `tests/e2e-render/phone-tier.spec.ts`: das Draw-Call-Budget des Phone-Tiers mit sieben fremden Autos.
- `tests/client/modelBudgets.test.ts`: jedes Auto hat ein Modell; für die vier neuen gelten die strengeren Grenzen aus `budgets.json` (`modelTriangles`: 20k / 7k / 2k).
- Screenshots: neue Ansichten `car-rear` (Bremslicht, Blinker, Innenraum durch die Heckscheibe) und `showroom` (alle Typen nebeneinander, dazu ein Bulli mit Surfbrett); seit „vier Autos“ zusätzlich `car-beetle`, `car-pickup`, `car-sport`, `car-jeep` (Nahansicht, bremsend, eingelenkt) und `showroom-rear` (alle Typen von hinten mit Bremslicht).
