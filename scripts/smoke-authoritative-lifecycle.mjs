import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3210";
let ownerCookie = "";

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  if (!header) return "";
  return header.split(";", 1)[0] ?? "";
}

async function request(path, init = {}, options = {}) {
  const headers = new Headers(init.headers ?? {});
  if (ownerCookie && options.owner !== false) headers.set("cookie", ownerCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body = text;
  if (response.headers.get("content-type")?.includes("application/json")) {
    body = text ? JSON.parse(text) : {};
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body.code ?? body.error ?? text ?? "unknown error"}`);
  }
  return { status: response.status, body, response };
}

async function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = await readFile(".env.local", "utf8");
  const match = env.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m);
  if (!match) throw new Error("DATABASE_URL is unavailable for smoke cleanup.");
  return match[1].trim();
}

async function cleanup(taskId, workspaceId) {
  if (!taskId && !workspaceId) return;
  const client = new pg.Client({ connectionString: await loadDatabaseUrl() });
  await client.connect();
  try {
    const identity = await client.query("select current_database() as db,current_user as usr,current_schema() as sch");
    const row = identity.rows[0];
    if (row.db !== "intentchord_dev" || row.usr !== "intentchord_app" || row.sch !== "intentchord") {
      throw new Error(`SMOKE_CLEANUP_DATABASE_IDENTITY_MISMATCH:${row.db}|${row.usr}|${row.sch}`);
    }
    await client.query("begin");
    if (taskId) {
      const runResult = await client.query("select id from intentchord.runs where task_id=$1", [taskId]);
      const runIds = runResult.rows.map(value => value.id);
      if (runIds.length) {
        await client.query("delete from intentchord.inherited_validation_evidence where run_id=any($1::uuid[]) or parent_run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.trusted_producer_receipts where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.correction_rounds where task_id=$1", [taskId]);
        await client.query("delete from intentchord.owner_decisions where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.verdicts where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.tool_trace_events where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.validation_evidence where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.report_submissions where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.context_leases where run_id=any($1::uuid[])", [runIds]);
        await client.query("update intentchord.compiled_contract_artifacts set run_id=null where run_id=any($1::uuid[])", [runIds]);
        await client.query("delete from intentchord.runs where id=any($1::uuid[])", [runIds]);
      }
      await client.query("delete from intentchord.compiled_contract_artifacts where contract_revision_id in (select id from intentchord.contract_revisions where task_id=$1)", [taskId]);
      await client.query("delete from intentchord.contract_approvals where contract_revision_id in (select id from intentchord.contract_revisions where task_id=$1)", [taskId]);
      await client.query("delete from intentchord.contract_revisions where task_id=$1", [taskId]);
      await client.query("delete from intentchord.tasks where id=$1", [taskId]);
    }
    if (workspaceId) await client.query("delete from intentchord.workspaces where id=$1", [workspaceId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function proofReferences(requirement) {
  const reference = category => ({
    kind: "VALIDATION_CHECK",
    checkId: `requirement:${requirement.id}:${category}`,
  });
  return {
    sourceBehaviorRefs: [reference("source-behavior")],
    positiveProofRefs: [reference("positive")],
    negativeAdversarialProofRefs: requirement.proofProfile.negativeAdversarial
      ? [reference("negative-adversarial")]
      : [],
    persistenceReloadProofRefs: requirement.proofProfile.persistenceReload
      ? [reference("persistence-reload")]
      : [],
  };
}

let taskId;
let workspaceId;
try {
  const root = await request("/", {}, { owner: false });
  console.log(`HTTP_ROOT=${root.status}`);

  const bootstrap = await request("/api/tasks", {}, { owner: false });
  ownerCookie = cookieFrom(bootstrap.response);
  if (!ownerCookie) throw new Error("OWNER_SESSION_COOKIE_NOT_ISSUED");
  console.log("OWNER_SESSION_BOOTSTRAP=PASS");

  const manual = await request("/api/workspaces/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "IntentChord authoritative HTTP smoke Workspace",
      role: "primary",
      referenceType: "LOCAL_PATH",
      reference: process.cwd(),
      authorizationContext: "bounded authoritative HTTP smoke scope",
    }),
  });
  workspaceId = manual.body.id;

  const verified = await request(`/api/workspaces/${workspaceId}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: manual.body.revision }),
  });
  if (verified.body.id !== workspaceId || verified.body.verificationStatus !== "VERIFIED") {
    throw new Error("WORKSPACE_SAME_ID_VERIFICATION_FAILED");
  }
  if (verified.body.source !== "MANUAL_VERIFIED") throw new Error("WORKSPACE_PROVENANCE_PROJECTION_FAILED");

  const draft = {
    title: "IntentChord authoritative HTTP smoke",
    titleManuallyEdited: true,
    objective: "Prove the authoritative IntentChord HTTP lifecycle, trusted evidence, reload, and final Owner acceptance.",
    ownerRequirements: [{
      id: "http-lifecycle",
      outcome: "The HTTP lifecycle preserves Backend authority, trusted evidence, and reload state.",
      proofProfile: {
        sourceBehavior: true,
        positive: true,
        negativeAdversarial: true,
        persistenceReload: true,
      },
    }],
    taskMode: "SOURCE_IMPLEMENTATION",
    providerId: "OPENAI",
    modelId: "gpt-5.6-terra",
    executionChannelId: "CODEX",
    reasoningProfile: "Medium",
    runtimeProfileId: "STANDARD",
    modelOverrideAccepted: false,
    modelOverrideReason: "",
    workspaces: [{
      id: verified.body.id,
      displayName: verified.body.displayName,
      role: verified.body.role,
      referenceType: verified.body.referenceType,
      source: verified.body.source,
      reference: verified.body.normalizedReference,
      repositoryIdentity: verified.body.repositoryIdentity,
      branch: verified.body.branch,
      commitSha: verified.body.commitSha,
      fingerprint: verified.body.fingerprint,
      provenance: JSON.stringify(verified.body.provenance ?? {}),
      allowedPaths: ["src"],
      excludedPaths: ["node_modules"],
      authorizationContext: "bounded authoritative HTTP smoke scope",
      ordering: 0,
    }],
    workspaceRef: verified.body.normalizedReference,
    workspaceSource: verified.body.source,
    workspaceFingerprint: verified.body.fingerprint,
    allowedPaths: [`${verified.body.id}:src`],
    excludedPaths: [`${verified.body.id}:node_modules`],
    evidenceFiles: [],
    identity: "",
    readFiles: true,
    modifySource: true,
    runStaticValidation: true,
    runTests: true,
    build: false,
    deploy: false,
    restartServices: false,
    writeDatabase: false,
    changeEnvironment: false,
    useNetwork: false,
  };

  let task = (await request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft }),
  })).body;
  taskId = task.id;
  console.log("TASK_CREATE=201");

  const reloadedDraft = (await request(`/api/tasks/${taskId}`)).body;
  if (reloadedDraft.draft.ownerRequirements[0].id !== "http-lifecycle") {
    throw new Error("TASK_RELOAD_OWNER_REQUIREMENT_MISMATCH");
  }

  task = (await request(`/api/tasks/${taskId}/contract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: task.revision, locale: "en" }),
  })).body;
  if (!task.contract || task.contract.ownerApproval.state !== "AWAITING_OWNER_APPROVAL") {
    throw new Error("CONTRACT_RESOLUTION_FAILED");
  }

  task = (await request(`/api/contracts/${task.contractRevisionId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: task.contractStateRevision,
      expectedContentSha256: task.contractContentSha256,
      approvalChannel: "HTTP_SMOKE",
    }),
  })).body;
  if (task.contract.ownerApproval.state !== "APPROVED") throw new Error("CONTRACT_APPROVAL_FAILED");

  task = (await request(`/api/tasks/${taskId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: task.revision,
      locale: "en",
      executionType: "INITIAL",
      source: "IMPORTED_REPORT",
    }),
  })).body;
  let run = task.runs.at(-1);
  if (!run?.compiledArtifact?.text || run.status !== "AWAITING_REPORT") throw new Error("RUN_CREATION_FAILED");

  const requirements = task.contract.executionPackage.mandatoryRequirements;
  const reportSections = {
    "executive-summary": "The authoritative HTTP smoke followed the approved objective and binding.",
    "sources-inspected": "The approved src scope was represented as a structured Workspace path.",
    "evidence-matrix": "Every mandatory requirement has one governed proof row.",
    "unsupported-claims": "No unsupported claims were promoted to trusted evidence.",
    "evidence-gaps": "No evidence gap remains after trusted Owner Runtime validation.",
    "validation-results": "Executor claims remain non-authoritative pending the trusted batch.",
    "executor-classification": "PASS",
    "exact-next-action": "Record trusted Owner Runtime validation and request the Backend Verdict.",
  };
  const requirementProofs = requirements.map(requirement => ({
    requirementId: requirement.id,
    classification: "PASS",
    actualSourceBehavior: `Authoritative smoke behavior was exercised for ${requirement.id}.`,
    ...proofReferences(requirement),
    notes: "Executor claim only until the trusted Owner Runtime batch is recorded.",
  }));
  const findings = requirements.map(requirement => ({
    requirementId: requirement.id,
    claim: `The authoritative lifecycle behavior was exercised for ${requirement.id}.`,
    status: "PROVEN",
    evidenceRefs: [{
      kind: "VALIDATION_CHECK",
      checkId: `requirement:${requirement.id}:source-behavior`,
    }],
  }));
  const report = {
    contractId: task.contract.contractId,
    runId: run.id,
    round: run.round,
    executionType: run.executionType,
    bindingMarker: run.bindingMarker,
    executorName: task.contract.agentResolution.executionChannelName,
    providerId: run.providerId,
    modelId: run.modelId,
    executionChannelId: run.agentProfileId,
    reasoningProfile: run.reasoningProfile,
    runtimeProfileId: run.runtimeProfileId,
    terminalState: "READY_FOR_FINAL_REPORT",
    inspectedPaths: [{ workspaceId: verified.body.id, path: "src" }],
    changedPaths: [],
    commands: [],
    evidenceIdentities: [],
    findings,
    requirementProofs,
    validationResults: task.contract.requiredChecks.map(check => ({
      checkId: check.id,
      status: "PASS",
      details: "Executor claim only; the trusted Owner Runtime batch remains authoritative.",
    })),
    executorClassification: "PASS",
    nextAction: "Record the trusted Owner Runtime evidence batch and evaluate the Run.",
    reportSections,
    missingRequiredSources: [],
    accessDeniedPaths: [],
    closureCriteriaSatisfied: ["report-closure"],
    rawReport: "The authoritative HTTP smoke proves the approved IntentChord lifecycle objective through structured data.",
    completedReportSections: Object.keys(reportSections),
  };

  task = (await request(`/api/runs/${run.id}/reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "if-match": String(run.stateRevision),
    },
    body: JSON.stringify(report),
  })).body;
  run = task.runs.at(-1);
  if (run.status !== "REPORT_RECEIVED") throw new Error("REPORT_RECEIPT_FAILED");

  const validationBatchId = randomUUID();
  const checks = task.contract.requiredChecks.filter(check => check.required);
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    task = (await request(`/api/runs/${run.id}/validations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-intentchord-producer-type": "OWNER_RUNTIME",
      },
      body: JSON.stringify({
        expectedRevision: run.stateRevision,
        checkId: check.id,
        status: "PASS",
        details: `Owner Runtime smoke independently passed governed check ${check.id}.`,
        batchId: validationBatchId,
        sequence: index,
        sequenceTotal: checks.length,
        isTerminal: index === checks.length - 1,
      }),
    })).body;
    run = task.runs.at(-1);
  }

  task = (await request(`/api/runs/${run.id}/tool-trace`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-intentchord-producer-type": "OWNER_RUNTIME",
    },
    body: JSON.stringify({
      expectedRevision: run.stateRevision,
      batchId: randomUUID(),
      sequence: 0,
      sequenceTotal: 1,
      isTerminal: true,
      command: "INTENTCHORD:NO_COMMANDS_EXECUTED",
      authorizationResult: "AUTHORIZED",
      occurredAt: new Date().toISOString(),
    }),
  })).body;
  run = task.runs.at(-1);

  task = (await request(`/api/runs/${run.id}/verdict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: run.stateRevision }),
  })).body;
  run = task.runs.at(-1);
  if (run.status !== "REVIEW_READY" || run.verdict?.classification !== "PASS") {
    throw new Error(`INDEPENDENT_VERDICT_FAILED:${run.verdict?.classification ?? "missing"}`);
  }

  task = (await request(`/api/runs/${run.id}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: run.stateRevision,
      decisionType: "ACCEPTED",
      reason: "Owner Runtime accepted the independently proven authoritative HTTP smoke.",
    }),
  })).body;
  run = task.runs.at(-1);
  if (run.status !== "DECIDED" || run.decision !== "ACCEPTED") throw new Error("OWNER_ACCEPTANCE_FAILED");

  const reload = (await request(`/api/tasks/${taskId}`)).body;
  const reloadedRun = reload.runs.find(value => value.id === run.id);
  if (!reloadedRun || reloadedRun.status !== "DECIDED" || reloadedRun.verdict?.classification !== "PASS") {
    throw new Error("AUTHORITATIVE_RELOAD_FAILED");
  }
  const history = (await request(`/api/tasks/${taskId}/history`)).body;
  for (const eventType of [
    "TASK_CREATED",
    "CONTRACT_RESOLVED",
    "CONTRACT_APPROVED",
    "RUN_CREATED",
    "REPORT_RECEIVED",
    "REPORT_PARSED",
    "VALIDATION_RECORDED",
    "TOOL_TRACE_RECORDED",
    "VERDICT_ISSUED",
    "OWNER_DECISION_RECORDED",
  ]) {
    if (!history.some(event => event.eventType === eventType)) throw new Error(`AUDIT_EVENT_MISSING:${eventType}`);
  }

  console.log("AUTHORITATIVE_RELOAD=PASS");
  console.log("TRUSTED_VALIDATION_BATCH=PASS");
  console.log("TRUSTED_TOOL_TRACE_BATCH=PASS");
  console.log("BACKEND_VERDICT=PASS");
  console.log("OWNER_DECISION=ACCEPTED");
  console.log("INTENTCHORD_HTTP_LIFECYCLE_SMOKE=PASS");
} finally {
  await cleanup(taskId, workspaceId);
}
