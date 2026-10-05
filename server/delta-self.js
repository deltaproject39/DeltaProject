// Read Delta's journal and her notes about herself, or have her reflect / write her diary now.
//
// Usage: node server/delta-self.js            show her notes about herself and recent journal
//        node server/delta-self.js reflect    reflect now on conversations she hasn't thought about yet
//        node server/delta-self.js diary      write a diary entry now from her recent reflections
//        node server/delta-self.js roam       let her go roaming the web, following her curiosity
//        node server/delta-self.js roam "deep sea creatures"   ...or send her somewhere to start
//        node server/delta-self.js sleep      put her to sleep (no chatting or roaming) until you wake her
//        node server/delta-self.js wake       wake her up

const memory = require("./memory");

const when = (ms) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

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
  } else if (command === "reflect") {
    console.log("Delta is reflecting... (this takes a little while)");
    const n = await memory.reflectIfDue(true);
    console.log(n ? `She reflected on ${n} conversation${n === 1 ? "" : "s"}.` : "Nothing new to reflect on.");
  } else if (command === "roam") {
    const topic = process.argv.slice(3).join(" ").trim();
    console.log("Delta is off roaming the web... (a few minutes)");
    const trip = await memory.roam(topic || undefined);
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
