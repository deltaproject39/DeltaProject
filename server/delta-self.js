// Read Delta's journal and her notes about herself, or have her reflect / write her diary now.
//
// Usage: node server/delta-self.js            show her notes about herself and recent journal
//        node server/delta-self.js reflect    reflect now on conversations she hasn't thought about yet
//        node server/delta-self.js diary      write a diary entry now from her recent reflections

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
  for (const e of entries) console.log(`\n--- ${e.kind === "diary" ? "Diary" : "Reflection"}, ${when(e.created)} ---\n${e.entry}`);
  console.log();
}

(async () => {
  const command = process.argv[2];
  if (command === "reflect") {
    console.log("Delta is reflecting... (this takes a little while)");
    const n = await memory.reflectIfDue(true);
    console.log(n ? `She reflected on ${n} conversation${n === 1 ? "" : "s"}.` : "Nothing new to reflect on.");
  } else if (command === "diary") {
    console.log("Delta is writing her diary...");
    console.log((await memory.diaryIfDue(true)) ? "Done." : "She needs at least one reflection first (try 'reflect').");
  }
  show();
  process.exit(0);
})();
