import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "026_internal_ai_vendor_website_url.sql";
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
  "023_internal_ai_vendors_and_models.sql",
  "024_internal_ai_credentials.sql",
  "025_engine_binding_vendor_model_and_revision_immutability.sql",
];
const expectedSha256 = "74E44B75BCB7382E845AA06CD60A9028A19DC32B28081791EFF618ECB85830BE";

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

async function sourceHash() {
  return createHash("sha256")
    .update(await readFile(`migrations/${migrationId}`))
    .digest("hex")
    .toUpperCase();
}

async function assertSourceHash() {
  const actual = await sourceHash();
  if (actual !== expectedSha256) {
    fail("MIGRATION_026_SOURCE_HASH_MISMATCH", `expected=${expectedSha256} actual=${actual}`);
  }
  console.log(`MIGRATION_026_SOURCE_HASH: PASS sha256=${actual}`);
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
  const missing = baselineIds.filter(id => !ids.includes(id));
  if (missing.length) fail("MIGRATION_026_BASELINE_BLOCKER", missing.join(","));
  return ids.includes(migrationId) ? "APPLIED" : "NOT_APPLIED";
}
async function assertObjects(client) {
  const col = await client.query(
    `select column_name from information_schema.columns
       where table_schema='intentchord'
         and table_name='internal_ai_vendors'
         and column_name='website_url'`,
  );
  if (!col.rowCount) fail("MIGRATION_026_COLUMN_MISSING", "website_url");

  const constraint = await client.query(
    `select conname from pg_constraint
       where conrelid='intentchord.internal_ai_vendors'::regclass
         and conname='ck_internal_ai_vendor_website_url'`,
  );
  if (!constraint.rowCount) fail("MIGRATION_026_CONSTRAINT_MISSING", "ck_internal_ai_vendor_website_url");

  console.log("MIGRATION_026_OBJECTS: PASS website_url + https constraint");
}

async function main() {
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) {
    fail("MIGRATION_026_ACTION_INVALID", String(action));
  }
  await assertSourceHash();
  const sql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await databaseUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    const current = await state(client);
    console.log(`MIGRATION_026_STATE: ${current}`);
    if (action === "preflight") {
      if (current === "APPLIED") await assertObjects(client);
      console.log("MIGRATION_026_PREFLIGHT: PASS");
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
      console.log(`MIGRATION_026_QUALIFY: PASS source_state=${current} transaction=ROLLBACK`);
      return;
    }

    if (action === "verify") {
      if (current !== "APPLIED") fail("MIGRATION_026_NOT_APPLIED");
      await assertObjects(client);
      console.log("MIGRATION_026_VERIFY: PASS");
      return;
    }

    if (current === "APPLIED") {
      await assertObjects(client);
      console.log("MIGRATION_026_APPLY: PASS already_applied=true");
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
    console.log("MIGRATION_026_APPLY: PASS already_applied=false");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`MIGRATION_026_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
