import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
if (!process.env.DATABASE_URL) {
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (match) process.env.DATABASE_URL = match[1].trim();
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const identity = await client.query("select current_database() as database, current_user as role, current_schema() as schema");
  const row = identity.rows[0];
  if (row.database !== "intentchord_dev" || row.role !== "intentchord_app" || row.schema !== "intentchord") throw new Error("Migration target guard rejected this database, role, or schema.");
  await client.query("create table if not exists intentchord.schema_migrations (id text primary key, applied_at timestamptz not null default now())");
  for (const id of (await readdir("migrations")).filter(x => x.endsWith(".sql")).sort()) {
    if ((await client.query("select 1 from intentchord.schema_migrations where id = $1", [id])).rowCount) continue;
    await client.query("begin"); try { await client.query(await readFile(path.join("migrations", id), "utf8")); await client.query("insert into intentchord.schema_migrations(id) values ($1)", [id]); await client.query("commit"); } catch (e) { await client.query("rollback"); throw e; }
  }
} finally { await client.end(); }
