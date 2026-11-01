import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "008_project_truth_database_clock_authority.sql";
const appliedBaselineMigrationIds = [
  "001_intentchord_vertical_slice.sql",
  "002_backend_authoritative_lifecycle.sql",
  "003_owner_decision_ledger.sql",
  "004_trust_invariants_and_authoritative_projection.sql",
  "005_semantic_trust_hardening.sql",
  "006_intelligence_and_evidence_semantics.sql",
  "007_project_context_and_truth_registry.sql",
];
const expectedMigrationHashes = new Map([
  ["001_intentchord_vertical_slice.sql", "2EA16FE625DE4CCE441E6B291CD4978BD0570F8A8A21FEE0EA1708E41BE6A352"],
  ["002_backend_authoritative_lifecycle.sql", "ECDC2623ABB4A8C54398070B96B1AB00DF8720A85308F0E55C129DEE8AE18A22"],
  ["003_owner_decision_ledger.sql", "E4269AF86BACB9C3E6DE06A1300B6A7BDE358A3CA55F939E7EA340E9DD544645"],
  ["004_trust_invariants_and_authoritative_projection.sql", "22E66A8206CB9E354BBFD7A81B4FD54C8FC00B07B472F7369E94151DBA83AFBE"],
  ["005_semantic_trust_hardening.sql", "605F65F85F97E0C814B2A75F82D711E29D7855DAB28621A12CCDBD9020EA9D71"],
  ["006_intelligence_and_evidence_semantics.sql", "CA9F4854EC95A07CAAAAFBF154D94A0494AC04150BD5CC4A803FDC07DA6555D6"],
  ["007_project_context_and_truth_registry.sql", "FC345BC3BBA52236E658E6FC41885B42B23D48FDCB312170A26DD689539FAA95"],
  [migrationId, "89BEB9995D86A030C21F76C73E6982BF6A86DE96A95272F75257AB1419F15644"],
]);
const phase1Tables = [
  "project_contexts",
  "project_context_workspaces",
  "project_facts",
  "project_fact_revisions",
  "project_truth_snapshots",
];
const newTriggers = [
  "project_context_workspaces_database_clock_insert",
  "project_fact_revisions_database_clock_insert",
  "project_truth_snapshots_database_clock_insert",
  "project_truth_audit_events_database_clock_insert",
];
const projectionTriggers = [
  "project_contexts_projection_revision_guard",
  "project_facts_projection_revision_guard",
];
const newConstraints = [
  "project_contexts_projection_time_order_check",
  "project_facts_projection_time_order_check",
];
const databaseClockDefaults = [
  ["project_contexts", "created_at"],
  ["project_contexts", "updated_at"],
  ["project_context_workspaces", "created_at"],
  ["project_facts", "created_at"],
  ["project_facts", "updated_at"],
  ["project_fact_revisions", "created_at"],
  ["project_truth_snapshots", "created_at"],
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
  console.log("MIGRATION_SOURCE_HASHES: PASS count=8");
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
    fail(code, `expected=${expected.join(",")} actual=${actual.join(",")}`);
  }
}

async function assertPhase1TablesPresent(client) {
  for (const objectName of phase1Tables) {
    const row = await client.query("select to_regclass($1) as name", [`intentchord.${objectName}`]);
    if (!row.rows[0].name) fail("MIGRATION_007_OBJECT_MISSING", objectName);
  }
  console.log("MIGRATION_007_OBJECT_BASELINE: PASS tables=5");
}

async function readNamedTriggers(client, names) {
  const result = await client.query(
    `select tgname,pg_get_triggerdef(oid) as definition
     from pg_trigger
     where not tgisinternal and tgname=any($1::text[])
     order by tgname`,
    [names],
  );
  return new Map(result.rows.map(row => [row.tgname, row.definition]));
}

async function assertPreflight(client) {
  const migrations = await schemaMigrationsState(client);
  assertExactMigrationSet(migrations, appliedBaselineMigrationIds, "MIGRATION_008_BASELINE_BLOCKER");
  await assertPhase1TablesPresent(client);

  const newTriggerState = await readNamedTriggers(client, newTriggers);
  if (newTriggerState.size > 0) {
    fail("MIGRATION_008_PARTIAL_TRIGGER_BLOCKER", [...newTriggerState.keys()].join(","));
  }
  const constraints = await client.query(
    `select conname from pg_constraint
     where connamespace='intentchord'::regnamespace and conname=any($1::text[])`,
    [newConstraints],
  );
  if (constraints.rowCount) {
    fail("MIGRATION_008_PARTIAL_CONSTRAINT_BLOCKER", constraints.rows.map(row => row.conname).join(","));
  }
  for (const [tableName, columnName] of databaseClockDefaults) {
    const result = await client.query(
      `select column_default from information_schema.columns
       where table_schema='intentchord' and table_name=$1 and column_name=$2`,
      [tableName, columnName],
    );
    const defaultValue = String(result.rows[0]?.column_default ?? "");
    if (defaultValue.includes("clock_timestamp()")) {
      fail("MIGRATION_008_PARTIAL_CLOCK_DEFAULT_BLOCKER", `${tableName}.${columnName}`);
    }
  }
  const projectionTriggerState = await readNamedTriggers(client, projectionTriggers);
  for (const [name, definition] of projectionTriggerState) {
    if (/BEFORE INSERT OR UPDATE/i.test(String(definition))) {
      fail("MIGRATION_008_PARTIAL_PROJECTION_TRIGGER_BLOCKER", name);
    }
  }

  const functions = await client.query(
    `select pg_get_functiondef(p.oid) as definition
     from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='intentchord'
       and p.proname in ('enforce_project_context_projection_revision','enforce_project_fact_projection_revision')`,
  );
  if (functions.rows.some(row => String(row.definition).includes("UPDATED_AT_DATABASE_MANAGED"))) {
    fail("MIGRATION_008_PARTIAL_FUNCTION_BLOCKER");
  }

  console.log("MIGRATION_BASELINE_001_007: PASS");
  console.log("MIGRATION_008_STATE: NOT_APPLIED");
  console.log("MIGRATION_008_PARTIAL_STATE_CHECK: PASS");
}

async function assertPostApply(client) {
  const migrations = await schemaMigrationsState(client);
  assertExactMigrationSet(
    migrations,
    [...appliedBaselineMigrationIds, migrationId],
    "MIGRATION_008_POST_STATE_BLOCKER",
  );
  await assertPhase1TablesPresent(client);

  const triggerState = await readNamedTriggers(client, [...newTriggers, ...projectionTriggers]);
  const missingTriggers = [...newTriggers, ...projectionTriggers].filter(name => !triggerState.has(name));
  if (missingTriggers.length) fail("MIGRATION_008_TRIGGERS_MISSING", missingTriggers.join(","));
  for (const name of projectionTriggers) {
    const definition = String(triggerState.get(name));
    if (!/BEFORE INSERT OR UPDATE/i.test(definition)) {
      fail("MIGRATION_008_PROJECTION_TRIGGER_EVENT_MISMATCH", `${name} definition=${definition}`);
    }
  }

  const constraints = await client.query(
    `select conname,convalidated from pg_constraint
     where connamespace='intentchord'::regnamespace and conname=any($1::text[])
     order by conname`,
    [newConstraints],
  );
  const constraintState = new Map(constraints.rows.map(row => [row.conname, row.convalidated]));
  for (const name of newConstraints) {
    if (!constraintState.has(name)) fail("MIGRATION_008_CONSTRAINT_MISSING", name);
    if (constraintState.get(name) !== true) fail("MIGRATION_008_CONSTRAINT_NOT_VALIDATED", name);
  }

  for (const [tableName, columnName] of databaseClockDefaults) {
    const result = await client.query(
      `select column_default from information_schema.columns
       where table_schema='intentchord' and table_name=$1 and column_name=$2`,
      [tableName, columnName],
    );
    const defaultValue = String(result.rows[0]?.column_default ?? "");
    if (!defaultValue.includes("clock_timestamp()")) {
      fail("MIGRATION_008_CLOCK_DEFAULT_MISSING", `${tableName}.${columnName} default=${defaultValue}`);
    }
  }

  const functions = await client.query(
    `select p.proname,pg_get_functiondef(p.oid) as definition
     from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='intentchord'
       and p.proname=any($1::text[])`,
    [[
      "enforce_project_context_projection_revision",
      "enforce_project_fact_projection_revision",
      "assign_project_truth_history_database_clock",
      "assign_project_truth_audit_database_clock",
    ]],
  );
  const definitions = new Map(functions.rows.map(row => [row.proname, String(row.definition)]));
  const expectedFunctionMarkers = new Map([
    ["enforce_project_context_projection_revision", "INTENTCHORD_PROJECT_CONTEXT_UPDATED_AT_DATABASE_MANAGED"],
    ["enforce_project_fact_projection_revision", "INTENTCHORD_PROJECT_FACT_UPDATED_AT_DATABASE_MANAGED"],
    ["assign_project_truth_history_database_clock", "clock_timestamp()"],
    ["assign_project_truth_audit_database_clock", "clock_timestamp()"],
  ]);
  for (const [name, marker] of expectedFunctionMarkers) {
    const definition = definitions.get(name);
    if (!definition || !definition.includes(marker)) {
      fail("MIGRATION_008_FUNCTION_CONTRACT_MISSING", `${name} marker=${marker}`);
    }
  }

  console.log("MIGRATION_008_STATE: APPLIED");
  console.log("MIGRATION_008_CLOCK_DEFAULTS: PASS columns=7");
  console.log("MIGRATION_008_TRIGGERS: PASS projection=2 history=3 audit=1");
  console.log("MIGRATION_008_CONSTRAINTS: PASS count=2 validated=true");
}

async function run() {
  if (!new Set(["preflight", "apply", "verify"]).has(action)) {
    fail("MIGRATION_008_ACTION_INVALID", String(action ?? ""));
  }
  await assertMigrationSourceHashes();
  const connectionString = await loadDatabaseUrl();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await assertIdentity(client);
    if (action === "preflight") {
      await assertPreflight(client);
      console.log("MIGRATION_008_PREFLIGHT: PASS");
      return;
    }
    if (action === "verify") {
      await assertPostApply(client);
      console.log("MIGRATION_008_VERIFY: PASS");
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
    console.log("MIGRATION_008_TRANSACTION: COMMIT");
    await assertPostApply(client);
    console.log("MIGRATION_008_APPLY: PASS");
  } finally {
    await client.end();
  }
}

run().catch(error => {
  console.error(`MIGRATION_008_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
