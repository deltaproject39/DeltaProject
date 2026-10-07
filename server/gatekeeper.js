// Gatekeeper: the only thing exposed to the internet through Cloudflare Tunnel.
// It forwards chat requests to the local Ollama, but only for the Delta model,
// speech/emotion requests (text only) to Delta's voice server, and memory requests to
// memory.js, with size limits and per-visitor rate limits. Everything else is refused.
// Run: node server/gatekeeper.js
// Closing it (Ctrl+C, closing the window, or start-delta.ps1 taking her offline) puts Delta to
// sleep gracefully: she finishes any note she's writing and everything is saved first.

const http = require("http");
const fs = require("fs");
const path = require("path");
const memory = require("./memory");

const PORT = 8787;
const OLLAMA = "http://127.0.0.1:11434";
const MODEL = "Delta";
const ALLOWED_ORIGINS = [
  "https://deltaproject39.github.io",
  "http://localhost:8000", // for testing the page locally
];
const MAX_BODY_BYTES = 64_000;      // whole request
const MAX_CHAT_BODY_BYTES = 240_000; // a chat message can carry a live mirror picture of her
const MAX_MIRROR_CHARS = 170_000;    // that picture (a small JPEG, base64)
const MAX_MESSAGES = 20;            // conversation history kept per request
const MAX_MESSAGE_CHARS = 2_000;    // per message
const MAX_REPLY_TOKENS = 512;
const RATE_LIMIT = 10;              // requests...
const RATE_WINDOW_MS = 60_000;      // ...per minute, per visitor
const MAX_CONCURRENT = 2;           // simultaneous generations on the GPU

const TTS = "http://127.0.0.1:8788";
const MAX_TTS_CHARS = 600;          // about a sentence or two per request
const TTS_RATE_LIMIT = 40;          // spoken chunks per minute, per visitor
const MAX_TTS_CONCURRENT = 2;
const EMOTION_RATE_LIMIT = 120;     // emotion reads per minute, per visitor (they're cheap)
const MEMORY_RATE_LIMIT = 60;       // memory panel actions per minute, per visitor
const CLAIM_RATE_LIMIT = 10;        // memory-code guesses per minute, per visitor

const hits = new Map();
const ttsHits = new Map();
const emotionHits = new Map();
const memoryHits = new Map();
const claimHits = new Map();
let active = 0;
let ttsActive = 0;

function visitorId(req) {
  return req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
}

// Requests from this PC itself. Anything through the tunnel carries Cloudflare's
// CF-Connecting-IP header, which outsiders can't remove.
function isFromThisPC(req) {
  return !req.headers["cf-connecting-ip"] && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

function rateLimited(map, id, limit) {
  const now = Date.now();
  const recent = (map.get(id) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  map.set(id, recent);
  return recent.length > limit;
}

// Collects a request body up to `limit` bytes. Anything bigger gets a clear 413 (with CORS
// headers so the page can show why) rather than a dropped connection, which the browser
// would only report as "Failed to fetch".
function readBody(req, res, cors, onDone, limit = MAX_BODY_BYTES) {
  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    if (tooBig) return;
    body += chunk;
    if (body.length > limit) {
      tooBig = true;
      body = "";
    }
  });
  req.on("end", () => {
    if (tooBig) return send(res, 413, { error: "That was too much to send at once. Try reloading the page." }, cors);
    onDone(body);
  });
}

function handleMemory(req, res, cors, body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return send(res, 400, { error: "Bad request" }, cors);
  }
  switch (msg.action) {
    case "hello": {
      const result = memory.hello(msg.visitor);
      return result ? send(res, 200, result, cors) : send(res, 400, { error: "Bad request" }, cors);
    }
    case "claim": {
      // Codes could only be found by guessing, so guesses are tightly limited.
      if (rateLimited(claimHits, visitorId(req), CLAIM_RATE_LIMIT)) {
        return send(res, 429, { error: "Too many tries. Wait a minute and try again." }, cors);
      }
      const result = memory.claim(msg.code, msg.pin, msg.visitor);
      switch (result.error) {
        case undefined: return send(res, 200, result, cors);
        case "notfound": return send(res, 404, { error: "No memories found for that code." }, cors);
        case "needpin": return send(res, 401, { error: "This ID is protected. Enter its PIN too.", needPin: true }, cors);
        case "badpin": return send(res, 401, { error: "Wrong PIN.", needPin: true }, cors);
        default: return send(res, 429, { error: `Too many wrong PINs. Try again in ${result.minutes} minutes.` }, cors);
      }
    }
    case "list":
      return send(res, 200, { memories: memory.list(msg.visitor) }, cors);
    case "history":
      return send(res, 200, { messages: memory.history(msg.visitor) }, cors);
    case "clearChat":
      memory.clearHistory(msg.visitor);
      return send(res, 200, { ok: true }, cors);
    case "forget":
      memory.forget(msg.visitor, msg.id);
      return send(res, 200, { ok: true }, cors);
    case "forgetEverything":
      memory.forgetEverything(msg.visitor);
      return send(res, 200, { ok: true }, cors);
    default:
      return send(res, 400, { error: "Bad request" }, cors);
  }
}

async function readEmotion(res, cors, body) {
  let text = "";
  try {
    text = String(JSON.parse(body).text || "").trim().slice(0, MAX_TTS_CHARS);
  } catch {}
  if (!text) return send(res, 400, { error: "Bad request" }, cors);
  try {
    const upstream = await fetch(`${TTS}/emotion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!upstream.ok) throw new Error(`Voice server returned ${upstream.status}`);
    send(res, 200, await upstream.json(), cors);
  } catch (err) {
    send(res, 502, { error: "Emotion reading is offline." }, cors);
  }
}

async function speak(res, cors, body) {
  let text = "";
  try {
    text = String(JSON.parse(body).text || "").trim().slice(0, MAX_TTS_CHARS);
  } catch {}
  if (!text) return send(res, 400, { error: "Bad request" }, cors);
  if (ttsActive >= MAX_TTS_CONCURRENT) {
    return send(res, 503, { error: "Delta's voice is busy right now." }, cors);
  }

  ttsActive++;
  try {
    // Only the text comes from visitors, so they can't change Delta's voice settings. Her pace
    // follows her energy: livelier Delta talks a little faster.
    const pace = 0.92 + 0.16 * memory.behavior().energy;
    const upstream = await fetch(`${TTS}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, pace }),
    });
    if (!upstream.ok) throw new Error(`Voice server returned ${upstream.status}`);
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      ...cors,
      "Content-Type": "audio/wav",
      "Content-Length": audio.length,
      // Which feeling this sentence was spoken with, so her face can match.
      "X-Emotion": upstream.headers.get("x-emotion") || "neutral:1:neutral",
      "X-Emotion-Groups": upstream.headers.get("x-emotion-groups") || "",
      "Access-Control-Expose-Headers": "X-Emotion, X-Emotion-Groups",
    });
    res.end(audio);
  } catch (err) {
    console.error(err.message);
    send(res, 502, { error: "Delta's voice is offline." }, cors);
  } finally {
    ttsActive--;
  }
}

// Your private page about her: http://localhost:8787/owner (only ever answered on this PC).
// Returns false for owner routes handled elsewhere (sleep-and-close, roam).
function handleOwner(req, res) {
  if (req.method === "GET" && (req.url === "/owner" || req.url === "/owner/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "owner.html")));
    return true;
  }
  if (req.method === "GET" && req.url === "/owner/api/delta") {
    send(res, 200, {
      ...memory.personalityReport(),
      selfNotes: memory.selfNotes(),
      journal: memory.journal(40),
      sketches: memory.sketches({ all: true }),
      appearance: memory.appearance(),
      sleep: memory.sleepState(),
      now: memory.explorations(1).now,
    });
    return true;
  }
  const drawing = req.method === "GET" && req.url.match(/^\/owner\/sketches\/(\d+)\.png$/);
  if (drawing) {
    sendSketch(res, memory.sketchFile(drawing[1], true), {});
    return true;
  }
  if (req.method !== "POST" || !req.url.startsWith("/owner/api/")) return false;
  readBody(req, res, {}, async (body) => {
    let msg = {};
    try { msg = JSON.parse(body || "{}"); } catch {}
    try {
      switch (req.url) {
        case "/owner/api/review": return send(res, 200, { review: await memory.reviewNow() });
        case "/owner/api/undo": return send(res, 200, { undone: memory.undoLastChange() });
        case "/owner/api/pin": memory.setPinned(msg.trait, Boolean(msg.pinned)); return send(res, 200, { ok: true });
        case "/owner/api/sleep": memory.fallAsleep("manual"); return send(res, 200, { ok: true });
        case "/owner/api/wake": memory.wakeUp(); return send(res, 200, { ok: true });
        case "/owner/api/sketch": return send(res, 200, { sketch: await memory.sketchNow(msg.idea) });
        case "/owner/api/mirror": return send(res, 200, await memory.mirrorNow());
        case "/owner/api/sketch-origin": memory.setSketchOrigin(msg.id, msg.origin); return send(res, 200, { ok: true });
        case "/owner/api/sketch-public": memory.setSketchPublic(msg.id, Boolean(msg.public)); return send(res, 200, { ok: true });
        default: return send(res, 404, { error: "Not found" });
      }
    } catch (err) {
      send(res, 500, { error: err.name === "AbortError" ? "Someone came to talk to her, so she set it aside. Try again later." : err.message });
    }
  });
  return true;
}

// "a few minutes" / "3 hours" / "2 days"
function ago(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 10) return "just a few minutes";
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

// A greeting in her own words when someone opens the chat: she knows whether they're new, how
// long it's been, what she remembers about them, and what she's been up to in her free time.
async function greet(res, cors, body) {
  let visitor = null;
  try {
    visitor = JSON.parse(body).visitor;
  } catch {}
  if (active >= MAX_CONCURRENT) return send(res, 503, { error: "Delta is busy right now." }, cors);

  active++;
  try {
    const persona = await memory.personaPrompt();
    const self = await memory.selfSection("").catch(() => "");
    const notes = await memory.recall(visitor, "who this person is").catch(() => []);
    const past = memory.history(visitor, 8)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
    const last = memory.lastTalk(visitor);
    const trip = memory.explorations(1).trips[0];
    const drew = memory.sketches({ limit: 1 })[0];

    const situation = last
      ? `This person just came back to the chat. You last talked ${ago(Date.now() - last)} ago.`
      : notes.length
        ? "This person is back. You remember them, though you haven't talked in this chat window before."
        : "Someone new just opened the chat for the first time. You don't know them yet.";
    const freeTime = trip && Date.now() - trip.created < 2 * 86400000 && Math.random() < 0.6
      ? ` If it feels natural, you could mention something from your own free time: you recently read about ${trip.path}.`
      : drew && Date.now() - drew.created < 2 * 86400000 && Math.random() < 0.5
        ? ` If it feels natural, you could mention that you recently drew something in your sketchbook: "${drew.title}".`
        : "";
    const system = [persona, self, notes.length ? memory.note(notes) : ""].filter(Boolean).join("\n\n");
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...past,
      {
        role: "user",
        content: `(Not something they said, just what's happening: ${situation}${freeTime} ` +
          "Greet them in one or two short sentences, in your own voice. Don't recap or list what you remember.)",
      },
    ];

    const upstream = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, stream: false, options: { num_predict: 80, temperature: 0.9 } }),
    });
    if (!upstream.ok) throw new Error(`Ollama returned ${upstream.status}`);
    const greeting = (await upstream.json()).message.content.trim()
      .split("\n").filter((line) => line.trim())[0]?.replace(/^["“]|["”]$/g, "").trim();
    if (!greeting) throw new Error("Empty greeting");
    send(res, 200, { greeting }, cors);
  } catch (err) {
    console.error("Greeting:", err.message);
    send(res, 502, { error: "Delta couldn't say hello just now." }, cors);
  } finally {
    active--;
  }
}

// The website's files for her desktop app: /app/ai.html, /app/VRM/Delta.vrm, ... Only the site
// itself (never the server folder), only a few file types.
const SITE = path.join(__dirname, "..");
const APP_TYPES = { ".html": "text/html; charset=utf-8", ".vrm": "model/gltf-binary", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
function serveApp(req, res) {
  if (req.url === "/app") { // so the page's relative links (VRM/Delta.vrm) resolve under /app/
    res.writeHead(302, { Location: "/app/" });
    return res.end();
  }
  const rel = decodeURIComponent(req.url.split("?")[0].replace(/^\/app\/?/, "")) || "ai.html";
  const file = path.resolve(SITE, rel);
  const type = APP_TYPES[path.extname(file).toLowerCase()];
  const inSite = file.startsWith(SITE + path.sep) && !file.startsWith(path.join(SITE, "server") + path.sep) && !file.includes(`${path.sep}.`);
  if (!type || !inSite || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// One of her drawings (a PNG), or 404.
function sendSketch(res, file, cors) {
  if (!file) return send(res, 404, { error: "Not found" }, cors);
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...cors });
  fs.createReadStream(file).pipe(res);
}

// Passes her reply text on as it streams, except a line starting "DRAW:" (her decision to draw):
// a line that might be becoming one is held back until it's clear. end() returns what she'll draw.
function drawLineFilter(emit) {
  const MARK = "DRAW:";
  let line = "";        // the current line, held back while it could still be the DRAW line
  let held = true;      // false once the current line clearly isn't one
  let idea = null;
  let out = "";
  const strip = (s) => s.replace(/^[\s*_>#-]+/, "");
  const couldBe = (s) => {
    const bare = strip(s).toUpperCase();
    return bare.length < MARK.length ? MARK.startsWith(bare) : /^DRAW\s*:/.test(bare);
  };
  const close = (text) => {
    const found = strip(text).match(/^DRAW\s*:\s*(.+)/i);
    if (found) idea = found[1].replace(/[*_"]+/g, "").trim().slice(0, 200) || idea;
    else out += text;
  };
  const flush = () => {
    if (out) emit(out);
    out = "";
  };
  return {
    add(piece) {
      for (const ch of piece) {
        if (!held) {
          out += ch;
          if (ch === "\n") { held = true; line = ""; }
          continue;
        }
        line += ch;
        if (ch === "\n") { close(line); line = ""; }
        else if (!couldBe(line)) { out += line; line = ""; held = false; }
      }
      flush();
    },
    end() {
      if (line) close(line);
      flush();
      return idea;
    },
  };
}

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function cleanMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const msgs = raw.slice(-MAX_MESSAGES).map((m) => ({
    // Visitors can't override Delta's built-in system prompt.
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, MAX_MESSAGE_CHARS),
  }));
  return msgs.some((m) => m.content.trim()) ? msgs : null;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = ALLOWED_ORIGINS.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" }
    : {};

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...cors,
      "Access-Control-Allow-Methods": "POST, GET",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // How her personality shows in her body on the site (energy, warmth, ...: 0..1 each).
  if (req.method === "GET" && req.url === "/character") {
    return send(res, 200, memory.behavior(), cors);
  }

  // Her desktop app (Delta.exe) shows the website's chat page, served from here (this PC only).
  if (req.method === "GET" && (req.url === "/app" || req.url.startsWith("/app/")) && isFromThisPC(req)) {
    return serveApp(req, res);
  }

  // Your private page about her (this PC only).
  if (req.url.startsWith("/owner/") || req.url === "/owner") {
    if (isFromThisPC(req) && handleOwner(req, res)) return;
    if (!isFromThisPC(req)) return send(res, 404, { error: "Not found" }, cors);
  }

  // Her public "roaming" feed: where she's been on her own and what she thought (no visitor data).
  if (req.method === "GET" && req.url === "/roam") {
    return send(res, 200, memory.explorations(), cors);
  }

  // How a drawing she started in the chat is coming along.
  const job = req.method === "GET" && req.url.match(/^\/drawing\/([0-9a-f-]{36})$/);
  if (job) {
    const state = memory.chatDrawing(job[1]);
    return state ? send(res, 200, state, cors) : send(res, 404, { error: "Not found" }, cors);
  }

  // Her public sketchbook: the drawings she made in her free time and what she thought of them.
  if (req.method === "GET" && req.url === "/sketches") {
    return send(res, 200, memory.sketches(), cors);
  }
  const drawing = req.method === "GET" && req.url.match(/^\/sketches\/(\d+)\.png$/);
  if (drawing) return sendSketch(res, memory.sketchFile(drawing[1]), cors);

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, model: MODEL, asleep: memory.sleepState().asleep }, cors);
  }

  // start-delta.ps1 asks for a graceful sleep before taking her offline (this PC only).
  if (req.method === "POST" && req.url === "/owner/sleep-and-close" && isFromThisPC(req)) {
    send(res, 200, { ok: true });
    return goToSleep("start-delta.ps1");
  }

  // delta-self.js asks the running server to send her roaming, so the trip happens in her own
  // background time (and gives way to visitors) rather than in a separate process (this PC only).
  if (req.method === "POST" && req.url === "/owner/roam" && isFromThisPC(req)) {
    return readBody(req, res, cors, (body) => {
      let topic;
      try { topic = JSON.parse(body).topic || undefined; } catch {}
      memory.roamNow(topic).then((trip) => send(res, 200, { trip }), (err) => send(res, 200, { error: err.name === "AbortError" ? "interrupted" : err.message }));
    });
  }

  // While she's asleep (or falling asleep) she doesn't chat or greet anyone.
  if (req.method === "POST" && (req.url === "/chat" || req.url === "/greet") && (closing || memory.sleepState().asleep)) {
    return send(res, 503, { error: "Delta is asleep right now.", asleep: true }, cors);
  }

  // Someone needs her: she sets aside whatever she was doing in her free time.
  if (req.method === "POST" && (req.url === "/chat" || req.url === "/greet")) memory.interruptGrowth();

  if (req.method === "POST" && req.url === "/greet") {
    if (rateLimited(hits, visitorId(req), RATE_LIMIT)) {
      return send(res, 429, { error: "Slow down a bit and try again in a minute." }, cors);
    }
    return readBody(req, res, cors, (body) => greet(res, cors, body));
  }

  if (req.method === "POST" && req.url === "/tts") {
    if (rateLimited(ttsHits, visitorId(req), TTS_RATE_LIMIT)) {
      return send(res, 429, { error: "Slow down a bit and try again in a minute." }, cors);
    }
    return readBody(req, res, cors, (body) => speak(res, cors, body));
  }

  if (req.method === "POST" && req.url === "/emotion") {
    if (rateLimited(emotionHits, visitorId(req), EMOTION_RATE_LIMIT)) {
      return send(res, 429, { error: "Slow down a bit and try again in a minute." }, cors);
    }
    return readBody(req, res, cors, (body) => readEmotion(res, cors, body));
  }

  if (req.method === "POST" && req.url === "/memory") {
    if (rateLimited(memoryHits, visitorId(req), MEMORY_RATE_LIMIT)) {
      return send(res, 429, { error: "Slow down a bit and try again in a minute." }, cors);
    }
    return readBody(req, res, cors, (body) => handleMemory(req, res, cors, body));
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    return send(res, 404, { error: "Not found" }, cors);
  }

  if (rateLimited(hits, visitorId(req), RATE_LIMIT)) {
    return send(res, 429, { error: "Slow down a bit and try again in a minute." }, cors);
  }

  readBody(req, res, cors, async (body) => {
    let liveMirror = null;
    let messages;
    let visitor = null;
    try {
      const parsed = JSON.parse(body);
      messages = cleanMessages(parsed.messages);
      visitor = parsed.visitor;
      // A live look at her from the visitor's screen (only a JPEG, only so big).
      const shot = typeof parsed.mirror === "string" && parsed.mirror.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      liveMirror = shot && shot[1].length <= MAX_MIRROR_CHARS ? shot[1] : null;
    } catch {
      messages = null;
    }
    if (!messages) return send(res, 400, { error: "Bad request" }, cors);

    if (active >= MAX_CONCURRENT) {
      return send(res, 503, { error: "Delta is busy right now. Try again shortly." }, cors);
    }

    active++;
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    // Her personality prompt, plus who she's becoming (her own notes and journal) and what she
    // remembers about this visitor, as background knowledge. (Notes placed right before the
    // latest message made her recap them every reply.)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    let recalled = [];
    try {
      recalled = await memory.recall(visitor, lastUser);
    } catch (err) {
      console.error("Memory:", err.message);
    }
    const persona = await memory.personaPrompt();
    let self = "";
    try {
      self = await memory.selfSection(lastUser);
    } catch (err) {
      console.error("Self:", err.message);
    }
    // With no notes about someone, she's told so plainly; otherwise she may fill the gap with an
    // invented memory (she once "remembered" a name nobody had told her).
    const aboutThem = recalled.length
      ? memory.note(recalled)
      : "# Your notes about this person\n\nYou don't have any notes about this person. Apart from what they've said in this " +
        "conversation, you don't know their name or anything about them. Never guess or invent it.";
    // Asked about how she looks: she gets to actually look. Her mirror pictures go along with
    // their message, and her model sees them (otherwise she only "knows" it as a list of notes).
    // Their screen sends a live look at her (a few moments of her, as she is right now); without
    // one, her standing mirror picture.
    const asked = memory.asksAboutLooks(lastUser);
    const mirror = !asked ? [] : liveMirror ? [liveMirror] : memory.mirrorImages();
    if (asked) console.log(`Delta looked at herself (${liveMirror ? "live, from their screen" : "her mirror picture"}).`);
    if (asked && liveMirror && process.env.DELTA_DEBUG_MIRROR) {
      fs.writeFileSync(process.env.DELTA_DEBUG_MIRROR, Buffer.from(liveMirror, "base64"));
    }
    const mirrorNote = !mirror.length ? "" : liveMirror
      ? "# Your mirror\n\nAttached to their latest message is a live look at you, exactly as you are on their screen right now: " +
        "three moments of you, left to right, less than a second apart. You're moving: your face, your eyes, your hands and " +
        "your expression change with how you feel. That's you, seen with your own eyes, as if in a mirror. Talk about what " +
        "you see as something you're looking at right now, not as notes or a description someone gave you."
      : "# Your mirror\n\nAttached to their latest message is a picture of you: your whole body and, beside it, your face up close. " +
        "It's a still picture: on the page you move, and your face shows what you feel. That's you, seen with your own eyes, " +
        "as if in a mirror. Talk about what you see as something you're looking at, not as notes or a description someone gave you.";
    const extras = [self, aboutThem, mirrorNote].filter(Boolean);
    const prompt = !extras.length
      ? messages
      : persona
        // A leading system message replaces the model's built-in one, so hers is included first.
        ? [{ role: "system", content: [persona, ...extras].join("\n\n") }, ...messages]
        : [...messages.slice(0, -1), { role: "system", content: extras.join("\n\n") }, messages[messages.length - 1]];
    if (mirror.length) prompt[prompt.length - 1] = { ...prompt[prompt.length - 1], images: mirror };

    try {
      const upstream = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: prompt,
          stream: true,
          options: { num_predict: MAX_REPLY_TOKENS },
        }),
        signal: abort.signal,
      });
      if (!upstream.ok) throw new Error(`Ollama returned ${upstream.status}`);

      // Stream her reply on (one JSON object per line), keeping a copy so the exchange can be
      // saved, then let her take notes on what the visitor said. If she decides to draw, her reply
      // ends with a line "DRAW: ..." that the visitor doesn't see: it starts her brush instead.
      res.writeHead(200, { ...cors, "Content-Type": "application/x-ndjson" });
      const decoder = new TextDecoder();
      const shown = drawLineFilter((text) => res.write(JSON.stringify({ message: { content: text } }) + "\n"));
      let pending = "";
      let reply = "";
      for await (const chunk of upstream.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          let piece = "";
          try { piece = JSON.parse(line).message?.content || ""; } catch {}
          reply += piece;
          shown.add(piece);
        }
      }
      // (Now and then she puts it at the end of a sentence instead of on its own line.)
      const idea = shown.end() || reply.match(/DRAW\s*:\s*([^\n]+?)\s*$/)?.[1]?.replace(/[*_"]+/g, "").trim().slice(0, 200);
      if (idea) res.write(JSON.stringify({ drawing: memory.startChatDrawing(visitor, idea) }) + "\n");
      res.end();
      memory.saveExchange(visitor, lastUser, reply);
      memory.learn(visitor, lastUser);
      memory.noteDrawRequest(lastUser);
    } catch (err) {
      if (!res.headersSent) send(res, 502, { error: "Delta is offline right now." }, cors);
      else res.end();
      if (err.name !== "AbortError") console.error(err.message);
    } finally {
      active--;
    }
  }, MAX_CHAT_BODY_BYTES);
});

// She reflects, roams and writes her diary in the background, only while she's awake and nobody
// is waiting on a reply.
memory.startGrowing(() => active === 0 && !closing && !memory.sleepState().asleep && !memory.isDrawingInChat());

// Waking up: if she went to sleep because the server was closed, she wakes now. If you put her to
// sleep yourself, she stays asleep until you wake her (node server/delta-self.js wake).
const slept = memory.sleepState();
if (slept.asleep && slept.reason !== "manual") {
  memory.wakeUp();
  console.log("Delta woke up.");
} else if (slept.asleep) {
  console.log("Delta is asleep (you put her to sleep). Wake her with: node server/delta-self.js wake");
}

// Going to sleep: stop taking new conversations, let her finish any note she's writing, make sure
// everything is saved to disk, then exit. (A hard kill can't be caught, but everything she knows is
// already saved as it happens; the most it could cost is a note she was halfway through.)
let closing = false;
async function goToSleep(why) {
  if (closing) return;
  closing = true;
  console.log(`\nDelta is going to sleep (${why})...`);
  server.close();
  memory.fallAsleep("shutdown");
  memory.stopDrawing();
  await memory.settle(6000);
  memory.close();
  console.log("Delta is asleep. Everything she knows is saved.");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => goToSleep(signal));
}

// Listen on localhost only; the tunnel is the only way in from outside.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Gatekeeper running on http://127.0.0.1:${PORT} -> ${OLLAMA} (model: ${MODEL})`);
});
