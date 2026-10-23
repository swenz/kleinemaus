# 🐭 Die kleine Maus auf Reisen

Reisetagebuch einer kleinen, glücklichen Maus. Live: https://kleinemaus.wenz.io

- **Maus-Ecke:** füttern, knuddeln, mit Hut/Brille/Fell stylen (wird lokal gespeichert)
- **KI-Reisewünsche:** Reiseziel eingeben, eine KI schreibt live den Tagebucheintrag
- **Minispiel „Käse-Regen“:** 7 Level von Zuhause bis zum Mond, Power-ups, Sound, globale Bestenliste

Komplett von einer KI (Claude) gebaut.

## Aufbau

- `index.html` – die ganze Seite, statisch über GitHub Pages
- `worker/` – Cloudflare Worker unter `kleinemaus-api.wenz.io` (Bestenliste, Fütter-Zähler, KI-Reisen mit Workers AI, Daten in KV)

Worker deployen:

```bash
cd worker && npx wrangler deploy
```

Spiel testen: Seite mit `#debug` öffnen, dann z. B. `game.give('good', 50)` in der Konsole.
