# Bulli Drive — Arbeitsregeln

## Tests: Testpyramide einhalten

- **Viele Unit-Tests** (Vitest, `tests/shared`, `tests/server`): reine Logik wie Sim, Kontakt, Protokoll/valibot, Welt-Generierung, Reconciliation, Room-Regeln. Schnell, deterministisch, ohne Netzwerk und ohne Browser.
- **Weniger Integrationstests** (Server-Prozess + echte WebSockets, `tools/bots`): Zusammenspiel von Server-Tick, Protokoll und mehreren Clients.
- **Wenige E2E-Tests** (Playwright, `tests/e2e`): nur kritische Nutzerwege (laden und beitreten, fahren, zwei Spieler sehen/rammen sich, Touch auf dem Handy, Reload nach Deploy). Alles, was ein Unit- oder Integrationstest abdecken kann, gehört nicht in E2E. Die E2E-Suite soll in CI unter ~5 Minuten bleiben.
- Neue Funktionalität bekommt ihren Test auf der **niedrigsten Ebene**, auf der das Verhalten prüfbar ist.

## Keine tautologischen Tests

Ein Test muss scheitern können, wenn das Verhalten kaputtgeht.

- Erwartete Werte **nicht** mit demselben Code (oder einer Kopie davon) berechnen, der getestet wird. Quellen für Erwartungswerte: Handrechnung, physikalische Überlegung, unabhängige Referenz, vorheriger Stand (dann als Regressions-Lock kennzeichnen).
- Nicht auf Mocks/Stubs prüfen, die der Test selbst so konfiguriert hat, und nicht nur prüfen, dass eine Funktion aufgerufen wurde, wenn das Ergebnis prüfbar ist.
- Goldens nicht blind neu erzeugen (`UPDATE_GOLDEN=1` nur mit Begründung im Commit, was sich warum geändert hat).
- **Mutationsprobe:** Für jeden neuen Test einmal die getestete Logik absichtlich brechen (z.B. Vorzeichen, Grenzwert, Zeile auskommentieren) und bestätigen, dass der Test rot wird; danach zurücksetzen. Im Commit bzw. PR kurz nennen.
- Verhalten über die öffentliche Schnittstelle testen, nicht Implementierungsdetails.
- Flaky ist ein Bug: kein festes `sleep`/Warten auf Uhrzeit, sondern auf Bedingungen bzw. Sim-Ticks warten; feste Seeds; Float-Vergleiche plattformübergreifend mit begründeter Toleranz (CI läuft auf Linux x64, lokal macOS arm64).

## Laufzeitziele je Ebene

Gemessen wird die Wanduhr des jeweiligen Befehls bzw. CI-Jobs. Wird ein Ziel überschritten, gehört das untersucht (langsamer Test, falsche Ebene), nicht das Ziel angehoben.

| Ebene | Befehl | Ziel lokal | Ziel CI |
| --- | --- | --- | --- |
| Unit (Vitest) | `npm test` | < 15 s (heute ~8 s) | < 1 min im Job „Typecheck and unit tests“ |
| Integration (Bots, echter Server-Prozess) | `npm run test:bots` | < 3 min | < 5 min |
| E2E (Playwright, Desktop + Mobile) | `npm run test:e2e` | < 5 min inkl. Build | < 5 min, ein Job ohne Shards |
| Render-Messungen (Playwright) | `npm run test:e2e:render` | < 3 min | < 5 min |
| Mutationstests (Stryker) | `npm run test:mutation` | Minuten je Datei (inkrementell) | wöchentlich, nie blockierend |

- Wanduhr-Schranken (Millisekunden, fps) gehören nicht in die Unit-Tests: Sie laufen parallel auf geteilten Runnern. Solche Messungen laufen als eigene Skripte, die nur loggen oder warnen: `npm run perf:sim` (Sim-Kosten, Ziel < 2 ms pro Tick bei 32 Autos), `npm run perf:baseline` (Browser).
- Im Unit-Lauf keine Tests über ~1 s ohne Grund; lange Sweeps bekommen ein explizites Timeout und stehen in `tests/mutation/strykerSetup.ts`, wenn Stryker sie überspringen soll.

## Mutationstests (Stryker)

Stryker prüft, ob die Unit-Tests rot werden, wenn die Logik kaputtgeht. Konfiguration: `stryker.config.mjs` (mutiert `src/shared/**` und `src/server/rooms/**`), Vitest-Konfiguration dafür: `vitest.stryker.config.ts` mit `tests/mutation/strykerSetup.ts`.

- **Gezielt, nach einer Änderung (der Normalfall):** `npm run test:mutation -- --mutate "src/shared/net/prediction.ts"` (mehrere Dateien mit Komma). Inkrementell über `reports/stryker-incremental.json`: Nur Mutanten, deren Code oder abdeckende Tests sich geändert haben, laufen erneut; das dauert Sekunden bis wenige Minuten. Die übrigen Dateien behalten ihr Ergebnis im Bericht.
- **Eine Gruppe:** `MUTATION_GROUP=sim|contact|net|world|rooms|race npm run test:mutation` (eigene inkrementelle Datei und eigener Bericht je Gruppe, so läuft auch der Workflow `.github/workflows/mutation.yml`).
- **Alles:** `npm run test:mutation` ohne Argumente. Der erste Lauf ohne inkrementelle Datei dauert Stunden (die Golden-Läufe decken fast jeden Sim-Mutanten ab); danach inkrementell.
- **Auswerten:** `npx tsx scripts/mutation-summary.ts` (Score je Datei), `--survivors` listet jeden überlebenden und nicht abgedeckten Mutanten mit Zeile und Ersetzung. HTML-Bericht: `reports/mutation/index.html`.
- **Umgang mit Überlebenden:** Jeder Überlebende ist entweder eine Testlücke (Test auf der niedrigsten Ebene ergänzen, Erwartung unabhängig begründen) oder äquivalent (z. B. `<` gegen `<=` auf kontinuierlichen Floats, Initialwerte, die vor der ersten Nutzung überschrieben werden, reine Log- und Fehlertexte). Äquivalente im Commit bzw. PR kurz nennen, nicht mit Tests „wegtesten“.
- Stryker ist ein Bericht, kein Gate (`thresholds.break: null`). Der Score soll nicht sinken; eine Datei mit neuem Verhalten bekommt ihren Lauf, bevor sie gemergt wird.
- Tests, die von `Math.random` abhängen, machen Stryker-Ergebnisse instabil (Mutanten kippen zwischen den Läufen). Zufall injizierbar machen (`RandomSource`, siehe `src/server/rooms/spawn.ts`) und im Test skripten.
