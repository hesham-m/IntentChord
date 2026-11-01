import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "007_project_context_and_truth_registry.sql";
const baseMigrationIds = [
  "001_intentchord_vertical_slice.sql",
  "002_backend_authoritative_lifecycle.sql",
  "003_owner_decision_ledger.sql",
  "004_trust_invariants_and_authoritative_projection.sql",
  "005_semantic_trust_hardening.sql",
  "006_intelligence_and_evidence_semantics.sql",
];
const expectedMigrationHashes = new Map([
  ["001_intentchord_vertical_slice.sql", "2EA16FE625DE4CCE441E6B291CD4978BD0570F8A8A21FEE0EA1708E41BE6A352"],
  ["002_backend_authoritative_lifecycle.sql", "ECDC2623ABB4A8C54398070B96B1AB00DF8720A85308F0E55C129DEE8AE18A22"],
  ["003_owner_decision_ledger.sql", "E4269AF86BACB9C3E6DE06A1300B6A7BDE358A3CA55F939E7EA340E9DD544645"],
  ["004_trust_invariants_and_authoritative_projection.sql", "22E66A8206CB9E354BBFD7A81B4FD54C8FC00B07B472F7369E94151DBA83AFBE"],
  ["005_semantic_trust_hardening.sql", "605F65F85F97E0C814B2A75F82D711E29D7855DAB28621A12CCDBD9020EA9D71"],
  ["006_intelligence_and_evidence_semantics.sql", "CA9F4854EC95A07CAAAAFBF154D94A0494AC04150BD5CC4A803FDC07DA6555D6"],
  [migrationId, "FC345BC3BBA52236E658E6FC41885B42B23D48FDCB312170A26DD689539FAA95"],
]);
const expectedObjects = [
  "project_contexts",
  "project_context_workspaces",
  "project_facts",
  "project_fact_revisions",
  "project_truth_snapshots",
];
const expectedConstraints = [
  "project_facts_current_revision_same_fact_fkey",
  "project_fact_revisions_source_proposal_same_fact_fkey",
  "project_fact_revisions_supersedes_same_fact_fkey",
];
const expectedTriggers = [
  "project_context_workspaces_append_only_update",
  "project_context_workspaces_append_only_delete",
  "project_fact_revisions_append_only_update",
  "project_fact_revisions_append_only_delete",
  "project_truth_snapshots_append_only_update",
  "project_truth_snapshots_append_only_delete",
  "project_contexts_projection_revision_guard",
  "project_facts_projection_revision_guard",
  "project_facts_projection_integrity_guard",
];

function fail(code, details = "") {
  const suffix = details ? `: ${details}` : "";
  throw new Error(`${code}${suffix}`);
}

async function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) fail("DATABASE_URL_NOT_FOUND");
  return match[1].trim();
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function assertMigrationSourceHashes() {
  for (const [id, expectedHash] of expectedMigrationHashes) {
    const path = `migrations/${id}`;
    try {
      const info = await stat(path);
      if (!info.isFile()) fail("MIGRATION_SOURCE_NOT_FILE", id);
    } catch {
      fail("MIGRATION_SOURCE_NOT_FOUND", id);
    }
    const actualHash = await sha256File(path);
    if (actualHash !== expectedHash) {
      fail("MIGRATION_SOURCE_HASH_MISMATCH", `${id} expected=${expectedHash} actual=${actualHash}`);
    }
  }
  console.log("MIGRATION_SOURCE_HASHES: PASS count=7");
}

async function assertIdentity(client) {
  const identity = await client.query(
    "select current_database() as database, current_user as role, current_schema() as schema",
  );
  const row = identity.rows[0];
  if (row.database !== "intentchord_dev") fail("DATABASE_IDENTITY_BLOCKER", `database=${row.database}`);
  if (row.role !== "intentchord_app") fail("DATABASE_IDENTITY_BLOCKER", `role=${row.role}`);
  if (row.schema !== "intentchord") fail("DATABASE_IDENTITY_BLOCKER", `schema=${row.schema}`);
  console.log("DATABASE_IDENTITY: PASS database=intentchord_dev role=intentchord_app schema=intentchord");
}

async function schemaMigrationsState(client) {
  const regclass = await client.query("select to_regclass('intentchord.schema_migrations') as name");
  if (!regclass.rows[0].name) fail("SCHEMA_MIGRATIONS_TABLE_MISSING");
  const rows = await client.query("select id from intentchord.schema_migrations order by id");
  return rows.rows.map(row => row.id);
}

function assertExactMigrationSet(actual, expected, code) {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail(code, `expected=${expected.join(',')} actual=${actual.join(',')}`);
  }
}

async function readObjectPresence(client) {
  const result = new Map();
  for (const objectName of expectedObjects) {
    const row = await client.query("select to_regclass($1) as name", [`intentchord.${objectName}`]);
    result.set(objectName, Boolean(row.rows[0].name));
  }
  return result;
}

async function assertPreflight(client) {
  const migrations = await schemaMigrationsState(client);
  assertExactMigrationSet(migrations, baseMigrationIds, "MIGRATION_BASELINE_BLOCKER");
  const presence = await readObjectPresence(client);
  const existing = [...presence.entries()].filter(([, isPresent]) => isPresent).map(([name]) => name);
  if (existing.length > 0) fail("MIGRATION_007_PARTIAL_OBJECTS_BLOCKER", existing.join(','));
  console.log("MIGRATION_BASELINE_001_006: PASS");
  console.log("MIGRATION_007_STATE: NOT_APPLIED");
  console.log("MIGRATION_007_OBJECT_PREFLIGHT: PASS expected_objects_absent=5");
}

async function assertPostApply(client) {
  const migrations = await schemaMigrationsState(client);
  assertExactMigrationSet(migrations, [...baseMigrationIds, migrationId], "MIGRATION_POST_STATE_BLOCKER");
  const presence = await readObjectPresence(client);
  const missing = [...presence.entries()].filter(([, isPresent]) => !isPresent).map(([name]) => name);
  if (missing.length > 0) fail("MIGRATION_007_OBJECTS_MISSING", missing.join(','));

  const constraints = await client.query(
    `select conname from pg_constraint
     where connamespace = 'intentchord'::regnamespace and conname = any($1::text[])
     order by conname`,
    [expectedConstraints],
  );
  const constraintNames = constraints.rows.map(row => row.conname);
  const missingConstraints = expectedConstraints.filter(name => !constraintNames.includes(name));
  if (missingConstraints.length > 0) fail("MIGRATION_007_CONSTRAINTS_MISSING", missingConstraints.join(','));

  const triggers = await client.query(
    `select tgname from pg_trigger
     where not tgisinternal and tgname = any($1::text[])
     order by tgname`,
    [expectedTriggers],
  );
  const triggerNames = triggers.rows.map(row => row.tgname);
  const missingTriggers = expectedTriggers.filter(name => !triggerNames.includes(name));
  if (missingTriggers.length > 0) fail("MIGRATION_007_TRIGGERS_MISSING", missingTriggers.join(','));

  console.log("MIGRATION_007_STATE: APPLIED");
  console.log("MIGRATION_007_OBJECTS: PASS tables=5 constraints=3 triggers=9");
}

async function run() {
  if (!new Set(["preflight", "apply", "verify"]).has(action)) {
    fail("MIGRATION_007_ACTION_INVALID", String(action ?? ""));
  }
  await assertMigrationSourceHashes();
  const connectionString = await loadDatabaseUrl();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await assertIdentity(client);
    if (action === "preflight") {
      await assertPreflight(client);
      console.log("MIGRATION_007_PREFLIGHT: PASS");
      return;
    }
    if (action === "verify") {
      await assertPostApply(client);
      console.log("MIGRATION_007_VERIFY: PASS");
      return;
    }

    await assertPreflight(client);
    const sql = await readFile(`migrations/${migrationId}`, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into intentchord.schema_migrations(id) values ($1)", [migrationId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    console.log("MIGRATION_007_TRANSACTION: COMMIT");
    await assertPostApply(client);
    console.log("MIGRATION_007_APPLY: PASS");
  } finally {
    await client.end();
  }
}

run().catch(error => {
  console.error(`MIGRATION_007_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
