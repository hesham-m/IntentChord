import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

function outputArgument() {
  const value = process.argv.find(item => item.startsWith("--output="));
  if (!value) throw new Error("--output is required.");
  return path.resolve(value.slice("--output=".length));
}

async function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required.");
  return match[1].trim();
}

function validate(parsed) {
  const database = parsed.pathname.replace(/^\//, "");
  if (decodeURIComponent(parsed.username) !== "intentchord_app" || parsed.hostname !== "127.0.0.1" || (parsed.port || "5432") !== "5432" || database !== "intentchord_dev") {
    throw new Error("DATABASE_BACKUP_IDENTITY_BLOCKED");
  }
}

function candidates() {
  const explicit = process.env.PG_DUMP_PATH;
  const list = [];
  if (explicit) list.push(explicit);
  if (process.platform === "win32") {
    for (const version of ["17", "16", "15", "14"]) list.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin\\pg_dump.exe`);
    list.push("pg_dump.exe");
  } else {
    list.push("pg_dump");
  }
  return list;
}

function hashFile(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex").toUpperCase();
}

const output = outputArgument();
await mkdir(path.dirname(output), { recursive: true });
const parsed = new URL(await databaseUrl());
validate(parsed);
let lastError = "pg_dump was not found";
for (const executable of candidates()) {
  const result = spawnSync(executable, [
    "--host", parsed.hostname,
    "--port", parsed.port || "5432",
    "--username", decodeURIComponent(parsed.username),
    "--dbname", parsed.pathname.replace(/^\//, ""),
    "--format", "custom",
    "--schema", "intentchord",
    "--no-owner",
    "--no-privileges",
    "--file", output,
  ], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
    encoding: "utf8",
    windowsHide: true,
  });
  if (!result.error && result.status === 0 && existsSync(output) && statSync(output).size > 1024) {
    const sha256 = hashFile(output);
    console.log(`INTENTCHORD_DATABASE_BACKUP: PASS | bytes=${statSync(output).size} | sha256=${sha256} | path=${output}`);
    process.exit(0);
  }
  lastError = result.error?.message ?? result.stderr?.trim() ?? `exit=${result.status}`;
}
throw new Error(`DATABASE_BACKUP_FAILED: ${lastError}`);
