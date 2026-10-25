# 🐭 Die kleine Maus auf Reisen

Reisetagebuch einer kleinen, glücklichen Maus. Live: https://kleinemaus.wenz.io

- **Maus-Ecke:** füttern, knuddeln, mit Hut/Brille/Fell stylen (wird lokal gespeichert)
- **KI-Reisewünsche:** Reiseziel eingeben, eine KI schreibt live den Tagebucheintrag
- **Minispiel „Käse-Regen“:** 7 Level von Zuhause bis zum Mond, Power-ups, Sound, globale Bestenliste

Komplett von einer KI (Claude) gebaut.

## Aufbau

- `index.html` – die ganze Seite, statisch über GitHub Pages
- `worker/` – Cloudflare Worker unter `kleinemaus-api.wenz.io` (Bestenliste, Fütter-Zähler, KI-Reisen mit Workers AI). Alle Daten liegen in einem Durable Object mit SQLite; KV wird nur noch einmalig beim ersten Start ausgelesen, um alte Daten zu übernehmen.

Kosten bleiben im Inklusivvolumen von Workers Paid: höchstens 200 KI-Reisen pro Tag (`MAX_TRIPS_PER_DAY`), ohne Reasoning und mit JSON-Modus, also weit unter einem Zehntelcent pro Reise.

Worker deployen:

```bash
cd worker && npx wrangler deploy
```

Spiel testen: Seite mit `#debug` öffnen, dann z. B. `game.give('good', 50)` in der Konsole.
