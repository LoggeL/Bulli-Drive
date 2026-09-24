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
