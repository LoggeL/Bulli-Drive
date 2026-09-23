# Welt-Look: realistisch, ruhig-naturgetreu (Grafik-Schritt G1)

**Stand:** 2026-09-23 · Branch `gfx/g1-realistic`

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
| Plaza, Park | Einzel-Meshes | Terrakotta-Creme-Pflaster, Steinbrunnen mit Wasser-Shader, Pflanzkübel, Sonnenschirme. Rasen (PBR), Sandwege, Teich, Eichen, Bougainvillea-Beete |
| Straßenmöbel | Kugel-Laternen | Schwanenhals-Laternen der Probe, Fächerpalmen (Washingtonia) und Dattelpalmen aus der Probe |
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

## Qualitäts-Tiers

`src/client/effects/renderQuality.ts` bestimmt den Tier. Mit `?tier=high|low|software` lässt er sich erzwingen.

| | high (`desktop`) | low (`mobile`, Handys) | software (SwiftShader, E2E) |
|---|---|---|---|
| Materialien | PBR: Albedo, Normal, ARM | PBR ohne Normal-Maps | Lambert, große Flächen ohne Textur (mittlere Albedo), nur Atlas- und Laubtexturen |
| Himmel | HDRIs (2,7 MB) | prozedurale Wolken, keine HDRIs | Verlauf und Sonne ohne Wolken |
| Environment-Map | PMREM | PMREM | keine (Hemisphere-Licht) |
| Schatten | 2048, PCF soft, ±60 m | 1024, PCF soft, ±45 m | 1024, PCF |
| Pixel-Ratio | ≤ 2 | ≤ 1,5 | ≤ 2 (adaptiv) |
| Post-Processing | keins | keins | keins |
| Gelände-Raster | 8 m | 10 m | 16 m |

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
- **Ferne Laubkarten:** Auf den kleinsten Mip-Stufen würde das gemittelte Alpha das ganze Karten-Rechteck durchlassen. Dort wird der Ausschnitt deshalb zu einer Silhouette aus Krone und Stamm (`cardMask`). Aus großer Höhe (Überblick) wirken ferne Bäume dadurch etwas vereinfacht. Echte Impostors wären ein späterer Schritt.
- **Kollisionen:** Ein E2E-Test pinnt den SHA-1 der 241 Hindernisse des Clients auf den Stand vor diesem Schritt.

## Dateien

- `src/client/render/look.ts`: Look-Parameter, Tonemapping-Grade, Höhennebel
- `src/client/render/sky.ts`: Himmel und Environment-Map
- `src/client/render/lighting.ts`: Sonne, Schatten, Tiers, Kontaktschatten
- `src/client/render/frameStats.ts`: Draw Calls einschließlich Schatten-Pass
- `src/client/world/textures.ts`: KTX2-Welttexturen
- `src/client/world/materials.ts`: Materialien und Shader-Blöcke
- `src/client/world/batch.ts`: Geometrie pro Material zusammenführen
- `src/client/world/vegetation.ts`: Palmen, Baum- und Buschkarten
- `src/client/world/city.ts`, `environment.ts`: Stadt und Gelände
