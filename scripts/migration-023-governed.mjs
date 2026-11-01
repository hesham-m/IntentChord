import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "023_internal_ai_vendors_and_models.sql";
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
  "013_internal_ai_engine_runtime_identity_decoupling.sql",
  "014_governed_context_assembly_and_ai_context_mapping_v2.sql",
  "015_sectioned_evidence_incremental_workspace.sql",
  "016_v2_context_assembly_mapping_binding_reconciliation.sql",
  "017_context_mapping_traversals_and_windows.sql",
  "018_context_mapping_integrity_corrections.sql",
  "019_context_mapping_contract_restoration.sql",
  "020_backend_internal_ai_engine_registry.sql",
  "021_ai_engine_registry_neutrality_and_execution_immutability.sql",
  "022_owner_authentication_foundation.sql",
];
const expectedSha256 = "5166755B3CDE41C843C847DA5B07F0D3955EF8D77D7800055D4091309A0D73F7";

function fail(code, details = "") { throw new Error(`${code}${details ? `: ${details}` : ""}`); }

async function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) fail("DATABASE_URL_NOT_FOUND");
  return match[1].trim();
}

async function assertSourceHash() {
  const actual = createHash("sha256").update(await readFile(`migrations/${migrationId}`)).digest("hex").toUpperCase();
  if (actual !== expectedSha256) fail("MIGRATION_023_SOURCE_HASH_MISMATCH", `expected=${expectedSha256} actual=${actual}`);
  console.log(`MIGRATION_023_SOURCE_HASH: PASS sha256=${actual}`);
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
  const hasBaseline = baselineIds.every(id => ids.includes(id));
  if (!hasBaseline) fail("MIGRATION_023_BASELINE_BLOCKER", ids.join(","));
  return ids.includes(migrationId) ? "APPLIED" : "NOT_APPLIED";
}

async function assertObjects(client) {
  const requiredTables = ["internal_ai_vendors", "internal_ai_models"];
  const tables = await client.query(
    `select table_name from information_schema.tables where table_schema='intentchord' and table_name=any($1::text[])`,
    [requiredTables],
  );
  const present = new Set(tables.rows.map(row => row.table_name));
  const missing = requiredTables.filter(name => !present.has(name));
  if (missing.length) fail("MIGRATION_023_TABLES_MISSING", missing.join(","));

  const vendorCols = await client.query(
    `select column_name from information_schema.columns where table_schema='intentchord' and table_name='internal_ai_vendors'`,
  );
  const vendorColSet = new Set(vendorCols.rows.map(row => row.column_name));
  for (const required of ["vendor_id", "display_name", "vendor_state", "base_url", "auth_type", "protocol_profile", "credential_reference", "created_at", "updated_at"]) {
    if (!vendorColSet.has(required)) fail("MIGRATION_023_VENDOR_COLUMN_MISSING", required);
  }

  const modelCols = await client.query(
    `select column_name from information_schema.columns where table_schema='intentchord' and table_name='internal_ai_models'`,
  );
  const modelColSet = new Set(modelCols.rows.map(row => row.column_name));
  for (const required of ["vendor_id", "model_id", "display_name", "model_state", "provider_facing_model_id", "capability_metadata", "runtime_compatibility_metadata"]) {
    if (!modelColSet.has(required)) fail("MIGRATION_023_MODEL_COLUMN_MISSING", required);
  }

  console.log(`MIGRATION_023_OBJECTS: PASS tables=${requiredTables.length}`);
  console.log("VENDOR_FIRST_CLASS_DOMAIN: PASS");
  console.log("MODEL_UNDER_VENDOR: PASS");
}

async function main() {
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) fail("MIGRATION_023_ACTION_INVALID", String(action));
  await assertSourceHash();
  const sql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await databaseUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    const current = await state(client);
    console.log(`MIGRATION_023_STATE: ${current}`);
    if (action === "preflight") {
      if (current === "APPLIED") await assertObjects(client);
      console.log("MIGRATION_023_PREFLIGHT: PASS");
      return;
    }
    if (action === "qualify") {
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(sql);
        await assertObjects(client);
        await client.query("rollback");
      } catch (error) { await client.query("rollback"); throw error; }
      console.log(`MIGRATION_023_QUALIFY: PASS source_state=${current} transaction=ROLLBACK`);
      return;
    }
    if (action === "verify") {
      if (current !== "APPLIED") fail("MIGRATION_023_NOT_APPLIED");
      await assertObjects(client);
      console.log("MIGRATION_023_VERIFY: PASS");
      return;
    }
    if (current === "APPLIED") {
      await assertObjects(client);
      console.log("MIGRATION_023_APPLY: PASS already_applied=true");
      return;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into intentchord.schema_migrations(id) values($1)", [migrationId]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    await assertObjects(client);
    console.log("MIGRATION_023_APPLY: PASS already_applied=false");
  } finally { await client.end(); }
}

main().catch(error => {
  console.error(`MIGRATION_023_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
