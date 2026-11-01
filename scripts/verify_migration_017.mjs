import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (match) process.env.DATABASE_URL = match[1].trim();
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const appliedMigrations = await client.query(
    "SELECT id, applied_at FROM intentchord.schema_migrations ORDER BY id"
  );
  
  const tables = await client.query(`
    SELECT table_name 
      FROM information_schema.tables 
     WHERE table_schema = 'intentchord' 
       AND table_name LIKE 'context_mapping_%'
     ORDER BY table_name
  `);

  const constraints = await client.query(`
    SELECT conname, contype, c.relname as table_name, pg_get_constraintdef(con.oid) as def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'intentchord'
       AND c.relname LIKE 'context_mapping_%'
     ORDER BY table_name, conname
  `);

  const triggers = await client.query(`
    SELECT tgname, relname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'intentchord'
       AND tgname LIKE '%context_mapping_%'
     ORDER BY relname, tgname
  `);

  const output = [
    "=== APPLIED MIGRATIONS ===",
    JSON.stringify(appliedMigrations.rows, null, 2),
    "",
    "=== CONTEXT MAPPING TABLES ===",
    JSON.stringify(tables.rows, null, 2),
    "",
    "=== CONSTRAINTS ===",
    JSON.stringify(constraints.rows, null, 2),
    "",
    "=== TRIGGERS ===",
    JSON.stringify(triggers.rows, null, 2)
  ].join("\n");

  console.log(output);
  await writeFile(
    "E:\\project\\gemini report\\INTENTCHORD_FINAL_MULTI_WINDOW_IMPLEMENTATION_20260907_173000\\POSTGRESQL_SCHEMA_PROOF.txt",
    output,
    "utf8"
  );
} finally {
  await client.end();
}
