# Betrieb

**Stand:** 2026-09-24 · Bezug: [`phase-1b-design.md`](phase-1b-design.md), Abschnitt 11 (Robustheit und Betrieb) und 20.4 (Umsetzung)

Der Spielserver läuft rund um die Uhr (live: https://bulli.logge.top, Dokploy deployt `main` automatisch). Dieses Dokument beschreibt, was der Server für den Betrieb mitbringt und was im Hosting eingestellt sein muss.

## Umgebungsvariablen

| Variable | Standard | Wirkung |
|---|---|---|
| `PORT` | `8000` | HTTP- und WebSocket-Port |
| `SESSION_SECRET` | – (Zufall pro Prozess) | Schlüssel für die Resume-Tickets (HMAC-SHA256). **In Dokploy als Secret setzen**, mindestens 16 Zeichen. Ohne ihn verlieren Spieler bei jedem Deploy ihren Party-Score; der Server warnt beim Start. |
| `NODE_ENV` | im Docker-Image `production` | In Produktion ist die Dev-Netsim gesperrt, Express liefert knappe Fehler. |
| `MAX_PLAYERS_PER_ROOM` | `32` | Spieler pro Room-Instanz |
| `MAX_CONNECTIONS` | `160` | offene Sockets des Prozesses; darüber Close 4002 („voll“), der Client versucht es mit Backoff weiter |
| `GRACE_MS` | `30000` | Wie lange die Sitzung eines getrennten Spielers wartet. Nur für Tests kürzer (Playwright: 3000). |
| `METRICS` | – | `1` schaltet `/metrics.json` frei (Rooms einzeln, Traffic-Summen) |
| `NETSIM` | – | Dev-Netsim für jede Verbindung, z. B. `rtt=150,jitter=30,loss=3,mode=tcp`. Wirkt nur außerhalb von `NODE_ENV=production` oder mit `NETSIM_ALLOW=1`. |
| `E2E` | – | `1` nur für die Playwright-Server: nimmt `debugPlace` an |

## Health-Check

`GET /healthz` (immer `Cache-Control: no-store`):

```json
{"ok":true,"uptimeS":8123,"build":"4f1155c40a45dae6","rooms":2,"players":17,"sessions":18,
 "graceSessions":1,"connections":17,"lastTickAgeMs":4,"tickMeanMs":0.21,"tickP95Ms":0.48,
 "tickP99Ms":0.9,"overruns":0,"bytesInPerSec":31000,"bytesOutPerSec":410000,"kicks":0,"shuttingDown":false,
 "heapUsedMb":21.4,"rssMb":107.1}
```

- **200** solange der Tick-Scheduler in der letzten Sekunde gelaufen ist, sonst **503**. Während des Herunterfahrens ebenfalls 503.
- Hängt die Event-Loop, antwortet der Endpunkt gar nicht; der Docker-Health-Check zählt den Timeout (3 s) als Fehlschlag.
- `tickP95Ms`/`tickP99Ms` beziehen sich auf die letzten 1024 Scheduler-Ticks (≈ 17 s) über alle Rooms. Budget: p99 < 2 ms bei einem vollen Room (Abschnitt 5.7).
- Das Overlay `?debug=perf` bzw. `?debug=net` fragt `/healthz` alle 2 s ab und zeigt die Tick-Zeiten des Servers.
- `heapUsedMb`/`rssMb`: Speicher des Prozesses, für Soak-Läufe. Der Heap schwankt mit der Garbage Collection; ein Leck zeigt sich am steigenden Minimum.

## Lasttest mit Bots

`npm run bots -- --url wss://<host>/ws --count 32 --mix drive:24,ram:6,reconnect:1,hop:1 --duration 120` fährt headless Bot-Clients gegen einen laufenden Server und gibt Snapshot-Rate, Downlink pro Client, Korrekturen, Kontakte und die Tick-Zeiten aus `/healthz` aus (`--netsim 150,30,3` für ein schlechtes Netz, `--json` für den ganzen Bericht). Gegen den Live-Server nur mit Bedacht: Die Bots sind echte Spieler im Room und belegen Plätze. Messwerte: [`baseline.md`](baseline.md), Abschnitt Phase 1b.

Das Docker-Image enthält:

```
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8000}/healthz" > /dev/null || exit 1
```

Nach drei Fehlschlägen in Folge (≈ 30 s) ist der Container `unhealthy`.

## Neustart-Verhalten

- **Dokploy** betreibt Anwendungen als Docker-Swarm-Service. Swarm ersetzt einen Task, der `unhealthy` wird, und startet nach einem Exit neu. Ein hängender Tick führt damit ohne weiteres Zutun zum Neustart.
- **Docker Compose / `docker run`:** `restart: unless-stopped` (bzw. `--restart unless-stopped`) startet nach einem Exit neu. **Achtung:** Ohne Swarm startet Docker einen Container, der nur `unhealthy` ist, *nicht* neu; dafür bräuchte es einen Watchdog (z. B. `willfarrell/autoheal`) oder eben Swarm.
- `uncaughtException` und `unhandledRejection` beenden den Prozess mit Exit-Code 1 (nach dem Log), statt in einem unbekannten Zustand weiterzulaufen.

## Deploy und Graceful Shutdown

Bei `SIGTERM` (Deploy, `docker stop`) oder `SIGINT`:

1. keine neuen Verbindungen mehr, `/healthz` meldet 503,
2. der Tick stoppt,
3. jeder verbundene Client bekommt `shutdown {reconnectInMs: 1500, resume}` mit einem signierten Resume-Ticket (Name, Farbe, Karosse, Profil, Room-Art, Party-Score; 120 s gültig, einmal einlösbar),
4. nach 300 ms werden alle Sockets mit Close 1012 geschlossen,
5. Exit 0, spätestens nach 5 s. Docker wartet standardmäßig 10 s, bevor es `SIGKILL` schickt.

Die Clients zeigen nach einer Sekunde „Reconnecting…“, versuchen es nach 1,5 s und dann mit Backoff (1 s, 2 s, 4 s, dann alle 8 s, je ±20 %) und kommen mit dem Ticket zurück: gleiche Farbe, im Party-Room gleicher Score, das Auto spawnt neu. Hat der Deploy einen neuen Client-Build, lädt die Seite nach dem Wiederverbinden einmal neu (Build-Abgleich); das Sitzungs-Token überlebt den Reload, der Score bleibt erhalten, der Spieler landet wieder auf dem Startbildschirm.

Die CI prüft im Docker-Job, dass der Container `healthy` wird und `docker stop` ihn in unter 6 s mit Exit-Code 0 beendet.

## Verbindungsabbrüche

- Eine Sitzung, deren Socket wegfällt, bleibt 30 s bestehen. Ihr Auto steht so lange als Idle-Ghost (grau, ohne Kontakt) im Room.
- Kommt dieselbe Seite innerhalb der Frist wieder (Token in `sessionStorage`), übernimmt sie Spieler, Slot, Auto und Party-Zustand. Lädt der Spieler die Seite neu, bleibt er derselbe Spieler mit seinem Score, startet aber wieder beim Startbildschirm.
- Ein duplizierter Tab (kopiertes `sessionStorage`, alte Seite noch verbunden) wird ein eigener Spieler.
- Kicks (Close 4003 Flut/ungültig, 4004 nach 10 min Idle) beenden die Sitzung sofort, ohne Frist.

## Dev-Netsim

- Client: `?netsim=RTT,JITTER,LOSS[,MODE]`, z. B. `?netsim=150,30,3`. Wirkt nur auf den eigenen Tab und ist deshalb auch live erlaubt. `MODE` ist `tcp` (Standard: verlorene Nachrichten kommen 200 ms + RTT später und halten alles dahinter auf) oder `drop` (verlorene Binärrahmen fallen weg, JSON nie).
- Server: `NETSIM="rtt=150,jitter=30,loss=3,mode=tcp"` für jede Verbindung, nur in Entwicklung (siehe oben).
- Beide addieren sich. `?debug=net` zeigt die aktive Netsim, RTT, Lead, Snapshots pro Sekunde, Korrekturen und die Verbindung.
