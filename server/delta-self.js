// Read Delta's journal and her notes about herself, or have her reflect / write her diary now.
//
// Usage: node server/delta-self.js            show her notes about herself and recent journal
//        node server/delta-self.js reflect    reflect now on conversations she hasn't thought about yet
//        node server/delta-self.js diary      write a diary entry now from her recent reflections
//        node server/delta-self.js roam       let her go roaming the web, following her curiosity
//        node server/delta-self.js roam "deep sea creatures"   ...or send her somewhere to start
//        node server/delta-self.js sleep      put her to sleep (no chatting or roaming) until you wake her
//        node server/delta-self.js wake       wake her up
//        node server/delta-self.js who        her personality: traits, likes, interests, today, recent changes
//        node server/delta-self.js review     have her look back and decide how she's changed, now
//
// Easier: open http://localhost:8787/owner on this PC for all of this in your browser.

const memory = require("./memory");

const when = (ms) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

function showPersonality() {
  const p = memory.personalityReport();
  console.log("\n=== Who Delta is right now ===\n");
  for (const t of p.traits) {
    const bar = "#".repeat(Math.round(t.value / 5)).padEnd(20, ".");
    const drift = t.value - t.start;
    console.log(`  ${t.name.padEnd(15)} ${bar} ${String(t.value).padStart(3)}${drift ? ` (${drift > 0 ? "+" : ""}${drift} since start)` : ""}${t.pinned ? "  [pinned]" : ""}`);
  }
  console.log(`\n  Today: ${p.today}`);
  if (p.likes.length) console.log(`  Likes: ${p.likes.join(", ")}`);
  if (p.dislikes.length) console.log(`  Dislikes: ${p.dislikes.join(", ")}`);
  if (p.interests.length) console.log(`  Drawn to: ${p.interests.join(", ")}`);
  if (p.habits.length) console.log(`  Habits: ${p.habits.join("; ")}`);
  const last = p.history.find((h) => h.changes.length);
  if (last) {
    console.log(`\n  Last change (${when(last.created)})${last.undone ? " [undone]" : ""}:`);
    for (const c of last.changes) console.log(`    ${c.trait} ${c.from} → ${c.to}: "${c.why}"`);
  }
  console.log();
}

function show() {
  const notes = memory.selfNotes();
  console.log(`\n=== What Delta has come to think about herself (${notes.length}) ===\n`);
  if (notes.length === 0) console.log("  (nothing yet: she writes these after reflecting on conversations)");
  for (const n of notes) console.log(`  - ${n.text}   [${n.source}, ${when(n.created)}]`);

  const entries = memory.journal(5).reverse();
  console.log(`\n=== Her journal (latest ${entries.length}) ===`);
  if (entries.length === 0) console.log("\n  (empty so far)");
  const label = { diary: "Diary", reflection: "Reflection", exploration: "Roaming" };
  for (const e of entries) {
    const about = e.topic ? `: ${e.topic}` : "";
    console.log(`\n--- ${label[e.kind] || e.kind}${about}, ${when(e.created)} ---\n${e.entry}`);
  }
  console.log();
}

(async () => {
  const command = process.argv[2];
  if (command === "sleep") {
    memory.fallAsleep("manual");
    console.log("Delta is asleep. Visitors will see her sleeping; she won't chat or roam until you wake her.");
    process.exit(0);
  } else if (command === "wake") {
    const was = memory.wakeUp();
    console.log(was.asleep ? "Delta is awake." : "She was already awake.");
    process.exit(0);
  } else if (command === "who") {
    showPersonality();
    process.exit(0);
  } else if (command === "review") {
    console.log("Delta is looking back at who she's been... (a minute or two)");
    const review = await memory.reviewPersonality(true);
    if (!review) console.log("She has nothing new to look back on yet.");
    else console.log(`\n${review.thoughts}\n`);
    showPersonality();
    process.exit(0);
  } else if (command === "reflect") {
    console.log("Delta is reflecting... (this takes a little while)");
    const n = await memory.reflectIfDue(true);
    console.log(n ? `She reflected on ${n} conversation${n === 1 ? "" : "s"}.` : "Nothing new to reflect on.");
  } else if (command === "roam") {
    const topic = process.argv.slice(3).join(" ").trim();
    console.log("Delta is off roaming the web... (a few minutes)");
    // If her server is running, the trip happens there (so visitors can interrupt it);
    // otherwise she roams right here.
    let trip;
    try {
      const res = await fetch("http://127.0.0.1:8787/owner/roam", {
        method: "POST",
        body: JSON.stringify({ topic: topic || undefined }),
        signal: AbortSignal.timeout(15 * 60000),
      });
      const result = await res.json();
      if (result.error === "interrupted") {
        console.log("Someone came to talk to her, so she set the trip aside. Try again later.");
        process.exit(0);
      }
      trip = result.trip;
    } catch (err) {
      if (err.name === "TimeoutError") throw err;
      trip = await memory.roam(topic || undefined); // server isn't running
    }
    if (!trip) console.log("She couldn't find anything to read this time.");
    else {
      console.log(`She ${trip.how}, and went:`);
      for (const stop of trip.stops) console.log(`  → ${stop.title}\n    ${stop.url}\n    "${stop.note}"`);
      if (trip.next) console.log(`Next she wants to look up: ${trip.next}`);
    }
  } else if (command === "diary") {
    console.log("Delta is writing her diary...");
    console.log((await memory.diaryIfDue(true)) ? "Done." : "She needs at least one reflection first (try 'reflect').");
  }
  show();
  process.exit(0);
})();
