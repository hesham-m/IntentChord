import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

async function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is required.");
  return match[1].trim();
}

function validateUrl(raw) {
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const port = parsed.port || "5432";
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol))
      || decodeURIComponent(parsed.username) !== "intentchord_app"
      || parsed.hostname !== "127.0.0.1"
      || port !== "5432"
      || database !== "intentchord_dev") {
    throw new Error("INTEGRATION_DATA_MAINTENANCE_DATABASE_IDENTITY_BLOCKED");
  }
  return parsed;
}

async function verifyIdentity(client) {
  const result = await client.query(
    "select current_database() as database,current_user as role,current_schema() as schema",
  );
  const row = result.rows[0];
  if (row.database !== "intentchord_dev" || row.role !== "intentchord_app" || row.schema !== "intentchord") {
    throw new Error(`INTEGRATION_DATA_MAINTENANCE_DATABASE_IDENTITY_BLOCKED: ${row.database}/${row.role}/${row.schema}`);
  }
}

const testScenarioSuffixes = [
  "unverified", "stale-workspace", "revision", "single-run", "rejected-markdown",
  "backend-automatic-validation", "trusted-pass", "command-history-mismatch",
  "multi-validation-producer", "signed-request-replay", "signed-receipt-missing",
  "trace-integrity-tamper", "validation-integrity-tamper", "batch-adversarial",
  "trace-compound-command", "trace-time-order", "correction", "audit", "history",
];
const testObjectives = testScenarioSuffixes.map(suffix =>
  `Implement and verify Backend authority, trusted evidence, Run state, and reload behavior for scenario ${suffix}.`,
);
testObjectives.push("Implement and verify Backend authority, trusted evidence, Run state, and reload behavior for scenario revision. Revised once.");

const candidateSql = `
  select t.id::text,t.title,t.objective,t.task_mode,t.created_at,t.updated_at,
    coalesce(array_agg(distinct tws.workspace_registration_id::text)
      filter (where tws.workspace_registration_id is not null),array[]::text[]) as workspace_ids,
    (select count(*)::int from intentchord.runs r where r.task_id=t.id) as run_count,
    (select count(*)::int from intentchord.contract_revisions cr where cr.task_id=t.id) as contract_count,
    (select count(*)::int from intentchord.discovery_runs dr where dr.task_id=t.id) as discovery_run_count
  from intentchord.tasks t
  left join intentchord.task_workspace_snapshots tws on tws.task_id=t.id
  where t.task_mode='SOURCE_IMPLEMENTATION'
    and t.title='Implement and verify Backend authority, trusted evidence, Run state,...'
    and t.objective=any($1::text[])
  group by t.id,t.title,t.objective,t.task_mode,t.created_at,t.updated_at
  order by t.created_at,t.id`;

function normalizedCandidates(rows) {
  return rows.map(row => ({
    id: String(row.id),
    title: String(row.title),
    objective: String(row.objective),
    taskMode: String(row.task_mode),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    workspaceIds: [...(row.workspace_ids ?? [])].map(String).sort(),
    runCount: Number(row.run_count),
    contractCount: Number(row.contract_count),
    discoveryRunCount: Number(row.discovery_run_count),
    classification: "PROVEN_TEST_DATA",
  }));
}

function fingerprint(candidates) {
  return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}

async function createPlan(client, output) {
  const result = await client.query(candidateSql, [testObjectives]);
  const candidates = normalizedCandidates(result.rows);
  const plan = {
    schemaVersion: "intentchord-integration-cleanup-plan/v1",
    database: "intentchord_dev",
    role: "intentchord_app",
    schema: "intentchord",
    generatedAt: new Date().toISOString(),
    candidateRule: "exact lifecycle.postgres.integration.test.ts generated title plus enumerated source scenario objectives",
    candidateCount: candidates.length,
    candidateFingerprint: fingerprint(candidates),
    candidates,
    immutableAuditEventsPreserved: true,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`INTEGRATION_DATA_PLAN: PASS | candidates=${candidates.length} | fingerprint=${plan.candidateFingerprint} | path=${output}`);
}

async function ids(client, text, values) {
  const result = await client.query(text, values);
  return result.rows.map(row => String(row.id));
}

async function deleteTaskGraph(client, taskId) {
  const runRows = await client.query(
    "select id::text,round from intentchord.runs where task_id=$1 order by round desc",
    [taskId],
  );
  const runIds = runRows.rows.map(row => String(row.id));
  const discoveryRunIds = await ids(client, "select id from intentchord.discovery_runs where task_id=$1", [taskId]);
  const contractIds = await ids(client, "select id from intentchord.contract_revisions where task_id=$1", [taskId]);

  if (discoveryRunIds.length) {
    await client.query("delete from intentchord.discovery_scope_expansion_requests where discovery_run_id=any($1::uuid[])", [discoveryRunIds]);
    await client.query("delete from intentchord.discovery_findings where discovery_run_id=any($1::uuid[])", [discoveryRunIds]);
    await client.query("delete from intentchord.source_evidence where discovery_run_id=any($1::uuid[])", [discoveryRunIds]);
    await client.query("delete from intentchord.discovery_items where discovery_run_id=any($1::uuid[])", [discoveryRunIds]);
  }

  if (runIds.length) {
    await client.query("delete from intentchord.correction_rounds where task_id=$1", [taskId]);
    await client.query("delete from intentchord.inherited_validation_evidence where run_id=any($1::uuid[]) or parent_run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.owner_decisions where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.verdicts where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.trusted_producer_receipts where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.tool_trace_events where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.validation_evidence where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.artifact_evidence where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.source_evidence where run_id=any($1::uuid[])", [runIds]);

    const submissionIds = await ids(client, "select id from intentchord.report_submissions where run_id=any($1::uuid[])", [runIds]);
    if (submissionIds.length) {
      await client.query("delete from intentchord.report_evidence_references where report_submission_id=any($1::uuid[])", [submissionIds]);
      await client.query("delete from intentchord.report_claims where report_submission_id=any($1::uuid[])", [submissionIds]);
    }
    await client.query("delete from intentchord.report_submissions where run_id=any($1::uuid[])", [runIds]);
    await client.query("delete from intentchord.context_leases where run_id=any($1::uuid[])", [runIds]);
    await client.query("update intentchord.compiled_contract_artifacts set run_id=null where run_id=any($1::uuid[])", [runIds]);
    for (const row of runRows.rows) {
      await client.query("delete from intentchord.runs where id=$1", [String(row.id)]);
    }
  }

  if (discoveryRunIds.length) {
    await client.query("delete from intentchord.discovery_runs where id=any($1::uuid[])", [discoveryRunIds]);
  }
  await client.query("delete from intentchord.intent_resolutions where task_id=$1", [taskId]);
  if (contractIds.length) {
    await client.query("delete from intentchord.compiled_contract_artifacts where contract_revision_id=any($1::uuid[])", [contractIds]);
    await client.query("delete from intentchord.contract_approvals where contract_revision_id=any($1::uuid[])", [contractIds]);
  }
  await client.query("delete from intentchord.contract_revisions where task_id=$1", [taskId]);
  await client.query(
    "delete from intentchord.task_workspace_scope_entries where task_workspace_snapshot_id in (select id from intentchord.task_workspace_snapshots where task_id=$1)",
    [taskId],
  );
  await client.query("delete from intentchord.task_workspace_snapshots where task_id=$1", [taskId]);
  await client.query("delete from intentchord.task_draft_revisions where task_id=$1", [taskId]);
  await client.query("delete from intentchord.scope_entries where task_id=$1", [taskId]);
  await client.query("delete from intentchord.task_workspaces where task_id=$1", [taskId]);
  await client.query("delete from intentchord.tasks where id=$1", [taskId]);
}

async function applyPlan(client, planPath, backupPath, reportPath) {
  if (!backupPath || !existsSync(backupPath) || statSync(backupPath).size < 1024) {
    throw new Error("INTEGRATION_DATA_CLEANUP_BACKUP_REQUIRED");
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.schemaVersion !== "intentchord-integration-cleanup-plan/v1") throw new Error("INTEGRATION_DATA_PLAN_SCHEMA_BLOCKED");
  const current = normalizedCandidates((await client.query(candidateSql, [testObjectives])).rows);
  const currentFingerprint = fingerprint(current);
  if (currentFingerprint !== plan.candidateFingerprint || JSON.stringify(current.map(x => x.id)) !== JSON.stringify(plan.candidates.map(x => x.id))) {
    throw new Error("INTEGRATION_DATA_PLAN_STALE: candidate set changed after planning.");
  }

  const taskIds = plan.candidates.map(candidate => candidate.id);
  const workspaceIds = [...new Set(plan.candidates.flatMap(candidate => candidate.workspaceIds))];
  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const taskId of taskIds) await deleteTaskGraph(client, taskId);
    const deletedWorkspaceIds = [];
    for (const workspaceId of workspaceIds) {
      const result = await client.query(
        `delete from intentchord.workspaces w
         where w.id=$1
           and not exists(select 1 from intentchord.task_workspaces x where x.workspace_id=w.id)
           and not exists(select 1 from intentchord.task_workspace_snapshots x where x.workspace_registration_id=w.id)
           and not exists(select 1 from intentchord.project_context_workspaces x where x.workspace_registration_id=w.id)
           and not exists(select 1 from intentchord.discovery_items x where x.workspace_registration_id=w.id)
           and not exists(select 1 from intentchord.discovery_scope_expansion_requests x where x.workspace_registration_id=w.id)
           and not exists(select 1 from intentchord.source_evidence x where x.workspace_registration_id=w.id)
           and not exists(select 1 from intentchord.report_evidence_references x where x.workspace_registration_id=w.id)
         returning id::text`,
        [workspaceId],
      );
      if (result.rowCount) deletedWorkspaceIds.push(workspaceId);
    }
    const remaining = await client.query("select count(*)::int as count from intentchord.tasks where id=any($1::uuid[])", [taskIds]);
    if (remaining.rows[0].count !== 0) throw new Error("INTEGRATION_DATA_CLEANUP_VERIFICATION_FAILED");
    await client.query("COMMIT");

    const report = {
      schemaVersion: "intentchord-integration-cleanup-receipt/v1",
      completedAt: new Date().toISOString(),
      database: "intentchord_dev",
      deletedTaskCount: taskIds.length,
      deletedTaskIds: taskIds,
      deletedOrphanWorkspaceIds: deletedWorkspaceIds,
      deletedCounts: { tasks: taskIds.length, orphanWorkspaces: deletedWorkspaceIds.length },
      preservedOwnerIds: [],
      preservedAmbiguousIds: [],
      immutableAuditEventsPreserved: true,
      backupPath,
      planFingerprint: plan.candidateFingerprint,
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`INTEGRATION_DATA_CLEANUP: PASS | deleted_tasks=${taskIds.length} | deleted_orphan_workspaces=${deletedWorkspaceIds.length} | receipt=${reportPath}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const mode = process.argv[2];
const rawUrl = await loadDatabaseUrl();
validateUrl(rawUrl);
const client = new pg.Client({ connectionString: rawUrl, options: "-c search_path=intentchord" });
await client.connect();
try {
  await verifyIdentity(client);
  if (mode === "plan") {
    const output = argument("output");
    if (!output) throw new Error("--output is required for plan mode.");
    await createPlan(client, path.resolve(output));
  } else if (mode === "apply") {
    const planPath = argument("plan");
    const backupPath = argument("backup");
    const reportPath = argument("report");
    if (!planPath || !backupPath || !reportPath) throw new Error("--plan, --backup, and --report are required for apply mode.");
    await applyPlan(client, path.resolve(planPath), path.resolve(backupPath), path.resolve(reportPath));
  } else {
    throw new Error("Usage: node scripts/integration-data-maintenance.mjs plan|apply ...");
  }
} finally {
  await client.end();
}
