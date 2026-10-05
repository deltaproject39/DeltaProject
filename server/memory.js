// Delta's long-term memory: things each visitor has told her, kept in a SQLite file on this PC.
//
// Visitors are identified by a random ID their browser makes up (no IPs, no accounts). Each one
// also gets a memory code like "sunny-otter-4821" that carries their memories to another device.
// After every exchange, Delta's model writes down lasting facts about the visitor in the
// background; before each reply, the facts most related to the conversation are recalled
// using nomic-embed-text.

const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE = path.join(__dirname, "memory.db"); // personal data: never committed (see .gitignore)
const OLLAMA = "http://127.0.0.1:11434";
const EMBED_MODEL = "nomic-embed-text";
const NOTE_MODEL = "Delta";
const MAX_MEMORIES = 200;        // per visitor; the oldest go first
const RECALL_COUNT = 6;          // memories handed to Delta per reply
const RECALL_ALL_BELOW = 8;      // with this few memories, just recall them all
const MIN_SIMILARITY = 0.4;
const DUPLICATE_SIMILARITY = 0.9;

const ADJECTIVES = [
  "sunny", "brave", "quiet", "lucky", "gentle", "bright", "clever", "cozy", "swift", "happy",
  "calm", "bold", "merry", "noble", "witty", "rosy", "misty", "golden", "silver", "amber",
  "frosty", "breezy", "starry", "velvet", "cosmic", "lunar", "crimson", "jolly", "keen", "proud",
];
const ANIMALS = [
  "otter", "fox", "panda", "koala", "falcon", "lynx", "heron", "badger", "dolphin", "owl",
  "tiger", "rabbit", "wolf", "seal", "raven", "deer", "finch", "turtle", "whale", "lemur",
  "hedgehog", "penguin", "sparrow", "moose", "gecko", "bison", "crane", "puffin", "yak", "orca",
];

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS visitors (
    id      TEXT PRIMARY KEY,
    code    TEXT UNIQUE NOT NULL,
    created INTEGER NOT NULL,
    seen    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id        INTEGER PRIMARY KEY,
    visitor   TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    text      TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_by_visitor ON memories(visitor);
`);
// "keep" marks visitors that are never tidied away, e.g. custom IDs set with set-code.js.
if (!db.prepare("PRAGMA table_info(visitors)").all().some((c) => c.name === "keep")) {
  db.exec("ALTER TABLE visitors ADD COLUMN keep INTEGER NOT NULL DEFAULT 0");
}

const isVisitorId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
const pick = (list) => list[crypto.randomInt(list.length)];

function newCode() {
  for (;;) {
    const code = `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${crypto.randomInt(1000, 10000)}`;
    if (!db.prepare("SELECT 1 FROM visitors WHERE code = ?").get(code)) return code;
  }
}

function countMemories(visitor) {
  return db.prepare("SELECT COUNT(*) AS n FROM memories WHERE visitor = ?").get(visitor).n;
}

// ---- Visitors ----

// Registers a visitor the first time they're seen; returns their code and memory count.
function hello(visitor) {
  if (!isVisitorId(visitor)) return null;
  const now = Date.now();
  let row = db.prepare("SELECT code FROM visitors WHERE id = ?").get(visitor);
  if (!row) {
    row = { code: newCode() };
    db.prepare("INSERT INTO visitors (id, code, created, seen) VALUES (?, ?, ?, ?)").run(visitor, row.code, now, now);
  } else {
    db.prepare("UPDATE visitors SET seen = ? WHERE id = ?").run(now, visitor);
  }
  return { code: row.code, count: countMemories(visitor) };
}

// A memory code typed on another device gives back that visitor's ID. The device's own ID is
// usually brand new and empty, so it's dropped rather than left behind; one that already has
// memories is kept.
function claim(code, previousVisitor) {
  const wanted = String(code || "").trim().toLowerCase();
  const row = db.prepare("SELECT id FROM visitors WHERE code = ?").get(wanted);
  if (!row) return null;
  if (isVisitorId(previousVisitor) && previousVisitor !== row.id && countMemories(previousVisitor) === 0) {
    db.prepare("DELETE FROM visitors WHERE id = ? AND keep = 0").run(previousVisitor);
  }
  return { visitor: row.id, code: wanted, count: countMemories(row.id) };
}

// Visitors who never told her anything are tidied away once they've been gone a while.
const EMPTY_VISITOR_DAYS = 7;
function tidy() {
  const cutoff = Date.now() - EMPTY_VISITOR_DAYS * 24 * 60 * 60 * 1000;
  const removed = db.prepare(`DELETE FROM visitors WHERE keep = 0 AND seen < ?
    AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.visitor = visitors.id)`).run(cutoff).changes;
  if (removed) console.log(`Memory: tidied away ${removed} empty visitor${removed === 1 ? "" : "s"}.`);
}
tidy();
setInterval(tidy, 6 * 60 * 60 * 1000).unref();

function list(visitor) {
  if (!isVisitorId(visitor)) return [];
  return db.prepare("SELECT id, text, created FROM memories WHERE visitor = ? ORDER BY created").all(visitor);
}

function forget(visitor, memoryId) {
  if (!isVisitorId(visitor)) return;
  db.prepare("DELETE FROM memories WHERE visitor = ? AND id = ?").run(visitor, Number(memoryId));
}

function forgetEverything(visitor) {
  if (!isVisitorId(visitor)) return;
  db.prepare("DELETE FROM visitors WHERE id = ?").run(visitor); // memories go with it
}

// ---- Embeddings ----

async function embed(texts, kind) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // nomic-embed-text expects these task prefixes.
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => `${kind}: ${t}`) }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  return (await res.json()).embeddings.map((e) => normalize(Float32Array.from(e)));
}

function normalize(v) {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  return v.map((x) => x / len);
}

function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// ---- Recall ----

// The memories most related to what's being talked about now.
async function recall(visitor, query) {
  if (!isVisitorId(visitor)) return [];
  const rows = db.prepare("SELECT text, embedding FROM memories WHERE visitor = ? ORDER BY created").all(visitor);
  if (rows.length === 0) return [];
  if (rows.length <= RECALL_ALL_BELOW) return rows.map((r) => r.text);
  const [q] = await embed([query], "search_query");
  return rows
    .map((r) => ({ text: r.text, score: similarity(q, fromBlob(r.embedding)) }))
    .filter((r) => r.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_COUNT)
    .map((r) => r.text);
}

// Handed to Delta just before the visitor's latest message.
function note(memories) {
  return [
    "[Your memory notebook] You now keep notes between conversations. These are real things this",
    "person told you before, so you genuinely remember them. Use them naturally when they're",
    "relevant; don't list them back or mention the notebook unless asked.",
    ...memories.map((m) => `- ${m}`),
  ].join("\n");
}

// ---- Learning ----

const NOTE_INSTRUCTIONS = `You write long-term memory notes about the USER of a chat app.
Return JSON exactly like {"memories": ["...", "..."]}.
Write one short note for EACH separate fact the user states about themselves in THIS message: name, age, location, pets (names, breeds), family, job or school, likes and dislikes (including food, music, games), hobbies, plans, important events or feelings.
Use only what this message says. Never invent or carry over details.
Write a name as "The user's name is ...". Start other notes with the user's name if this message gives it, otherwise "The user". Never guess gender: no he/she/his/her.
Skip greetings, questions, small talk and opinions about the assistant. If nothing qualifies, return {"memories": []}.

Example message: "im priya from leeds. i play cello and hate olives"
Example output: {"memories": ["The user's name is Priya.", "Priya is from Leeds.", "Priya plays the cello.", "Priya hates olives."]}`;

async function writeNotes(userText) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: NOTE_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: 200 },
      messages: [
        // A leading system message replaces Delta's persona for this one task.
        { role: "system", content: NOTE_INSTRUCTIONS },
        { role: "user", content: `User message: """${userText}"""` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Note-taking failed: ${res.status}`);
  const parsed = JSON.parse((await res.json()).message.content);
  return (Array.isArray(parsed.memories) ? parsed.memories : [])
    .filter((m) => typeof m === "string" && m.trim())
    .map((m) => m.trim().slice(0, 200))
    .slice(0, 5);
}

async function learnNow(visitor, userText) {
  const facts = await writeNotes(userText);
  if (facts.length === 0) return;
  const vectors = await embed(facts, "search_document");
  const existing = db.prepare("SELECT id, embedding FROM memories WHERE visitor = ?").all(visitor)
    .map((r) => ({ id: r.id, vector: fromBlob(r.embedding) }));

  facts.forEach((text, i) => {
    // A near-duplicate replaces the older note (it's probably an update, e.g. a new age).
    const dupe = existing.find((e) => similarity(e.vector, vectors[i]) >= DUPLICATE_SIMILARITY);
    if (dupe) db.prepare("DELETE FROM memories WHERE id = ?").run(dupe.id);
    db.prepare("INSERT INTO memories (visitor, text, embedding, created) VALUES (?, ?, ?, ?)")
      .run(visitor, text, toBlob(vectors[i]), Date.now());
  });

  db.prepare(`DELETE FROM memories WHERE visitor = ? AND id NOT IN
    (SELECT id FROM memories WHERE visitor = ? ORDER BY created DESC LIMIT ?)`).run(visitor, visitor, MAX_MEMORIES);
}

// Note-taking runs one at a time in the background so it never competes with a reply for long.
let queue = Promise.resolve();
function learn(visitor, userText) {
  if (!isVisitorId(visitor) || !db.prepare("SELECT 1 FROM visitors WHERE id = ?").get(visitor)) return;
  queue = queue
    .then(() => learnNow(visitor, userText))
    .catch((err) => console.error("Memory:", err.message));
}

module.exports = { hello, claim, list, forget, forgetEverything, recall, note, learn };
