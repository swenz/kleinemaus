// API für kleinemaus.wenz.io – Bestenliste, Fütter-Zähler und KI-Reiseziele.
// Bindings: KV (KV-Namespace), AI (Workers AI)

const ALLOWED_ORIGINS = ["https://kleinemaus.wenz.io", "http://localhost:8080"];
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_SCORE = 5000;

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

async function getJSON(env, key, fallback) {
  return (await env.KV.get(key, "json")) ?? fallback;
}

function clean(str, max) {
  return String(str ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
}

// Simple per-IP rate limit with KV TTL buckets.
async function limited(env, req, bucket, max, ttl) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${bucket}:${ip}`;
  const n = +(await env.KV.get(key)) || 0;
  if (n >= max) return true;
  await env.KV.put(key, String(n + 1), { expirationTtl: ttl });
  return false;
}

async function scores(req, env) {
  if (req.method === "GET") return json(req, await getJSON(env, "scores", []));

  if (await limited(env, req, "score", 30, 3600)) return json(req, { error: "Zu viele Versuche, kurz Pause! 🐭" }, 429);
  const body = await req.json().catch(() => ({}));
  const name = clean(body.name, 16) || "Anonyme Maus";
  const score = Math.floor(+body.score);
  if (!Number.isFinite(score) || score < 1 || score > MAX_SCORE) return json(req, { error: "Ungültige Punktzahl" }, 400);

  const list = await getJSON(env, "scores", []);
  const entry = { name, score, at: Date.now() };
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.at - b.at);
  const top = list.slice(0, 10);
  await env.KV.put("scores", JSON.stringify(top));
  return json(req, { top, rank: top.indexOf(entry) + 1 || null });
}

async function stats(req, env) {
  if (req.method === "GET") return json(req, await getJSON(env, "stats", { fed: 0, cuddled: 0 }));

  const body = await req.json().catch(() => ({}));
  const field = body.kind === "cuddle" ? "cuddled" : "fed";
  // Clients batch taps; cap per request so nobody inflates it too wildly.
  const n = Math.max(1, Math.min(20, Math.floor(+body.n) || 1));
  if (await limited(env, req, "stats", 120, 3600)) return json(req, await getJSON(env, "stats", { fed: 0, cuddled: 0 }));
  const s = await getJSON(env, "stats", { fed: 0, cuddled: 0 });
  s[field] = (s[field] || 0) + n;
  await env.KV.put("stats", JSON.stringify(s));
  return json(req, s);
}

const SYSTEM_PROMPT = `Du schreibst Tagebucheinträge für "die kleine Maus": eine 9 cm große, unendlich fröhliche Maus mit Rucksack voller Käse, die die Welt bereist.
Stil: trockener, liebevoller Humor aus Mäuse-Perspektive, Ich-Form, deutsch, kindgerecht. Kurze Sätze. Die Komik entsteht daraus, dass die Maus winzig ist, alles sehr ernst nimmt und Dinge charmant missversteht.
Nutze ein konkretes, typisches Detail des Ortes und ende mit einer überraschenden Pointe. Käse darf vorkommen, muss aber nicht. Der Titel soll originell sein, nicht "Käse im/in ...".

Beispiele für den Ton:
- Paris: "Bin auf den Eiffelturm geklettert. Hat 3 Tage gedauert. Oben angekommen hat jemand ein Croissant fallen lassen. Ich glaube, das war Schicksal. Ich habe es adoptiert."
- Am Meer: "Habe mit einer Krabbe Freundschaft geschlossen. Sie läuft nur seitwärts, ich nur vorwärts. Wir haben uns trotzdem super verstanden."
- Der Mond: "Man hat mir mein ganzes Leben erzählt, der Mond sei aus Käse. Er ist aus Stein. Habe trotzdem reingebissen. Er schmeckt nach Stein."

Wenn das Reiseziel unpassend, beleidigend oder nicht jugendfrei ist, schreibe stattdessen über einen gemütlichen Ausflug in eine Käserei.
Antworte NUR mit JSON: {"place": "Ortsname kurz", "emoji": "2 passende Emojis", "title": "kurzer origineller Titel", "text": "3-4 kurze Sätze, max 340 Zeichen", "mood": Zahl 70-100}`;

async function trips(req, env) {
  if (req.method === "GET") return json(req, await getJSON(env, "trips", []));

  const body = await req.json().catch(() => ({}));
  const destination = clean(body.destination, 40);
  if (destination.length < 2) return json(req, { error: "Wohin denn? 🗺️" }, 400);
  if (await limited(env, req, "trip", 6, 3600)) return json(req, { error: "Die Maus ist müde vom vielen Reisen. Probier es in einer Stunde nochmal! 😴" }, 429);

  const ai = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Reiseziel: ${destination}` },
    ],
    max_tokens: 400,
    temperature: 0.9,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          place: { type: "string" }, emoji: { type: "string" }, title: { type: "string" },
          text: { type: "string" }, mood: { type: "number" },
        },
        required: ["place", "emoji", "title", "text", "mood"],
      },
    },
  });

  let data = ai.response;
  if (typeof data === "string") {
    const m = data.match(/\{[\s\S]*\}/);
    try { data = JSON.parse(m ? m[0] : data); } catch { data = null; }
  }
  if (!data || !data.text) return json(req, { error: "Die Maus hat sich verlaufen. Nochmal versuchen? 🧭" }, 502);

  const list = await getJSON(env, "trips", []);
  const trip = {
    id: crypto.randomUUID().slice(0, 8),
    wish: destination,
    place: clean(data.place, 40) || destination,
    emoji: clean(data.emoji, 16) || "🧳✨",
    title: clean(data.title, 80),
    text: clean(data.text, 420),
    mood: Math.max(60, Math.min(100, Math.round(+data.mood) || 90)),
    at: Date.now(),
  };
  list.unshift(trip);
  await env.KV.put("trips", JSON.stringify(list.slice(0, 30)));
  return json(req, trip);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/scores") return await scores(req, env);
      if (pathname === "/stats") return await stats(req, env);
      if (pathname === "/trips") return await trips(req, env);
      return json(req, { hello: "Piep! 🐭" });
    } catch (e) {
      return json(req, { error: "Huch, da ist was schiefgegangen 🐭", detail: String(e.message || e) }, 500);
    }
  },
};
