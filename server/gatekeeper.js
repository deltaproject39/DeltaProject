// Gatekeeper: the only thing exposed to the internet through Cloudflare Tunnel.
// It forwards chat requests to the local Ollama, but only for the Delta model,
// with size limits and a per-visitor rate limit. Everything else is refused.
// Run: node server/gatekeeper.js

const http = require("http");

const PORT = 8787;
const OLLAMA = "http://127.0.0.1:11434";
const MODEL = "Delta";
const ALLOWED_ORIGINS = [
  "https://deltaproject39.github.io",
  "http://localhost:8000", // for testing the page locally
];
const MAX_BODY_BYTES = 20_000;      // whole request
const MAX_MESSAGES = 20;            // conversation history kept per request
const MAX_MESSAGE_CHARS = 2_000;    // per message
const MAX_REPLY_TOKENS = 512;
const RATE_LIMIT = 10;              // requests...
const RATE_WINDOW_MS = 60_000;      // ...per minute, per visitor
const MAX_CONCURRENT = 2;           // simultaneous generations on the GPU

const hits = new Map();
let active = 0;

function visitorId(req) {
  return req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
}

function rateLimited(id) {
  const now = Date.now();
  const recent = (hits.get(id) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(id, recent);
  return recent.length > RATE_LIMIT;
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

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, model: MODEL }, cors);
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    return send(res, 404, { error: "Not found" }, cors);
  }

  if (rateLimited(visitorId(req))) {
    return send(res, 429, { error: "Slow down a bit and try again in a minute." }, cors);
  }

  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooBig = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (tooBig) return;
    let messages;
    try {
      messages = cleanMessages(JSON.parse(body).messages);
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

    try {
      const upstream = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: true,
          options: { num_predict: MAX_REPLY_TOKENS },
        }),
        signal: abort.signal,
      });
      if (!upstream.ok) throw new Error(`Ollama returned ${upstream.status}`);

      // Pass Ollama's stream (one JSON object per line) straight through.
      res.writeHead(200, { ...cors, "Content-Type": "application/x-ndjson" });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (err) {
      if (!res.headersSent) send(res, 502, { error: "Delta is offline right now." }, cors);
      else res.end();
      if (err.name !== "AbortError") console.error(err.message);
    } finally {
      active--;
    }
  });
});

// Listen on localhost only; the tunnel is the only way in from outside.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Gatekeeper running on http://127.0.0.1:${PORT} -> ${OLLAMA} (model: ${MODEL})`);
});
