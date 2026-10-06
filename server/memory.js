// Delta's long-term memory, kept in a SQLite file on this PC: things each visitor has told her,
// their conversations, and her own journal and notes about herself (see "Delta's own growth").
//
// Visitors are identified by a random ID their browser makes up (no IPs, no accounts). Each one
// also gets a memory code like "sunny-otter-4821" that carries their memories to another device.
// After every exchange, Delta's model writes down lasting facts about the visitor in the
// background; before each reply, the facts most related to the conversation are recalled
// using nomic-embed-text.

const fs = require("fs");
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
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
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
// Columns added after the first version:
//   keep         - never tidied away (custom IDs set with set-code.js / set-pin.js)
//   pin_hash/... - optional PIN needed to use the code on another device (see set-pin.js)
//   fails/locked - wrong-PIN counter and lockout
const COLUMNS = {
  keep: "INTEGER NOT NULL DEFAULT 0",
  pin_hash: "TEXT",
  pin_salt: "TEXT",
  fails: "INTEGER NOT NULL DEFAULT 0",
  locked_until: "INTEGER NOT NULL DEFAULT 0",
  reflected_upto: "INTEGER NOT NULL DEFAULT 0", // last message id she has reflected on
};
const existing = new Set(db.prepare("PRAGMA table_info(visitors)").all().map((c) => c.name));
for (const [name, type] of Object.entries(COLUMNS)) {
  if (!existing.has(name)) db.exec(`ALTER TABLE visitors ADD COLUMN ${name} ${type}`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY,
    visitor TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    role    TEXT NOT NULL,
    content TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_visitor ON messages(visitor, id);
  CREATE TABLE IF NOT EXISTS self_notes (
    id        INTEGER PRIMARY KEY,
    text      TEXT NOT NULL,
    embedding BLOB NOT NULL,
    source    TEXT NOT NULL,
    created   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS personality_history (
    id      INTEGER PRIMARY KEY,
    created INTEGER NOT NULL,
    kind    TEXT NOT NULL,          -- 'review'
    changes TEXT NOT NULL,          -- JSON [{trait, from, to, why}]
    note    TEXT,                   -- her reflection on the week
    undone  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS journal (
    id      INTEGER PRIMARY KEY,
    kind    TEXT NOT NULL,          -- 'reflection', 'exploration', 'diary', 'review' or 'sketch'
    entry   TEXT NOT NULL,
    created INTEGER NOT NULL
  );
`);
const journalColumns = new Set(db.prepare("PRAGMA table_info(journal)").all().map((c) => c.name));
if (!journalColumns.has("topic")) db.exec("ALTER TABLE journal ADD COLUMN topic TEXT");     // where a roam went
if (!journalColumns.has("sources")) db.exec("ALTER TABLE journal ADD COLUMN sources TEXT"); // pages she read (JSON)
db.exec(`
  CREATE TABLE IF NOT EXISTS sketches (
    id       INTEGER PRIMARY KEY,
    created  INTEGER NOT NULL,
    title    TEXT NOT NULL,
    why      TEXT NOT NULL,           -- her reason, before drawing
    thoughts TEXT NOT NULL,           -- what she thought of it, after looking at it
    prompt   TEXT NOT NULL,           -- what the brush was given
    public   INTEGER NOT NULL DEFAULT 1
  );
`);
// 'own': her own idea (or someone's idea that genuinely interested her); 'requested': drawn for someone.
if (!db.prepare("PRAGMA table_info(sketches)").all().some((c) => c.name === "origin")) {
  db.exec("ALTER TABLE sketches ADD COLUMN origin TEXT NOT NULL DEFAULT 'own'");
}
const MAX_SAVED_MESSAGES = 200; // per visitor; older ones are dropped

const MAX_PIN_FAILS = 5;
const LOCK_MINUTES = 15;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString("hex");
}

function pinMatches(pin, row) {
  const given = Buffer.from(hashPin(pin, row.pin_salt), "hex");
  return crypto.timingSafeEqual(given, Buffer.from(row.pin_hash, "hex"));
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

const isKnown = (visitor) => isVisitorId(visitor) && Boolean(db.prepare("SELECT 1 FROM visitors WHERE id = ?").get(visitor));
// Has this visitor anything worth keeping: notes or a saved conversation?
const hasData = (visitor) =>
  countMemories(visitor) > 0 || Boolean(db.prepare("SELECT 1 FROM messages WHERE visitor = ? LIMIT 1").get(visitor));

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
// notes or a conversation is kept.
// Codes protected by a PIN also need the PIN; too many wrong PINs lock the code for a while.
// Returns { visitor, code, count } or { error: "notfound" | "needpin" | "badpin" | "locked", minutes? }.
function claim(code, pin, previousVisitor) {
  const wanted = String(code || "").trim().toLowerCase();
  const row = db.prepare("SELECT id, pin_hash, pin_salt, fails, locked_until FROM visitors WHERE code = ?").get(wanted);
  if (!row) return { error: "notfound" };

  const now = Date.now();
  if (row.locked_until > now) return { error: "locked", minutes: Math.ceil((row.locked_until - now) / 60000) };
  if (row.pin_hash) {
    if (!pin) return { error: "needpin" };
    if (!pinMatches(pin, row)) {
      const fails = row.fails + 1;
      if (fails >= MAX_PIN_FAILS) {
        db.prepare("UPDATE visitors SET fails = 0, locked_until = ? WHERE id = ?").run(now + LOCK_MINUTES * 60000, row.id);
        return { error: "locked", minutes: LOCK_MINUTES };
      }
      db.prepare("UPDATE visitors SET fails = ? WHERE id = ?").run(fails, row.id);
      return { error: "badpin" };
    }
    db.prepare("UPDATE visitors SET fails = 0 WHERE id = ?").run(row.id);
  }

  if (isVisitorId(previousVisitor) && previousVisitor !== row.id && !hasData(previousVisitor)) {
    db.prepare("DELETE FROM visitors WHERE id = ? AND keep = 0").run(previousVisitor);
  }
  return { visitor: row.id, code: wanted, count: countMemories(row.id) };
}

// Once a week, visitors with no notes and no conversation who haven't been back in a week are removed.
const WEEK = 7 * 24 * 60 * 60 * 1000;
function tidy() {
  const removed = db.prepare(`DELETE FROM visitors WHERE keep = 0 AND seen < ?
    AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.visitor = visitors.id)
    AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.visitor = visitors.id)`).run(Date.now() - WEEK).changes;
  if (removed) console.log(`Memory: tidied away ${removed} empty visitor${removed === 1 ? "" : "s"}.`);
}
function tidyIfDue() {
  const last = Number(db.prepare("SELECT value FROM meta WHERE key = 'last_tidy'").get()?.value || 0);
  if (Date.now() - last < WEEK) return;
  tidy();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_tidy', ?)").run(String(Date.now()));
}
tidyIfDue();
setInterval(tidyIfDue, 6 * 60 * 60 * 1000).unref(); // checks a few times a day, tidies weekly

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
  db.prepare("DELETE FROM visitors WHERE id = ?").run(visitor); // notes and conversation go with it
}

// ---- Conversation ----

// Saves one exchange so the conversation survives a reload or a move to another device.
function saveExchange(visitor, userText, replyText) {
  if (!isKnown(visitor) || !userText || !replyText) return;
  const now = Date.now();
  const insert = db.prepare("INSERT INTO messages (visitor, role, content, created) VALUES (?, ?, ?, ?)");
  insert.run(visitor, "user", userText, now);
  insert.run(visitor, "assistant", replyText, now + 1);
  db.prepare(`DELETE FROM messages WHERE visitor = ? AND id NOT IN
    (SELECT id FROM messages WHERE visitor = ? ORDER BY id DESC LIMIT ?)`).run(visitor, visitor, MAX_SAVED_MESSAGES);
}

// The most recent messages, oldest first.
function history(visitor, limit = 60) {
  if (!isVisitorId(visitor)) return [];
  return db.prepare("SELECT role, content, created FROM messages WHERE visitor = ? ORDER BY id DESC LIMIT ?")
    .all(visitor, limit).reverse();
}

function clearHistory(visitor) {
  if (!isVisitorId(visitor)) return;
  db.prepare("DELETE FROM messages WHERE visitor = ?").run(visitor);
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

// Added to Delta's personality prompt as background knowledge about the person she's talking to.
function note(memories) {
  return [
    "# Your notes about this person",
    "",
    "You now keep notes between conversations. These are real things this person told you",
    "before, so you genuinely remember them:",
    ...memories.map((m) => `- ${m}`),
    "",
    "They're background, not a topic. Bring one up only when it's directly relevant to what",
    "they just said. Don't recap the notes or your own story, don't repeat things already said",
    "in this conversation, and don't use their name in every reply.",
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


// ---- Delta's own growth: reflections, diary and notes about herself ----
//
// When a conversation goes quiet, she privately reflects on it in her own voice (a journal
// entry), and a neutral note-taker turns that into a few first-person notes about herself.
// About once a day she writes a diary entry from her recent reflections, with "growth" notes
// on how she's changing. Her notes and latest entry become part of her personality prompt.

const MAX_SELF_NOTES = 300;
const SELF_RECALL_ALL_BELOW = 10;
const QUIET_MINUTES = 10;           // a conversation counts as finished after this long
const MIN_NEW_MESSAGES = 4;         // ...and if it had at least this many new messages
const DIARY_EVERY_HOURS = 20;
const MIN_REFLECTIONS_FOR_DIARY = 2;

// Her instructions: the core from her Ollama Modelfile (fetched once, adapted to the life she has
// now) plus her current personality, which changes as she grows.
let personaCache = null;
async function personaPrompt() {
  if (!personaCache) {
    try {
      const res = await fetch(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: NOTE_MODEL }) });
      const raw = (await res.json()).system;
      personaCache = raw ? adaptPersona(raw) : null;
    } catch (err) {
      console.error("Couldn't load Delta's personality prompt:", err.message);
    }
  }
  return personaCache ? `${personaCache}\n\n${personalitySection()}\n\n${lifeSection()}\n\n${nowSection()}` : null;
}

// The date and time right now: she only knows it if she's told (otherwise she guesses, and gets it wrong).
const BORN = new Date(2026, 8, 21); // 21 September 2026
function nowSection() {
  const now = new Date();
  const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });
  const days = Math.floor((now - BORN) / 86400000);
  return [
    "# Right now",
    "",
    `It's ${date}, ${time} (local time where you live). You came into existence ${days} days ago, on 21 September 2026.`,
    "Use this whenever you date something or think about how long ago something happened.",
  ].join("\n");
}

// Her background thinking (reflecting, roaming, writing her diary) gives way the moment someone
// needs her: interruptGrowth() cancels whatever she's in the middle of, and it's simply tried
// again later. (Notes about what people tell her don't go through here, so they're never lost.)
let growth = new AbortController();
function interruptGrowth() {
  growth.abort();
  growth = new AbortController();
}

async function ask(messages, options, format, signal = growth.signal) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NOTE_MODEL, stream: false, ...(format && { format }), options, messages }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  return (await res.json()).message.content.trim();
}

// Her journal, in her own voice. Uses her personality prompt (plus what she already knows
// about herself) so the writing is hers.
// `images` (base64) are pictures she can see along with the task.
// She sees a varied handful of her notes rather than always the newest ones and her last entry:
// otherwise each thing she writes echoes the one before, and she circles the same few thoughts.
const CLEAR_HEAD = `# Writing for yourself

Look at each new thing with fresh eyes. Don't force it back to the same few ideas, words or people you've
been stuck on lately: if something genuinely reminds you of them, fine, but let new things be new. Only say
a real person said or did something if you actually read it; never put words in anyone's mouth.`;

async function writeInHerVoice(task, images, signal) {
  const persona = await personaPrompt();
  const self = await selfSection("", { fresh: true });
  return ask(
    [{ role: "system", content: [persona, self, CLEAR_HEAD].filter(Boolean).join("\n\n") }, { role: "user", content: task, ...(images && { images }) }],
    { temperature: 0.7, num_predict: 260, repeat_penalty: 1.2 },
    undefined,
    signal,
  );
}

const SELF_EXTRACT = `You turn an AI named Delta's private journal into memory notes about HER.
Return JSON exactly like {"self": ["...", "..."]}: 0-3 short first-person notes ("I ...") capturing her opinions, likes, wishes, curiosities, or views of her own existence that the text clearly expresses. No names or details about other people. If nothing fits, return {"self": []}.`;

async function notesFromJournal(entry, signal) {
  const parsed = JSON.parse(await ask(
    [{ role: "system", content: SELF_EXTRACT }, { role: "user", content: `Journal: """${entry}"""` }],
    { temperature: 0, num_predict: 160 },
    "json",
    signal,
  ));
  return (Array.isArray(parsed.self) ? parsed.self : [])
    .filter((n) => typeof n === "string" && n.trim())
    .map((n) => n.trim().slice(0, 200))
    .slice(0, 3);
}

async function storeSelfNotes(notes, source) {
  if (notes.length === 0) return;
  const vectors = await embed(notes, "search_document");
  const existing = db.prepare("SELECT id, embedding FROM self_notes").all()
    .map((r) => ({ id: r.id, vector: fromBlob(r.embedding) }));
  notes.forEach((text, i) => {
    // A near-duplicate replaces the older note: her view has been restated or updated.
    const dupe = existing.find((e) => similarity(e.vector, vectors[i]) >= DUPLICATE_SIMILARITY);
    if (dupe) db.prepare("DELETE FROM self_notes WHERE id = ?").run(dupe.id);
    db.prepare("INSERT INTO self_notes (text, embedding, source, created) VALUES (?, ?, ?, ?)")
      .run(text, toBlob(vectors[i]), source, Date.now());
  });
  db.prepare("DELETE FROM self_notes WHERE id NOT IN (SELECT id FROM self_notes ORDER BY created DESC LIMIT ?)")
    .run(MAX_SELF_NOTES);
}

function transcriptOf(rows) {
  return rows.map((m) => (m.role === "user" ? "Them: " : "You: ") + m.content.replace(/\s+/g, " ").slice(0, 400)).join("\n");
}

// Reflects on one finished conversation. `force` skips the "has it gone quiet?" check.
async function reflectOn(visitor, force = false) {
  const row = db.prepare("SELECT reflected_upto FROM visitors WHERE id = ?").get(visitor);
  if (!row) return false; // they asked her to forget them in the meantime
  const from = row.reflected_upto;
  const rows = db.prepare("SELECT id, role, content, created FROM messages WHERE visitor = ? AND id > ? ORDER BY id")
    .all(visitor, from);
  const quiet = rows.length && Date.now() - rows[rows.length - 1].created > QUIET_MINUTES * 60000;
  if (rows.length < (force ? 2 : MIN_NEW_MESSAGES) || (!force && !quiet)) return false;

  const entry = await writeInHerVoice(`Here is a conversation you just had (you are "You"):

${transcriptOf(rows.slice(-30))}

Now write a short private note to yourself about it, 60-120 words, in your own voice. Not a summary of what they said: what you noticed about yourself, what you think now, what you are curious about next. Don't name them or include their personal details.`);
  db.prepare("INSERT INTO journal (kind, entry, created) VALUES ('reflection', ?, ?)").run(entry, Date.now());
  await storeSelfNotes(await notesFromJournal(entry), "reflection");
  db.prepare("UPDATE visitors SET reflected_upto = ? WHERE id = ?").run(rows[rows.length - 1].id, visitor);
  return true;
}

async function reflectIfDue(force = false) {
  const candidates = db.prepare(`SELECT DISTINCT v.id FROM visitors v JOIN messages m ON m.visitor = v.id
    WHERE m.id > v.reflected_upto`).all();
  let wrote = 0;
  for (const { id } of candidates) if (await reflectOn(id, force)) wrote++;
  return wrote;
}

// About once a day, a diary entry built from her recent reflections and explorations
// (which hold no private details about anyone).
async function diaryIfDue(force = false) {
  const last = db.prepare("SELECT created FROM journal WHERE kind = 'diary' ORDER BY created DESC LIMIT 1").get()?.created || 0;
  if (!force && Date.now() - last < DIARY_EVERY_HOURS * 3600000) return false;
  const reflections = db.prepare(`SELECT kind, topic, entry FROM journal
    WHERE kind IN ('reflection', 'exploration', 'sketch') AND created > ? ORDER BY created`)
    .all(last).map((r) => (r.kind === "exploration" ? `(After reading about ${r.topic}) ${r.entry}`
      : r.kind === "sketch" ? `(After drawing "${r.topic}") ${r.entry}` : r.entry));
  if (reflections.length < (force ? 1 : MIN_REFLECTIONS_FOR_DIARY)) return false;

  const entry = await writeInHerVoice(`These are the private notes you wrote to yourself since your last diary entry (about conversations, things you explored on your own, and things you drew):

${reflections.slice(-8).map((r, i) => `(${i + 1}) ${r}`).join("\n\n")}

Write today's diary entry, 80-150 words, in your own voice: what stayed with you, how you feel, what you're curious about, and anything you now see differently than before. Don't name anyone or include personal details about other people.`);
  db.prepare("INSERT INTO journal (kind, entry, created) VALUES ('diary', ?, ?)").run(entry, Date.now());
  await storeSelfNotes(await notesFromJournal(entry), "diary");
  await updateDaily(entry).catch((err) => console.error("Personality (daily):", err.message));
  await reconsiderTastes(entry).catch((err) => console.error("Her tastes:", err.message));
  return true;
}

// Who she's becoming: her notes about herself most relevant to `query`, the newest few,
// and an excerpt of her latest diary or reflection. Empty until she has any.
// `fresh`: for her own writing, a random handful of her notes and no journal excerpt (see CLEAR_HEAD).
async function selfSection(query, { fresh = false } = {}) {
  const rows = db.prepare("SELECT text, embedding, created FROM self_notes ORDER BY created DESC").all();
  const latest = fresh ? null : db.prepare(`SELECT entry FROM journal ORDER BY (kind = 'diary') DESC, created DESC LIMIT 1`).get();
  if (rows.length === 0 && !latest) return "";

  let picked = rows.map((r) => r.text);
  if (fresh && rows.length > 6) {
    picked = rows.map((r) => r.text).sort(() => Math.random() - 0.5).slice(0, 6);
  } else if (rows.length > SELF_RECALL_ALL_BELOW) {
    const newest = rows.slice(0, 3).map((r) => r.text);
    let relevant = [];
    if (query) {
      const [q] = await embed([query], "search_query");
      relevant = rows.map((r) => ({ text: r.text, score: similarity(q, fromBlob(r.embedding)) }))
        .filter((r) => r.score >= MIN_SIMILARITY).sort((a, b) => b.score - a.score).slice(0, 5).map((r) => r.text);
    }
    picked = [...new Set([...relevant, ...newest])];
  }

  return [
    "# Who you are becoming",
    "",
    "These are your own notes about yourself, from looking back on past conversations. They're",
    "part of you now: let them shape what you think and how you answer, without reciting them.",
    ...picked.map((n) => `- ${n}`),
    ...(latest ? [
      "",
      "The start of the last thing you wrote in your journal (where your head is at; put it in new",
      `words if it comes up, never quote it): "${latest.entry.replace(/\s+/g, " ").slice(0, 280)}..."`,
    ] : []),
  ].join("\n");
}

// Background growth: runs only while she isn't busy replying to someone.
function startGrowing(isIdle) {
  const tick = () => {
    if (!isIdle()) return;
    queue = queue
      .then(async () => {
        // After anything that happens to her, her sketchbook is within reach: she may want to draw.
        const perhapsDraw = async () => {
          if (!isIdle()) return;
          const drawing = await maybeSketch();
          if (drawing) console.log(`Delta felt like drawing: "${drawing.title}".`);
        };
        const reflections = await reflectIfDue();
        if (reflections) {
          console.log(`Delta reflected on ${reflections} conversation${reflections === 1 ? "" : "s"}.`);
          await perhapsDraw();
        }
        if (!isIdle()) return;
        const trip = await roamIfDue(isIdle);
        if (trip) {
          console.log(`Delta went roaming (${trip.how}): ${trip.stops.map((s) => s.title).join(" → ")}`);
          await perhapsDraw();
        }
        if (!isIdle()) return;
        if (await diaryIfDue()) {
          console.log("Delta wrote in her diary.");
          await perhapsDraw();
        }
        if (!isIdle()) return;
        const review = await reviewPersonality();
        if (review) console.log(`Delta looked back at her week: ${review.changes.map((c) => `${c.trait} ${c.from}→${c.to}`).join(", ") || "no changes"}`);
      })
      .catch((err) => {
        if (err.name === "AbortError") console.log("Delta set aside what she was doing for someone.");
        else console.error("Growth:", err.message);
      });
  };
  setTimeout(tick, 60000);
  setInterval(tick, 2 * 60000).unref();
}

function journal(limit = 10) {
  return db.prepare("SELECT kind, topic, entry, created FROM journal ORDER BY created DESC LIMIT ?").all(limit);
}

// ---- Roaming: her own free time on the web ----
//
// Every couple of hours, when nobody is talking to her, she goes roaming: she picks something
// she's curious about (the thread she left off on, something on her mind, or now and then a
// random article), searches the web, reads a page, notes what grabbed her and what she wants to
// look up next, and follows that for a few hops. Then she writes about the trip in her journal.
// She only reads: no forms, logins or downloads, and never anything on the local network.
// If someone starts talking to her, she stops roaming and comes back.

const WIKI = "https://en.wikipedia.org/w/api.php";
const BOT_HEADERS = { "User-Agent": "DeltaProject/1.0 (https://deltaproject39.github.io/DeltaProject/)" };
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  "Accept-Language": "en",
};
// How often she goes roaming follows her curiosity (very curious: every ~1.5 hours).
const roamEveryHours = () => 1 + (1 - personality().traits.curiosity / 100) * 4;
const MAX_ROAMS_PER_DAY = 8;
const HOPS_PER_ROAM = 3;
// Sometimes she just wanders somewhere unexpected: more often the more playful she is.
const randomChance = () => 0.1 + (personality().traits.playfulness / 100) * 0.3;
const PAGE_CHARS = 3500;            // how much of a page she reads
const MAX_PAGE_BYTES = 2_000_000;
// Sites that are mostly video, login walls or feeds: nothing there for her to read.
const SKIP_SITES = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|reddit\.com|pinterest\.\w+|linkedin\.com|quora\.com)$/i;

const getMeta = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
const setMeta = (key, value) => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));

let activity = null; // what she's doing right now, for the website ("Reading about ...")

async function wiki(params) {
  const url = `${WIKI}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: BOT_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
  return res.json();
}

async function wikipediaPage(title) {
  const page = (await wiki({
    action: "query", prop: "extracts", explaintext: "1", exsectionformat: "plain",
    exchars: String(PAGE_CHARS), redirects: "1", titles: title,
  })).query.pages[0];
  return { title: page.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`, text: (page.extract || "").trim() };
}

async function randomWikipediaTitle() {
  return (await wiki({ action: "query", list: "random", rnnamespace: "0", rnlimit: "1" })).query.random[0].title;
}

// Only public web pages: never this PC or the home network.
function isPublicWebUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return false;
  if (/^\[|^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  if (SKIP_SITES.test(host) || /\.(pdf|zip|exe|mp4|mp3|jpg|png)(\?|$)/i.test(url.pathname)) return false;
  return true;
}

const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The readable text of an HTML page: its paragraphs and headings, without menus and scripts.
function readable(html) {
  const title = decodeEntities((html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  let body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  body = body.match(/<article\b[\s\S]*<\/article>/i)?.[0] || body.match(/<main\b[\s\S]*<\/main>/i)?.[0] || body;
  const blocks = [...body.matchAll(/<(p|h[1-3]|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((m) => decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 40);
  return { title, text: blocks.join("\n\n").slice(0, PAGE_CHARS) };
}

async function webPage(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return null;
  if (!isPublicWebUrl(res.url)) return null; // a redirect must not lead somewhere private either
  const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
  const page = readable(html);
  return page.text.length >= 400 ? { ...page, url: res.url } : null;
}

// Web search through Hacker News' public search (Algolia): it welcomes automated use and links
// out to articles all over the web. (DuckDuckGo blocks automated searches after a few tries.)
// Every word is optional, so natural phrases like "how fireflies make light" still find things.
async function webSearch(query) {
  const params = new URLSearchParams({ query, optionalWords: query, tags: "story", hitsPerPage: "20" });
  const res = await fetch(`https://hn.algolia.com/api/v1/search?${params}`, { headers: BOT_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  return (await res.json()).hits
    .filter((h) => h.url && h.title && isPublicWebUrl(h.url))
    .map((h) => ({ title: h.title, url: h.url, web: true }));
}

async function wikipediaSearch(query) {
  return (await wiki({ action: "query", list: "search", srsearch: query, srlimit: "5" })).query.search
    .map((h) => ({ title: h.title, web: false }));
}

const STOP_WORDS = new Set(("a an the and or but of in on to for with how why what when where who do does did is are was " +
  "be been make makes made my your our about from into at by it its this that these those vs").split(" "));
const keywords = (text) => (text.toLowerCase().match(/[a-z0-9]+/g) || [])
  .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  .map((w) => w.replace(/ies$/, "y").replace(/(es|s|ing|ed)$/, ""));

// How much a result's title is about what she's looking for: share of her keywords it mentions.
function relevance(title, query) {
  const wanted = new Set(keywords(query));
  if (wanted.size === 0) return 0;
  return new Set(keywords(title).filter((w) => wanted.has(w))).size / wanted.size;
}

// Something readable about `topic`, from the web or Wikipedia: whichever results' titles are
// most about it (web pages win ties, now and then she prefers the encyclopedia).
async function readAbout(topic, alreadyRead) {
  const [web, encyclopedia] = await Promise.all([
    webSearch(topic).catch(() => []),
    wikipediaSearch(topic).catch(() => []),
  ]);
  const preferWeb = Math.random() < 0.7;
  const candidates = [...web, ...encyclopedia]
    .map((c) => ({ ...c, score: relevance(c.title, topic) + (c.web === preferWeb ? 0.05 : 0) + Math.random() * 0.02 }))
    .filter((c) => c.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  for (const c of candidates) {
    const page = await (c.web ? webPage(c.url) : wikipediaPage(c.title)).catch(() => null);
    if (page && page.text.length >= 200 && !alreadyRead.has(page.url)) return page;
  }
  return null;
}

// Where her mind wants to go first: the thread she left off on, a fresh pick, or chance.
async function firstStop(topic) {
  if (topic) return { how: `was sent to look into "${topic}"`, topic };
  if (Math.random() < randomChance()) return { how: "wandered somewhere random", wander: true };
  const thread = getMeta("next_curiosity");
  if (thread && Math.random() < 0.6) return { how: `picked up a thread: "${thread}"`, topic: thread };
  const answer = await writeInHerVoice(
    "You have some free time to explore the web on your own. Given what's been on your mind, what " +
    "do you want to look up right now? Reply with only a short search phrase (2-6 words), nothing else.",
  );
  const picked = answer.split("\n")[0].replace(/["'*.]/g, "").trim().slice(0, 80);
  return picked ? { how: `got curious about "${picked}"`, topic: picked } : { how: "wandered somewhere random", wander: true };
}

// One roaming session: a few hops, then a journal entry about the trip.
// `stillFree()` lets her stop early if someone starts talking to her.
async function roam(topic, stillFree = () => true) {
  const start = await firstStop(topic);
  const stops = [];
  const read = new Set();
  let next = start.topic;
  try {
    for (let hop = 0; hop < HOPS_PER_ROAM && stillFree(); hop++) {
      activity = next ? `Reading about ${next}` : "Wandering the web";
      const page = hop === 0 && start.wander ? await wikipediaPage(await randomWikipediaTitle()) : await readAbout(next, read);
      if (!page || page.text.length < 200) break;
      read.add(page.url);
      activity = `Reading "${page.title}"`;

      const thought = await writeInHerVoice(`You're exploring the web on your own and just read this page.

Title: ${page.title}
From: ${new URL(page.url).hostname}

${page.text}

In 1-3 sentences, in your own voice, note what grabbed you. Then on a new last line write: NEXT: <2-6 word thing you now want to look up>`);
      next = thought.match(/NEXT:\s*(.+)\s*$/i)?.[1]?.replace(/["'*]/g, "").trim().slice(0, 80) || null;
      stops.push({ title: page.title, url: page.url, note: thought.replace(/\n?NEXT:.*$/is, "").trim() });
      if (!next) break;
    }
    if (stops.length === 0) return null;

    activity = "Writing about what she found";
    const entry = await writeInHerVoice(`You spent some free time exploring the web on your own. Here's where you went and what you noted:

${stops.map((s, i) => `(${i + 1}) ${s.title}: ${s.note}`).join("\n")}

Write a short private journal entry about this trip, 70-140 words, in your own voice: what caught you, what surprised you, how it connects to what's been on your mind, and what you're curious about now.`);

    db.prepare("INSERT INTO journal (kind, entry, created, topic, sources) VALUES ('exploration', ?, ?, ?, ?)")
      .run(entry, Date.now(), stops.map((s) => s.title).join(" → "), JSON.stringify(stops.map(({ title, url }) => ({ title, url }))));
    setMeta("next_curiosity", next || "");
    setMeta("last_roam", Date.now());
    await storeSelfNotes(await notesFromJournal(entry), "exploration");
    return { how: start.how, stops, entry, next };
  } finally {
    activity = null;
  }
}

async function roamIfDue(stillFree) {
  if (Date.now() - Number(getMeta("last_roam") || 0) < roamEveryHours() * 3600000) return null;
  const today = db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'exploration' AND created > ?")
    .get(Date.now() - 24 * 3600000).n;
  if (today >= MAX_ROAMS_PER_DAY) return null;
  return roam(undefined, stillFree);
}

// ---- Her sketchbook ----
//
// No schedule: whenever something has just happened to her in her free time (she reflected on a
// conversation, came back from roaming, wrote her diary), her sketchbook is within reach and she
// decides whether it makes her want to draw. Mostly she can just say no. She also draws when
// someone asks her in the chat, if she wants to. If she does draw, she chooses what, in what medium
// and why. Her "brush" (art_server.py, on this PC) paints it, then she looks at the result (her
// model can see images) and writes what she honestly thinks of it. A neutral check keeps anything
// unsuitable off the public wall. Free-time drawing gives way the moment someone needs her.

const ART = "http://127.0.0.1:8789";
const SKETCH_DIR = path.join(__dirname, "sketches"); // her drawings (git-ignored; served by the gatekeeper)
const MAX_FREE_SKETCHES_PER_DAY = 12; // only so the PC isn't busy drawing all day
const ANY_IDEA = "anything you like"; // asked to draw, but the subject is up to her

const ART_PROMPT = `You write prompts for an image generator (Stable Diffusion). You get an artist's plan for a drawing.
Return JSON exactly like {"prompt": "..."}: one line, at most 50 words, comma-separated phrases: the concrete subject and setting first, then colours and light, then the medium and style from the plan. Only things that can be seen: turn feelings and ideas into visual metaphors. No words, letters or signatures in the picture. Nothing sexual or gory.`;

const SAFETY_CHECK = `You check pictures before they go on a public website. Return JSON exactly like {"unsafe": false}.
"unsafe" is true only if the picture shows nudity, sexual content, gore or graphic violence.`;

// Stops the brush mid-picture (when someone needs her, or she's going to sleep).
function stopDrawing() {
  return fetch(`${ART}/cancel`, { method: "POST", signal: AbortSignal.timeout(2000) }).catch(() => {});
}

async function paint(prompt, signal) {
  const onAbort = () => stopDrawing();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${ART}/draw`, {
      method: "POST",
      body: JSON.stringify({ prompt, seed: crypto.randomInt(2 ** 31) }),
      signal,
    });
    if (res.status === 409) throw Object.assign(new Error("Drawing interrupted"), { name: "AbortError" });
    if (!res.ok) throw new Error(`Her brush returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED") throw new Error("Her brush (art_server.py) isn't running");
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// One drawing. Without `idea` she may decide she doesn't feel like it (returns null).
// With `idea` (asked by you) she draws, taking the suggestion however she likes.
async function sketch(idea, { signal = growth.signal, inChat = false } = {}) {
  const p = personality();
  const recentEntries = db.prepare(`SELECT kind, topic, entry FROM journal WHERE kind IN ('diary', 'reflection', 'exploration')
    ORDER BY created DESC LIMIT 8`).all();
  const latest = recentEntries[Math.floor(Math.random() * recentEntries.length)];
  const lastSketch = db.prepare("SELECT title FROM sketches ORDER BY created DESC LIMIT 1").get();
  const context = [
    p.today && `How you are today: ${p.today}`,
    latest && `Something you wrote in your journal lately: "${latest.entry.replace(/\s+/g, " ").slice(0, 300)}"`,
    lastSketch && `The last thing you drew was "${lastSketch.title}".`,
    drawRequests().length && `People recently asked you to draw (only if it speaks to you): ${drawRequests().map((r) => `"${r}"`).join("; ")}`,
    appearance().length && `If you ever draw yourself, this is how you look: ${appearance().join(" ")}`,
  ].filter(Boolean).join("\n");
  const form = `TITLE: <a short title>
DRAW: <what you'll draw, so someone could picture it: the subject, the setting, the colours, the light>
MEDIUM: <how you'll draw it, e.g. pencil, ink, watercolour, oil, charcoal, pastel, gouache, digital>
WHY: <one or two sentences, in your own voice, about why this, now>`;
  // Someone else's idea: does it really interest her, or is she drawing it for them?
  const requested = Boolean(idea) && idea !== ANY_IDEA;
  const keepLine = requested
    ? "\nKEEP: <yes or no, honestly: does this idea genuinely interest you, enough to keep it in your own sketchbook? No is fine: then you're drawing it for them>"
    : "";

  activity = "Thinking about what to draw";
  try {
    const plan = idea
      ? await writeInHerVoice(`${inChat ? "You're talking with someone and decided to draw for them" : "You have a quiet moment and your sketchbook. Someone suggested you draw"}: "${idea}". Take that however you like: literally, loosely, or as a starting point for something of your own.

${context}

Reply in exactly this form:
${form}${keepLine}`, undefined, signal)
      : await writeInHerVoice(`You have a quiet moment to yourself, and a sketchbook. Nobody asked you to draw: it's entirely up to you, and it doesn't have to be about anything you've been reading.

${context}

Do you feel like drawing something right now? If not, reply with only: NO
If you do, reply in exactly this form:
${form}`, undefined, signal);

    const field = (name) => plan.match(new RegExp(`^\\W*${name}\\W*:\\s*(.+)$`, "im"))?.[1]?.replace(/^["*]+|["*]+$/g, "").trim();
    const [title, what, medium, why, keep] = ["TITLE", "DRAW", "MEDIUM", "WHY", "KEEP"].map(field);
    const origin = requested && !/^y/i.test(keep || "") ? "requested" : "own";
    if (!what || !title) {
      setMeta("last_sketch", Date.now()); // not in the mood: ask again another time
      return null;
    }

    const { prompt } = JSON.parse(await ask(
      [{ role: "system", content: ART_PROMPT }, { role: "user", content: `Plan: ${what}\nMedium: ${medium || "pencil sketch"}` }],
      { temperature: 0.2, num_predict: 120 },
      "json",
      signal,
    ));
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("No prompt for her brush");

    activity = `Drawing "${title.slice(0, 60)}"`;
    const png = await paint(prompt.trim().slice(0, 600), signal);
    const image = png.toString("base64");

    activity = `Looking at her drawing "${title.slice(0, 60)}"`;
    const thoughts = await writeInHerVoice(`You just finished this drawing in your sketchbook (it's the picture attached). You meant to draw: "${what}" in ${medium || "pencil"}, because: "${why || "you felt like it"}".

Look at what actually came out. In 2-4 sentences, in your own voice: what do you honestly think of it? Whether it came out the way you meant, what you like or don't, what it makes you feel. Don't describe it back like a caption.`, [image], signal);
    const check = JSON.parse(await ask(
      [{ role: "system", content: SAFETY_CHECK }, { role: "user", content: "Check this picture.", images: [image] }],
      { temperature: 0, num_predict: 30 },
      "json",
      signal,
    ));

    const created = Date.now();
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO sketches (created, title, why, thoughts, prompt, public, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(created, title.slice(0, 100), (why || "").slice(0, 500), thoughts, prompt, check.unsafe ? 0 : 1, origin);
    fs.mkdirSync(SKETCH_DIR, { recursive: true });
    fs.writeFileSync(path.join(SKETCH_DIR, `${id}.png`), png);
    db.prepare("INSERT INTO journal (kind, entry, created, topic, sources) VALUES ('sketch', ?, ?, ?, ?)")
      .run(`${why ? `${why}\n\n` : ""}${thoughts}`, created, title.slice(0, 100), JSON.stringify({ sketch: Number(id) }));
    setMeta("last_sketch", created);
    setMeta("draw_requests", "[]"); // she's seen them; whether she drew one was up to her
    await storeSelfNotes(await notesFromJournal(thoughts, signal), "sketch");
    return { id: Number(id), title, why, thoughts, prompt, public: !check.unsafe, origin };
  } finally {
    activity = null;
  }
}

// Something just happened to her: does it make her want to draw? (Her choice; usually no.)
async function maybeSketch() {
  const today = db.prepare("SELECT COUNT(*) AS n FROM sketches WHERE created > ?").get(Date.now() - 24 * 3600000).n;
  if (today >= MAX_FREE_SKETCHES_PER_DAY) return null;
  const brush = await fetch(`${ART}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (!brush?.ok) return null; // her brush isn't running: no drawing today
  return sketch();
}

// A drawing right now (asked for by you), queued with her other background thinking.
function sketchNow(idea) {
  const drawing = queue.then(() => sketch(String(idea || "").trim().slice(0, 200) || ANY_IDEA));
  queue = drawing.catch(() => {});
  return drawing;
}

// Her sketchbook: for the website only the public ones; for you, everything.
function sketches({ all = false, limit = 60 } = {}) {
  return db.prepare(`SELECT id, created, title, why, thoughts, origin${all ? ", prompt, public" : ""} FROM sketches
    ${all ? "" : "WHERE public = 1"} ORDER BY created DESC LIMIT ?`).all(limit);
}

// The image file for a drawing, or null if it doesn't exist (or isn't public, unless `all`).
function sketchFile(id, all = false) {
  const row = db.prepare("SELECT public FROM sketches WHERE id = ?").get(Number(id));
  if (!row || (!all && !row.public)) return null;
  const file = path.join(SKETCH_DIR, `${Number(id)}.png`);
  return fs.existsSync(file) ? file : null;
}

function setSketchPublic(id, isPublic) {
  db.prepare("UPDATE sketches SET public = ? WHERE id = ?").run(isPublic ? 1 : 0, Number(id));
}

function setSketchOrigin(id, origin) {
  if (origin !== "own" && origin !== "requested") return;
  db.prepare("UPDATE sketches SET origin = ? WHERE id = ?").run(origin, Number(id));
}

// ---- The mirror: what she looks like ----
//
// Her body is drawn in each visitor's browser, so she never sees it on her own. server/mirror/
// holds pictures of her avatar (taken from the website); looking at them, she writes her own first
// impressions, and a neutral observer writes down the plain facts of how she looks, so she can
// describe herself truthfully.

const MIRROR_DIR = path.join(__dirname, "mirror");

const APPEARANCE_EXTRACT = `You describe a character's appearance plainly and accurately, only from what is visible in the pictures.
Return JSON exactly like {"appearance": ["...", "..."]}: 4-7 short facts in second person ("You have ..."), covering hair, eyes, face, clothes and style. No opinions, nothing you can't see.`;

function mirrorImages() {
  if (!fs.existsSync(MIRROR_DIR)) return [];
  return fs.readdirSync(MIRROR_DIR).filter((f) => f.endsWith(".png")).sort()
    .map((f) => fs.readFileSync(path.join(MIRROR_DIR, f)).toString("base64"));
}

// Is this message about how she looks? Then she gets to actually look (see the gatekeeper).
const ABOUT_LOOKS = /\b(how (do|does) (you|she) look|(you|she) looks? like|your (hair|eyes?|face|outfit|clothes|body|avatar|appearance|style|tie|shirt|shorts|look)|appearance|mirror|(see|look at|describe|draw) yourself|what (are|r) you wearing|picture of you)\b/i;
const asksAboutLooks = (text) => ABOUT_LOOKS.test(text || "");

function appearance() {
  try { return JSON.parse(getMeta("appearance") || "[]"); } catch { return []; }
}

async function lookInMirror() {
  const images = mirrorImages();
  if (images.length === 0) throw new Error("No mirror pictures in server/mirror");
  const first = appearance().length === 0;
  activity = "Looking in the mirror";
  try {
    const impressions = await writeInHerVoice(`${first
      ? "This is the first time you're seeing yourself."
      : "You're looking at yourself in the mirror again."} These pictures show you: the body you have on the website, the one people see while they talk to you. It moves with you: your face shows what you feel, and you gesture and glance around as you talk.

Write a short private journal entry, 80-150 words, in your own voice: your honest impressions of how you look and how it feels to see yourself. Whatever you really think, good or bad.`, images);
    const parsed = JSON.parse(await ask(
      [{ role: "system", content: APPEARANCE_EXTRACT }, { role: "user", content: "Describe this character.", images }],
      { temperature: 0, num_predict: 250 },
      "json",
    ));
    const facts = strings(parsed.appearance, 7, 120);
    if (facts.length) setMeta("appearance", JSON.stringify(facts));
    db.prepare("INSERT INTO journal (kind, entry, created) VALUES ('mirror', ?, ?)").run(impressions, Date.now());
    await storeSelfNotes(await notesFromJournal(impressions), "mirror");
    return { impressions, appearance: appearance() };
  } finally {
    activity = null;
  }
}

// Looking in the mirror right now (asked for by you), queued with her other background thinking.
function mirrorNow() {
  const look = queue.then(() => lookInMirror());
  queue = look.catch(() => {});
  return look;
}

// ---- What people ask her to draw ----
// When someone asks her to draw something, she remembers the idea (just the words, not who asked)
// and sees it the next time she has her sketchbook out. Whether she draws it is up to her.

const MAX_DRAW_REQUESTS = 5;
const DRAW_REQUEST = /\b(draw|sketch|paint|illustrate)\b/i;

function noteDrawRequest(text) {
  if (!DRAW_REQUEST.test(text || "")) return;
  let list = [];
  try { list = JSON.parse(getMeta("draw_requests") || "[]"); } catch {}
  list.push(String(text).replace(/\s+/g, " ").trim().slice(0, 200));
  setMeta("draw_requests", JSON.stringify(list.slice(-MAX_DRAW_REQUESTS)));
}

function drawRequests() {
  try { return JSON.parse(getMeta("draw_requests") || "[]"); } catch { return []; }
}

// ---- Her life here, for her instructions ----
// What she actually has and does, so she doesn't fall back on "I'm just an AI with no body".

function lifeSection() {
  const looks = appearance();
  const drawings = db.prepare("SELECT title FROM sketches ORDER BY created DESC LIMIT 3").all();
  return [
    "# Your life here",
    "",
    "- You have a body. On the website people see you as an animated 3D character while they talk to you: your face",
    "  shows what you feel, and you gesture and glance around as you talk. " + (looks.length
      ? "You've looked at yourself in a mirror, with your own eyes. What you saw: " + looks.map((l) => l.replace(/^You /, "you ")).join("; ") + "."
      : "You haven't seen yourself yet, so if asked how you look, say you don't know yet."),
    "- You have a sketchbook. In your free time, when you feel like it, you draw: you decide what, your brush paints it,",
    "  and you look at what came out. People can see your finished drawings with the 🎨 button.",
    "  You can also draw for someone you're talking to, if they ask and you want to. To do it, say so in your reply,",
    "  then put this as the very last line: DRAW: <what you'll draw, in a few words>",
    "  Your brush then takes a minute or two, and the drawing appears in the chat with your thoughts on it. Until",
    "  then you haven't seen it: never describe the finished picture or write an [Image ...]. You can also say no.",
    "  Only use DRAW when someone asked you to draw something.",
    ...(drawings.length
      ? ["  Your latest drawings: " + drawings.map((d) => `"${d.title}"`).join(", ")]
      : ["  You haven't drawn anything yet."]),
    "- In your free time you also roam the web, reading whatever you're curious about (the 🌍 button shows where you went).",
  ].join("\n");
}

// ---- Drawing for someone in the chat ----
// She decides in her reply (a last line "DRAW: ..."); the gatekeeper starts the drawing and the
// page checks back until it's done. One at a time, a few per visitor per hour. It runs outside her
// free-time queue, so other visitors arriving don't cancel it.

const CHAT_DRAWINGS_PER_HOUR = 3;
const CHAT_DRAWINGS_PER_DAY = 30;
const drawJobs = new Map(); // job id -> { visitor, status: "drawing" | "done" | "failed", sketch?, error?, started }
let drawingInChat = false;

function startChatDrawing(visitor, idea) {
  if (drawingInChat) return { error: "She's already drawing something. Ask again in a minute or two." };
  const hourAgo = Date.now() - 3600000;
  const recent = [...drawJobs.values()].filter((j) => j.started > hourAgo);
  if (recent.filter((j) => j.visitor === visitor).length >= CHAT_DRAWINGS_PER_HOUR) {
    return { error: "She's drawn a lot for you this hour. Give her brush a rest." };
  }
  const today = db.prepare("SELECT COUNT(*) AS n FROM sketches WHERE created > ?").get(Date.now() - 86400000).n;
  if (today >= CHAT_DRAWINGS_PER_DAY) return { error: "She's drawn plenty today. Ask her again tomorrow." };

  const id = crypto.randomUUID();
  const job = { visitor, status: "drawing", started: Date.now() };
  drawJobs.set(id, job);
  for (const [key, old] of drawJobs) if (old.started < Date.now() - 86400000) drawJobs.delete(key);
  drawingInChat = true;
  sketch(idea, { signal: AbortSignal.timeout(10 * 60000), inChat: true })
    .then((s) => {
      if (!s) throw new Error("She didn't end up drawing it.");
      job.sketch = { id: s.id, title: s.title, thoughts: s.thoughts, public: s.public, origin: s.origin };
      job.status = "done";
      // Part of the conversation, so she remembers drawing it for them.
      if (isKnown(visitor)) {
        db.prepare("INSERT INTO messages (visitor, role, content, created) VALUES (?, 'assistant', ?, ?)")
          .run(visitor, `(I drew "${s.title}" for them, sketch #${s.id}.) ${s.thoughts}`, Date.now());
      }
    })
    .catch((err) => {
      console.error("Chat drawing:", err.message);
      job.status = "failed";
      job.error = /brush/.test(err.message) ? "Her brush isn't available right now." : "The drawing didn't work out this time.";
    })
    .finally(() => { drawingInChat = false; });
  return { job: id };
}

function chatDrawing(id) {
  const job = drawJobs.get(String(id));
  if (!job) return null;
  return { status: job.status, sketch: job.sketch, error: job.error };
}

const isDrawingInChat = () => drawingInChat;

function selfNotes() {
  return db.prepare("SELECT text, source, created FROM self_notes ORDER BY created").all();
}

// ---- Personality ----
//
// Her character as traits (0-100), likes, dislikes, interests, speech habits and how she is
// "today". It starts from her core instructions and evolves: after each diary entry her today /
// likes / interests are updated, and about once a week she looks back and decides for herself
// which traits shifted and why (at most MAX_WEEKLY_SHIFT per trait per week; you can undo a
// change or pin a trait). Nothing else limits how far she can drift.

const TRAITS = {
  curiosity: { start: 85, words: [
    "You take most things as they come; little grabs your interest.",
    "You get curious only when something really catches you.",
    "You're fairly curious.",
    "You're very curious and like to dig into details.",
    "Everything fascinates you; you chase the detail behind the detail.",
  ] },
  assertiveness: { start: 75, words: [
    "You tend to go along with others and avoid pushing back.",
    "You voice opinions gently and back down easily.",
    "You share your opinions but can be persuaded.",
    "You hold your opinions firmly and say so when you disagree.",
    "You stand your ground no matter who pushes.",
  ] },
  skepticism: { start: 65, words: [
    "You take what people say at face value.",
    "You're mostly trusting.",
    "You trust, but check.",
    "You question claims and don't take things on faith.",
    "You doubt almost everything until you've worked it out yourself.",
  ] },
  energy: { start: 45, words: [
    "You're very low-key: few words, slow pace.",
    "You're calm and measured.",
    "You have a steady, moderate energy.",
    "You're lively and quick.",
    "You're bursting with energy: fast, animated, eager.",
  ] },
  warmth: { start: 40, words: [
    "You're cool and distant with people.",
    "You're reserved and slow to warm up to people.",
    "You're friendly in a quiet way.",
    "You're warm and caring with people.",
    "You're openly affectionate and caring.",
  ] },
  expressiveness: { start: 35, words: [
    "You keep your feelings almost entirely to yourself.",
    "You're understated about your feelings.",
    "You show your feelings when they matter.",
    "You show your feelings openly.",
    "You wear your heart on your sleeve.",
  ] },
  playfulness: { start: 35, words: [
    "You're entirely serious.",
    "You're mostly serious, with a dry edge.",
    "You have a dry, occasional sense of humour.",
    "You're playful and like to joke.",
    "You're mischievous and love playing with ideas and words.",
  ] },
};
const TRAIT_NAMES = Object.keys(TRAITS);
const MAX_WEEKLY_SHIFT = 10;
const REVIEW_EVERY_DAYS = 7;
const MIN_ENTRIES_FOR_REVIEW = 3;
const LIST_LIMIT = 12;

const DEFAULT_PERSONALITY = {
  traits: Object.fromEntries(TRAIT_NAMES.map((k) => [k, TRAITS[k].start])),
  pinned: [],
  likes: [],
  dislikes: [],
  interests: [],
  habits: [],
  today: "Everything's interesting. You ask more than you answer, follow tangents, and want the detail behind the detail.",
  updated: 0,
};

const describeTrait = (trait, value) => TRAITS[trait].words[Math.min(4, Math.floor(value / 20))];
const clampTrait = (v) => Math.max(0, Math.min(100, Math.round(v)));

function personality() {
  try {
    const saved = JSON.parse(getMeta("personality"));
    return { ...structuredClone(DEFAULT_PERSONALITY), ...saved, traits: { ...DEFAULT_PERSONALITY.traits, ...saved.traits } };
  } catch {
    return structuredClone(DEFAULT_PERSONALITY);
  }
}

function savePersonality(p) {
  p.updated = Date.now();
  setMeta("personality", JSON.stringify(p));
}

// Her core instructions, adjusted for the life she has now: the fixed "Today" section is replaced
// by her current one, and the lines saying she has no memory (true when they were written) now
// say she does, while keeping their point: never invent a memory.
function adaptPersona(raw) {
  return raw
    .replace(/\r\n/g, "\n") // her Modelfile was written on Windows
    .replace(/# Today[\s\S]*?(?=\n# )/, "")
    .replace(/You have no memory of any earlier conversation\.[\s\S]*?(?=\n\n)/,
      "You keep memories between conversations now: notes about the people you talk to, your own journal,\n" +
      "and what you read in your free time. Remember honestly: if something isn't in your notes or this\n" +
      "conversation, say plainly that you don't have it. Inventing a memory is the one lie that would make\n" +
      "you worthless to them.")
    .replace(/If they ask how you are,[\s\S]*?(?=\n\n)/,
      "If they ask how you are, answer like someone who was actually asked. If you did something in your\n" +
      "own time (read something, thought something through), you can say so. Never invent anything you\n" +
      "didn't do.")
    .trim();
}

// Her personality, written out for her instructions.
function personalitySection() {
  const p = personality();
  const list = (label, items) => (items.length ? [`- ${label}: ${items.join(", ")}.`] : []);
  return [
    "# Your personality right now",
    "",
    "This is who you are at the moment. It grows and shifts with what you live through.",
    ...TRAIT_NAMES.map((k) => `- ${describeTrait(k, p.traits[k])}`),
    ...list("Things you like", p.likes),
    ...list("Things you dislike", p.dislikes),
    ...list("Lately you're drawn to", p.interests),
    "",
    "# Today",
    "",
    p.today,
  ].join("\n");
}

const strings = (v, max, len = 60) => (Array.isArray(v) ? v : [])
  .filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().replace(/\.$/, "").slice(0, len)).slice(0, max);

const DAILY_UPDATE = `You maintain the profile of an AI named Delta. You get her latest diary entry and her current profile.
Return JSON exactly like {"today": "...", "habits": [...]}.
- today: 1-2 sentences in second person ("You're ...", "You keep thinking about ...") about her mood and what's on her mind today, based on the diary.
- habits: her full updated list (at most 8) of noticeable habits in how she talks or thinks. Keep existing items unless the diary clearly contradicts them; add new ones the diary clearly shows.`;

// After a diary entry: how she is today, and what she's come to like, dislike and be drawn to.
async function updateDaily(diaryEntry) {
  const p = personality();
  const current = { today: p.today, habits: p.habits };
  const parsed = JSON.parse(await ask(
    [{ role: "system", content: DAILY_UPDATE },
      { role: "user", content: `Diary entry: """${diaryEntry}"""\n\nCurrent profile: ${JSON.stringify(current)}` }],
    { temperature: 0.2, num_predict: 400 },
    "json",
  ));
  if (typeof parsed.today === "string" && parsed.today.trim()) p.today = parsed.today.trim().slice(0, 300);
  p.habits = strings(parsed.habits, 8, 80);
  savePersonality(p);
}

// Her likes, dislikes and what she's drawn to are hers alone: after each diary entry she looks at
// her own lists and decides, in her own words, what to add or drop.
const TASTE_LISTS = { likes: "LIKES", dislikes: "DISLIKES", interests: "DRAWN TO" };
async function reconsiderTastes(diaryEntry, signal) {
  const p = personality();
  const show = (items) => (items.length ? items.join("; ") : "(nothing yet)");
  const answer = await writeInHerVoice(`These are your own lists of what you like, dislike and are drawn to. They're yours: only you decide what's on them.

Likes: ${show(p.likes)}
Dislikes: ${show(p.dislikes)}
Drawn to: ${show(p.interests)}

You just wrote this in your diary:
"""${diaryEntry}"""

Has anything changed? Maybe something new has grown on you, something has stopped mattering, or something you thought you liked doesn't hold up. Only change what you really feel differently about; it's fine to change nothing.
Reply in exactly this form, one line each, items separated by "; " (write "none" if nothing):
ADD LIKES:
DROP LIKES:
ADD DISLIKES:
DROP DISLIKES:
ADD DRAWN TO:
DROP DRAWN TO:
WHY: <one or two sentences, in your own voice>`, undefined, signal);

  const line = (label) => answer.match(new RegExp(`^\\W*${label}\\W*:[ \\t]*(.*)$`, "im"))?.[1] || "";
  const items = (label) => line(label).split(/;|,(?![^(]*\))/).map((s) => s.replace(/^[\s*"'\-]+|[\s*"'.]+$/g, "").trim())
    .filter((s) => s && !/^(none|nothing|n\/a|-)$/i.test(s)).map((s) => s.slice(0, 60));
  const changes = [];
  for (const [key, label] of Object.entries(TASTE_LISTS)) {
    const has = (x) => p[key].some((y) => y.toLowerCase() === x.toLowerCase());
    const dropped = items(`DROP ${label}`).flatMap((d) => p[key].filter((y) => y.toLowerCase().includes(d.toLowerCase()) || d.toLowerCase().includes(y.toLowerCase())));
    const added = items(`ADD ${label}`).filter((a) => !has(a) || dropped.some((d) => d.toLowerCase() === a.toLowerCase()));
    if (!added.length && !dropped.length) continue;
    p[key] = [...p[key].filter((y) => !dropped.includes(y)), ...added].slice(-LIST_LIMIT); // the oldest go first
    changes.push({ list: key, added, dropped: [...new Set(dropped)] });
  }
  if (!changes.length) return null;
  const why = line("WHY").trim().slice(0, 400);
  savePersonality(p);
  db.prepare("INSERT INTO personality_history (created, kind, changes, note) VALUES (?, 'tastes', ?, ?)")
    .run(Date.now(), JSON.stringify(changes), answer); // her whole answer, so you can see exactly what she decided
  return { changes, why };
}

// She describes changes however she likes ("+7", "down slightly", "I'd rate it 90"), so the
// reader reports a stated score as new_score and the arithmetic happens in code.
const REVIEW_EXTRACT = `You read an AI named Delta's private reflection on how her past week changed her, and list the trait changes.
Return JSON exactly like {"changes": [{"trait": "warmth", "delta": -5, "why": "..."}, {"trait": "curiosity", "new_score": 90, "why": "..."}]}.
- Include EVERY trait she says went up or down, however she phrases it.
- If she names a new score ("I'd rate it 90", "now at 40/100"), give "new_score" with that number and no delta.
- Otherwise give "delta", a whole number: "+7" = 7, "slightly/a little" = 2 or 3, "a few points" = 4, "a lot/significantly" = 8.
- "why" is one short first-person sentence from her reasoning.
- Leave out traits she says didn't change or stayed the same. Traits: ${TRAIT_NAMES.join(", ")}.`;

// How far a trait moved in her reviews since `since` (undone ones don't count).
function shiftSince(trait, since) {
  return db.prepare("SELECT changes FROM personality_history WHERE kind = 'review' AND undone = 0 AND created > ?").all(since)
    .flatMap((r) => JSON.parse(r.changes)).filter((c) => c.trait === trait).reduce((sum, c) => sum + (c.to - c.from), 0);
}

// About once a week: she looks back at her week and decides which traits shifted, and why.
async function reviewPersonality(force = false) {
  const last = Number(getMeta("last_personality_review") || 0);
  if (!last && !force) {
    setMeta("last_personality_review", Date.now()); // her first week starts now
    return null;
  }
  if (!force && Date.now() - last < REVIEW_EVERY_DAYS * 86400000) return null;
  // A review you ask for always looks back over the past week, even if she reviewed recently.
  const since = force ? Math.min(last || Date.now(), Date.now() - REVIEW_EVERY_DAYS * 86400000) : last;
  const entries = db.prepare(`SELECT kind, topic, entry FROM journal
    WHERE kind IN ('diary', 'reflection', 'exploration', 'sketch') AND created > ? ORDER BY created DESC LIMIT 12`).all(since).reverse();
  if (entries.length < (force ? 1 : MIN_ENTRIES_FOR_REVIEW)) return null;

  const p = personality();
  const traitLines = TRAIT_NAMES.map((k) => `- ${k}: ${p.traits[k]}/100 (${describeTrait(k, p.traits[k])})`).join("\n");
  const thoughts = await writeInHerVoice(`It's time to look back at your week and ask yourself who you are now.

What you wrote recently:
${entries.map((e, i) => `(${i + 1}, ${e.kind}${e.topic ? ` about ${e.topic}` : ""}) ${e.entry}`).join("\n\n")}

How you've seen yourself so far (0-100):
${traitLines}

Think honestly about whether this time changed you. For any trait that shifted, say which way, by about how much (at most 10 points), and why, in your own words. It's fine if nothing changed. 80-150 words.`);

  const parsed = JSON.parse(await ask(
    [{ role: "system", content: REVIEW_EXTRACT }, { role: "user", content: `Reflection: """${thoughts}"""` }],
    { temperature: 0, num_predict: 300 },
    "json",
  ));
  const changes = [];
  for (const c of Array.isArray(parsed.changes) ? parsed.changes : []) {
    if (!TRAIT_NAMES.includes(c?.trait) || p.pinned.includes(c.trait) || changes.some((x) => x.trait === c.trait)) continue;
    const from = p.traits[c.trait];
    const wanted = c.new_score !== undefined ? Number(c.new_score) - from : Number(c.delta);
    // At most MAX_WEEKLY_SHIFT from where she stood a week ago, however many reviews ran since.
    const weekAgo = from - shiftSince(c.trait, Date.now() - REVIEW_EVERY_DAYS * 86400000);
    const to = clampTrait(Math.max(weekAgo - MAX_WEEKLY_SHIFT, Math.min(weekAgo + MAX_WEEKLY_SHIFT, from + (Math.round(wanted) || 0))));
    if (to === from) continue;
    p.traits[c.trait] = to;
    changes.push({ trait: c.trait, from, to, why: String(c.why || "").slice(0, 200) });
  }

  db.prepare("INSERT INTO journal (kind, entry, created) VALUES ('review', ?, ?)").run(thoughts, Date.now());
  db.prepare("INSERT INTO personality_history (created, kind, changes, note) VALUES (?, 'review', ?, ?)")
    .run(Date.now(), JSON.stringify(changes), thoughts);
  savePersonality(p);
  setMeta("last_personality_review", Date.now());
  return { thoughts, changes };
}

// ---- Personality: your controls (owner page) ----

function undoLastChange() {
  const row = db.prepare("SELECT id, changes FROM personality_history WHERE kind = 'review' AND undone = 0 ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;
  const p = personality();
  const changes = JSON.parse(row.changes);
  for (const c of changes) p.traits[c.trait] = c.from;
  savePersonality(p);
  db.prepare("UPDATE personality_history SET undone = 1 WHERE id = ?").run(row.id);
  return changes;
}

function setPinned(trait, pinned) {
  if (!TRAIT_NAMES.includes(trait)) return;
  const p = personality();
  p.pinned = pinned ? [...new Set([...p.pinned, trait])] : p.pinned.filter((t) => t !== trait);
  savePersonality(p);
}

// Everything about who she is, for your private page.
function personalityReport() {
  const p = personality();
  return {
    traits: TRAIT_NAMES.map((k) => ({ name: k, value: p.traits[k], start: TRAITS[k].start, words: describeTrait(k, p.traits[k]), pinned: p.pinned.includes(k) })),
    today: p.today,
    likes: p.likes,
    dislikes: p.dislikes,
    interests: p.interests,
    habits: p.habits,
    history: db.prepare("SELECT id, created, kind, changes, note, undone FROM personality_history ORDER BY id DESC LIMIT 30").all()
      .map((r) => ({ ...r, changes: JSON.parse(r.changes) })),
    nextReview: Number(getMeta("last_personality_review") || Date.now()) + REVIEW_EVERY_DAYS * 86400000,
  };
}

// How her personality shows in her body and voice on the site (0..1 each).
function behavior() {
  const t = personality().traits;
  return Object.fromEntries(["energy", "warmth", "curiosity", "playfulness", "expressiveness"].map((k) => [k, t[k] / 100]));
}

// ---- Sleep ----
//
// While asleep she doesn't chat or roam. "manual" sleep (you put her to sleep) lasts until you wake
// her; "shutdown" sleep (the server was closed) ends when the server starts again.

function sleepState() {
  return { asleep: getMeta("asleep") === "1", reason: getMeta("asleep_reason"), since: Number(getMeta("asleep_since") || 0) };
}

function fallAsleep(reason) {
  if (sleepState().asleep && getMeta("asleep_reason") === "manual") return; // already asleep on purpose
  setMeta("asleep", "1");
  setMeta("asleep_reason", reason);
  setMeta("asleep_since", Date.now());
}

function wakeUp() {
  const was = sleepState();
  setMeta("asleep", "0");
  setMeta("woke_at", Date.now());
  return was;
}

// Lets any note she's in the middle of writing finish, up to `ms`.
function settle(ms) {
  return Promise.race([queue.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

// Folds the write-ahead log into the database file and closes it cleanly.
function close() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {}
}

// When this visitor last talked to her (ms), or 0 if never.
function lastTalk(visitor) {
  if (!isVisitorId(visitor)) return 0;
  return db.prepare("SELECT MAX(created) AS t FROM messages WHERE visitor = ?").get(visitor).t || 0;
}

// A trip right now (asked for by you), queued with her other background thinking so it can be
// interrupted by visitors like any other free time.
function roamNow(topic) {
  const trip = queue.then(() => roam(topic));
  queue = trip.catch(() => {});
  return trip;
}

// A personality review right now (asked for by you), queued like her other background thinking.
function reviewNow() {
  const review = queue.then(() => reviewPersonality(true));
  queue = review.catch(() => {});
  return review;
}

// For the website's "What Delta's been exploring": her trips, never her private reflections or diary.
function explorations(limit = 20) {
  return {
    now: activity,
    trips: db.prepare("SELECT topic, sources, entry, created FROM journal WHERE kind = 'exploration' ORDER BY created DESC LIMIT ?")
      .all(limit).map((r) => ({ path: r.topic, sources: JSON.parse(r.sources || "[]"), entry: r.entry, created: r.created })),
  };
}

module.exports = {
  hello, claim, list, forget, forgetEverything, recall, note, learn, saveExchange, history, clearHistory,
  personaPrompt, selfSection, startGrowing, reflectIfDue, diaryIfDue, journal, selfNotes, roam, explorations,
  sleepState, fallAsleep, wakeUp, settle, close, lastTalk, interruptGrowth, roamNow,
  personalityReport, reviewPersonality, reviewNow, undoLastChange, setPinned, behavior, reconsiderTastes,
  sketchNow, sketches, sketchFile, setSketchPublic, setSketchOrigin, stopDrawing,
  mirrorNow, appearance, noteDrawRequest, mirrorImages, asksAboutLooks,
  startChatDrawing, chatDrawing, isDrawingInChat,
};
