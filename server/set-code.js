// Changes a visitor's memory code, e.g. to give yourself a custom ID.
// Usage: node server/set-code.js <current-code> <new-code>
//   e.g. node server/set-code.js starry-owl-6852 mark-delta
// Note: anyone who types a code gets those memories, so pick one that's hard to guess.

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const [current, wanted] = process.argv.slice(2).map((s) => String(s || "").trim().toLowerCase());
if (!current || !wanted) {
  console.log("Usage: node server/set-code.js <current-code> <new-code>");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(wanted)) {
  console.log("New code must be 3-40 characters: lowercase letters, numbers and dashes.");
  process.exit(1);
}

const db = new DatabaseSync(path.join(__dirname, "memory.db"));
const visitor = db.prepare("SELECT id FROM visitors WHERE code = ?").get(current);
if (!visitor) {
  console.log(`No visitor has the code "${current}".`);
  process.exit(1);
}
if (db.prepare("SELECT 1 FROM visitors WHERE code = ?").get(wanted)) {
  console.log(`The code "${wanted}" is already taken.`);
  process.exit(1);
}
db.prepare("UPDATE visitors SET code = ? WHERE id = ?").run(wanted, visitor.id);
console.log(`Done: "${current}" is now "${wanted}". Reload the page to see it in the memory panel.`);
