import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import pg from "pg";

const action = process.argv[2];
const migrationId = "009_ai_context_mapper_v1.sql";
const baselineIds = [
  "001_intentchord_vertical_slice.sql",
  "002_backend_authoritative_lifecycle.sql",
  "003_owner_decision_ledger.sql",
  "004_trust_invariants_and_authoritative_projection.sql",
  "005_semantic_trust_hardening.sql",
  "006_intelligence_and_evidence_semantics.sql",
  "007_project_context_and_truth_registry.sql",
  "008_project_truth_database_clock_authority.sql",
];
const laterMigrationIds = [
  "010_workspace_index_snapshots_and_context_decisions.sql",
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
  [migrationId, "58AA2A34F2C220A6D7F17CBE0F9D7A55C783E563A16D0D552D1BC63D02815065"],
]);
const tables = ["context_mapping_runs", "context_mapping_attempts", "context_catalog_proposals", "context_mapping_owner_verdicts"];
const triggers = [
  "context_mapping_runs_governed_update",
  "context_mapping_runs_touch_updated_at",
  "context_mapping_attempts_insert_guard",
  "context_mapping_attempts_update_guard",
  "context_catalog_proposals_insert_guard",
  "context_catalog_proposals_append_only_update",
  "context_mapping_owner_verdicts_insert_guard",
  "context_mapping_owner_verdicts_append_only_update",
];
const constraints = [
  "context_mapping_runs_final_attempt_fk",
  "context_mapping_runs_standby_governance_ck",
  "context_mapping_attempts_run_ordinal_uq",
  "context_mapping_attempts_id_run_uq",
  "context_mapping_attempts_prompt_identity_ck",
  "context_mapping_attempts_completion_ck",
  "context_mapping_attempts_validation_ck",
  "context_catalog_proposals_attempt_run_fk",
  "context_catalog_proposals_validation_ck",
  "context_catalog_proposals_envelope_schema_ck",
];

function fail(code, details = "") { throw new Error(`${code}${details ? `: ${details}` : ""}`); }
async function loadUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) fail("DATABASE_URL_NOT_FOUND");
  return match[1].trim();
}
async function hashFile(file) { return createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase(); }
async function verifySources() {
  for (const [id, expected] of hashes) {
    const file = `migrations/${id}`;
    try { if (!(await stat(file)).isFile()) fail("MIGRATION_SOURCE_NOT_FILE", id); } catch { fail("MIGRATION_SOURCE_NOT_FOUND", id); }
    const actual = await hashFile(file);
    if (actual !== expected) fail("MIGRATION_SOURCE_HASH_MISMATCH", `${id} expected=${expected} actual=${actual}`);
  }
  console.log("MIGRATION_SOURCE_HASHES: PASS count=9");
}
async function assertIdentity(client) {
  const { rows: [row] } = await client.query("select current_database() as database,current_user as role,current_schema() as schema");
  if (row.database !== "intentchord_dev" || row.role !== "intentchord_app" || row.schema !== "intentchord") fail("DATABASE_IDENTITY_BLOCKER", JSON.stringify(row));
  console.log("DATABASE_IDENTITY: PASS database=intentchord_dev role=intentchord_app schema=intentchord");
}
async function migrationIds(client) { return (await client.query("select id from intentchord.schema_migrations order by id")).rows.map(row => row.id); }
function exact(actual, expected, code) { if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) fail(code, `expected=${expected.join(",")} actual=${actual.join(",")}`); }
async function objectPresence(client) {
  const present = [];
  for (const table of tables) if ((await client.query("select to_regclass($1) as name", [`intentchord.${table}`])).rows[0].name) present.push(table);
  return present;
}
async function state(client) {
  const ids = await migrationIds(client);
  if (ids.length === baselineIds.length && ids.every((id, index) => id === baselineIds[index])) return "NOT_APPLIED";
  const requiredPrefix = [...baselineIds, migrationId];
  const prefixMatches = requiredPrefix.every((id, index) => ids[index] === id);
  const suffix = ids.slice(requiredPrefix.length);
  const suffixMatches = suffix.length <= laterMigrationIds.length
    && suffix.every((id, index) => id === laterMigrationIds[index]);
  if (ids.length >= requiredPrefix.length && prefixMatches && suffixMatches) return "APPLIED";
  fail("MIGRATION_009_BASELINE_BLOCKER", `actual=${ids.join(",")}`);
}
async function verifyObjects(client) {
  const present = await objectPresence(client);
  const missing = tables.filter(table => !present.includes(table));
  if (missing.length) fail("MIGRATION_009_TABLES_MISSING", missing.join(","));
  const triggerRows = await client.query(
    "select tgname from pg_trigger where not tgisinternal and tgname=any($1::text[]) order by tgname",
    [triggers],
  );
  const actualTriggers = triggerRows.rows.map(row => row.tgname);
  const missingTriggers = triggers.filter(name => !actualTriggers.includes(name));
  if (missingTriggers.length) fail("MIGRATION_009_TRIGGERS_MISSING", missingTriggers.join(","));
  const constraintRows = await client.query(
    "select conname from pg_constraint where connamespace='intentchord'::regnamespace and conname=any($1::text[]) order by conname",
    [constraints],
  );
  const actualConstraints = constraintRows.rows.map(row => row.conname);
  const missingConstraints = constraints.filter(name => !actualConstraints.includes(name));
  if (missingConstraints.length) fail("MIGRATION_009_CONSTRAINTS_MISSING", missingConstraints.join(","));
  const ids = await migrationIds(client);
  const identityDecouplingApplied = ids.includes("013_internal_ai_engine_runtime_identity_decoupling.sql");
  const identityConstraints = identityDecouplingApplied
    ? [
        "context_mapping_runs_primary_engine_identity_ck",
        "context_mapping_runs_standby_engine_identity_ck",
        "context_mapping_runs_provider_configuration_snapshot_shape_ck",
        "context_mapping_attempts_engine_identity_shape_ck",
      ]
    : ["context_mapping_attempts_fixed_channel_ck"];
  const identityConstraintRows = await client.query(
    "select conname from pg_constraint where connamespace='intentchord'::regnamespace and conname=any($1::text[]) order by conname",
    [identityConstraints],
  );
  const presentIdentityConstraints = identityConstraintRows.rows.map(row => row.conname);
  const missingIdentityConstraints = identityConstraints.filter(name => !presentIdentityConstraints.includes(name));
  if (missingIdentityConstraints.length) fail("MIGRATION_009_CURRENT_IDENTITY_CONSTRAINTS_MISSING", missingIdentityConstraints.join(","));
  if (identityDecouplingApplied) {
    const oldFixed = await client.query(
      "select 1 from pg_constraint where connamespace='intentchord'::regnamespace and conname='context_mapping_attempts_fixed_channel_ck'",
    );
    if (oldFixed.rowCount) fail("MIGRATION_013_FIXED_ENGINE_CONSTRAINT_STILL_PRESENT");
  }
  const envelope = await client.query(
    "select 1 from information_schema.columns where table_schema='intentchord' and table_name='context_catalog_proposals' and column_name='result_envelope' and is_nullable='NO'",
  );
  if (!envelope.rowCount) fail("MIGRATION_009_RESULT_ENVELOPE_COLUMN_MISSING");
  console.log(`MIGRATION_009_OBJECTS: PASS tables=${tables.length} triggers=${triggers.length} constraints=${constraints.length + identityConstraints.length}`);
}
async function preflight(client) {
  const current = await state(client);
  const present = await objectPresence(client);
  if (current === "NOT_APPLIED" && present.length) fail("MIGRATION_009_PARTIAL_OBJECTS_BLOCKER", present.join(","));
  if (current === "APPLIED") await verifyObjects(client);
  console.log("MIGRATION_BASELINE_001_008: PASS");
  console.log(`MIGRATION_009_STATE: ${current}`);
  return current;
}

async function expectFailure(client, savepoint, sql, params, expected) {
  await client.query(`savepoint ${savepoint}`);
  let failed = false;
  try { await client.query(sql, params); }
  catch (error) {
    failed = true;
    if (!String(error instanceof Error ? error.message : error).includes(expected)) throw error;
  }
  await client.query(`rollback to savepoint ${savepoint}`);
  if (!failed) fail("MIGRATION_009_NEGATIVE_PROBE_DID_NOT_FAIL", expected);
}

async function qualificationProbes(client) {
  const zero = `sha256:${"0".repeat(64)}`;
  const one = `sha256:${"1".repeat(64)}`;
  const two = `sha256:${"2".repeat(64)}`;
  const promptHash = "sha256:b7349b1636adaf04291f2bfdde7d34a0ebc91753865cd5e7c06c795ee5bfd477";
  const run1 = randomUUID();
  const attempt1 = randomUUID();
  const blockedStandbyAttempt = randomUUID();
  const run2 = randomUUID();
  const attempt2 = randomUUID();
  const proposal2 = randomUUID();
  const invalidProposal2 = randomUUID();
  const verdict2 = randomUUID();
  const runInsert = `insert into intentchord.context_mapping_runs(
    id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
    workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
    eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
    primary_provider_id,primary_channel_id,primary_model_id,
    standby_provider_id,standby_channel_id,standby_model_id,standby_enabled,
    standby_governance_state,provider_configuration_snapshot
  ) values($1,'mis_probe',$2,'{}'::jsonb,'1.0.0','wsr_probe',$3,1,0,1,'CREATED',
    'zai','zai_direct_chat_completions_v4','glm-4.7-flash',
    'sambanova','sambanova_direct_chat_completions_v1','gpt-oss-120b',false,
    'BLOCKED_BY_GOVERNANCE','{}'::jsonb)`;
  await client.query(runInsert, [run1, zero, one]);
  await expectFailure(client, "attempt_before_state", `insert into intentchord.context_mapping_attempts(
    id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,prompt_template_id,prompt_template_sha256,status,started_at
  ) values($1,$2,1,'zai','zai_direct_chat_completions_v4','glm-4.7-flash','intentchord_ai_context_mapper_system_v1',$3,'RUNNING',clock_timestamp())`, [attempt1, run1, promptHash], "PRIMARY_ATTEMPT_STATE_BLOCKED");
  await client.query("update intentchord.context_mapping_runs set status='INPUT_VALIDATED' where id=$1", [run1]);
  await client.query("update intentchord.context_mapping_runs set status='PRIMARY_RUNNING' where id=$1", [run1]);
  await client.query(`insert into intentchord.context_mapping_attempts(
    id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,prompt_template_id,prompt_template_sha256,status,started_at
  ) values($1,$2,1,'zai','zai_direct_chat_completions_v4','glm-4.7-flash','intentchord_ai_context_mapper_system_v1',$3,'RUNNING',clock_timestamp())`, [attempt1, run1, promptHash]);
  await client.query(`update intentchord.context_mapping_attempts set status='FAILED_TECHNICAL',normalized_error_code='PRIMARY_PROVIDER_UNAVAILABLE',completed_at=clock_timestamp(),duration_ms=1 where id=$1`, [attempt1]);
  await client.query("update intentchord.context_mapping_runs set status='PRIMARY_FAILED_TECHNICAL',final_attempt_id=$2 where id=$1", [run1, attempt1]);
  await expectFailure(client, "standby_insert_block", `insert into intentchord.context_mapping_attempts(
    id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,prompt_template_id,prompt_template_sha256,status,started_at
  ) values($3,$1,2,'sambanova','sambanova_direct_chat_completions_v1','gpt-oss-120b','intentchord_ai_context_mapper_system_v1',$2,'RUNNING',clock_timestamp())`, [run1, promptHash, blockedStandbyAttempt], "STANDBY_ATTEMPT_GOVERNANCE_BLOCKED");

  await client.query(runInsert, [run2, zero, one]);
  await client.query("update intentchord.context_mapping_runs set status='INPUT_VALIDATED' where id=$1", [run2]);
  await client.query("update intentchord.context_mapping_runs set status='PRIMARY_RUNNING' where id=$1", [run2]);
  await client.query(`insert into intentchord.context_mapping_attempts(
    id,mapping_run_id,attempt_ordinal,provider_id,channel_id,requested_model_id,prompt_template_id,prompt_template_sha256,status,started_at
  ) values($1,$2,1,'zai','zai_direct_chat_completions_v4','glm-4.7-flash','intentchord_ai_context_mapper_system_v1',$3,'RUNNING',clock_timestamp())`, [attempt2, run2, promptHash]);
  await client.query("update intentchord.context_mapping_runs set status='VALIDATING' where id=$1", [run2]);
  await expectFailure(client, "success_without_validation", `update intentchord.context_mapping_attempts set
    status='SUCCEEDED',completed_at=clock_timestamp(),duration_ms=1,raw_response_sha256=$2,raw_response_body='{}',parsed_catalog_sha256=$3
    where id=$1`, [attempt2, one, two], "context_mapping_attempts_validation_ck");
  await client.query(`update intentchord.context_mapping_attempts set
    status='SUCCEEDED',completed_at=clock_timestamp(),duration_ms=1,raw_response_sha256=$2,raw_response_body='{}',parsed_catalog_sha256=$3,
    validation_summary='{"status":"PASS","gates":[],"raw_response_sha256":"${one}","parsed_catalog_sha256":"${two}"}'::jsonb
    where id=$1`, [attempt2, one, two]);
  const envelope = {
    schema_version: "intentchord.context-mapping-result.v1",
    mapping_run_id: run2,
    mapping_input_snapshot_id: "mis_probe",
    mapping_input_sha256: zero,
    attempt_id: attempt2,
    attempt_ordinal: 1,
    provider_id: "zai",
    channel_id: "zai_direct_chat_completions_v4",
    requested_model_id: "glm-4.7-flash",
    prompt_template_id: "intentchord_ai_context_mapper_system_v1",
    prompt_template_sha256: promptHash,
    raw_response_sha256: one,
    parsed_catalog_sha256: two,
    validation_result: { status: "PASS", gates: [], raw_response_sha256: one, parsed_catalog_sha256: two },
    model_proposal: { schema_version: "intentchord.model-proposed-context-catalog.v1" },
  };
  await expectFailure(client, "proposal_without_validation", `insert into intentchord.context_catalog_proposals(
    id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,deterministic_validation_evidence,result_envelope
  ) values($1,$2,$3,'intentchord.model-proposed-context-catalog.v1',$4,$5,'{}'::jsonb,$6)`, [
    invalidProposal2, run2, attempt2,
    JSON.stringify(envelope.model_proposal), two, JSON.stringify({ ...envelope, validation_result: {} }),
  ], "INTENTCHORD_CONTEXT_CATALOG_PROPOSAL_PROVENANCE_MISMATCH");
  await client.query(`insert into intentchord.context_catalog_proposals(
    id,mapping_run_id,source_attempt_id,schema_version,proposal_json,proposal_sha256,deterministic_validation_evidence,result_envelope
  ) values($1,$2,$3,'intentchord.model-proposed-context-catalog.v1',$4,$5,$6,$7)`, [
    proposal2, run2, attempt2,
    JSON.stringify(envelope.model_proposal), two,
    JSON.stringify(envelope.validation_result), JSON.stringify(envelope),
  ]);
  await client.query("update intentchord.context_mapping_runs set status='AWAITING_OWNER_REVIEW',final_attempt_id=$2 where id=$1", [run2, attempt2]);
  await client.query("insert into intentchord.context_mapping_owner_verdicts(id,mapping_run_id,verdict,owner_reference) values($1,$2,'ACCEPT','owner-local:Hisham')", [verdict2, run2]);
  await client.query("update intentchord.context_mapping_runs set status='OWNER_ACCEPTED',owner_verdict_state='ACCEPTED' where id=$1", [run2]);
  await expectFailure(client, "proposal_mutation_block", "update intentchord.context_catalog_proposals set proposal_json='{}'::jsonb where id=$1", [proposal2], "HISTORY_APPEND_ONLY");
  await expectFailure(client, "attempt_second_completion_block", "update intentchord.context_mapping_attempts set retry_count=1 where id=$1", [attempt2], "ATTEMPT_COMPLETE_ONCE");
  console.log("MIGRATION_009_GOVERNANCE_PROBES: PASS");
}

async function qualify(client, migrationSql) {
  const current = await preflight(client);
  const ids = await migrationIds(client);
  const laterApplied = laterMigrationIds.filter(id => ids.includes(id));
  await client.query("begin");
  try {
    if (laterApplied.length === 0) {
      await client.query(migrationSql);
      await client.query(migrationSql);
      await verifyObjects(client);
      await qualificationProbes(client);
    } else {
      console.log(`MIGRATION_009_LATER_SCHEMA_DELEGATION: ${laterApplied.join(",")}`);
      await verifyObjects(client);
      console.log("MIGRATION_009_GOVERNANCE_PROBES: DELEGATED_TO_LATER_MIGRATION_QUALIFICATION");
    }
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  console.log(`MIGRATION_009_QUALIFY: PASS source_state=${current} transaction=ROLLBACK`);
}

async function verifyApplied(client) {
  const current = await state(client);
  if (current !== "APPLIED") fail("MIGRATION_009_POST_STATE_BLOCKER", `state=${current}`);
  await verifyObjects(client);
  console.log("MIGRATION_009_STATE: APPLIED");
}

async function main() {
  if (!["preflight", "qualify", "apply", "verify"].includes(action)) fail("MIGRATION_009_ACTION_INVALID", String(action));
  await verifySources();
  const migrationSql = await readFile(`migrations/${migrationId}`, "utf8");
  const client = new pg.Client({ connectionString: await loadUrl() });
  await client.connect();
  try {
    await assertIdentity(client);
    if (action === "preflight") { await preflight(client); console.log("MIGRATION_009_PREFLIGHT: PASS"); return; }
    if (action === "qualify") { await qualify(client, migrationSql); return; }
    if (action === "verify") { await verifyApplied(client); console.log("MIGRATION_009_VERIFY: PASS"); return; }
    const current = await preflight(client);
    if (current === "APPLIED") {
      await verifyApplied(client);
      console.log("MIGRATION_009_APPLY: PASS already_applied=true");
      return;
    }
    await client.query("begin");
    try {
      await client.query(migrationSql);
      await verifyObjects(client);
      await client.query("insert into intentchord.schema_migrations(id) values($1)", [migrationId]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    console.log("MIGRATION_009_TRANSACTION: COMMIT");
    await verifyApplied(client);
    console.log("MIGRATION_009_APPLY: PASS already_applied=false");
  } finally { await client.end(); }
}
main().catch(error => { console.error(`MIGRATION_009_ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
