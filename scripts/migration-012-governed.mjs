import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "012_workspace_revision_observation_and_index_artifacts.sql";
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
];
const expectedSha256 = "CCED6C5730F2833633A296B30DA6BA562E33880F00C0B98A8CE588F3B379253C";
const requiredTables = [
  "workspace_source_revisions",
  "canonical_index_artifacts",
  "workspace_index_delta_artifacts",
  "workspace_observations",
  "workspace_revision_transitions",
];
const requiredWorkspaceColumns = [
  "verified_root_real_path",
  "verified_root_device_id",
  "verified_root_file_id",
  "verified_root_identity_method",
  "verified_root_verified_at",
  "root_authority_state",
  "current_root_real_path",
  "current_root_device_id",
  "current_root_file_id",
  "current_root_identity_method",
  "root_authority_checked_at",
];
const requiredSnapshotColumns = [
  "workspace_observation_id",
  "workspace_revision_id",
  "canonical_index_artifact_id",
  "index_configuration_sha256",
  "observation_result",
  "delta_artifact_id",
  "scan_base_observation_id",
  "index_attempt_status",
  "index_attempt_evidence",
  "index_attempt_candidate_json",
  "index_attempt_candidate_sha256",
];
const requiredArtifactColumns = ["artifact_semantic_sha256", "artifact_semantic_json"];
const requiredObservationColumns = ["authority_sequence", "previous_observation_id"];
const requiredTransitionColumns = ["lineage_evidence_json"];
const requiredMappingRunColumns = ["canonical_index_artifact_id", "artifact_semantic_sha256"];
const requiredConstraints = [
  ["workspaces", "workspaces_root_authority_state_ck"],
  ["workspaces", "workspaces_verified_root_identity_shape_ck"],
  ["workspaces", "workspaces_current_root_identity_shape_ck"],
  ["workspaces", "workspaces_root_authority_binding_shape_ck"],
  ["workspace_index_snapshots", "workspace_index_snapshots_scan_base_same_workspace_fk"],
  ["workspace_index_snapshots", "workspace_index_snapshots_scan_base_mode_ck"],
  ["workspace_index_snapshots", "workspace_index_snapshots_b1_binding_shape_ck"],
  ["workspace_index_snapshots", "workspace_index_snapshots_attempt_status_ck"],
  ["workspace_index_snapshots", "workspace_index_snapshots_attempt_hash_ck"],
  ["workspace_observations", "workspace_observations_artifact_shape_ck"],
  ["workspace_observations", "workspace_observations_registration_revision_fk"],
  ["workspace_observations", "workspace_observations_registration_artifact_fk"],
  ["workspace_observations", "workspace_observations_previous_same_workspace_fk"],
];
const requiredTriggers = [
  ["workspace_index_snapshots", "workspace_index_snapshots_governed_update"],
  ["workspace_source_revisions", "workspace_source_revisions_append_only_update"],
  ["canonical_index_artifacts", "canonical_index_artifacts_append_only_update"],
  ["workspace_index_delta_artifacts", "workspace_index_delta_artifacts_append_only_update"],
  ["workspace_observations", "workspace_observations_b1_insert_guard"],
  ["workspace_observations", "workspace_observations_append_only_update"],
  ["workspace_revision_transitions", "workspace_revision_transitions_b1_insert_guard"],
  ["workspace_revision_transitions", "workspace_revision_transitions_append_only_update"],
  ["context_mapping_runs", "context_mapping_runs_snapshot_insert_guard"],
  ["context_mapping_runs", "context_mapping_runs_governed_update"],
];

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
  const actual = createHash("sha256")
    .update(await readFile(`migrations/${migrationId}`))
    .digest("hex")
    .toUpperCase();
  if (actual !== expectedSha256) {
    fail("MIGRATION_012_SOURCE_HASH_MISMATCH", `expected=${expectedSha256} actual=${actual}`);
  }
  console.log("MIGRATION_012_SOURCE_HASH: PASS");
}

async function assertIdentity(client) {
  const { rows: [row] } = await client.query(
    "select current_database() database,current_user role,current_schema() schema",
  );
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
  const applied = [...baselineIds, migrationId];
  if (JSON.stringify(ids) === JSON.stringify(baselineIds)) return "NOT_APPLIED";
  if (JSON.stringify(ids) === JSON.stringify(applied)) return "APPLIED";
  if (JSON.stringify(ids) === JSON.stringify([...applied, "013_internal_ai_engine_runtime_identity_decoupling.sql"])) return "APPLIED";
  fail("MIGRATION_012_BASELINE_BLOCKER", ids.join(","));
}

async function assertObjects(client) {
  const tables = await client.query(
    `select table_name from information_schema.tables
       where table_schema='intentchord' and table_name=any($1::text[])`,
    [requiredTables],
  );
  if (tables.rowCount !== requiredTables.length) fail("MIGRATION_012_TABLES_MISSING");

  const workspaceColumns = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord'
         and table_name='workspaces'
         and column_name=any($1::text[])`,
    [requiredWorkspaceColumns],
  );
  if (workspaceColumns.rowCount !== requiredWorkspaceColumns.length) fail("MIGRATION_012_WORKSPACE_ROOT_AUTHORITY_COLUMNS_MISSING");

  const columns = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord'
         and table_name='workspace_index_snapshots'
         and column_name=any($1::text[])`,
    [requiredSnapshotColumns],
  );
  if (columns.rowCount !== requiredSnapshotColumns.length) fail("MIGRATION_012_SNAPSHOT_COLUMNS_MISSING");

  const legacyRevisionBinding = await client.query(
    `select 1 from information_schema.columns
       where table_schema='intentchord' and table_name='workspace_source_revisions' and column_name='source_binding_id'`,
  );
  if (legacyRevisionBinding.rowCount !== 0) fail("MIGRATION_012_SOURCE_BINDING_LOCALITY_VIOLATION");

  const artifactColumns = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord' and table_name='canonical_index_artifacts' and column_name=any($1::text[])`,
    [requiredArtifactColumns],
  );
  if (artifactColumns.rowCount !== requiredArtifactColumns.length) fail("MIGRATION_012_ARTIFACT_COLUMNS_MISSING");

  const observationColumns = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord' and table_name='workspace_observations' and column_name=any($1::text[])`,
    [requiredObservationColumns],
  );
  if (observationColumns.rowCount !== requiredObservationColumns.length) fail("MIGRATION_012_OBSERVATION_COLUMNS_MISSING");

  const transitionColumns = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord' and table_name='workspace_revision_transitions' and column_name=any($1::text[])`,
    [requiredTransitionColumns],
  );
  if (transitionColumns.rowCount !== requiredTransitionColumns.length) fail("MIGRATION_012_TRANSITION_COLUMNS_MISSING");

  const mappingRunColumns = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord' and table_name='context_mapping_runs' and column_name=any($1::text[])`,
    [requiredMappingRunColumns],
  );
  if (mappingRunColumns.rowCount !== requiredMappingRunColumns.length) fail("MIGRATION_012_MAPPING_RUN_COLUMNS_MISSING");

  for (const [tableName, constraintName] of requiredConstraints) {
    const constraint = await client.query(
      `select 1
         from pg_constraint c
         join pg_class t on t.oid=c.conrelid
         join pg_namespace n on n.oid=t.relnamespace
        where n.nspname='intentchord' and t.relname=$1 and c.conname=$2
        limit 1`,
      [tableName, constraintName],
    );
    if (constraint.rowCount !== 1) fail("MIGRATION_012_CONSTRAINT_MISSING", `${tableName}.${constraintName}`);
  }

  for (const [tableName, triggerName] of requiredTriggers) {
    const trigger = await client.query(
      `select 1 from information_schema.triggers
        where event_object_schema='intentchord'
          and event_object_table=$1
          and trigger_name=$2
        limit 1`,
      [tableName, triggerName],
    );
    if (trigger.rowCount !== 1) fail("MIGRATION_012_APPEND_ONLY_TRIGGER_MISSING", `${tableName}.${triggerName}`);
  }

  console.log(`MIGRATION_012_OBJECTS: PASS tables=${requiredTables.length} workspace_root_authority_columns=${requiredWorkspaceColumns.length} snapshot_columns=${requiredSnapshotColumns.length} artifact_columns=${requiredArtifactColumns.length} observation_columns=${requiredObservationColumns.length} transition_columns=${requiredTransitionColumns.length} mapping_run_columns=${requiredMappingRunColumns.length} governed_constraints=${requiredConstraints.length} governed_triggers=${requiredTriggers.length}`);
}

async function main() {
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) fail("MIGRATION_012_ACTION_INVALID");
  await assertSourceHash();
  const sql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await databaseUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    const currentState = await state(client);
    console.log(`MIGRATION_012_STATE: ${currentState}`);

    if (action === "preflight") {
      if (currentState === "APPLIED") await assertObjects(client);
      console.log("MIGRATION_012_PREFLIGHT: PASS");
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
      console.log(`MIGRATION_012_QUALIFY: PASS source_state=${currentState} transaction=ROLLBACK`);
      return;
    }

    if (action === "verify") {
      if (currentState !== "APPLIED") fail("MIGRATION_012_NOT_APPLIED");
      await assertObjects(client);
      console.log("MIGRATION_012_VERIFY: PASS");
      return;
    }

    if (currentState === "APPLIED") {
      await assertObjects(client);
      console.log("MIGRATION_012_APPLY: PASS already_applied=true");
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
    console.log("MIGRATION_012_APPLY: PASS already_applied=false");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`MIGRATION_012_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
