import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "013_internal_ai_engine_runtime_identity_decoupling.sql";
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
  "010_workspace_index_snapshots_and_context_decisions.sql",
  "011_workspace_index_runtime_governance.sql",
  "012_workspace_revision_observation_and_index_artifacts.sql",
];
const expectedSha256 = "D89E8F42522F2A458289EA130CD07EB3A1D51A5E585FA5C9369F807BCEC0C7AD";

function fail(code, details = "") {
  throw new Error(`${code}${details ? `: ${details}` : ""}`);
}

async function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) fail("DATABASE_URL_NOT_FOUND");
  return match[1].trim();
}

async function assertSourceHash() {
  const actual = createHash("sha256").update(await readFile(`migrations/${migrationId}`)).digest("hex").toUpperCase();
  if (actual !== expectedSha256) fail("MIGRATION_013_SOURCE_HASH_MISMATCH", `expected=${expectedSha256} actual=${actual}`);
  console.log(`MIGRATION_013_SOURCE_HASH: PASS sha256=${actual}`);
}

async function assertIdentity(client) {
  const { rows: [row] } = await client.query("select current_database() database,current_user role,current_schema() schema");
  if (row.database !== "intentchord_dev" || row.role !== "intentchord_app" || row.schema !== "intentchord") {
    fail("DATABASE_IDENTITY_BLOCKER", JSON.stringify(row));
  }
  console.log("DATABASE_IDENTITY: PASS database=intentchord_dev role=intentchord_app schema=intentchord");
}

async function migrationIds(client) {
  return (await client.query("select id from intentchord.schema_migrations order by id")).rows.map(row => row.id);
}

async function state(client) {
  const ids = await migrationIds(client);
  if (JSON.stringify(ids) === JSON.stringify(baselineIds)) return "NOT_APPLIED";
  if (JSON.stringify(ids) === JSON.stringify([...baselineIds, migrationId])) return "APPLIED";
  fail("MIGRATION_013_BASELINE_BLOCKER", ids.join(","));
}

async function assertObjects(client) {
  const required = [
    "context_mapping_runs_primary_engine_identity_ck",
    "context_mapping_runs_standby_engine_identity_ck",
    "context_mapping_runs_provider_configuration_snapshot_shape_ck",
    "context_mapping_attempts_engine_identity_shape_ck",
  ];
  const constraints = await client.query(
    `select conname from pg_constraint
       where connamespace='intentchord'::regnamespace and conname=any($1::text[])`,
    [required],
  );
  const present = new Set(constraints.rows.map(row => row.conname));
  const missing = required.filter(name => !present.has(name));
  if (missing.length) fail("MIGRATION_013_CONSTRAINTS_MISSING", missing.join(","));

  const oldConstraints = [
    "context_mapping_runs_primary_provider_id_check",
    "context_mapping_runs_primary_channel_id_check",
    "context_mapping_runs_primary_model_id_check",
    "context_mapping_runs_standby_provider_id_check",
    "context_mapping_runs_standby_channel_id_check",
    "context_mapping_runs_standby_model_id_check",
    "context_mapping_attempts_provider_id_check",
    "context_mapping_attempts_fixed_channel_ck",
  ];
  const old = await client.query(
    `select conname from pg_constraint
       where connamespace='intentchord'::regnamespace and conname=any($1::text[])`,
    [oldConstraints],
  );
  if (old.rowCount) fail("MIGRATION_013_LITERAL_ENGINE_CONSTRAINT_REMAINS", old.rows.map(row => row.conname).join(","));

  const standbyColumns = await client.query(
    `select column_name,is_nullable from information_schema.columns
       where table_schema='intentchord' and table_name='context_mapping_runs'
         and column_name=any($1::text[])`,
    [["standby_provider_id", "standby_channel_id", "standby_model_id"]],
  );
  if (standbyColumns.rowCount !== 3 || standbyColumns.rows.some(row => row.is_nullable !== "YES")) {
    fail("MIGRATION_013_OPTIONAL_STANDBY_COLUMNS_NOT_NULLABLE");
  }

  const runtimeTrigger = await client.query(
    `select 1 from pg_trigger where not tgisinternal and tgrelid='intentchord.context_mapping_runs'::regclass
       and tgname='context_mapping_runs_runtime_configuration_v013'`,
  );
  if (!runtimeTrigger.rowCount) fail("MIGRATION_013_RUNTIME_CONFIGURATION_TRIGGER_MISSING");

  const runtimeGuard = await client.query(
    `select pg_get_functiondef('intentchord.context_mapping_run_insert_guard_v013()'::regprocedure) definition`,
  );
  const runtimeDefinition = runtimeGuard.rows[0]?.definition ?? "";
  for (const marker of [
    "intentchord.internal-ai-provider-configuration.v3",
    "intentchord.internal-ai-engine-registry.v2",
    "AI_CONTEXT_MAPPING_V1",
    "SINGLE",
    "selected_engine_configuration_sha256",
    "engine_configuration_sha256",
    "internal_ai_engine_configuration_sha256_v1",
    "INTENTCHORD_CONTEXT_MAPPING_RUNTIME_CONFIGURATION_V3_EXACT_QUALIFICATION_REQUIRED",
  ]) if (!runtimeDefinition.includes(marker)) fail("MIGRATION_013_RUNTIME_CONFIGURATION_GUARD_MARKER_MISSING", marker);

  const fingerprintFunction = await client.query(
    `select pg_get_functiondef('intentchord.internal_ai_engine_configuration_sha256_v1(jsonb)'::regprocedure) definition`,
  );
  const fingerprintDefinition = fingerprintFunction.rows[0]?.definition ?? "";
  for (const marker of [
    "intentchord.internal-ai-engine-configuration-identity.v1", "credential_reference", "timeout_ms", "sha256",
  ]) if (!fingerprintDefinition.includes(marker)) fail("MIGRATION_013_ENGINE_CONFIGURATION_FINGERPRINT_FUNCTION_MARKER_MISSING", marker);

  const attemptGuard = await client.query(
    `select pg_get_functiondef('intentchord.context_mapping_attempt_insert_guard()'::regprocedure) definition`,
  );
  const attemptDefinition = attemptGuard.rows[0]?.definition ?? "";
  for (const marker of [
    "INTENTCHORD_CONTEXT_MAPPING_PRIMARY_ATTEMPT_ENGINE_MISMATCH",
    "INTENTCHORD_CONTEXT_MAPPING_STANDBY_ATTEMPT_ENGINE_MISMATCH",
    "primary_provider_id",
    "standby_provider_id",
  ]) if (!attemptDefinition.includes(marker)) fail("MIGRATION_013_ATTEMPT_GUARD_MARKER_MISSING", marker);

  const proposalGuard = await client.query(
    `select pg_get_functiondef('intentchord.context_catalog_proposal_insert_guard()'::regprocedure) definition`,
  );
  const proposalDefinition = proposalGuard.rows[0]?.definition ?? "";
  for (const marker of [
    "requested_model_id",
    "response_model_id",
    "provider_request_id",
    "provider_system_fingerprint",
    "INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_PROVENANCE_MISMATCH",
  ]) if (!proposalDefinition.includes(marker)) fail("MIGRATION_013_PROPOSAL_GUARD_MARKER_MISSING", marker);

  console.log(`MIGRATION_013_OBJECTS: PASS constraints=${required.length} optional_standby_columns=3 runtime_insert_guard=1 provenance_guards=2`);
}

async function main() {
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) fail("MIGRATION_013_ACTION_INVALID", String(action));
  await assertSourceHash();
  const sql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await databaseUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    const current = await state(client);
    console.log(`MIGRATION_013_STATE: ${current}`);

    if (action === "preflight") {
      if (current === "APPLIED") await assertObjects(client);
      console.log("MIGRATION_013_PREFLIGHT: PASS");
      return;
    }

    if (action === "qualify") {
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(sql);
        await assertObjects(client);
        await client.query("rollback");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      console.log(`MIGRATION_013_QUALIFY: PASS source_state=${current} transaction=ROLLBACK`);
      return;
    }

    if (action === "verify") {
      if (current !== "APPLIED") fail("MIGRATION_013_NOT_APPLIED");
      await assertObjects(client);
      console.log("MIGRATION_013_VERIFY: PASS");
      return;
    }

    if (current === "APPLIED") {
      await assertObjects(client);
      console.log("MIGRATION_013_APPLY: PASS already_applied=true");
      return;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into intentchord.schema_migrations(id) values($1)", [migrationId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    await assertObjects(client);
    console.log("MIGRATION_013_APPLY: PASS already_applied=false");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`MIGRATION_013_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
