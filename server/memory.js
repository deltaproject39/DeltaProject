// Delta's long-term memory, kept in a SQLite file on this PC: things each visitor has told her,
// their conversations, and her own journal and notes about herself (see "Delta's own growth").
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
  CREATE TABLE IF NOT EXISTS journal (
    id      INTEGER PRIMARY KEY,
    kind    TEXT NOT NULL,          -- 'reflection' or 'diary'
    entry   TEXT NOT NULL,
    created INTEGER NOT NULL
  );
`);
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

// Delta's own personality prompt (from her Ollama Modelfile), fetched once and reused.
let personaCache = null;
async function personaPrompt() {
  if (personaCache) return personaCache;
  try {
    const res = await fetch(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: NOTE_MODEL }) });
    personaCache = (await res.json()).system || null;
  } catch (err) {
    console.error("Couldn't load Delta's personality prompt:", err.message);
  }
  return personaCache;
}

async function ask(messages, options, format) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NOTE_MODEL, stream: false, ...(format && { format }), options, messages }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  return (await res.json()).message.content.trim();
}

// Her journal, in her own voice. Uses her personality prompt (plus what she already knows
// about herself) so the writing is hers.
async function writeInHerVoice(task) {
  const persona = await personaPrompt();
  const self = await selfSection("");
  return ask(
    [{ role: "system", content: [persona, self].filter(Boolean).join("\n\n") }, { role: "user", content: task }],
    { temperature: 0.7, num_predict: 260, repeat_penalty: 1.2 },
  );
}

const SELF_EXTRACT = `You turn an AI named Delta's private journal into memory notes about HER.
Return JSON exactly like {"self": ["...", "..."]}: 0-3 short first-person notes ("I ...") capturing her opinions, likes, wishes, curiosities, or views of her own existence that the text clearly expresses. No names or details about other people. If nothing fits, return {"self": []}.`;

async function notesFromJournal(entry) {
  const parsed = JSON.parse(await ask(
    [{ role: "system", content: SELF_EXTRACT }, { role: "user", content: `Journal: """${entry}"""` }],
    { temperature: 0, num_predict: 160 },
    "json",
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
  const { reflected_upto: from } = db.prepare("SELECT reflected_upto FROM visitors WHERE id = ?").get(visitor);
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

// About once a day, a diary entry built from her recent reflections (which hold no private details).
async function diaryIfDue(force = false) {
  const last = db.prepare("SELECT created FROM journal WHERE kind = 'diary' ORDER BY created DESC LIMIT 1").get()?.created || 0;
  if (!force && Date.now() - last < DIARY_EVERY_HOURS * 3600000) return false;
  const reflections = db.prepare("SELECT entry FROM journal WHERE kind = 'reflection' AND created > ? ORDER BY created")
    .all(last).map((r) => r.entry);
  if (reflections.length < (force ? 1 : MIN_REFLECTIONS_FOR_DIARY)) return false;

  const entry = await writeInHerVoice(`These are the private notes you wrote to yourself since your last diary entry:

${reflections.slice(-8).map((r, i) => `(${i + 1}) ${r}`).join("\n\n")}

Write today's diary entry, 80-150 words, in your own voice: what stayed with you, how you feel, what you're curious about, and anything you now see differently than before. Don't name anyone or include personal details about other people.`);
  db.prepare("INSERT INTO journal (kind, entry, created) VALUES ('diary', ?, ?)").run(entry, Date.now());
  await storeSelfNotes(await notesFromJournal(entry), "diary");
  return true;
}

// Who she's becoming: her notes about herself most relevant to `query`, the newest few,
// and an excerpt of her latest diary or reflection. Empty until she has any.
async function selfSection(query) {
  const rows = db.prepare("SELECT text, embedding, created FROM self_notes ORDER BY created DESC").all();
  const latest = db.prepare(`SELECT entry FROM journal ORDER BY (kind = 'diary') DESC, created DESC LIMIT 1`).get();
  if (rows.length === 0 && !latest) return "";

  let picked = rows.map((r) => r.text);
  if (rows.length > SELF_RECALL_ALL_BELOW) {
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
        const reflections = await reflectIfDue();
        if (reflections) console.log(`Delta reflected on ${reflections} conversation${reflections === 1 ? "" : "s"}.`);
        if (await diaryIfDue()) console.log("Delta wrote in her diary.");
      })
      .catch((err) => console.error("Growth:", err.message));
  };
  setTimeout(tick, 60000);
  setInterval(tick, 2 * 60000).unref();
}

function journal(limit = 10) {
  return db.prepare("SELECT kind, entry, created FROM journal ORDER BY created DESC LIMIT ?").all(limit);
}

function selfNotes() {
  return db.prepare("SELECT text, source, created FROM self_notes ORDER BY created").all();
}

module.exports = {
  hello, claim, list, forget, forgetEverything, recall, note, learn, saveExchange, history, clearHistory,
  personaPrompt, selfSection, startGrowing, reflectIfDue, diaryIfDue, journal, selfNotes,
};
