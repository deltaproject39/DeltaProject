// Protects a memory code with a PIN, so using it on another device needs the PIN too.
// The PIN is stored hashed (scrypt); the code is also marked "keep" so it's never tidied away.
//
// Usage: node server/set-pin.js <code>          (asks for the PIN, hidden)
//        node server/set-pin.js <code> off      (removes the PIN)

const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");

// Opening memory.js adds any missing columns to the database.
require("./memory");
const db = new DatabaseSync(path.join(__dirname, "memory.db"));

const code = String(process.argv[2] || "").trim().toLowerCase();
const option = String(process.argv[3] || "").trim().toLowerCase();
if (!code) {
  console.log("Usage: node server/set-pin.js <code>   (or add 'off' to remove the PIN)");
  process.exit(1);
}
const visitor = db.prepare("SELECT id FROM visitors WHERE code = ?").get(code);
if (!visitor) {
  console.log(`No visitor has the code "${code}".`);
  process.exit(1);
}

if (option === "off") {
  db.prepare("UPDATE visitors SET pin_hash = NULL, pin_salt = NULL, fails = 0, locked_until = 0 WHERE id = ?").run(visitor.id);
  console.log(`PIN removed from "${code}".`);
  process.exit(0);
}

// Reads a line without showing what's typed.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) process.stdout.write(question);
      else if (text.includes("\n") || text.includes("\r")) process.stdout.write("\n");
      else process.stdout.write("*".repeat(text.length));
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

(async () => {
  const pin = await askHidden("New PIN (4-8 digits): ");
  if (!/^\d{4,8}$/.test(pin)) {
    console.log("The PIN must be 4 to 8 digits.");
    process.exit(1);
  }
  if ((await askHidden("Type it again: ")) !== pin) {
    console.log("The PINs didn't match. Nothing was changed.");
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 32).toString("hex");
  db.prepare("UPDATE visitors SET pin_hash = ?, pin_salt = ?, fails = 0, locked_until = 0, keep = 1 WHERE id = ?")
    .run(hash, salt, visitor.id);
  console.log(`PIN set for "${code}". Other devices will need it along with the code.`);
})();
