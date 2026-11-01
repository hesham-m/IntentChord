import { randomBytes, scrypt } from "node:crypto";
import { Client } from "pg";
import { createInterface } from "node:readline";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

function deriveKey(plaintext, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(plaintext, "utf8"),
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function promptHidden(rl, question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = "";
    const onData = (chunk) => {
      const str = chunk.toString("utf8");
      for (const ch of str) {
        if (ch === "\n" || ch === "\r") {
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") { process.exit(1); }
        if (ch === "\u007F" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--login") result.loginName = args[i + 1];
    if (args[i] === "--display") result.displayName = args[i + 1];
  }
  return result;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  const args = parseArgs();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const loginName = args.loginName || (await prompt(rl, "Owner login name: ")).trim();
    if (!loginName) { console.error("ERROR: Login name cannot be empty."); process.exit(1); }

    const displayName = args.displayName || (await prompt(rl, "Display name: ")).trim();
    if (!displayName) { console.error("ERROR: Display name cannot be empty."); process.exit(1); }

    let password = process.env.INTENTCHORD_PROVISION_PASSWORD;
    if (!password) {
      password = await promptHidden(rl, "Password: ");
      if (password.length < 8) { console.error("ERROR: Password must be at least 8 characters."); process.exit(1); }
      const confirmPassword = await promptHidden(rl, "Confirm password: ");
      if (password !== confirmPassword) { console.error("ERROR: Passwords do not match."); process.exit(1); }
    } else {
      if (password.length < 8) { console.error("ERROR: Password must be at least 8 characters."); process.exit(1); }
    }

    const salt = randomBytes(32);
    const hash = await deriveKey(password, salt);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("BEGIN");

      const identityCheck = await client.query(
        "SELECT current_database() as db, current_user as usr, current_schema() as sch",
      );
      const id = identityCheck.rows[0];
      if (id.db !== "intentchord_dev" || id.usr !== "intentchord_app" || id.sch !== "intentchord") {
        throw new Error(` Wrong database identity: ${id.db}/${id.usr}/${id.sch}`);
      }

      const existing = await client.query("SELECT 1 FROM intentchord.owner_accounts WHERE account_state = 'ACTIVE' LIMIT 1");
      if (existing.rows.length > 0) {
        throw new Error(" An ACTIVE Owner account already exists. Refusing to create a second Owner.");
      }

      await client.query(
        `INSERT INTO intentchord.owner_accounts (login_name, display_name, password_hash, password_salt, password_kdf)
         VALUES ($1, $2, $3, $4, 'scrypt-v1')`,
        [loginName, displayName, hash, salt],
      );

      await client.query("COMMIT");
      console.log(`\nOwner account "${loginName}" created successfully.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
