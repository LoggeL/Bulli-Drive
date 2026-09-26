# Welt-Look: realistisch, ruhig-naturgetreu (Grafik-Schritt G1)

**Stand:** 2026-09-25 · Phase 3 M4 (Bulli Bay). Der Abschnitt „Bulli Bay“ beschreibt die heutige Welt; die Abschnitte danach sind das Protokoll des Grafik-Schritts G1 (2026-09-23, Branch `gfx/g1-realistic`) und beschreiben die alte Stadt. Licht, Nebel, Grade, Himmel, Palmen, Bäume, Brunnen, Straßenmöbel und die Texturen gelten weiter, Gebäude, Straßen und Gelände nicht mehr.

## Bulli Bay (Phase 3, M4)

Seit M4 zeichnet der Client die kuratierte Karte (Details und Abweichungen: [`docs/phase-3-design.md`](phase-3-design.md) 9–11 und A59 ff.):

| Bereich | Umsetzung |
|---|---|
| Gelände | verschachtelte Ringe um die Kamera (Clipmap, `terrainGrid.ts`), auf der CPU aus `heightAt` gefüllt: jede Ecke liegt auf dem Boden der Sim (4,3 cm Abweichung bei 0,5 m Raster auf dem rauesten befahrbaren Boden, 2,5 cm auf Straßen). Oberflächen aus der gebackenen Schicht als Splat (Sand, nasser Sand, Erde, Kies, Fels, Rasen), Hügel jenseits der Kartendaten |
| Straßen | Bänder entlang der Kanten mit den Markierungen im Shader (Mittel-, Spur-, Randlinien, Parken, Haltelinien, Zebrastreifen, Stellplätze), Kreuzungsflächen mit runden Ecken, Gehwege und Bordsteine, Plaza-Pflaster; je Belag und 500-m-Block ein Mesh |
| Meer | eine Ebene bis zum Horizont, Tiefe aus den Höhen (R16UI), Brandung und Flachwasser, weiche Wasserlinie |
| Gebäude, Landmarken | das Blender-Kit (`public/models/kit`), je Zelle und LOD zusammengeführt: 250-m-Chunks mit LOD2, 125-m-Viertel mit LOD1, 62,5-m-Achtel mit LOD0. Diner, Tankstelle, Leuchtturm, Wasserturm, Rettungstürme, Lichtmasten, Hafenkräne, Pier |
| Pflanzen, Requisiten | Palmen und Bäume mit Collidern aus `src/shared`, Streuung ohne Collider im Client (Chaparral, Büsche, Blumen, Strandhafer, Sonnenschirme, Volleyballnetze, Paletten, Briefkästen, Ranch-Zäune), alles instanziert und je Chunk gecullt |
| Straßenmöbel | Laternen, Ampelmasten, Hydranten, Bänke und Mülleimer in Downtown, im Park und um den Plaza-Brunnen, mit Collidern aus `src/shared/map/furniture.ts`; nah das G1-Modell, fern ein paar Boxen |
| Sonne | aus `map.json`: West-Nordwest über dem Pazifik, 17° hoch |
| Minimap | Karte genordet, Osten rechts (E2) |

**Detailstufen** (`worldQuality.ts`): high (Desktop), mid (Desktop, dessen GPU selbst bei kleinster Auflösung zu langsam ist), low (Handys), software (CPU-Rasterizer, E2E). Sie regeln Gelände-Ringe, Kit-Zellen, Sichtweiten der Instanzen und die Dichte der Streuung. Auf einem CPU-Rasterizer zeichnet die Seite ohne Multisampling und mit einem halben Pixel je CSS-Pixel (zusammen gut die Hälfte jedes SwiftShader-Bildes).

**Draw Calls und Dreiecke** (`npm run screenshots`, M5-GPU, einschließlich Schatten-Pass; Budget Desktop ≤ 300 Calls und 1,2 Mio. Dreiecke, Handy ≤ 150 und 500 k):

| Ansicht | Calls (Schatten) | Dreiecke |
|---|---|---|
| Main Street (street) | 143 (39) | 1 009 k |
| Fahrt (drive) | 151 (40) | 1 005 k |
| Plaza | 91 (26) | 776 k |
| Promenade | 101 (33) | 873 k |
| Hafen (harbor) | 111 (30) | 611 k |
| Arena mit 8 Autos | 104 (35) | 377 k |
| Ridge-Kehre (ridge) | 52 (16) | 529 k |
| Aussichtspunkt (lookout) | 102 (9) | 653 k |
| Überblick (overview) | 107 (10) | 634 k |
| Rennstart mit Feld (race-start) | 182 (69) | 1 123 k |
| Mobil hoch (Tier low) | 99 (28) | 406 k |
| Mobil quer (Tier low) | 126 (28) | 483 k |

Der Render-Test (`tests/e2e-render/phone-tier.spec.ts`) prüft das Handy-Budget an drei festen Punkten und mit sieben fremden Autos.

## Grafik-Schritt G1 (alte Stadt)

Die Spielwelt ist vom Low-Poly-Stil mit Einzel-Meshes auf einen realistischen Look umgestellt. Vorbild ist die Welt-Probe des Prototyps (`gfx/real/world`), mit ruhigerer, naturgetreuer Farbstimmung. Das goldene KI-Zielbild war ausdrücklich nicht die Vorlage. Straßen- und Stadtlayout sowie alle Kollisionen sind unverändert. Geändert hat sich nur die Optik.

## Was sich geändert hat

| Bereich | Vorher | Jetzt |
|---|---|---|
| Licht | Gradient-Himmel, Sonne 28° | HDRI-basierter Himmel mit Wolkenstruktur aus Qwantani Sunset (CC0), PMREM-Environment aus demselben Himmel, unten Victoria Sunset (CC0). Sonne 17° hoch, auf der Himmelsrichtung der HDRI-Sonne |
| Nebel | `THREE.Fog`, linear 70–340 m, stark orange | Höhennebel aus der Probe: in linearem HDR vor dem Tonemapping, in Sonnenrichtung wärmer und heller, dünnt mit der Höhe aus. Gilt für jedes Material mit `fog: true` |
| Tonemapping | ACES | ACES mit mildem Grade aus der Probe: farbtonerhaltende Lichter, leichtes Split-Toning, Sättigung 1,06. Keine LUT |
| Straßen | Flächen in einer Farbe | PBR-Asphalt (Poly Haven) mit Radspuren, Ölspur, Rinnstein-Schmutz und Flicken. Markierungen abgefahren (gelbe Mittellinie, weiße Randlinien, Continental-Zebrastreifen, Haltelinien, rote Bordsteine an den Ecken) |
| Gehwege, Blöcke | einfarbig | Besenstrich-Beton mit 1,5-m-Fugenraster, Bordsteine, Gassen in Asphalt |
| Gebäude | Box + Einzel-Mesh-Fenster, Rahmen, Türen, Schilder | Stuckfassaden aus dem Geschoss-Atlas (Fenster, Balkone, Türen und Läden im Atlas statt als Meshes), getönt nach der Server-Farbe (auf ruhige Pastelltöne abgebildet), Gurtgesims, Kranzgesims, Walmdach mit Ziegeln oder Flachdach mit Kiesbelag, Brüstung, Terrakotta-Abdeckung und Ziegel-Vordach. Dazu gestreifte Markisen und Ladenfronten (Diner, Surf-Shop, Tankstelle) |
| Plaza, Park | Einzel-Meshes | Terrakotta-Platten (Shader), profilierter Steinbrunnen mit zwei Schalen, fallendem Wasser und Wasser-Shader, Terrakotta-Töpfe, Marktschirme. Rasen (PBR), Wege mit Beton-Kante, Teich mit Steinrand, Kanarische Dattelpalmen, Bänke, Bougainvillea-Beete (Details unten) |
| Straßenmöbel | Kugel-Laternen | instanziert: Schwanenhals-Laternen, Ampel-Auslegermasten mit Straßenleuchte, Hydranten, Mülleimer, Parkbänke. Palmen instanziert mit Wind und Fern-Impostor (Details unten) |
| Gelände | grüne Vertexfarben, Kegelbäume | trockenes goldenes Gras (PBR) mit Chaparral-Flecken, Erde und Fels an steilen Hängen. Eichen und Zypressen als Kreuzkarten, Felsen, Büsche. Außerhalb der Spielfläche steigt eine Hügelkette zum Horizont an (nur Optik) |

## Draw Calls

Gemessen mit `npm run screenshots` auf dem M5-GPU, **einschließlich Schatten-Pass**. Seit diesem Schritt zählen die Zähler den Schatten-Pass mit (`src/client/render/frameStats.ts`). Vorher setzte three.js die Zähler erst nach dem Schatten-Pass zurück. Die Vorher-Werte stammen vom selben Stand mit korrigierter Zählung.

| Ansicht | vorher | jetzt |
|---|---|---|
| Straße (street) | 1 038 | 132 |
| Überblick (overview) | 1 396 | 165 |
| Stadt vom Hügel (outskirts-city) | 1 371 | 167 |
| Fahrt (drive) | 1 060 | 136 |
| Park | 413 | 68 |
| Mobil quer (iPhone 13, Tier low) | 1 012 | 129 |
| Mobil hoch (iPhone 13, Tier low) | 571 | 101 |

Die ganze statische Stadt besteht aus je einem Mesh pro Material, etwa 16 Draw Calls plus Schatten. Den Rest der Calls verursachen Spielobjekte, die dieser Schritt nicht anfasst: 30 Münzen, 25 Powerups mit je zwei Meshes und das prozedurale Auto mit rund 25 Meshes. Die Dreiecke steigen von etwa 100 k auf etwa 200 k (Desktop) bzw. 150 k (Mobil), vor allem durch das größere Gelände mit Hügelkette. Das Budget für Tier low liegt bei ≤ 500 k.

## Palmen und Straßenmöbel (Schritt palms-props)

Palmen, Straßenmöbel, Plaza und Park sind in einem zweiten Schritt realistischer geworden. Positionen und Collider sind unverändert: `obstacles.json` der Screenshot-Läufe ist vorher und nachher byte-gleich, der E2E-Test pinnt weiter den SHA-1.

**Palmen** (`src/client/world/palms.ts`)
- Washingtonia robusta am Boulevard mit dichterer, grünerer Krone: 5 Blattringe statt 4, fast nur die grünen Zellen des Fächer-Atlas, stärkere Transluzenz im Gegenlicht, kurzer Rock aus toten Blättern. Kanarische Dattelpalmen mit dickem Stamm und rund 60 Wedeln.
- Instanziert: pro Art ein Stamm- und ein Wedel-Mesh für alle nahen Palmen.
- Wind: Jeder Vertex trägt `wind` = (Biegung, Flattern, Phase). Der Vertex-Shader (`WIND_GLSL` in `materials.ts`) lässt die Palme schwanken und die Blätter flattern. Der Schatten-Pass nutzt dasselbe über ein `customDepthMaterial`, die Schatten schwanken also mit. Im software-Tier ist der Wind aus.
- Fern-LOD: Ab 170 m (Handy 110 m, software 80 m, Hysterese 8 m) wird eine Palme zur Impostor-Karte. Die Karte dreht sich um die Hochachse zur Kamera und wird mit gerundeten Normalen beleuchtet. Ihr Bild wird zur Laufzeit aus derselben Geometrie und denselben Texturen in einen Atlas gerendert, sobald die Texturen geladen sind. Nach einem Kontextverlust wird es neu gerendert, bis dahin sind alle Palmen nah. Alle fernen Palmen zusammen kosten einen Draw Call.
- Der Park („Palm Park“) hat statt der vier Eichen-Karten Dattelpalmen auf denselben Plätzen mit denselben Collidern.

**Straßenmöbel** (`src/client/world/furniture.ts`, Platzierung in `streetLayout.ts`)
- Pro Art ein `InstancedMesh`: Schwanenhals-Laterne (Gusseisen, Milchglas-Kugel), Ampelmast (verzinkter Mast, 7-m-Ausleger mit zwei Signalköpfen über den Fahrspuren, ein Kopf am Mast, Straßenleuchte obendrauf), kalifornischer Hydrant, Mülleimer aus Stahllamellen und Parkbank (Gusseisen und Holz).
- Materialien: ein gemeinsames Material. Das Vertex-Attribut `surface` trägt Rauheit, Metallizität, Emission und Ampel-Linse, dazu Rauschen in der Rauheit und Schmutz am Boden. Verzinkter Stahl ist metallisch und spiegelt die Environment-Map.
- Ampeln: An den fünf Kreuzungen mit einem Mast an jeder Ecke werden alle vier Laternen zu Ampelmasten. Jeder Ausleger reicht über die Spuren des Verkehrs, der von gegenüber kommt (Rechtsverkehr, fernes rechtes Eck). Die Lichter schalten im Shader in einem 40-s-Zyklus (16 s grün, 3,5 s gelb, kurzes Allrot). Die beiden Achsen sind um einen halben Zyklus versetzt.
- Hydranten und Mülleimer stehen nur innerhalb bestehender Collider: neben einem Mast (Collider 0,7 m) oder am Ende einer Bank (1,7 m). Es gibt also keine neuen Hindernisse, und das Auto fährt nie durch einen Hydranten. `tests/client/streetLayout.test.ts` prüft, dass jedes Teil im Collider seines Wirts steht und dessen Fuß nicht schneidet.
- Bestand: 12 Laternen, 20 Ampelmasten, 6 Hydranten, 7 Mülleimer, 4 Bänke.

**Plaza und Park**
- Plaza: Terrakotta-Platten (60 cm) als Shader auf dem Beton-PBR (`M.pavers`) mit Farbe pro Platte und Mörtelfugen. Terrakotta-Töpfe mit Wulstrand, Marktschirme mit achteckigem Dach, Rippen, Volant, Holzstiel und gusseisernem Fuß.
- Brunnen (`src/client/world/fountain.ts`): profiliertes Steinbecken, Säule mit zwei Schalen und Spitze. Wasserflächen mit Wellenringen und Schaum dort, wo das Wasser auftrifft (`M.fountainWater`). Fallende Wasserschleier von beiden Schalenrändern und eine Wasserglocke über der Spitze mit nach unten laufenden Schlieren (`M.falls`). Nur `uTime` animiert, die Kugel-Partikel auf der CPU sind weg.
- Park: Bänke zum Teich gedreht, Teich mit profiliertem Steinrand, Wege mit Beton-Kante, Beete mit Steinrand.

**Draw Calls und Dreiecke** (M5-GPU, einschließlich Schatten, vorher → nachher)

| Ansicht | Calls | Dreiecke |
|---|---|---|
| Straße (street) | 132 → 146 | 197 k → 296 k |
| Plaza | 87 → 98 | 183 k → 280 k |
| Park | 68 → 78 | 176 k → 279 k |
| Überblick (overview) | 165 → 171 | 208 k → 269 k |
| Fahrt (drive) | 136 → 150 | 199 k → 293 k |
| Mobil quer (iPhone 13, Tier low) | 129 → 137 | 157 k → 195 k |
| Mobil hoch (iPhone 13, Tier low) | 101 → 106 | 148 k → 183 k |

SwiftShader (software-Tier, fester Punkt, je zwei Läufe): Straße 12,7 → 10,6 FPS, Plaza 16,7 → 14,3 FPS, Park 18,8 → 16,0 FPS (die Werte schwanken zwischen Läufen um bis zu 2 FPS). Dort werfen die Möbel keine Schatten, der Wind ist aus, Palmen haben 40 % weniger Blätter und werden ab 80 m zu Impostors. Die E2E-Fahrtests laufen unverändert durch.

Tier low bleibt unter 150 Draw Calls und weit unter 500 k Dreiecken. Der E2E-Test mit `?tier=low` prüft beides und dazu, dass ferne Palmen Impostors sind. Die Mehrkosten entstehen so: fünf Möbel-Arten (je ein Call plus Schatten; auf dem Handy werfen Hydranten und Mülleimer keine Schatten), Plaza-Platten, Wasserschleier und Impostors. Dafür entfallen das Emissive-Mesh der Laternen und die Eichen-Karten. Die zusätzlichen Dreiecke auf dem Desktop stammen vor allem von den 20 Ampelmasten im Schatten-Pass.

## Qualitäts-Tiers

`src/client/effects/renderQuality.ts` bestimmt den Tier. Mit `?tier=high|low|software` lässt er sich erzwingen.

| | high (`desktop`) | low (`mobile`, Handys) | software (SwiftShader, E2E) |
|---|---|---|---|
| Materialien | PBR: Albedo, Normal, ARM | PBR ohne Normal-Maps | Lambert, große Flächen ohne Textur (mittlere Albedo), nur Atlas- und Laubtexturen |
| Himmel | HDRIs (2,7 MB) | prozedurale Wolken, keine HDRIs | Verlauf und Sonne ohne Wolken |
| Environment-Map | PMREM | PMREM | keine (Hemisphere-Licht) |
| Schatten | 2048, PCF 3 × 3, ±60 m | 1024, PCF 3 × 3, ±45 m | keine Schattenkarte, nur Kontaktschatten unter den Autos (seit Phase 3, A71) |
| Pixel-Ratio | ≤ 2 | ≤ 1,5 | ≤ 2 (adaptiv); seit Phase 3 M4 fest 0,5 |
| Post-Processing | keins | keins | keins |
| Gelände-Raster | 8 m | 10 m | 16 m |
| Bulli Bay (M4) | Ringe ab 0,5 m, Kit-LOD0 bis 60 m | Ringe ab 0,5 m, Kit ab LOD1 | Ringe ab 1 m, Kit-LOD2 bis 220 m, kein Multisampling |

Texturen sind auf allen Tiers KTX2 (`src/client/world/textures.ts`, Platzhalter-Texturen, die nach dem Laden gefüllt werden, ohne dass Shader neu kompilieren).

**SwiftShader:** Die E2E-Tests messen Fahrstrecken, deshalb ist der software-Tier bewusst schlank. Gemessen mit `scripts/perf-baseline.ts` (1 Client, 15 s):

| | FPS | gefahrene Strecke |
|---|---|---|
| vorher | 13,1 | 47 m |
| jetzt | 20,0 | 521 m |

Die Strecke hängt von der zufälligen Route ab. An einem festen Punkt (Straßenansicht) liefen vorher 10,0 FPS und jetzt 11,7 FPS.

## Kontextverlust

Nach `webglcontextrestored` baut `sky.ts` die PMREM-Environment-Map neu. Texturen (KTX2-Mipmaps, HDR-DataTextures, Canvas) lädt three.js aus den behaltenen CPU-Daten selbst wieder hoch. `tests/e2e/world-look.spec.ts` prüft beides: Es gibt eine neue Environment-Map und dieselbe mittlere Bildfarbe vor und nach dem Verlust.

## Entscheidungen

- **Sonnenhöhe 17° statt 9° (Probe):** Die Stadt hat bis zu 26 m hohe Häuser. Bei 9° lägen fast alle Straßen im Schatten. 17° hält das warme, flache Licht und lässt die Fahrbahn teilweise in der Sonne.
- **Farbstimmung:** Sonne `#FFBD88` statt `#FFB070` und Sättigung 1,06 statt 1,12. Das ist die ruhige Variante der Probe, weniger orange.
- **Kein Post-Processing, auch nicht auf Desktop:** Bloom und SMAA der Probe würden einen zweiten Render-Pfad bedeuten, mit eigenen Regeln für Resize, Kontextverlust und adaptive Auflösung. Das Sonnenglühen übernimmt der Himmel-Shader. Nachrüsten lässt sich das in einem eigenen Schritt.
- **Nebel über die Shader-Chunks:** Statt jedes Material einzeln zu patchen, ersetzt `installHeightFog()` die Fog-Chunks von three.js. Damit stehen Autos, Münzen und Partikel im selben Dunst wie die Welt.
- **Gebäude ohne eingesetzte Fensterlaibungen:** Die Probe setzte Fenster nah an der Kamera 14 cm tief ein. Im Spiel fährt die Kamera überall hin, deshalb nur der flache Atlas (weniger Dreiecke, gleiche Draw Calls).
- **Keine zusätzlichen Palmen oder Bäume auf Spielfläche mit Kollision:** Neue Kollisionsobjekte hätten das Gameplay verändert. Dekorative Vegetation ohne Kollision gibt es auf der Spielfläche nur als niedriges Buschwerk (wie die bisherigen Büsche). Bäume ohne Kollision stehen nur außerhalb von `WORLD_BOUND`.
- **Hügelkette nur optisch:** Innerhalb der Spielfläche folgt der Boden exakt `getTerrainHeight()`. Erst ab 590 m vom Stadtzentrum wachsen Hügel dazu. Deshalb liegt die Far-Plane der Kamera jetzt bei 2 600 m statt 1 000 m.
- **Ferne Laubkarten:** Auf den kleinsten Mip-Stufen würde das gemittelte Alpha das ganze Karten-Rechteck durchlassen. Dort wird der Ausschnitt deshalb zu einer Silhouette aus Krone und Stamm (`cardMask`). Aus großer Höhe (Überblick) wirken ferne Bäume dadurch etwas vereinfacht. Palmen haben seit palms-props echte Impostors, die Bäume im Gelände noch nicht.
- **Impostors zur Laufzeit gerendert statt als Datei:** Der Atlas entsteht aus genau der Geometrie des Tiers, braucht kein Build-Werkzeug und keine Bytes im Repo. Gerendert wird nur die Albedo, das Licht kommt zur Laufzeit dazu. Deshalb passen Impostor und Palme bei jeder Sonne zusammen. Die Seitenansicht wirkt aus der Nähe flach (`palms-lod` im Screenshot-Satz erzwingt Impostors ab 12 m). Ab 170 m fällt das nicht auf.
- **Ampeln statt Laternen an vollen Kreuzungen:** Nur Kreuzungen, an denen schon an jeder Ecke ein Laternen-Collider stand, bekommen Ampeln. So bleibt jeder Collider, wo er war. Ausleger und Signalköpfe hängen in 4,9–6,5 m Höhe über der Fahrbahn und haben keinen eigenen Collider. Bei sehr hohen Sprüngen kann ein Auto durch einen Ausleger fliegen.
- **Instanzen statt zusammengeführter Batches:** Instanzen kosten pro Art einen Call (plus Schatten), der frühere Laternen-Batch war ein einziger. Dafür teilen sich alle Masten eine Geometrie im Speicher, und jede Art lässt sich einzeln budgetieren und abschalten (z. B. Schatten der Kleinteile auf dem Handy).
- **Kein neues Textur-Asset:** Plaza-Platten, Wasser und Möbel-Oberflächen kommen aus dem vorhandenen Beton-PBR, dem Welt-Rauschen und Vertex-Attributen.
- **Kollisionen:** Ein E2E-Test pinnt den SHA-1 der 241 Hindernisse des Clients auf den Stand vor diesem Schritt.

## Nacharbeit nach dem Art-Review

Ein Review der Screenshots und Messungen brachte 20 Befunde. Umgesetzt (Wirkung zuerst):

**Laubbäume (`vegetation.ts`, `materials.ts` `cardMask`).** Die Kreuzkarten zerfielen in eine schwarze und eine helle Hälfte, mit heller Naht und blassen Geisterkarten. Ursachen und Lösung:

- Die gebogenen Normalen drehten nicht mit der Kartenebene mit. Jetzt zeigen sie in jeder Ebene vom Stamm weg (oben mehr nach oben).
- three.js drehte die Normalen auf Rückseiten um (DoubleSide). Die Karten behalten jetzt auf beiden Seiten dieselbe Normale. Normalen der abgewandten Kronenseite werden zur Kamera gespiegelt wie bei einer Kugel. Dazu kommt ein Wrap zur Sonne (Streulicht in der Krone), sonst ist jede Karte entweder ganz hell oder schwarz.
- Die Karten beschatteten sich gegenseitig in harten Hälften, und an der Schnittlinie leckte Licht durch den Schatten-Bias. Die Bäume empfangen keine Schatten mehr. Die Vertexfarbe dunkelt den Fuß der Krone ab (gebackene Verdeckung).
- Der „blasse Schemen“ war die Spiegelung des Abendhimmels auf der Karte, die zur Kamera zeigt. Laub ist jetzt matt: 10 % indirekte, 30 % direkte Spiegelung.
- Karten, die man fast von der Kante sieht, blenden aus. Eichen haben eine waagerechte Kronenkarte, die nur von oben sichtbar ist. Breite und Höhe variieren pro Baum, die Hälfte ist gespiegelt. Ferne Kronen haben einen verrauschten Umriss statt einer Ellipse (kein „Lolli“) und sind etwas dunkler.

**Bäume im Gelände (`environment.ts`).** Die Bäume standen auf der exakten Höhe, das Terrain-Mesh interpoliert aber über bis zu 110 m große Zellen. Auf Graten schwebten sie deshalb meterweise. Jetzt nimmt `GroundSampler` die Höhe aus dem Dreieck des gerenderten Gitters, für Bäume, Büsche und Felsen. Die Schattenkarte deckt die Hügel nicht ab. Deshalb standen Bäume auf den sonnenabgewandten Hängen voll beleuchtet als helle Punkte da. Ein Strahl von der Krone zur Sonne über das Gelände (`sunOver`) backt jetzt den Hügelschatten in die Instanzfarbe.

**Stadt.**

- Teich: Die Kieswege lagen unter dem Wasser, ihr Polygon-Offset (−2) zog sie aus der Ferne darüber. Die Wege enden jetzt unter der Einfassung. Das Wasser reicht bis zu deren Innenseite und hat selbst einen Offset.
- Lichtlinie am Gebäudefuß: Das war kein Spalt, sondern Sonnenlicht auf dem Gehweg. three.js zeichnet die Schattentiefe der Wände von ihren Rückseiten, also der Schattenseite. Der Bias (rund 0,2 m) ließ direkt vor der Wand einen Streifen Licht durch. `M.facade.shadowSide = FrontSide` nimmt die sonnenzugewandten Wände. Die Wände reichen zudem 0,2 m unter das Pflaster.
- Fassaden-Putz: Das Rauschen für die „Schmutzläufer“ war vertikal zwölffach gestreckt (Holzbretter-Optik). Jetzt gibt es richtungsloses Putz-Rauschen in zwei Größen und nur vereinzelte, schwache Läufer.

**Farbstimmung (`look.ts`, `sky.ts`).** Der Dunst ist warm-grau-beige statt altrosa (0,60/0,52/0,46 statt 0,66/0,44/0,42), mit etwas weniger Dichte. Die Wolken sind beige statt rosa, oben grau statt violett, das Himmelsband zwischen Horizont und Zenit weniger rosa. Die Schatten-Tönung im Grade kippt nicht mehr ins Magenta. Der Asphalt wird dadurch neutraler.

**Laden und Ausfall (`textures.ts`, `texturePlaceholders.ts`, `ui/assetGate.ts`, `CarModel.ts`).**

- Jede Welttextur ist sofort ein neutraler 1×1-Platzhalter ihrer Art: mittlere Albedo, flache Normale, rau und nicht metallisch, Laub transparent. Schlägt das Laden fehl, bleibt der Platzhalter. Die Welt ist dann schlicht schattiert statt schwarz. Ein E2E-Test bricht alle KTX2-Anfragen ab und prüft die mittlere Bildfarbe.
- Der Start-Button wartet auf Welttexturen und Automodelle (geladen und kompiliert), zeigt den Fortschritt („LOADING 63 %“) und startet nach 20 s trotzdem.
- Ein Auto wechselt erst nach dem Shader-Warm-up auf das GLB, damit kein Frame mitten in der Fahrt kompiliert.

**Auslieferung (`src/server/staticAssets.ts`).** Modelle und Texturen mit `?v=<hash>` werden ein Jahr lang `immutable` gecacht. Die Manifeste werden immer neu validiert. Die HDRIs gehen Brotli- bzw. gzip-komprimiert raus (1,06 → 0,54 MB, 1,68 → 1,33 MB), mit Inhalts-ETag statt mtime. Ein Deploy ohne Asset-Änderung lädt also nichts neu. Nicht mehr ausgeliefert werden die nie geladenen Texturen Straßenschilder, Diner-Innenraum und `asphalt_clean` (rund 0,57 MB). `tests/client/worldTextures.test.ts` hält Manifest und Client-Code deckungsgleich.

**Handy-Budget mit Mitspielern.** Siehe [`docs/cars.md`](cars.md): Fremde Autos kosten auf Tier low 3–4 statt rund 14 Draw Calls. Gemessen im Hochformat: 88 Calls allein, 105 mit sieben Autos (vorher rund 190).

**HUD (`style.css`).** Auf Handys ist das Boost-Label fett, voll deckend und hat einen dunklen Halo. Im Hochformat ab 375 px steht die Münz-/Lebens-Pille in der oberen Reihe zwischen Minimap und Rang, der Boost-Balken darunter. Die Straße vor dem Auto bleibt frei.

**Verworfen bzw. offen:**

- Die doppelten Atlas-Texturen in LOD0 und LOD1 sind nur teilweise gelöst: `ModelCache` teilt gleiche Texturen im GPU-Speicher. Der doppelte Download (rund 200 KB) bleibt, bis `tools/models/pack.mjs` die Atlanten auslagert.
- Die Rohbilder der KI-Texturen liegen in einem Archiv außerhalb von git, mit Hash-Liste im Repo (`tools/textures/README.md`). Eine dauerhafte Ablage außerhalb dieses Rechners (Release-Asset) ist noch zu erledigen.

## Dateien

- `src/client/render/look.ts`: Look-Parameter, Tonemapping-Grade, Höhennebel
- `src/client/render/sky.ts`: Himmel und Environment-Map
- `src/client/render/lighting.ts`: Sonne, Schatten, Tiers, Kontaktschatten
- `src/client/render/frameStats.ts`: Draw Calls einschließlich Schatten-Pass
- `src/client/world/textures.ts`, `texturePlaceholders.ts`: KTX2-Welttexturen und ihre neutralen Platzhalter
- `src/client/ui/assetGate.ts`: Start wartet auf Texturen und Modelle
- `src/server/staticAssets.ts`: Cache-Header, komprimierte HDRIs
- `src/client/world/materials.ts`: Materialien und Shader-Blöcke
- `src/client/world/batch.ts`: Geometrie pro Material zusammenführen
- `src/client/world/vegetation.ts`: Baum- und Buschkarten
- `src/client/world/palms.ts`: Palmen, Wind, Impostors
- `src/client/world/furniture.ts`, `streetFurniture.ts`: Oberflächen der Requisiten, Modelle der Straßenmöbel (Plätze: `src/shared/map/furniture.ts`)
- `src/client/world/fountain.ts`: Plaza-Brunnen
- `src/client/world/mapScene.ts`, `mapWorld.ts`: die Welt der Karte (seit Phase 3 M4)
- `src/client/world/terrain.ts`, `terrainGrid.ts`, `terrainSplat.ts`: Gelände
- `src/client/world/roads.ts`, `roadGeometry.ts`: Straßen, Gehwege, Markierungen
- `src/client/world/sea.ts`: Meer
- `src/client/world/kit.ts`, `kitCells.ts`: Gebäude-Kit
- `src/client/world/chunkedInstances.ts`, `scatter.ts`, `railings.ts`, `viewpoint.ts`: Instanzen je Chunk, Streuung, Geländer, Fernrohre
- `src/client/world/worldQuality.ts`: Detailstufen
