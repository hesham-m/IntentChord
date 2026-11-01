import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "010_workspace_index_snapshots_and_context_decisions.sql";
const baselineIds = [
  "001_intentchord_vertical_slice.sql",
  "002_backend_authoritative_lifecycle.sql",
  "003_owner_decision_ledger.sql",
  "004_trust_invariants_and_authoritative_projection.sql",
  "005_semantic_trust_hardening.sql",
  "006_intelligence_and_evidence_semantics.sql",
  "007_project_context_and_truth_registry.sql",
  "008_project_truth_database_clock_authority.sql",
  "009_ai_context_mapper_v1.sql",
];
const laterMigrationIds = [
  "011_workspace_index_runtime_governance.sql",
  "012_workspace_revision_observation_and_index_artifacts.sql",
  "013_internal_ai_engine_runtime_identity_decoupling.sql",
];
const hashes = new Map([
  ["001_intentchord_vertical_slice.sql", "2EA16FE625DE4CCE441E6B291CD4978BD0570F8A8A21FEE0EA1708E41BE6A352"],
  ["002_backend_authoritative_lifecycle.sql", "ECDC2623ABB4A8C54398070B96B1AB00DF8720A85308F0E55C129DEE8AE18A22"],
  ["003_owner_decision_ledger.sql", "E4269AF86BACB9C3E6DE06A1300B6A7BDE358A3CA55F939E7EA340E9DD544645"],
  ["004_trust_invariants_and_authoritative_projection.sql", "22E66A8206CB9E354BBFD7A81B4FD54C8FC00B07B472F7369E94151DBA83AFBE"],
  ["005_semantic_trust_hardening.sql", "605F65F85F97E0C814B2A75F82D711E29D7855DAB28621A12CCDBD9020EA9D71"],
  ["006_intelligence_and_evidence_semantics.sql", "CA9F4854EC95A07CAAAAFBF154D94A0494AC04150BD5CC4A803FDC07DA6555D6"],
  ["007_project_context_and_truth_registry.sql", "FC345BC3BBA52236E658E6FC41885B42B23D48FDCB312170A26DD689539FAA95"],
  ["008_project_truth_database_clock_authority.sql", "89BEB9995D86A030C21F76C73E6982BF6A86DE96A95272F75257AB1419F15644"],
  ["009_ai_context_mapper_v1.sql", "58AA2A34F2C220A6D7F17CBE0F9D7A55C783E563A16D0D552D1BC63D02815065"],
  [migrationId, "AE123F5241423A6651B1C7A653B9154546E4C7D8598A598E7A4B5923F9378A09"],
]);

function fail(code, details = "") {
  throw new Error(`${code}${details ? `: ${details}` : ""}`);
}

async function loadUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) fail("DATABASE_URL_NOT_FOUND");
  return match[1].trim();
}

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase();
}

async function verifySources() {
  for (const [id, expected] of hashes) {
    const file = `migrations/${id}`;
    try {
      if (!(await stat(file)).isFile()) fail("MIGRATION_SOURCE_NOT_FILE", id);
    } catch {
      fail("MIGRATION_SOURCE_NOT_FOUND", id);
    }
    const actual = await hashFile(file);
    if (actual !== expected) fail("MIGRATION_SOURCE_HASH_MISMATCH", `${id} expected=${expected} actual=${actual}`);
  }
  console.log("MIGRATION_SOURCE_HASHES: PASS count=10");
}

async function assertIdentity(client) {
  const { rows: [row] } = await client.query(
    "select current_database() as database,current_user as role,current_schema() as schema",
  );
  if (row.database !== "intentchord_dev" || row.role !== "intentchord_app" || row.schema !== "intentchord") {
    fail("DATABASE_IDENTITY_BLOCKER", JSON.stringify(row));
  }
  console.log("DATABASE_IDENTITY: PASS database=intentchord_dev role=intentchord_app schema=intentchord");
}

async function migrationIds(client) {
  return (await client.query("select id from intentchord.schema_migrations order by id")).rows.map(row => row.id);
}

function exact(actual, expected, code) {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail(code, `expected=${expected.join(",")} actual=${actual.join(",")}`);
  }
}

async function state(client) {
  const actual = await migrationIds(client);
  if (actual.length === baselineIds.length && actual.every((id, index) => id === baselineIds[index])) return "NOT_APPLIED";
  const requiredPrefix = [...baselineIds, migrationId];
  const prefixMatches = requiredPrefix.every((id, index) => actual[index] === id);
  const suffix = actual.slice(requiredPrefix.length);
  const suffixMatches = suffix.length <= laterMigrationIds.length
    && suffix.every((id, index) => id === laterMigrationIds[index]);
  if (actual.length >= requiredPrefix.length && prefixMatches && suffixMatches) return "APPLIED";
  fail("MIGRATION_010_BASELINE_BLOCKER", `actual=${actual.join(",")}`);
}

async function verifyObjects(client) {
  for (const table of ["workspace_index_snapshots", "context_mapping_owner_context_decisions"]) {
    const result = await client.query("select to_regclass($1) as name", [`intentchord.${table}`]);
    if (!result.rows[0].name) fail("MIGRATION_010_TABLE_MISSING", table);
  }
  const columns = await client.query(
    `select column_name from information_schema.columns
     where table_schema='intentchord' and table_name='context_mapping_runs'
       and column_name=any($1::text[])`,
    [["workspace_index_snapshot_id", "mapping_idempotency_key", "mapping_request_fingerprint_sha256"]],
  );
  if (columns.rowCount !== 3) fail("MIGRATION_010_MAPPING_COLUMNS_MISSING");

  const requiredTriggers = [
    "workspace_index_snapshots_governed_update",
    "workspace_index_snapshots_append_only_delete",
    "context_mapping_runs_snapshot_insert_guard",
    "context_mapping_owner_context_decisions_insert_guard",
    "context_mapping_owner_context_decisions_append_only",
  ];
  const triggerRows = await client.query(
    "select tgname from pg_trigger where not tgisinternal and tgname=any($1::text[])",
    [requiredTriggers],
  );
  const triggerNames = new Set(triggerRows.rows.map(row => row.tgname));
  const missingTriggers = requiredTriggers.filter(name => !triggerNames.has(name));
  if (missingTriggers.length) fail("MIGRATION_010_TRIGGERS_MISSING", missingTriggers.join(","));

  const constraints = [
    "context_mapping_runs_workspace_snapshot_fk",
    "context_mapping_runs_snapshot_binding_shape_ck",
    "context_catalog_proposals_id_run_uq",
    "context_mapping_owner_context_decisions_proposal_run_fk",
    "context_mapping_owner_context_decisions_run_context_uq",
  ];
  const constraintRows = await client.query(
    "select conname from pg_constraint where connamespace='intentchord'::regnamespace and conname=any($1::text[])",
    [constraints],
  );
  const constraintNames = new Set(constraintRows.rows.map(row => row.conname));
  const missingConstraints = constraints.filter(name => !constraintNames.has(name));
  if (missingConstraints.length) fail("MIGRATION_010_CONSTRAINTS_MISSING", missingConstraints.join(","));

  console.log("MIGRATION_010_OBJECTS: PASS tables=2 mapping_columns=3 triggers=5 constraints=5");
}

async function expectFailure(client, savepoint, sql, params, expected) {
  await client.query(`savepoint ${savepoint}`);
  let failed = false;
  try {
    await client.query(sql, params);
  } catch (error) {
    failed = true;
    if (!String(error instanceof Error ? error.message : error).includes(expected)) throw error;
  }
  await client.query(`rollback to savepoint ${savepoint}`);
  if (!failed) fail("MIGRATION_010_NEGATIVE_PROBE_DID_NOT_FAIL", expected);
}

async function qualificationProbes(client) {
  const snapshotId = randomUUID();
  const zero = `sha256:${"0".repeat(64)}`;
  const one = `sha256:${"1".repeat(64)}`;
  await client.query(
    `insert into intentchord.workspace_index_snapshots(
      id,source_mode,status,governed_scope,snapshot_idempotency_key,snapshot_request_fingerprint_sha256,
      canonical_contract_version,canonical_index_json,canonical_sha256,owner_reference,started_at,completed_at
    ) values($1,'ADVANCED_DIAGNOSTIC','READY','{"filesystemRead":false}'::jsonb,$2,$3,'1.0.0','{}'::jsonb,$4,'migration-010-qualify',clock_timestamp(),clock_timestamp())`,
    [snapshotId, `snapshot-probe-${snapshotId}`, one, zero],
  );
  await expectFailure(
    client,
    "snapshot_update_block",
    "update intentchord.workspace_index_snapshots set canonical_sha256=$2 where id=$1",
    [snapshotId, one],
    "INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_TRANSITION_BLOCKED",
  );
  await expectFailure(
    client,
    "snapshot_delete_block",
    "delete from intentchord.workspace_index_snapshots where id=$1",
    [snapshotId],
    "INTENTCHORD_WORKSPACE_INDEX_SNAPSHOT_APPEND_ONLY",
  );
  await expectFailure(
    client,
    "mapping_snapshot_required",
    "insert into intentchord.context_mapping_runs(id) values($1)",
    [randomUUID()],
    "INTENTCHORD_CONTEXT_MAPPING_SNAPSHOT_BINDING_REQUIRED",
  );
  console.log("MIGRATION_010_GOVERNANCE_PROBES: PASS");
}

async function preflight(client) {
  const current = await state(client);
  if (current === "APPLIED") await verifyObjects(client);
  console.log("MIGRATION_BASELINE_001_009: PASS");
  console.log(`MIGRATION_010_STATE: ${current}`);
  return current;
}

async function qualify(client, migrationSql) {
  const current = await preflight(client);
  await client.query("begin");
  try {
    await client.query(migrationSql);
    await client.query(migrationSql);
    await verifyObjects(client);
    await qualificationProbes(client);
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  console.log(`MIGRATION_010_QUALIFY: PASS source_state=${current} transaction=ROLLBACK`);
}

async function verifyApplied(client) {
  const current = await state(client);
  if (current !== "APPLIED") fail("MIGRATION_010_POST_STATE_BLOCKER", `state=${current}`);
  await verifyObjects(client);
  console.log("MIGRATION_010_STATE: APPLIED");
}

async function main() {
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) fail("MIGRATION_010_ACTION_INVALID", String(action));
  await verifySources();
  const migrationSql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await loadUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    if (action === "preflight") {
      await preflight(client);
      console.log("MIGRATION_010_PREFLIGHT: PASS");
      return;
    }
    if (action === "qualify") {
      await qualify(client, migrationSql);
      return;
    }
    if (action === "verify") {
      await verifyApplied(client);
      console.log("MIGRATION_010_VERIFY: PASS");
      return;
    }
    const current = await preflight(client);
    if (current === "APPLIED") {
      await verifyApplied(client);
      console.log("MIGRATION_010_APPLY: PASS already_applied=true");
      return;
    }
    await client.query("begin");
    try {
      await client.query(migrationSql);
      await verifyObjects(client);
      await client.query("insert into intentchord.schema_migrations(id) values($1)", [migrationId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    console.log("MIGRATION_010_TRANSACTION: COMMIT");
    await verifyApplied(client);
    console.log("MIGRATION_010_APPLY: PASS already_applied=false");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`MIGRATION_010_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
