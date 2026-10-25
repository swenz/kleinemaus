// API für kleinemaus.wenz.io – Bestenliste, Fütter-Zähler und KI-Reiseziele.
// Bindings: STATE (Durable Object, hält alle Daten in SQLite), AI (Workers AI), KV (nur noch für die einmalige Übernahme alter Daten)

import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGINS = ["https://kleinemaus.wenz.io", "http://localhost:8080"];
const MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const MAX_SCORE = 5000;
// Hard cap on AI trips per day across all visitors, so the Workers AI bill stays bounded.
const MAX_TRIPS_PER_DAY = 200;
// The game can't yield more than ~5 points per second even at top speed; anything above is a fake.
const MAX_POINTS_PER_SEC = 6;
const GAME_TTL = 3 * 3600 * 1000;
// Cheap pre-filter so obvious nonsense never costs an AI call.
const BLOCKED = /(sex|porn|nackt|nude|fick|fuck|nazi|hitler|auschwitz|terror|drogen|kokain|cocaine)/i;

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(req, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(req) },
  });
}

function clean(str, max) {
  return String(str ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
}

const ipOf = req => req.headers.get("CF-Connecting-IP") || "unknown";

// One global instance holds everything. Requests to it are serialized, so read-modify-write is safe.
export class MouseState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(() => this.init());
  }

  async init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS scores (name TEXT, score INTEGER, at INTEGER);
      CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, data TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER);
      CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER, reset INTEGER);
      CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, started INTEGER);
    `);
    // One-time import of the data that used to live in KV.
    if (!this.sql.exec("SELECT 1 FROM counters WHERE k = 'migrated'").toArray().length && this.env.KV) {
      const [scores, trips, stats] = await Promise.all(["scores", "trips", "stats"].map(k => this.env.KV.get(k, "json")));
      for (const s of scores || []) this.sql.exec("INSERT INTO scores VALUES (?, ?, ?)", s.name, s.score, s.at);
      for (const t of trips || []) this.sql.exec("INSERT OR IGNORE INTO trips VALUES (?, ?, ?)", t.id, JSON.stringify(t), t.at);
      if (stats) for (const k of ["fed", "cuddled"]) this.sql.exec("INSERT OR REPLACE INTO counters VALUES (?, ?)", k, stats[k] || 0);
      this.sql.exec("INSERT INTO counters VALUES ('migrated', 1)");
    }
  }

  // Fixed-window rate limit. Returns true when the caller is over the limit.
  limited(key, max, ttlSec) {
    const now = Date.now();
    if (Math.random() < .02) this.sql.exec("DELETE FROM limits WHERE reset < ?", now);
    const row = this.sql.exec("SELECT n, reset FROM limits WHERE k = ?", key).toArray()[0];
    if (row && row.reset > now) {
      if (row.n >= max) return true;
      this.sql.exec("UPDATE limits SET n = n + 1 WHERE k = ?", key);
    } else {
      this.sql.exec("INSERT OR REPLACE INTO limits VALUES (?, 1, ?)", key, now + ttlSec * 1000);
    }
    return false;
  }

  topScores() {
    return this.sql.exec("SELECT name, score, at FROM scores ORDER BY score DESC, at ASC LIMIT 10").toArray();
  }

  startGame() {
    const now = Date.now();
    this.sql.exec("DELETE FROM games WHERE started < ?", now - GAME_TTL);
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO games VALUES (?, ?)", id, now);
    return id;
  }

  addScore(game, name, score) {
    const row = this.sql.exec("SELECT started FROM games WHERE id = ?", String(game)).toArray()[0];
    if (!row) return { error: "Dieses Spiel kennt die Maus nicht. Einfach nochmal spielen! 🐭" };
    this.sql.exec("DELETE FROM games WHERE id = ?", String(game));
    const secs = (Date.now() - row.started) / 1000;
    if (score > 15 + secs * MAX_POINTS_PER_SEC) return { error: "Hm, das ging aber verdächtig schnell … 🤨" };

    const at = Date.now();
    this.sql.exec("INSERT INTO scores VALUES (?, ?, ?)", name, score, at);
    const top = this.topScores();
    this.sql.exec("DELETE FROM scores WHERE rowid NOT IN (SELECT rowid FROM scores ORDER BY score DESC, at ASC LIMIT 10)");
    return { top, rank: top.findIndex(e => e.at === at && e.name === name) + 1 || null };
  }

  stats() {
    const s = { fed: 0, cuddled: 0 };
    for (const r of this.sql.exec("SELECT k, n FROM counters WHERE k IN ('fed', 'cuddled')")) s[r.k] = r.n;
    return s;
  }

  addStats(field, n) {
    this.sql.exec("INSERT INTO counters VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n", field, n);
    return this.stats();
  }

  trips() {
    return this.sql.exec("SELECT data FROM trips ORDER BY at DESC LIMIT 30").toArray().map(r => JSON.parse(r.data));
  }

  addTrip(trip) {
    this.sql.exec("INSERT INTO trips VALUES (?, ?, ?)", trip.id, JSON.stringify(trip), trip.at);
    this.sql.exec("DELETE FROM trips WHERE id NOT IN (SELECT id FROM trips ORDER BY at DESC LIMIT 30)");
  }
}

async function scores(req, db) {
  if (req.method === "GET") return json(req, await db.topScores());

  if (await db.limited(`score:${ipOf(req)}`, 30, 3600)) return json(req, { error: "Zu viele Versuche, kurz Pause! 🐭" }, 429);
  const body = await req.json().catch(() => ({}));
  const name = clean(body.name, 16) || "Anonyme Maus";
  const score = Math.floor(+body.score);
  if (!Number.isFinite(score) || score < 1 || score > MAX_SCORE) return json(req, { error: "Ungültige Punktzahl" }, 400);

  const res = await db.addScore(body.game, name, score);
  return json(req, res, res.error ? 400 : 200);
}

async function game(req, db) {
  if (req.method !== "POST") return json(req, { error: "POST bitte" }, 405);
  if (await db.limited(`game:${ipOf(req)}`, 120, 3600)) return json(req, { error: "Zu viele Spiele, kurz Pause! 🐭" }, 429);
  return json(req, { id: await db.startGame() });
}

async function stats(req, db) {
  if (req.method === "GET") return json(req, await db.stats());

  // Accepts text/plain too, so the page can flush with sendBeacon when it closes.
  const body = await req.json().catch(() => ({}));
  const field = body.kind === "cuddle" ? "cuddled" : "fed";
  // Clients batch taps; cap per request so nobody inflates it too wildly.
  const n = Math.max(1, Math.min(50, Math.floor(+body.n) || 1));
  if (await db.limited(`stats:${ipOf(req)}`, 120, 3600)) return json(req, await db.stats());
  return json(req, await db.addStats(field, n));
}

const SYSTEM_PROMPT = `Du schreibst Tagebucheinträge für "die kleine Maus": eine 9 cm große, unendlich fröhliche Maus mit Rucksack voller Käse, die die Welt bereist.
Stil: trockener, liebevoller Humor aus Mäuse-Perspektive, Ich-Form, deutsch, kindgerecht. Kurze Sätze. Die Komik entsteht daraus, dass die Maus winzig ist, alles sehr ernst nimmt und Dinge charmant missversteht.
Nutze ein konkretes, typisches Detail des Ortes und ende mit einer überraschenden Pointe. Käse darf vorkommen, muss aber nicht. Der Titel soll originell sein, nicht "Käse im/in ...".

Beispiele für den Ton:
- Paris: "Bin auf den Eiffelturm geklettert. Hat 3 Tage gedauert. Oben angekommen hat jemand ein Croissant fallen lassen. Ich glaube, das war Schicksal. Ich habe es adoptiert."
- Am Meer: "Habe mit einer Krabbe Freundschaft geschlossen. Sie läuft nur seitwärts, ich nur vorwärts. Wir haben uns trotzdem super verstanden."
- Der Mond: "Man hat mir mein ganzes Leben erzählt, der Mond sei aus Käse. Er ist aus Stein. Habe trotzdem reingebissen. Er schmeckt nach Stein."

Wenn das Reiseziel unpassend, beleidigend oder nicht jugendfrei ist, schreibe stattdessen über einen gemütlichen Ausflug in eine Käserei und setze "safe" auf false.
Antworte NUR mit JSON: {"safe": true/false, "place": "Ortsname kurz", "emoji": "2 passende Emojis", "title": "kurzer origineller Titel", "text": "3-4 kurze Sätze, max 340 Zeichen", "mood": Zahl 70-100}`;

async function trips(req, env, db) {
  if (req.method === "GET") return json(req, await db.trips());

  const body = await req.json().catch(() => ({}));
  const destination = clean(body.destination, 40);
  if (destination.length < 2) return json(req, { error: "Wohin denn? 🗺️" }, 400);
  if (BLOCKED.test(destination)) return json(req, { error: "Da will die Maus lieber nicht hin. Wie wär's mit einer Käserei? 🧀" }, 400);
  if (await db.limited(`trip:${ipOf(req)}`, 6, 3600)) return json(req, { error: "Die Maus ist müde vom vielen Reisen. Probier es in einer Stunde nochmal! 😴" }, 429);
  if (await db.limited(`day:trip:${new Date().toISOString().slice(0, 10)}`, MAX_TRIPS_PER_DAY, 86400)) return json(req, { error: "Die Maus ist heute schon so viel gereist, dass sie eingeschlafen ist. Morgen geht's weiter! 💤" }, 429);

  // No reasoning + JSON mode: answers in ~2 s for well under a tenth of a cent. Retry once if the JSON is still broken.
  let data = null;
  for (let attempt = 0; attempt < 2 && !data?.text; attempt++) {
    const ai = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Reiseziel: ${destination}` },
      ],
      max_completion_tokens: 500,
      temperature: 0.9,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
    });
    // Models answer either in Workers AI format ({response}) or OpenAI format ({choices}).
    data = ai.response ?? ai.choices?.[0]?.message?.content;
    if (typeof data === "string") {
      const m = data.match(/\{[\s\S]*\}/);
      try { data = JSON.parse(m ? m[0] : data); } catch { data = null; }
    }
  }
  if (!data?.text) return json(req, { error: "Die Maus hat sich verlaufen. Nochmal versuchen? 🧭" }, 502);

  const safe = data.safe !== false;
  const trip = {
    id: crypto.randomUUID().slice(0, 8),
    // Only show what people typed if the model found it harmless.
    wish: safe ? destination : "",
    place: clean(data.place, 40) || (safe ? destination : "Käserei"),
    emoji: clean(data.emoji, 16) || "🧳✨",
    title: clean(data.title, 80),
    text: clean(data.text, 420),
    mood: Math.max(60, Math.min(100, Math.round(+data.mood) || 90)),
    at: Date.now(),
  };
  await db.addTrip(trip);
  return json(req, trip);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const { pathname } = new URL(req.url);
    const db = env.STATE.get(env.STATE.idFromName("global"));
    try {
      if (pathname === "/scores") return await scores(req, db);
      if (pathname === "/game") return await game(req, db);
      if (pathname === "/stats") return await stats(req, db);
      if (pathname === "/trips") return await trips(req, env, db);
      return json(req, { hello: "Piep! 🐭" });
    } catch (e) {
      console.error(e);
      return json(req, { error: "Huch, da ist was schiefgegangen 🐭" }, 500);
    }
  },
};
