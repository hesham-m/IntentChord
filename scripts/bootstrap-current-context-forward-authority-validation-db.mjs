import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { disposableValidationUrl, safeValidationTarget, EXPECTED_SCHEMA, EXPECTED_USER } from "./current-context-disposable-validation-target.mjs";

const EXPECTED_MIGRATION_014_SHA256 = "8ED111969E4D92CF2DFC613A0AC7573D1E1E2FF01ADA012A8EEABA90561947EB";
const EXPECTED_LOCK_SHA256 = "DDAA83B333CCBF7D61890914E769CA2666F8F779B842709DE8FAFF7496019D3F";
const MIGRATION_014_ID = "014_governed_context_assembly_and_ai_context_mapping_v2.sql";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex").toUpperCase(); }

async function assertSourceIdentity() {
  const lock = await readFile("package-lock.json");
  const lockSha = sha256(lock);
  if (lockSha !== EXPECTED_LOCK_SHA256) throw new Error(`PACKAGE_LOCK_IDENTITY_MISMATCH: expected=${EXPECTED_LOCK_SHA256} actual=${lockSha}`);
  const migration = await readFile(path.join("migrations", MIGRATION_014_ID));
  const migrationSha = sha256(migration);
  if (migrationSha !== EXPECTED_MIGRATION_014_SHA256) throw new Error(`MIGRATION_014_SOURCE_HASH_MISMATCH: expected=${EXPECTED_MIGRATION_014_SHA256} actual=${migrationSha}`);
  console.log(`PACKAGE_LOCK_SHA256=PASS ${lockSha}`);
  console.log(`MIGRATION_014_SHA256=PASS ${migrationSha}`);
}

async function assertRuntimeIdentity(client, expected) {
  const { rows: [row] } = await client.query("select current_database() database,current_user role");
  if (row?.database !== expected.database || row?.role !== EXPECTED_USER) {
    throw new Error(`DISPOSABLE_DATABASE_RUNTIME_IDENTITY_BLOCKED: database=${row?.database ?? "<missing>"}, role=${row?.role ?? "<missing>"}`);
  }
}

async function applyMigrations(client) {
  const names = (await readdir("migrations"))
    .filter(name => /^\d{3}_.*\.sql$/.test(name))
    .sort();
  const required = names.filter(name => Number(name.slice(0, 3)) <= 14);
  if (required.length !== 14 || required[13] !== MIGRATION_014_ID) {
    throw new Error(`DISPOSABLE_MIGRATION_SET_INVALID: ${required.join(",")}`);
  }
  await client.query(`DROP SCHEMA IF EXISTS ${EXPECTED_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${EXPECTED_SCHEMA} AUTHORIZATION ${EXPECTED_USER}`);
  await client.query(`SET search_path TO ${EXPECTED_SCHEMA}`);
  for (const name of required) {
    const sql = await readFile(path.join("migrations", name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        `insert into intentchord.schema_migrations(id) values($1) on conflict(id) do nothing`,
        [name],
      );
      await client.query("COMMIT");
      console.log(`DISPOSABLE_MIGRATION_APPLIED=${name}`);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
      throw error;
    }
  }
}

async function main() {
  await assertSourceIdentity();
  const raw = disposableValidationUrl();
  const expected = safeValidationTarget(raw);
  console.log(`DISPOSABLE_VALIDATION_TARGET database=${expected.database} user=${expected.user} host=${expected.host} port=${expected.port} schema=${expected.schema}`);
  const client = new pg.Client({ connectionString: raw });
  await client.connect();
  try {
    await assertRuntimeIdentity(client, expected);
    await applyMigrations(client);
    const { rows } = await client.query(`select id from intentchord.schema_migrations order by id`);
    if (rows.length !== 14 || rows.at(-1)?.id !== MIGRATION_014_ID) {
      throw new Error(`DISPOSABLE_MIGRATION_STATE_INVALID: count=${rows.length} last=${rows.at(-1)?.id ?? "<none>"}`);
    }
    const schema = await client.query(`select current_schema() schema`);
    if (schema.rows[0]?.schema !== EXPECTED_SCHEMA) throw new Error("DISPOSABLE_SCHEMA_AUTHORITY_MISMATCH");
    console.log("DISPOSABLE_DB_MIGRATION_014_APPLIED_FOR_VALIDATION=PASS");
    console.log("OWNER_DB_MIGRATION_014_PERSISTENT_APPLY=NO");
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
