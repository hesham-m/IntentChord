import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import type { ContractInput, ContextAssemblyTaskCandidateScope, OwnerRequirement, TaskCandidateScope, TaskContext, TaskDraftInput, TaskScopeConfirmation, WorkspaceReference } from "@/core/tasks/task-input";
import {
  assertContractReadyTaskDraft,
  candidateScopeIdentityFromScope,
  candidateScopeIdentityMatches,
  effectiveTaskContext,
  extractExecutionSetup,
  generatedTaskTitle,
  normalizeExecutionSetupCanonical,
  synchronizeLegacyWorkspaceProjection,
} from "@/core/tasks/task-input";
import { applyOwnerScopeConfirmation } from "@/core/tasks/candidate-scope";
import { resolveUnifiedExecutionSetup, UnifiedExecutionRoutingError } from "@/core/tasks/execution-routing-policy";
import { requiresLegacyIntentAndDiscovery } from "@/core/tasks/orchestration-policy";
import { resolveCorrectionOperationalInheritance } from "@/core/tasks/correction-authority";
import { validateAndResolveTaskContextBinding } from "@/server/task-context-binding-service";
import { resolveContextAssemblyWorkSelection, resolveCurrentHeadContextAssemblyWorkSelection, validateContextAssemblyCandidateScope } from "@/server/context-assembly-task-binding-service";
import { readDatabaseCommandTime } from "@/server/database-clock";
import { taskAuthorityInputSha256V1 } from "@/server/task-authority-input";
import { assertCurrentEffectiveContextAuthority } from "@/server/context-head-authority";
import type { ExecutionContract } from "@/core/contracts/execution-contract";
import { executionContractSchema, requiredCheckSatisfactionMode } from "@/core/contracts/execution-contract";
import { resolveRequirementProofProfile } from "@/core/contracts/requirement-proof-profile";
import { resolveExecutionContract } from "@/core/contracts/resolver";
import { validatePreflight } from "@/core/policies/preflight";
import { resolveAuthorization } from "@/core/policies/policy";
import {
  DeterministicIntentPlannerProvider,
  intentInputFingerprint,
} from "@/core/intelligence/intent-resolver";
import {
  authorityFingerprint as resolveAuthorityFingerprint,
  confirmIntentResolution,
  intentResolutionSha256,
  validateIntentResolutionPolicy,
} from "@/core/intelligence/intent-policy";
import {
  intentPromptVersion,
  intentResolutionSchema,
  type IntentResolution,
} from "@/core/intelligence/intent-schema";
import {
  aiAdapterRegistry,
  assertAdapterBinding,
  providerBinding,
} from "@/core/providers/ai-role-routing";
import { compileAgentPromptDiagnostics } from "@/core/prompts/compiler";
import { lintResolvedContract, contextLease } from "@/core/prompts/governance";
import type { ExecutorReportEnvelope, ReportEvidenceReference } from "@/core/reports/executor-report";
import type { Verdict } from "@/core/verdicts/engine";
import { evaluateVerdict } from "@/core/verdicts/engine";
import { parseAuthoritativeReport } from "@/core/reports/parser";
import { reportSectionIds } from "@/core/reports/report-contract";
import { validateReportSemantics } from "@/core/reports/semantics";
import type { Decision, RunRecord, TaskRecord } from "@/lib/workspace";
import { modelRegistry, providerRegistry, runtimeProfileSupportsProvider } from "@/core/providers/registry";
import { databaseQuery, transaction } from "@/server/db";
import { ConflictError, HttpCommandError } from "@/server/errors";
import type { TrustedProducerContext } from "@/server/authority";
import { assertRegisteredWorkspaceSourceAuthority } from "@/server/workspace-connector";
import { captureRegisteredWorkspaceSourceFile } from "@/server/workspace-source-read";
import { projectTaskSetup } from "@/server/presentation";
import {
  discoveryContractSummary,
  readLatestDiscoveryRunForTask,
  supersedeDiscoveryRunsForTask,
} from "@/server/discovery-lifecycle";
import { terminalRuntimeGovernanceCode } from "@/core/workspace-index/adapters/filesystem-errors";
import {
  approveContractCommandSchema,
  compileContractCommandSchema,
  confirmIntentCommandSchema,
  createDiscoveryRunCommandSchema,
  createRunCommandSchema,
  createTaskCommandSchema,
  evaluateRunCommandSchema,
  manualWorkspaceCommandSchema,
  ownerDecisionCommandSchema,
  reviseTaskCommandSchema,
  resolveContractCommandSchema,
  resolveIntentCommandSchema,
  selectWorkspaceCommandSchema,
  selectWorkspaceScopePathCommandSchema,
  startCorrectionCommandSchema,
  submitDiscoveryFindingsCommandSchema,
  taskExecutionPlatformCommandSchema,
  taskScopeConfirmationCommandSchema,
  taskWorkSelectionCommandSchema,
  toolTraceBatchCommandSchema,
  toolTraceCommandSchema,
  validationEvidenceCommandSchema,
  verifyWorkspaceCommandSchema,
} from "@/server/schemas";

// only complete trusted producer batches can satisfy independent evidence gates.
const OWNER_AUTHORITY_DEFAULT = "owner:unknown";
const COMPILER_VERSION = "intentchord-compiler/1.0";
const VERDICT_ENGINE_VERSION = "intentchord-independent-verdict/1.0";
const PARSER_VERSION = "intentchord-report-parser/1.0";
const GOVERNANCE_VERSION = "intentchord-stable-governance/1.0";
const MODEL_REGISTRY_VERSION = "intentchord-model-registry/0.1-2026-07-24";

type Json = Record<string, unknown>;
type Queryable = Pick<PoolClient, "query">;

function runtimeDatabase(): Queryable {
  return { query: databaseQuery as PoolClient["query"] };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonPersistable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clearUnifiedExecutionConfiguration(draft: TaskDraftInput): TaskDraftInput {
  const next = { ...draft };
  delete next.executionSetup;
  delete next.providerId;
  delete next.modelId;
  delete next.executionChannelId;
  delete next.reasoningProfile;
  delete next.runtimeProfileId;
  delete next.modelOverrideAccepted;
  delete next.modelOverrideReason;
  return next;
}

function requireUnifiedV2ScopeFreeze(draft: TaskDraftInput): string | undefined {
  if (draft.orchestrationVersion !== "UNIFIED_V1") return undefined;
  if (
    !draft.contextAssemblyBinding
    || draft.candidateScope?.authorityVersion !== "CONTEXT_ASSEMBLY_V2"
    || draft.scopeConfirmation?.candidateIdentity.authorityVersion !== "CONTEXT_ASSEMBLY_V2"
  ) {
    throw new HttpCommandError(409, "UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED", "Historical V1 Context remains readable provenance but cannot create new UNIFIED_V1 forward execution authority.");
  }
  const confirmation = draft.scopeConfirmation;
  if (!confirmation || confirmation.candidateIdentity.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
    throw new HttpCommandError(409, "UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED", "Current UNIFIED execution authority requires an exact V2 Scope Confirmation.");
  }
  if (!confirmation.authorityInputSha256) {
    throw new HttpCommandError(409, "SCOPE_AUTHORITY_INPUT_IDENTITY_REQUIRED", "Current UNIFIED execution authority requires a Scope Confirmation frozen to the exact authority-affecting Task input identity.");
  }
  const current = taskAuthorityInputSha256V1(draft);
  if (current !== confirmation.authorityInputSha256) {
    throw new HttpCommandError(409, "SCOPE_AUTHORITY_INPUT_DRIFT_REBASE_REQUIRED", "Authority-affecting Task inputs changed after Scope Confirmation. Explicit current-context Work Selection and Scope re-confirmation are required.", { frozenAuthorityInputSha256: confirmation.authorityInputSha256, currentAuthorityInputSha256: current });
  }
  return confirmation.candidateIdentity.contextAssemblyRevisionId;
}

async function resolveCurrentUnifiedCandidateScope(taskId: string, draft: TaskDraftInput, queryable?: Queryable): Promise<TaskCandidateScope> {
  if (!draft.candidateScope) {
    throw new HttpCommandError(422, "CANDIDATE_SCOPE_REQUIRED", "A Backend-derived Candidate Scope is required.");
  }
  if (draft.orchestrationVersion === "UNIFIED_V1") {
    if (!draft.contextAssemblyBinding || draft.candidateScope.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
      throw new HttpCommandError(409, "UNIFIED_V2_CONTEXT_AUTHORITY_REQUIRED", "Historical MAPPING_V1 Context cannot create new UNIFIED_V1 Scope or execution authority.");
    }
    return validateContextAssemblyCandidateScope({
      taskId,
      binding: draft.contextAssemblyBinding,
      candidateScope: draft.candidateScope as ContextAssemblyTaskCandidateScope,
      boundWorkspaceIds: draft.workspaces.map(workspace => workspace.id),
      ...(queryable ? { queryable } : {}),
    });
  }
  if (draft.contextAnalysisBinding && (draft.candidateScope.authorityVersion ?? "MAPPING_V1") === "MAPPING_V1") {
    return validateAndResolveTaskContextBinding(draft.contextAnalysisBinding, draft.workspaces.map(workspace => workspace.id));
  }
  throw new HttpCommandError(409, "CONTEXT_AUTHORITY_BINDING_MISMATCH", "Candidate Scope authority does not match the Task context-understanding binding.");
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpCommandError(400, "INVALID_IDENTIFIER", `${label} must be a valid UUID.`);
  }
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function requireCompatibleConfiguration(draft: TaskDraftInput) {
  const executionSetup = extractExecutionSetup(draft);
  if (!executionSetup) {
    return;
  }
  const model = modelRegistry[executionSetup.modelId];
  if (!model) {
    throw new HttpCommandError(422, "UNKNOWN_MODEL", `Unknown model ${executionSetup.modelId}.`);
  }
  const provider = providerRegistry[executionSetup.providerId];
  if (!provider) {
    throw new HttpCommandError(422, "UNKNOWN_PROVIDER", `Unknown provider ${executionSetup.providerId}.`);
  }
  if (model.providerId !== executionSetup.providerId) {
    throw new HttpCommandError(422, "MODEL_PROVIDER_MISMATCH", "The selected model does not belong to the selected provider.");
  }
  if (provider.executionChannelId !== executionSetup.executionChannelId) {
    throw new HttpCommandError(422, "EXECUTION_CHANNEL_MISMATCH", "The execution channel does not match the selected provider.");
  }
  if (!model.allowedReasoningProfiles.includes(executionSetup.reasoningProfile)) {
    throw new HttpCommandError(422, "REASONING_PROFILE_MISMATCH", "The selected reasoning profile is not supported by the selected model.");
  }
  if (!runtimeProfileSupportsProvider(executionSetup.runtimeProfileId, executionSetup.providerId)) {
    throw new HttpCommandError(422, "RUNTIME_PROFILE_MISMATCH", "The runtime profile is not supported by the selected provider.");
  }
  if (executionSetup.modelOverrideAccepted && (!executionSetup.modelOverrideReason || executionSetup.modelOverrideReason.length < 12)) {
    throw new HttpCommandError(422, "MODEL_OVERRIDE_REASON_REQUIRED", "An explicit Owner override reason of at least 12 characters is required.");
  }
}

async function audit(
  client: PoolClient,
  event: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    actor?: string;
    revision?: number;
    taskId?: string;
    contractRevisionId?: string;
    runId?: string;
    metadata?: Json;
  },
) {
  await client.query(
    `insert into intentchord.audit_events(
      id, aggregate_type, aggregate_id, event_type, actor_authority,
      related_revision, related_task_id, related_contract_revision_id, related_run_id, metadata
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.actor ?? "BACKEND",
      event.revision ?? null,
      event.taskId ?? null,
      event.contractRevisionId ?? null,
      event.runId ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

async function lockTask(client: PoolClient, taskId: string, expectedRevision?: number) {
  const result = await client.query(
    "select id, revision from intentchord.tasks where id=$1 for update",
    [taskId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
  const revision = Number(result.rows[0].revision);
  if (expectedRevision !== undefined && revision !== expectedRevision) throw new ConflictError();
  return revision;
}

async function requireWorkspaceRegistrations(client: PoolClient, workspaces: WorkspaceReference[]) {
  const ids = workspaces.map(workspace => workspace.id);
  const result = await client.query(
    `select id, display_name, role, reference_type, reference, normalized_reference,
      verification_status, verification_method, verified_at, verification_authority,
      repository_identity, branch, commit_sha, fingerprint, provenance, source_type
     from intentchord.workspaces where id = any($1::uuid[])`,
    [ids],
  );
  if (result.rowCount !== ids.length) {
    throw new HttpCommandError(
      422,
      "WORKSPACE_REGISTRATION_REQUIRED",
      "Every Workspace must be registered by the Backend before it can be attached to a Task.",
    );
  }
  const byId = new Map(result.rows.map(row => [row.id as string, row]));
  return workspaces.map((workspace, ordering) => {
    const row = byId.get(workspace.id)!;
    return {
      ...workspace,
      ordering,
      displayName: workspace.displayName,
      role: workspace.role,
      referenceType: row.reference_type as WorkspaceReference["referenceType"],
      source: row.source_type as NonNullable<WorkspaceReference["source"]>,
      reference: row.normalized_reference as string,
      repositoryIdentity: row.repository_identity ?? undefined,
      branch: row.branch ?? undefined,
      commitSha: row.commit_sha ?? undefined,
      fingerprint: row.fingerprint as string,
      provenance: canonical({
        ...(asJson<Json>(row.provenance) ?? {}),
        verificationStatus: row.verification_status,
        verificationMethod: row.verification_method,
        verifiedAt: row.verified_at ? asIso(row.verified_at) : undefined,
        verificationAuthority: row.verification_authority,
      }),
    } satisfies WorkspaceReference;
  });
}

async function normalizeTaskContextForPersistence(
  client: PoolClient,
  draft: TaskDraftInput,
  workspaces: WorkspaceReference[],
): Promise<TaskContext> {
  const taskContext = effectiveTaskContext(draft);
  if (taskContext.kind === "INDEPENDENT") return { kind: "INDEPENDENT" };

  const context = await client.query(
    `select id,display_name,status,revision
     from intentchord.project_contexts
     where id=$1`,
    [taskContext.projectContextId],
  );
  if (!context.rowCount) {
    throw new HttpCommandError(422, "PROJECT_CONTEXT_NOT_FOUND", "The selected Project was not found.");
  }
  const row = context.rows[0];
  if (row.status !== "ACTIVE") {
    throw new HttpCommandError(409, "PROJECT_CONTEXT_ARCHIVED", "Archived Projects cannot receive new or revised Tasks.");
  }
  const currentRevision = Number(row.revision);
  if (currentRevision !== taskContext.projectContextRevision) {
    throw new HttpCommandError(409, "PROJECT_CONTEXT_REVISION_MISMATCH", "The selected Project changed. Reload it before continuing.");
  }

  const workspaceIds = workspaces.map(workspace => workspace.id);
  const linked = await client.query(
    `select workspace_registration_id
     from intentchord.project_context_workspaces
     where project_context_id=$1
       and valid_from <= clock_timestamp()
       and (valid_until is null or valid_until > clock_timestamp())
       and workspace_registration_id = any($2::uuid[])`,
    [taskContext.projectContextId, workspaceIds],
  );
  if ((linked.rowCount ?? 0) !== workspaceIds.length) {
    throw new HttpCommandError(422, "PROJECT_WORKSPACE_LINK_REQUIRED", "Every Workspace selected for a project Task must be linked to that Project. Project membership still grants no Task authority by itself.");
  }

  return {
    kind: "PROJECT_BOUND",
    projectContextId: String(row.id),
    projectContextDisplayName: String(row.display_name),
    projectContextRevision: currentRevision,
  };
}

async function normalizeDraftForPersistence(
  client: PoolClient,
  draftInput: TaskDraftInput,
  existingDraft?: TaskDraftInput,
): Promise<TaskDraftInput> {
  // Amendment 1: Orchestration Version is Server-Owned & Immutable
  // New task receives UNIFIED_V1 if not already stamped.
  // Existing task strictly preserves its existing orchestrationVersion (never silently upgraded!).
  const orchestrationVersion = existingDraft
    ? existingDraft.orchestrationVersion
    : (draftInput.orchestrationVersion ?? "UNIFIED_V1");

  // Canonicalize execution setup before persistence — reject conflicts
  const canonicalized = normalizeExecutionSetupCanonical(draftInput);
  requireCompatibleConfiguration(canonicalized);
  const workspaces = await requireWorkspaceRegistrations(client, canonicalized.workspaces);
  const taskContext = await normalizeTaskContextForPersistence(client, canonicalized, workspaces);
  const title = generatedTaskTitle(canonicalized.objective);

  // Amendment 3: Candidate Scope is backend-recomputed from binding
  let candidateScope = existingDraft?.candidateScope;
  if (canonicalized.contextAnalysisBinding) {
    candidateScope = await validateAndResolveTaskContextBinding(
      canonicalized.contextAnalysisBinding,
      workspaces.map(w => w.id),
    );
  }

  // Amendment 3: Scope confirmation is backend-owned; preserve from existing draft
  const scopeConfirmation = existingDraft?.scopeConfirmation ?? draftInput.scopeConfirmation;

  // Amendment 4: For UNIFIED_V1 tasks, executionSetup is the single source of truth.
  // Strip duplicate flattened execution fields so they are not persisted in draft_projection.
  const executionSetup = extractExecutionSetup(canonicalized);
  const draftToPersist = { ...canonicalized };
  if (orchestrationVersion === "UNIFIED_V1" && executionSetup) {
    delete draftToPersist.providerId;
    delete draftToPersist.modelId;
    delete draftToPersist.executionChannelId;
    delete draftToPersist.reasoningProfile;
    delete draftToPersist.runtimeProfileId;
    delete draftToPersist.modelOverrideAccepted;
    delete draftToPersist.modelOverrideReason;
  }

  return jsonPersistable(synchronizeLegacyWorkspaceProjection({
    ...draftToPersist,
    ...(orchestrationVersion ? { orchestrationVersion } : {}),
    taskContext,
    title,
    titleManuallyEdited: false,
    workspaces,
    ...(candidateScope ? { candidateScope } : {}),
    ...(scopeConfirmation ? { scopeConfirmation } : {}),
    ...(executionSetup ? { executionSetup } : {}),
  }));
}

async function insertDraftRevision(
  client: PoolClient,
  taskId: string,
  revision: number,
  draftInput: TaskDraftInput,
  normalizedDraft?: TaskDraftInput,
  existingDraft?: TaskDraftInput,
) {
  const draft = normalizedDraft ?? await normalizeDraftForPersistence(client, draftInput, existingDraft);
  const workspaces = draft.workspaces;
  const title = draft.title;
  const draftRevisionId = randomUUID();
  await client.query(
    `insert into intentchord.task_draft_revisions(
      id,task_id,revision,title,title_manually_edited,objective,task_mode,draft_projection,content_sha256
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      draftRevisionId,
      taskId,
      revision,
      title,
      draft.titleManuallyEdited,
      draft.objective,
      draft.taskMode,
      JSON.stringify(draft),
      sha256(canonical(draft)),
    ],
  );
  for (const workspace of workspaces) {
    const registration = await client.query(
      `select normalized_reference, verification_status, verification_method, verified_at,
        verification_authority, repository_identity, branch, commit_sha, fingerprint, provenance, source_type
       from intentchord.workspaces where id=$1`,
      [workspace.id],
    );
    const source = registration.rows[0];
    const snapshotId = randomUUID();
    await client.query(
      `insert into intentchord.task_workspace_snapshots(
        id,task_id,draft_revision_id,workspace_registration_id,ordering,display_name,role,
        reference_type,normalized_reference,verification_status,verification_method,verified_at,
        verification_authority,repository_identity,branch,commit_sha,fingerprint,provenance,
        authorization_context,source_type
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        snapshotId,
        taskId,
        draftRevisionId,
        workspace.id,
        workspace.ordering,
        workspace.displayName,
        workspace.role,
        workspace.referenceType,
        source.normalized_reference,
        source.verification_status,
        source.verification_method,
        source.verified_at,
        source.verification_authority,
        source.repository_identity,
        source.branch,
        source.commit_sha,
        source.fingerprint,
        source.provenance,
        workspace.authorizationContext,
        source.source_type,
      ],
    );
    for (const [entryType, paths] of [
      ["ALLOWED", workspace.allowedPaths],
      ["EXCLUDED", workspace.excludedPaths],
    ] as const) {
      for (const [ordering, scopePath] of paths.entries()) {
        await client.query(
          `insert into intentchord.task_workspace_scope_entries(
            id,task_workspace_snapshot_id,entry_type,path,ordering
          ) values($1,$2,$3,$4,$5)`,
          [randomUUID(), snapshotId, entryType, scopePath, ordering],
        );
      }
    }
  }
  return { draftRevisionId, draft };
}

export async function appendAuthorizedContextWorkspaceInTransaction(
  client: PoolClient,
  input: {
    taskId: string;
    expectedTaskRevision: number;
    workspace: WorkspaceReference;
    sourceAuthorizationId: string;
    missingEvidenceRequestId: string;
    ownerAuthority: string;
  },
) {
  const currentRevision = await lockTask(client, input.taskId, input.expectedTaskRevision);
  const currentDraft = await latestDraft(client, input.taskId);
  if (currentDraft.draft.orchestrationVersion !== "UNIFIED_V1") {
    throw new HttpCommandError(422, "UNIFIED_TASK_ORCHESTRATION_REQUIRED", "Context source expansion requires a UNIFIED_V1 Task.");
  }
  if (currentDraft.draft.workspaces.some(workspace => workspace.id === input.workspace.id)) {
    throw new HttpCommandError(409, "SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX", "The selected Workspace is already governed by the Task. Adding the same source again cannot resolve the Context requirement.");
  }
  const executionAuthority = await client.query(
    `select exists(
       select 1 from intentchord.runs
        where task_id=$1 and status in ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY')
     ) as active_run_exists`,
    [input.taskId],
  );
  if (executionAuthority.rows[0]?.active_run_exists) {
    throw new HttpCommandError(409, "CONTEXT_SOURCE_EXPANSION_LOCKED_DURING_ACTIVE_RUN", "Additional Context source cannot alter current Task authority while an active Run exists. Terminal historical Runs remain frozen provenance and do not permanently block Rebase.");
  }

  const expandedDraft = clearUnifiedExecutionConfiguration({
    ...currentDraft.draft,
    workspaces: [...currentDraft.draft.workspaces, { ...input.workspace, ordering: currentDraft.draft.workspaces.length }],
  });
  delete expandedDraft.contextAssemblyBinding;
  delete expandedDraft.contextAnalysisBinding;
  delete expandedDraft.candidateScope;
  delete expandedDraft.scopeConfirmation;

  const normalized = await normalizeDraftForPersistence(client, expandedDraft, currentDraft.draft);
  const finalDraft = clearUnifiedExecutionConfiguration({ ...normalized });
  delete finalDraft.contextAssemblyBinding;
  delete finalDraft.contextAnalysisBinding;
  delete finalDraft.candidateScope;
  delete finalDraft.scopeConfirmation;

  const nextRevision = currentRevision + 1;
  await insertDraftRevision(client, input.taskId, nextRevision, finalDraft, finalDraft, currentDraft.draft);
  await client.query(
    `update intentchord.tasks set
       title=$2,title_manually_edited=$3,objective=$4,task_mode=$5,draft=$6,revision=$7,updated_at=now()
     where id=$1`,
    [input.taskId, finalDraft.title, finalDraft.titleManuallyEdited, finalDraft.objective, finalDraft.taskMode, JSON.stringify(finalDraft), nextRevision],
  );
  await client.query(
    `update intentchord.contract_revisions set status='SUPERSEDED',state_revision=state_revision+1
      where task_id=$1 and status <> 'SUPERSEDED'`,
    [input.taskId],
  );
  await audit(client, {
    aggregateType: "TASK",
    aggregateId: input.taskId,
    eventType: "TASK_CONTEXT_SOURCE_EXPANDED",
    actor: input.ownerAuthority,
    revision: nextRevision,
    taskId: input.taskId,
    metadata: {
      sourceAuthorizationId: input.sourceAuthorizationId,
      missingEvidenceRequestId: input.missingEvidenceRequestId,
      workspaceRegistrationId: input.workspace.id,
      priorTaskRevision: currentRevision,
      forwardAuthorityMeaning: "NEW_CONTEXT_EVIDENCE_REQUIRES_NEW_ASSEMBLY_AND_REANALYSIS",
    },
  });
  return { taskRevision: nextRevision, draft: finalDraft };
}

async function latestDraft(client: Queryable, taskId: string) {
  const draftResult = await client.query(
    `select * from intentchord.task_draft_revisions
     where task_id=$1 order by revision desc limit 1`,
    [taskId],
  );
  if (!draftResult.rowCount) throw new HttpCommandError(500, "DRAFT_REVISION_MISSING", "The Task has no authoritative Draft revision.");
  const row = draftResult.rows[0];
  const snapshotResult = await client.query(
    `select s.*, wse.entry_type, wse.path, wse.ordering as scope_ordering
     from intentchord.task_workspace_snapshots s
     left join intentchord.task_workspace_scope_entries wse
       on wse.task_workspace_snapshot_id=s.id
     where s.draft_revision_id=$1
     order by s.ordering, wse.entry_type, wse.ordering`,
    [row.id],
  );
  const projection = asJson<TaskDraftInput>(row.draft_projection);
  const projectedWorkspaceById = new Map(
    (projection.workspaces ?? []).map(workspace => [workspace.id, workspace]),
  );
  const grouped = new Map<string, WorkspaceReference>();
  for (const snapshot of snapshotResult.rows) {
    let workspace = grouped.get(snapshot.id);
    if (!workspace) {
      workspace = {
        id: snapshot.workspace_registration_id,
        displayName: snapshot.display_name,
        role: snapshot.role,
        referenceType: snapshot.reference_type,
        source: snapshot.source_type,
        reference: snapshot.normalized_reference,
        repositoryIdentity: snapshot.repository_identity ?? undefined,
        branch: snapshot.branch ?? undefined,
        commitSha: snapshot.commit_sha ?? undefined,
        fingerprint: snapshot.fingerprint,
        provenance: canonical({
          ...(asJson<Json>(snapshot.provenance) ?? {}),
          verificationStatus: snapshot.verification_status,
          verificationMethod: snapshot.verification_method,
          verifiedAt: snapshot.verified_at ? asIso(snapshot.verified_at) : undefined,
          verificationAuthority: snapshot.verification_authority,
        }),
        discoveryScopeMode: projectedWorkspaceById.get(snapshot.workspace_registration_id)?.discoveryScopeMode,
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: snapshot.authorization_context,
        ordering: Number(snapshot.ordering),
      };
      grouped.set(snapshot.id, workspace);
    }
    if (snapshot.entry_type === "ALLOWED") workspace.allowedPaths.push(snapshot.path);
    if (snapshot.entry_type === "EXCLUDED") workspace.excludedPaths.push(snapshot.path);
  }
  const draft = synchronizeLegacyWorkspaceProjection({
    ...projection,
    title: generatedTaskTitle(row.objective),
    titleManuallyEdited: false,
    objective: row.objective,
    taskMode: row.task_mode,
    workspaces: [...grouped.values()],
  });
  return { row, draft };
}

async function latestDraftOrNull(client: Queryable, taskId: string): Promise<{ row: Record<string, unknown>; draft: TaskDraftInput } | null> {
  const draftResult = await client.query(
    `select * from intentchord.task_draft_revisions
     where task_id=$1 order by revision desc limit 1`,
    [taskId],
  );
  if (!draftResult.rowCount) return null;
  const row = draftResult.rows[0];
  const snapshotResult = await client.query(
    `select s.*, wse.entry_type, wse.path, wse.ordering as scope_ordering
     from intentchord.task_workspace_snapshots s
     left join intentchord.task_workspace_scope_entries wse
       on wse.task_workspace_snapshot_id=s.id
     where s.draft_revision_id=$1
     order by s.ordering, wse.entry_type, wse.ordering`,
    [row.id],
  );
  const projection = asJson<TaskDraftInput>(row.draft_projection);
  const projectedWorkspaceById = new Map(
    (projection.workspaces ?? []).map(workspace => [workspace.id, workspace]),
  );
  const grouped = new Map<string, WorkspaceReference>();
  for (const snapshot of snapshotResult.rows) {
    let workspace = grouped.get(snapshot.id);
    if (!workspace) {
      workspace = {
        id: snapshot.workspace_registration_id,
        displayName: snapshot.display_name,
        role: snapshot.role,
        referenceType: snapshot.reference_type,
        source: snapshot.source_type,
        reference: snapshot.normalized_reference,
        repositoryIdentity: snapshot.repository_identity ?? undefined,
        branch: snapshot.branch ?? undefined,
        commitSha: snapshot.commit_sha ?? undefined,
        fingerprint: snapshot.fingerprint,
        provenance: canonical({
          ...(asJson<Json>(snapshot.provenance) ?? {}),
          verificationStatus: snapshot.verification_status,
          verificationMethod: snapshot.verification_method,
          verifiedAt: snapshot.verified_at ? asIso(snapshot.verified_at) : undefined,
          verificationAuthority: snapshot.verification_authority,
        }),
        discoveryScopeMode: projectedWorkspaceById.get(snapshot.workspace_registration_id)?.discoveryScopeMode,
        allowedPaths: [],
        excludedPaths: [],
        authorizationContext: snapshot.authorization_context,
        ordering: Number(snapshot.ordering),
      };
      grouped.set(snapshot.id, workspace);
    }
    if (snapshot.entry_type === "ALLOWED") workspace.allowedPaths.push(snapshot.path);
    if (snapshot.entry_type === "EXCLUDED") workspace.excludedPaths.push(snapshot.path);
  }
  const draft = synchronizeLegacyWorkspaceProjection({
    ...projection,
    title: generatedTaskTitle(row.objective),
    titleManuallyEdited: false,
    objective: row.objective,
    taskMode: row.task_mode,
    workspaces: [...grouped.values()],
  });
  return { row, draft };
}

async function latestIntentResolution(client: Queryable, taskId: string) {
  const result = await client.query(
    `select ir.*
     from intentchord.intent_resolutions ir
     where ir.task_id=$1 and ir.status <> 'SUPERSEDED'
     order by ir.revision desc limit 1`,
    [taskId],
  );
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  const resolution = intentResolutionSchema.parse(asJson<IntentResolution>(row.resolution_content));
  return {
    id: row.id as string,
    revision: Number(row.revision),
    status: row.status as "PROPOSED" | "CONFIRMED" | "REJECTED",
    taskDraftRevisionId: row.task_draft_revision_id as string,
    resolverAdapterId: row.resolver_adapter_id as string,
    resolverProviderId: row.resolver_provider_id ?? undefined,
    resolverModelId: row.resolver_model_id ?? undefined,
    resolverExecutionChannelId: row.resolver_execution_channel_id ?? undefined,
    requestedProviderId: row.requested_provider_id as string,
    requestedModelId: row.requested_model_id as string,
    requestedExecutionChannelId: row.requested_execution_channel_id as string,
    promptVersion: row.prompt_version as string,
    schemaVersion: row.schema_version as string,
    authorityFingerprint: row.authority_fingerprint as string,
    inputSha256: row.input_sha256 as string,
    outputSha256: row.output_sha256 as string,
    confirmedBy: row.confirmed_by ?? undefined,
    confirmedAt: row.confirmed_at ? asIso(row.confirmed_at) : undefined,
    createdAt: asIso(row.created_at),
    resolution,
  };
}

function requestedAuthorizationFromDraft(draft: TaskDraftInput): ExecutionContract["authorization"] {
  return {
    readFiles: draft.readFiles,
    modifySource: draft.modifySource,
    runStaticValidation: draft.runStaticValidation,
    runTests: draft.runTests,
    build: draft.build,
    deploy: draft.deploy,
    restartServices: draft.restartServices,
    writeDatabase: draft.writeDatabase,
    changeEnvironment: draft.changeEnvironment,
    useNetwork: draft.useNetwork,
  };
}

function effectiveCapabilityIds(draft: TaskDraftInput): string[] {
  const policy = resolveAuthorization(draft.taskMode, requestedAuthorizationFromDraft(draft));
  return policy.trace.filter(item => item.effective).map(item => item.capability);
}

async function verifyCurrentTaskWorkspaceFreshness(taskId: string): Promise<void> {
  const mismatches = await transaction(async client => {
    const latest = await client.query(
      `select id from intentchord.task_draft_revisions
       where task_id=$1 order by revision desc limit 1`,
      [taskId],
    );
    if (!latest.rowCount) {
      throw new HttpCommandError(500, "DRAFT_REVISION_MISSING", "The Task has no authoritative Draft revision.");
    }
    const snapshots = await client.query(
      `select workspace_registration_id,display_name,reference_type,normalized_reference,
        verification_status,fingerprint,provenance
       from intentchord.task_workspace_snapshots
       where draft_revision_id=$1 order by ordering`,
      [latest.rows[0].id],
    );
    const stale: Array<Record<string, unknown>> = [];
    const unverified: Array<Record<string, unknown>> = [];
    for (const snapshot of snapshots.rows) {
      if (snapshot.verification_status !== "VERIFIED") {
        unverified.push({
          workspaceId: snapshot.workspace_registration_id,
          displayName: snapshot.display_name,
          verificationStatus: snapshot.verification_status,
          reason: "WORKSPACE_NOT_CURRENTLY_VERIFIED",
        });
        continue;
      }
      if (snapshot.reference_type !== "LOCAL_PATH") {
        continue;
      }
      let currentAuthority;
      try {
        currentAuthority = await assertRegisteredWorkspaceSourceAuthority(String(snapshot.workspace_registration_id));
      } catch (error) {
        stale.push({
          workspaceId: snapshot.workspace_registration_id,
          displayName: snapshot.display_name,
          reason: error instanceof HttpCommandError ? error.code : "WORKSPACE_REINSPECTION_FAILED",
        });
        continue;
      }
      // Task revisions freeze the Workspace Registration fingerprint. The shared Root Object Authority
      // gate first proves that the current path still resolves to the currently verified filesystem object;
      // this comparison then detects a later governed re-verification that supersedes the Task snapshot.
      const pathIdentityChanged = currentAuthority.registration.fingerprint !== snapshot.fingerprint;
      if (pathIdentityChanged) {
        stale.push({
          workspaceId: snapshot.workspace_registration_id,
          displayName: snapshot.display_name,
          reason: "WORKSPACE_REFERENCE_IDENTITY_CHANGED",
          expectedFingerprint: snapshot.fingerprint,
          currentFingerprint: currentAuthority.registration.fingerprint,
        });
      }
    }
    if (unverified.length) {
      throw new HttpCommandError(
        422,
        "WORKSPACE_VERIFICATION_REQUIRED",
        "Every Workspace snapshot must be Backend-verified before Contract resolution or Run creation.",
        unverified,
      );
    }
    // A governed re-verification may legitimately bind the Registration to a new Root Object.
    // That makes this Task's frozen Workspace snapshot stale, but it does not make the newly
    // verified Registration stale. Root-object mismatch/unprovable states are persisted by the
    // shared authority gate itself.
    return stale;
  });
  if (mismatches.length) {
    throw new HttpCommandError(
      409,
      "WORKSPACE_IDENTITY_STALE",
      "One or more Workspace verification identities changed after the Task snapshot. Refresh the Task Workspace snapshot before resolving or starting a Run.",
      mismatches,
    );
  }
}

function approvedContract(content: ExecutionContract, approvedAt?: unknown): ExecutionContract {
  return {
    ...content,
    ownerApproval: {
      required: true,
      state: approvedAt ? "APPROVED" : "AWAITING_OWNER_APPROVAL",
      ...(approvedAt ? { approvedAt: asIso(approvedAt) } : {}),
    },
  };
}

async function currentContract(client: Queryable, taskId: string) {
  const result = await client.query(
    `select cr.*, ca.approved_at, ca.owner_reference, ca.approval_channel
     from intentchord.contract_revisions cr
     left join intentchord.contract_approvals ca on ca.contract_revision_id=cr.id
     where cr.task_id=$1 and cr.status <> 'SUPERSEDED'
     order by cr.revision desc limit 1`,
    [taskId],
  );
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  return {
    row,
    contract: approvedContract(asJson<ExecutionContract>(row.contract_content), row.approved_at),
  };
}

async function currentContractForUpdate(client: PoolClient, taskId: string) {
  const result = await client.query(
    `select cr.*, ca.approved_at, ca.owner_reference, ca.approval_channel
     from intentchord.contract_revisions cr
     left join intentchord.contract_approvals ca on ca.contract_revision_id=cr.id
     where cr.task_id=$1 and cr.status <> 'SUPERSEDED'
     order by cr.revision desc limit 1
     for update of cr`,
    [taskId],
  );
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  return { row, contract: approvedContract(asJson<ExecutionContract>(row.contract_content), row.approved_at) };
}

async function lookupContractRouting(client: Queryable, contractRevisionId: string): Promise<{ taskId: string }> {
  const result = await client.query<{ task_id: string }>(
    `select task_id from intentchord.contract_revisions where id=$1`,
    [contractRevisionId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "CONTRACT_NOT_FOUND", "Contract revision not found.");
  return { taskId: result.rows[0].task_id };
}

async function readRuns(client: Queryable, taskId: string): Promise<RunRecord[]> {
  const result = await client.query(
    `select r.*, cr.contract_content, ca.approved_at,
      a.id as artifact_id, a.compiled_bytes, a.content_sha256 as artifact_sha256, a.compiler_version,
      a.compiled_at, a.delivery_state, a.delivery_method,
      rs.id as report_submission_id,
      v.id as verdict_id, v.verdict_content,
      od.id as decision_id, od.decision_type, od.reason as decision_reason, od.created_at as decision_at,
      rc.claim_value as report_envelope
     from intentchord.runs r
     join intentchord.contract_revisions cr on cr.id=r.contract_revision_id
     left join intentchord.contract_approvals ca on ca.contract_revision_id=cr.id
     left join intentchord.compiled_contract_artifacts a on a.id=r.compiled_artifact_id
     left join lateral (
       select * from intentchord.report_submissions
       where run_id=r.id and parse_status='PARSED'
       order by received_at desc limit 1
     ) rs on true
     left join lateral (
       select claim_value from intentchord.report_claims
       where report_submission_id=rs.id and claim_type='REPORT_ENVELOPE'
       order by created_at desc limit 1
     ) rc on true
     left join intentchord.verdicts v on v.run_id=r.id
     left join lateral (
       select * from intentchord.owner_decisions
       where run_id=r.id
       order by created_at desc,id desc limit 1
     ) od on true
     where r.task_id=$1
     order by r.round`,
    [taskId],
  );
  return result.rows.map(row => {
    const profile = asJson<{
      executor: string;
      agentProfileId: RunRecord["agentProfileId"];
      providerId: RunRecord["providerId"];
      modelId: RunRecord["modelId"];
      reasoningProfile: RunRecord["reasoningProfile"];
      runtimeProfileId: RunRecord["runtimeProfileId"];
    }>(row.profile_snapshot);
    const decision = (row.decision_type ?? "NONE") as Decision;
    return {
      id: row.id,
      round: Number(row.round),
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
      contractId: row.contract_revision_id,
      source: row.source,
      executionType: row.execution_type,
      status: row.status as RunRecord["status"],
      parentRunId: row.parent_run_id ?? undefined,
      bindingMarker: row.binding_marker,
      executor: profile.executor,
      agentProfileId: profile.agentProfileId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      reasoningProfile: profile.reasoningProfile,
      runtimeProfileId: profile.runtimeProfileId,
      executionCompleted: Boolean(row.report_submission_id),
      report: row.report_envelope ? asJson<ExecutorReportEnvelope>(row.report_envelope) : undefined,
      verdict: row.verdict_content ? asJson<Verdict>(row.verdict_content) : undefined,
      decision,
      decisionAt: row.decision_at ? asIso(row.decision_at) : undefined,
      correctionNotes: row.decision_reason ?? "",
      correctionStarted: Boolean(row.correction_started_at),
      supersededAt: row.superseded_at ? asIso(row.superseded_at) : undefined,
      stateRevision: Number(row.state_revision),
      compiledArtifact: row.artifact_id ? {
        id: row.artifact_id,
        text: (row.compiled_bytes as Buffer).toString("utf8"),
        sha256: row.artifact_sha256,
        compilerVersion: row.compiler_version,
        compiledAt: asIso(row.compiled_at),
        deliveryState: row.delivery_state,
        deliveryMethod: row.delivery_method ?? undefined,
      } : undefined,
    } as RunRecord;
  });
}

export async function readTaskLifecycle(taskId: string, client: Queryable = runtimeDatabase()) {
  assertUuid(taskId, "taskId");
  const taskResult = await client.query(
    "select id,revision,created_at,updated_at,draft from intentchord.tasks where id=$1",
    [taskId],
  );
  if (!taskResult.rowCount) return undefined;
  const taskRow = taskResult.rows[0];
  const draftResult = await latestDraftOrNull(client, taskId);
  const intentResolution = await latestIntentResolution(client, taskId);
  const discoveryRun = await readLatestDiscoveryRunForTask(taskId, client);
  const contract = await currentContract(client, taskId);
  const runs = await readRuns(client, taskId);
  const active = [...runs].reverse().find(run =>
    !run.supersededAt && ["AWAITING_REPORT", "REPORT_RECEIVED", "REVIEW_READY"].includes(run.status),
  );
  const draft = draftResult?.draft ?? asJson<TaskDraftInput>(taskRow.draft);
  return {
    id: taskId,
    createdAt: asIso(taskRow.created_at),
    updatedAt: asIso(taskRow.updated_at),
    revision: Number(taskRow.revision),
    draft,
    intentResolution,
    discoveryRun,
    contract: contract?.contract,
    contractRevisionId: contract?.row.id,
    contractStateRevision: contract ? Number(contract.row.state_revision) : undefined,
    contractContentSha256: contract?.row.content_sha256,
    runs,
    activeRunId: active?.id,
    promptLocaleExplicit: false,
    contractTab: "summary",
    reviewTab: "summary",
    ownerView: {
      taskSetup: projectTaskSetup(draft),
    },
  } satisfies TaskRecord;
}

export async function listTaskLifecycles() {
  const ids = await databaseQuery(
    "select id from intentchord.tasks order by updated_at desc",
  );
  return Promise.all(ids.rows.map(row => readTaskLifecycle(row.id)));
}

export async function createTask(command: unknown, ownerAuthority = OWNER_AUTHORITY_DEFAULT) {
  const { draft, requestedTaskId } = createTaskCommandSchema.parse(command);
  const taskId = requestedTaskId ?? randomUUID();
  await transaction(async client => {
    // Amendment 1: All new tasks receive UNIFIED_V1 from Backend authority
    const newDraftInput: TaskDraftInput = {
      ...(draft as TaskDraftInput),
      orchestrationVersion: "UNIFIED_V1",
    };
    const normalizedDraft = await normalizeDraftForPersistence(client, newDraftInput);
    const inserted = await client.query(
      `insert into intentchord.tasks(
        id,title,title_manually_edited,objective,task_mode,draft,revision
      ) values($1,$2,$3,$4,$5,$6,0)
      on conflict(id) do nothing
      returning id`,
      [
        taskId,
        normalizedDraft.title,
        false,
        normalizedDraft.objective,
        normalizedDraft.taskMode,
        JSON.stringify(normalizedDraft),
      ],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await client.query(
        `select draft_projection,content_sha256
         from intentchord.task_draft_revisions
         where task_id=$1 and revision=0
         limit 1`,
        [taskId],
      );
      const existingDraft = existing.rowCount
        ? asJson<TaskDraftInput>(existing.rows[0].draft_projection)
        : undefined;
      const normalizedDraftSha256 = sha256(canonical(normalizedDraft));
      const existingDraftSha256 = existing.rowCount
        ? String(existing.rows[0].content_sha256)
        : undefined;
      if (
        !existingDraft ||
        existingDraftSha256 !== normalizedDraftSha256 ||
        canonical(existingDraft) !== canonical(normalizedDraft)
      ) {
        throw new HttpCommandError(
          409,
          "TASK_CREATE_IDEMPOTENCY_MISMATCH",
          "The requested Task identity already exists with different input.",
        );
      }
      return;
    }
    await insertDraftRevision(client, taskId, 0, newDraftInput, normalizedDraft);
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "TASK_CREATED",
      actor: ownerAuthority,
      revision: 0,
      taskId,
    });
  });
  return readTaskLifecycle(taskId);
}

export async function reviseTask(taskId: string, command: unknown, ownerAuthority = OWNER_AUTHORITY_DEFAULT) {
  assertUuid(taskId, "taskId");
  const { expectedRevision, draft } = reviseTaskCommandSchema.parse(command);
  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, expectedRevision);
    const currentDraft = await latestDraft(client, taskId);
    const draftInput = draft as TaskDraftInput;

    // UNIFIED_V1 lifecycle authority mutations use dedicated commands only.
    if (currentDraft.draft.orchestrationVersion === "UNIFIED_V1") {
      if (
        canonical(draftInput.contextAnalysisBinding) !== canonical(currentDraft.draft.contextAnalysisBinding)
        || canonical(draftInput.contextAssemblyBinding) !== canonical(currentDraft.draft.contextAssemblyBinding)
        || canonical(draftInput.candidateScope) !== canonical(currentDraft.draft.candidateScope)
      ) {
        throw new HttpCommandError(
          400,
          "WORK_SELECTION_REQUIRES_DEDICATED_COMMAND",
          "Context understanding binding, accepted Catalog Work Selection, and Candidate Scope must be committed through the dedicated Work Selection command.",
        );
      }
      if (canonical(draftInput.scopeConfirmation) !== canonical(currentDraft.draft.scopeConfirmation)) {
        throw new HttpCommandError(
          400,
          "SCOPE_CONFIRMATION_REQUIRES_DEDICATED_COMMAND",
          "Owner Scope Confirmation must be submitted via the dedicated scope confirmation command.",
        );
      }
      if (canonical(extractExecutionSetup(draftInput)) !== canonical(extractExecutionSetup(currentDraft.draft))) {
        throw new HttpCommandError(
          400,
          "EXECUTION_PLATFORM_REQUIRES_DEDICATED_COMMAND",
          "UNIFIED_V1 execution configuration is backend-resolved after the Owner selects an Execution Platform through the dedicated command.",
        );
      }
    }

    let normalizedNext = await normalizeDraftForPersistence(client, draftInput, currentDraft.draft);
    let unifiedAuthorityInputChanged = true;
    let preserveUnifiedFrozenAuthority = false;

    if (currentDraft.draft.orchestrationVersion === "UNIFIED_V1") {
      const beforeAuthority = taskAuthorityInputSha256V1(currentDraft.draft);
      const afterAuthority = taskAuthorityInputSha256V1(normalizedNext);
      unifiedAuthorityInputChanged = beforeAuthority !== afterAuthority;
      preserveUnifiedFrozenAuthority = Boolean(currentDraft.draft.scopeConfirmation) && !unifiedAuthorityInputChanged;
      if (currentDraft.draft.scopeConfirmation) {
        // Scope Confirmation is the first execution-authority freeze. Generic edits may change
        // presentation-only metadata, but may not combine the frozen Scope with new authority inputs.
        if (unifiedAuthorityInputChanged) {
          throw new HttpCommandError(409, "SCOPE_AUTHORITY_REBASE_REQUIRED", "Authority-affecting Task inputs cannot change after Scope Confirmation. Preserve the historical confirmation and create a new current Context/Work/Scope authority through explicit Rebase.", { frozenAuthorityInputSha256: currentDraft.draft.scopeConfirmation.authorityInputSha256 ?? beforeAuthority, attemptedAuthorityInputSha256: afterAuthority });
        }
      } else if (currentDraft.draft.candidateScope && unifiedAuthorityInputChanged) {
        // Before the authority freeze, Work Selection is Owner intent only. An authority-input
        // change makes the prior Candidate historical intent/provenance; it must not remain confirmable.
        normalizedNext = clearUnifiedExecutionConfiguration({ ...normalizedNext });
        delete normalizedNext.contextAssemblyBinding;
        delete normalizedNext.contextAnalysisBinding;
        delete normalizedNext.candidateScope;
        delete normalizedNext.scopeConfirmation;
      }
    }

    const nextRevision = currentRevision + 1;
    const inserted = await insertDraftRevision(client, taskId, nextRevision, normalizedNext, normalizedNext, currentDraft.draft);
    await client.query(
      `update intentchord.tasks set
        title=$2,title_manually_edited=$3,objective=$4,task_mode=$5,draft=$6,
        revision=$7,updated_at=now()
       where id=$1`,
      [taskId, inserted.draft.title, inserted.draft.titleManuallyEdited, inserted.draft.objective, inserted.draft.taskMode, JSON.stringify(inserted.draft), nextRevision],
    );
    if (!preserveUnifiedFrozenAuthority) {
      await client.query(
        `update intentchord.contract_revisions
         set status='SUPERSEDED'
         where task_id=$1 and status <> 'SUPERSEDED'`,
        [taskId],
      );
      await client.query(
        `update intentchord.intent_resolutions
         set status='SUPERSEDED'
         where task_id=$1 and status in ('PROPOSED','CONFIRMED')`,
        [taskId],
      );
      await supersedeDiscoveryRunsForTask(client, taskId, "TASK_DRAFT_REVISED");
      const supersededRuns = await client.query(
        `update intentchord.runs
         set status='SUPERSEDED',superseded_at=now(),updated_at=now(),state_revision=state_revision+1
         where task_id=$1 and status in ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY')
         returning id,state_revision,contract_revision_id`,
        [taskId],
      );
      await client.query(
        `update intentchord.context_leases set status='INVALIDATED',invalidated_at=now(),
          invalidation_reason='TASK_DRAFT_REVISED',lease_revision=lease_revision+1
         where run_id = any($1::uuid[]) and status='ACTIVE'`,
        [supersededRuns.rows.map(row => row.id)],
      );
      for (const superseded of supersededRuns.rows) {
        await audit(client, {
          aggregateType: "RUN",
          aggregateId: superseded.id,
          eventType: "RUN_SUPERSEDED",
          actor: ownerAuthority,
          taskId,
          runId: superseded.id,
          revision: Number(superseded.state_revision),
          metadata: { reason: "TASK_DRAFT_REVISED" },
        });
      }
    }
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "TASK_DRAFT_REVISED",
      actor: ownerAuthority,
      revision: nextRevision,
      taskId,
    });
    for (const workspace of inserted.draft.workspaces) {
      await audit(client, {
        aggregateType: "TASK",
        aggregateId: taskId,
        eventType: "TASK_WORKSPACE_SNAPSHOTTED",
        actor: "BACKEND",
        revision: nextRevision,
        taskId,
        metadata: { workspaceRegistrationId: workspace.id, ordering: workspace.ordering },
      });
    }
  });
  return readTaskLifecycle(taskId);
}

export async function commitTaskWorkSelection(
  taskId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(taskId, "taskId");
  const parsed = taskWorkSelectionCommandSchema.parse(command);
  if (!("selectedComponentIds" in parsed)) {
    throw new HttpCommandError(
      422,
      "CONTEXT_CLOSURE_CATALOG_REQUIRED",
      "UNIFIED_V1 Owner Work Selection requires a deterministically closed Context Assembly and accepted V2 Component Catalog. Historical V1 Mapping proposals remain readable but are not canonical Work authority.",
    );
  }

  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const currentDraft = await latestDraft(client, taskId);
    if (currentDraft.draft.orchestrationVersion !== "UNIFIED_V1") {
      throw new HttpCommandError(422, "UNIFIED_TASK_ORCHESTRATION_REQUIRED", "Owner Work Selection requires a UNIFIED_V1 task.");
    }
    const executionAuthority = await client.query(
      `select exists(
         select 1 from intentchord.runs
          where task_id=$1 and status in ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY')
       ) as active_run_exists`,
      [taskId],
    );
    if (executionAuthority.rows[0]?.active_run_exists) {
      throw new HttpCommandError(409, "WORK_SELECTION_LOCKED_DURING_ACTIVE_RUN", "Current Work re-selection/Rebase cannot rewrite authority while an active Run is executing or awaiting resolution. Terminal historical Runs remain immutable provenance and do not permanently block Rebase.");
    }

    // Current Head is locked inside the same authority transaction. A successor Assembly cannot
    // appear between Catalog validation and the Task Work Selection write.
    const resolved = await resolveCurrentHeadContextAssemblyWorkSelection(client, {
      taskId,
      acceptedCatalogRevisionId: parsed.acceptedCatalogRevisionId,
      selectedComponentIds: parsed.selectedComponentIds,
      boundWorkspaceIds: currentDraft.draft.workspaces.map(workspace => workspace.id),
    });
    const revalidated = await validateContextAssemblyCandidateScope({
      taskId,
      binding: resolved.binding,
      candidateScope: resolved.candidateScope,
      boundWorkspaceIds: currentDraft.draft.workspaces.map(workspace => workspace.id),
      queryable: client,
    });

    const draftForSelection = clearUnifiedExecutionConfiguration({
      ...currentDraft.draft,
      contextAssemblyBinding: resolved.binding,
      candidateScope: revalidated,
    });
    delete draftForSelection.contextAnalysisBinding;
    delete draftForSelection.scopeConfirmation;

    const normalized = await normalizeDraftForPersistence(client, draftForSelection, currentDraft.draft);
    const selectionDraft = clearUnifiedExecutionConfiguration({
      ...normalized,
      contextAssemblyBinding: resolved.binding,
      candidateScope: revalidated,
    });
    delete selectionDraft.contextAnalysisBinding;
    delete selectionDraft.scopeConfirmation;

    const nextRevision = currentRevision + 1;
    await insertDraftRevision(client, taskId, nextRevision, selectionDraft, selectionDraft, currentDraft.draft);
    await client.query(
      `update intentchord.tasks set
        title=$2,title_manually_edited=$3,objective=$4,task_mode=$5,draft=$6,
        revision=$7,updated_at=now()
       where id=$1`,
      [taskId, selectionDraft.title, selectionDraft.titleManuallyEdited, selectionDraft.objective, selectionDraft.taskMode, JSON.stringify(selectionDraft), nextRevision],
    );
    await client.query(
      `update intentchord.contract_revisions set status='SUPERSEDED'
       where task_id=$1 and status <> 'SUPERSEDED'`,
      [taskId],
    );
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "OWNER_WORK_SELECTION_COMMITTED",
      actor: ownerAuthority,
      revision: nextRevision,
      taskId,
      metadata: {
        contextAssemblyId: resolved.binding.contextAssemblyId,
        contextAssemblyRevisionId: resolved.binding.contextAssemblyRevisionId,
        mappingIterationId: resolved.binding.mappingIterationId,
        closureEvaluationId: resolved.binding.closureEvaluationId,
        acceptedCatalogRevisionId: resolved.binding.acceptedCatalogRevisionId,
        selectedComponentCount: parsed.selectedComponentIds.length,
        selectedComponentIdsSha256: revalidated.selectedComponentIdsSha256,
        candidateScopeSha256: revalidated.candidateScopeSha256,
        authorityMeaning: "OWNER_INTENT_NOT_SCOPE_AUTHORITY_FREEZE",
      },
    });
  });
  return readTaskLifecycle(taskId);
}

export async function selectTaskExecutionPlatform(
  taskId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(taskId, "taskId");
  const parsed = taskExecutionPlatformCommandSchema.parse(command);
  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const currentDraft = await latestDraft(client, taskId);
    if (currentDraft.draft.orchestrationVersion !== "UNIFIED_V1") {
      throw new HttpCommandError(422, "UNIFIED_TASK_ORCHESTRATION_REQUIRED", "Late Execution Platform selection requires a UNIFIED_V1 task.");
    }
    const frozenContextRevisionId = requireUnifiedV2ScopeFreeze(currentDraft.draft);
    if (!frozenContextRevisionId) {
      throw new HttpCommandError(409, "UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED", "Current V2 Scope authority is required before selecting an Execution Platform.");
    }
    await assertCurrentEffectiveContextAuthority(client, taskId, frozenContextRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
    const authoritativeCandidateScope = await resolveCurrentUnifiedCandidateScope(taskId, currentDraft.draft, client);
    const confirmation = currentDraft.draft.scopeConfirmation;
    if (!confirmation) {
      throw new HttpCommandError(409, "SCOPE_CONFIRMATION_REQUIRED", "Owner Scope Confirmation is required before selecting an Execution Platform.");
    }
    const identity = confirmation.candidateIdentity;
    if (!candidateScopeIdentityMatches(identity, authoritativeCandidateScope)) {
      throw new HttpCommandError(409, "SCOPE_CONFIRMATION_IDENTITY_STALE", "Owner Scope Confirmation no longer matches the authoritative Candidate Scope.");
    }

    let executionSetup;
    try {
      executionSetup = resolveUnifiedExecutionSetup(currentDraft.draft, parsed.executionChannelId);
    } catch (error) {
      if (error instanceof UnifiedExecutionRoutingError) {
        throw new HttpCommandError(422, error.code, error.message);
      }
      throw error;
    }
    const draftWithExecution: TaskDraftInput = {
      ...currentDraft.draft,
      executionSetup,
    };
    delete draftWithExecution.providerId;
    delete draftWithExecution.modelId;
    delete draftWithExecution.executionChannelId;
    delete draftWithExecution.reasoningProfile;
    delete draftWithExecution.runtimeProfileId;
    delete draftWithExecution.modelOverrideAccepted;
    delete draftWithExecution.modelOverrideReason;

    const normalized = await normalizeDraftForPersistence(client, draftWithExecution, currentDraft.draft);
    const nextRevision = currentRevision + 1;
    await insertDraftRevision(client, taskId, nextRevision, normalized, normalized, currentDraft.draft);
    await client.query(
      `update intentchord.tasks set
        title=$2,title_manually_edited=$3,objective=$4,task_mode=$5,draft=$6,
        revision=$7,updated_at=now()
       where id=$1`,
      [taskId, normalized.title, normalized.titleManuallyEdited, normalized.objective, normalized.taskMode, JSON.stringify(normalized), nextRevision],
    );
    await client.query(
      `update intentchord.contract_revisions set status='SUPERSEDED'
       where task_id=$1 and status <> 'SUPERSEDED'`,
      [taskId],
    );
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "EXECUTION_PLATFORM_SELECTED_AND_CONFIGURATION_RESOLVED",
      actor: ownerAuthority,
      revision: nextRevision,
      taskId,
      metadata: {
        ownerSelectedExecutionChannelId: parsed.executionChannelId,
        resolvedProviderId: executionSetup.providerId,
        resolvedModelId: executionSetup.modelId,
        resolvedReasoningProfile: executionSetup.reasoningProfile,
        resolvedRuntimeProfileId: executionSetup.runtimeProfileId,
        modelOverrideAccepted: false,
      },
    });
  });
  return readTaskLifecycle(taskId);
}

export async function confirmTaskScope(
  taskId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(taskId, "taskId");
  const parsed = taskScopeConfirmationCommandSchema.parse(command);
  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const currentDraft = await latestDraft(client, taskId);
    if (!currentDraft.draft.orchestrationVersion || currentDraft.draft.orchestrationVersion !== "UNIFIED_V1") {
      throw new HttpCommandError(
        422,
        "UNIFIED_TASK_ORCHESTRATION_REQUIRED",
        "Dedicated Scope Confirmation requires a UNIFIED_V1 task draft.",
      );
    }
    if (!currentDraft.draft.contextAssemblyBinding || currentDraft.draft.candidateScope?.authorityVersion !== "CONTEXT_ASSEMBLY_V2") {
      throw new HttpCommandError(
        409,
        "UNIFIED_V2_CONTEXT_AUTHORITY_REQUIRED",
        "Historical MAPPING_V1 Context remains readable provenance but cannot create new UNIFIED_V1 Scope authority. Current Scope Confirmation requires an exact closed CONTEXT_ASSEMBLY_V2 authority chain.",
      );
    }

    // Scope Confirmation is the first execution-authority freeze. The same transaction proves
    // the complete CURRENT EFFECTIVE CONTEXT AUTHORITY, not merely max Assembly Revision.
    await assertCurrentEffectiveContextAuthority(
      client,
      taskId,
      currentDraft.draft.candidateScope.contextAssemblyRevisionId,
      "STALE_CANDIDATE_SCOPE",
    );
    // Recompute authoritative candidate scope from governed persisted records using the same
    // serialized authority transaction.
    const authoritativeCandidateScope = await resolveCurrentUnifiedCandidateScope(taskId, currentDraft.draft, client);

    // Concurrency precondition check (TOCTOU protection) across V1/V2 identities.
    const exp = parsed.expectedCandidateIdentity;
    const auth = authoritativeCandidateScope;
    if (!candidateScopeIdentityMatches(exp, auth)) {
      throw new HttpCommandError(
        409,
        "STALE_CANDIDATE_SCOPE",
        "The candidate scope has changed since presented to the owner. Re-confirm with the latest candidate scope.",
      );
    }

    // Amendment 5 & M1: Backend-derived confirmedBy and PostgreSQL DB clock confirmedAt
    const confirmedAt = await readDatabaseCommandTime(client);
    const provisionalConfirmation: TaskScopeConfirmation = {
      candidateIdentity: candidateScopeIdentityFromScope(auth),
      confirmedAllowedPaths: parsed.confirmedAllowedPaths,
      confirmedExcludedPaths: parsed.confirmedExcludedPaths,
      confirmedBy: ownerAuthority,
      confirmedAt,
      rationale: parsed.rationale,
    };
    const provisionalConfirmedDraft = clearUnifiedExecutionConfiguration(applyOwnerScopeConfirmation(
      currentDraft.draft,
      provisionalConfirmation,
      authoritativeCandidateScope,
    ));
    const confirmedDraft = { ...provisionalConfirmedDraft, scopeConfirmation: provisionalConfirmation };

    const nextRevision = currentRevision + 1;
    const normalized = await normalizeDraftForPersistence(client, confirmedDraft, currentDraft.draft);
    const normalizedAuthorityDraft = {
      ...normalized,
      candidateScope: authoritativeCandidateScope,
      scopeConfirmation: provisionalConfirmation,
    };
    const confirmation: TaskScopeConfirmation = {
      ...provisionalConfirmation,
      authorityInputSha256: taskAuthorityInputSha256V1(normalizedAuthorityDraft),
    };
    const draftWithConfirmation = {
      ...normalizedAuthorityDraft,
      scopeConfirmation: confirmation,
    };
    await insertDraftRevision(client, taskId, nextRevision, draftWithConfirmation, draftWithConfirmation, currentDraft.draft);
    await client.query(
      `update intentchord.tasks set
        title=$2,title_manually_edited=$3,objective=$4,task_mode=$5,draft=$6,
        revision=$7,updated_at=now()
       where id=$1`,
      [
        taskId,
        draftWithConfirmation.title,
        draftWithConfirmation.titleManuallyEdited,
        draftWithConfirmation.objective,
        draftWithConfirmation.taskMode,
        JSON.stringify(draftWithConfirmation),
        nextRevision,
      ],
    );
    await client.query(
      `update intentchord.contract_revisions
       set status='SUPERSEDED'
       where task_id=$1 and status <> 'SUPERSEDED'`,
      [taskId],
    );
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "TASK_DRAFT_REVISED",
      actor: ownerAuthority,
      revision: nextRevision,
      taskId,
      metadata: { action: "SCOPE_CONFIRMED", authorityMeaning: "FIRST_TASK_EXECUTION_AUTHORITY_FREEZE" },
    });
  });
  return readTaskLifecycle(taskId);
}

function mergeOwnerRequirementsIntoIntent(
  resolution: IntentResolution,
  ownerRequirements: OwnerRequirement[],
): IntentResolution {
  if (!ownerRequirements.length) return resolution;
  const explicit = ownerRequirements.map(requirement => ({
    id: requirement.id,
    outcome: requirement.outcome,
    origin: "OWNER_EXPLICIT" as const,
    requiredEvidenceTypes: requirement.requiredEvidenceTypes?.length
      ? requirement.requiredEvidenceTypes
      : resolution.taskMode === "SOURCE_IMPLEMENTATION"
        ? ["SOURCE", "VALIDATION"] as const
        : resolution.taskMode === "REPORT_REVIEW"
          ? ["ARTIFACT", "VALIDATION", "RUNTIME"] as const
          : ["SOURCE"] as const,
  }));
  const explicitIds = new Set(explicit.map(requirement => requirement.id));
  return intentResolutionSchema.parse({
    ...resolution,
    proposedRequirements: [
      ...explicit,
      ...resolution.proposedRequirements.filter(requirement => !explicitIds.has(requirement.id)),
    ],
  });
}

export async function resolveTaskIntent(
  taskId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(taskId, "taskId");
  const parsed = resolveIntentCommandSchema.parse(command);
  await verifyCurrentTaskWorkspaceFreshness(taskId);

  const snapshot = await transaction(async client => {
    await lockTask(client, taskId, parsed.expectedRevision);
    const activeRun = await client.query(
      `select id,status from intentchord.runs
       where task_id=$1 and status in ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY')
       limit 1`,
      [taskId],
    );
    if (activeRun.rowCount) {
      throw new HttpCommandError(
        409,
        "RUN_ALREADY_ACTIVE",
        "Intent understanding cannot be regenerated while an unresolved Run exists.",
        activeRun.rows[0],
      );
    }
    const confirmed = await client.query(
      `select id from intentchord.intent_resolutions
       where task_id=$1 and status='CONFIRMED' limit 1`,
      [taskId],
    );
    if (confirmed.rowCount) {
      throw new HttpCommandError(
        409,
        "INTENT_ALREADY_CONFIRMED",
        "The current Draft already has a confirmed Intent Resolution. Revise the Task objective to generate a new one.",
      );
    }
    const draft = await latestDraft(client, taskId);
    return {
      draftRevisionId: draft.row.id as string,
      draft: draft.draft,
    };
  });

  let binding;
  try {
    binding = providerBinding(
      "INTENT_PLANNER",
      parsed.plannerProviderId,
      parsed.plannerModelId,
      parsed.plannerExecutionChannelId,
    );
    assertAdapterBinding(parsed.plannerAdapterId, binding);
  } catch (error) {
    throw new HttpCommandError(
      422,
      "INTENT_PROVIDER_BINDING_INVALID",
      error instanceof Error ? error.message : "The Intent Planner provider binding is invalid.",
    );
  }
  const adapter = aiAdapterRegistry[parsed.plannerAdapterId];
  if (adapter.activation !== "BUILT_IN") {
    throw new HttpCommandError(
      501,
      "INTENT_PROVIDER_ADAPTER_NOT_CONFIGURED",
      `${parsed.plannerAdapterId} is registered but its external provider adapter is not configured in this deployment.`,
    );
  }

  const effectiveCapabilities = effectiveCapabilityIds(snapshot.draft);
  const authorityFingerprint = resolveAuthorityFingerprint({
    taskMode: snapshot.draft.taskMode,
    workspaceIds: snapshot.draft.workspaces.map(workspace => workspace.id),
    effectiveCapabilities,
  });
  const plannerInput = {
    literalObjective: snapshot.draft.objective,
    locale: parsed.locale,
    taskMode: snapshot.draft.taskMode,
    workspaceIds: snapshot.draft.workspaces.map(workspace => workspace.id),
    workspaceDisplayNames: snapshot.draft.workspaces.map(workspace => workspace.displayName),
    effectiveCapabilities,
    authorityFingerprint,
    providerBinding: binding,
  };
  const planner = new DeterministicIntentPlannerProvider();
  const proposed = mergeOwnerRequirementsIntoIntent(
    await planner.resolve(plannerInput),
    snapshot.draft.ownerRequirements,
  );
  const governed = validateIntentResolutionPolicy(proposed, plannerInput);
  const inputSha256 = intentInputFingerprint(plannerInput);
  const outputSha256 = intentResolutionSha256(governed);

  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const currentDraft = await latestDraft(client, taskId);
    if (currentDraft.row.id !== snapshot.draftRevisionId) throw new ConflictError();
    const confirmed = await client.query(
      `select id from intentchord.intent_resolutions
       where task_id=$1 and status='CONFIRMED' limit 1`,
      [taskId],
    );
    if (confirmed.rowCount) {
      throw new HttpCommandError(409, "INTENT_ALREADY_CONFIRMED", "The current Draft already has a confirmed Intent Resolution.");
    }
    await client.query(
      `update intentchord.intent_resolutions
       set status='SUPERSEDED'
       where task_id=$1 and status='PROPOSED'`,
      [taskId],
    );
    const nextResolution = await client.query(
      `select coalesce(max(revision),0)+1 as revision
       from intentchord.intent_resolutions where task_id=$1`,
      [taskId],
    );
    const resolutionId = randomUUID();
    await client.query(
      `insert into intentchord.intent_resolutions(
        id,task_id,task_draft_revision_id,revision,status,literal_objective,
        resolution_content,resolver_adapter_id,resolver_provider_id,resolver_model_id,
        resolver_execution_channel_id,requested_provider_id,requested_model_id,
        requested_execution_channel_id,prompt_version,schema_version,authority_fingerprint,
        input_sha256,output_sha256
      ) values($1,$2,$3,$4,'PROPOSED',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        resolutionId,
        taskId,
        snapshot.draftRevisionId,
        Number(nextResolution.rows[0].revision),
        governed.literalObjective,
        JSON.stringify(governed),
        planner.adapterId,
        null,
        null,
        null,
        binding.providerId,
        binding.modelId,
        binding.executionChannelId,
        intentPromptVersion,
        governed.schemaVersion,
        governed.authorityEcho.authorityFingerprint,
        inputSha256,
        outputSha256,
      ],
    );
    const nextTaskRevision = currentRevision + 1;
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [taskId, nextTaskRevision],
    );
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "INTENT_RESOLUTION_PROPOSED",
      actor: "BACKEND",
      revision: nextTaskRevision,
      taskId,
      metadata: {
        resolutionId,
        resolverAdapterId: planner.adapterId,
        requestedAdapterId: parsed.plannerAdapterId,
        producerKind: governed.producerKind,
        providerBinding: binding,
        inputSha256,
        outputSha256,
        authorityFingerprint,
      },
    });
  });
  return readTaskLifecycle(taskId);
}

export async function confirmTaskIntent(
  taskId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(taskId, "taskId");
  const parsed = confirmIntentCommandSchema.parse(command);
  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const rowResult = await client.query(
      `select * from intentchord.intent_resolutions
       where id=$1 and task_id=$2 for update`,
      [parsed.expectedResolutionId, taskId],
    );
    if (!rowResult.rowCount) {
      throw new HttpCommandError(404, "INTENT_RESOLUTION_NOT_FOUND", "Intent Resolution not found.");
    }
    const row = rowResult.rows[0];
    if (row.status !== "PROPOSED") {
      throw new HttpCommandError(409, "INTENT_RESOLUTION_NOT_CONFIRMABLE", "Only the current proposed Intent Resolution can be confirmed.");
    }
    if (row.output_sha256 !== parsed.expectedOutputSha256) {
      throw new HttpCommandError(409, "INTENT_RESOLUTION_HASH_MISMATCH", "The proposed Intent Resolution changed before confirmation.");
    }
    const currentDraft = await latestDraft(client, taskId);
    if (currentDraft.row.id !== row.task_draft_revision_id) throw new ConflictError();
    const currentContractResult = await client.query(
      `select id from intentchord.contract_revisions
       where task_id=$1 and status <> 'SUPERSEDED' limit 1`,
      [taskId],
    );
    if (currentContractResult.rowCount) {
      throw new HttpCommandError(409, "CONTRACT_ALREADY_RESOLVED", "Intent must be confirmed before Contract resolution.");
    }
    const proposed = intentResolutionSchema.parse(asJson<IntentResolution>(row.resolution_content));
    const confirmed = confirmIntentResolution(proposed);
    const confirmedSha256 = intentResolutionSha256(confirmed);
    await client.query(
      `update intentchord.intent_resolutions
       set status='CONFIRMED',resolution_content=$2,output_sha256=$3,
         confirmed_by=$4,confirmed_at=now()
       where id=$1`,
      [row.id, JSON.stringify(confirmed), confirmedSha256, ownerAuthority],
    );
    const nextTaskRevision = currentRevision + 1;
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [taskId, nextTaskRevision],
    );
    await audit(client, {
      aggregateType: "TASK",
      aggregateId: taskId,
      eventType: "INTENT_RESOLUTION_CONFIRMED",
      actor: ownerAuthority,
      revision: nextTaskRevision,
      taskId,
      metadata: {
        resolutionId: row.id,
        proposalSha256: parsed.expectedOutputSha256,
        confirmedSha256,
        authorityFingerprint: row.authority_fingerprint,
      },
    });
  });
  return readTaskLifecycle(taskId);
}

export async function resolveContract(taskId: string, command: unknown, ownerAuthority = OWNER_AUTHORITY_DEFAULT) {
  assertUuid(taskId, "taskId");
  const { expectedRevision } = resolveContractCommandSchema.parse(command);
  await verifyCurrentTaskWorkspaceFreshness(taskId);
  await transaction(async client => {
    const currentRevision = await lockTask(client, taskId, expectedRevision);
    const unresolvedRun = await client.query(
      `select id,status from intentchord.runs
       where task_id=$1 and status in ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY')
       limit 1`,
      [taskId],
    );
    if (unresolvedRun.rowCount) {
      throw new HttpCommandError(
        409,
        "RUN_ALREADY_ACTIVE",
        "A new Contract revision cannot be resolved while an unresolved Run exists.",
        unresolvedRun.rows[0],
      );
    }
    const draft = await latestDraft(client, taskId);
    let contractInput: ContractInput;
    try {
      contractInput = assertContractReadyTaskDraft(draft.draft);
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        throw new HttpCommandError(422, (error as { code: string }).code, error.message);
      }
      throw error;
    }

    if (draft.draft.orchestrationVersion === "UNIFIED_V1") {
      const frozenContextRevisionId = requireUnifiedV2ScopeFreeze(draft.draft);
      if (!frozenContextRevisionId) throw new HttpCommandError(409, "UNIFIED_V2_SCOPE_AUTHORITY_REQUIRED", "Current V2 Scope authority is required before Contract resolution.");
      await assertCurrentEffectiveContextAuthority(client, taskId, frozenContextRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
      const authoritativeCandidateScope = await resolveCurrentUnifiedCandidateScope(taskId, draft.draft, client);
      if (!draft.draft.scopeConfirmation || !candidateScopeIdentityMatches(draft.draft.scopeConfirmation.candidateIdentity, authoritativeCandidateScope)) {
        throw new HttpCommandError(422, "SCOPE_CONFIRMATION_IDENTITY_STALE", "Owner Scope Confirmation does not match the current authoritative Candidate Scope. Re-confirm scope after the latest governed Context understanding revision.");
      }
    } else if (draft.draft.contextAnalysisBinding) {
      await resolveCurrentUnifiedCandidateScope(taskId, draft.draft, client);
    }

    const requiresLegacyLifecycle = requiresLegacyIntentAndDiscovery(draft.draft.orchestrationVersion);
    let intentResolutionForContract: NonNullable<ExecutionContract["intentResolution"]> | undefined;
    let discoveryResolution: ExecutionContract["discoveryResolution"] | undefined;
    let intentOwnerRequirements: OwnerRequirement[] = draft.draft.ownerRequirements;

    if (requiresLegacyLifecycle) {
      const confirmedIntentResult = await client.query(
        `select * from intentchord.intent_resolutions
         where task_id=$1 and task_draft_revision_id=$2 and status='CONFIRMED'
         order by revision desc limit 1`,
        [taskId, draft.row.id],
      );
      if (!confirmedIntentResult.rowCount) {
        throw new HttpCommandError(
          422,
          "CONFIRMED_INTENT_REQUIRED",
          "Resolve and confirm the current Task intent before generating an Execution Contract.",
        );
      }
      const confirmedIntentRow = confirmedIntentResult.rows[0];
      const confirmedIntent = intentResolutionSchema.parse(
        asJson<IntentResolution>(confirmedIntentRow.resolution_content),
      );
      const discoveryRun = await readLatestDiscoveryRunForTask(taskId, client);
      if (!discoveryRun
        || discoveryRun.taskDraftRevisionId !== draft.row.id
        || discoveryRun.intentResolutionId !== confirmedIntentRow.id
        || !["COMPLETED", "EVIDENCE_REQUIRED"].includes(discoveryRun.status)) {
        throw new HttpCommandError(
          422,
          "TERMINAL_DISCOVERY_REQUIRED",
          "Complete bounded discovery for the confirmed current intent before generating an Execution Contract.",
        );
      }
      discoveryResolution = discoveryContractSummary(discoveryRun);
      const explicitOwnerRequirementById = new Map(
        draft.draft.ownerRequirements.map(requirement => [requirement.id, requirement]),
      );
      intentOwnerRequirements = confirmedIntent.proposedRequirements.map(requirement => {
        const explicitOwnerRequirement = explicitOwnerRequirementById.get(requirement.id);
        return {
          id: requirement.id,
          outcome: requirement.outcome,
          requiredEvidenceTypes: requirement.requiredEvidenceTypes,
          proofProfile: resolveRequirementProofProfile(
            requirement.requiredEvidenceTypes,
            explicitOwnerRequirement?.proofProfile,
          ),
        };
      });
      intentResolutionForContract = {
        id: confirmedIntentRow.id,
        revision: Number(confirmedIntentRow.revision),
        contentSha256: confirmedIntentRow.output_sha256,
        normalizedTopic: confirmedIntent.normalizedTopic,
        ownerSummary: confirmedIntent.ownerSummary,
        investigationQuestions: confirmedIntent.investigationQuestions.map(question => ({
          id: question.id,
          question: question.question,
        })),
        expectedConcepts: confirmedIntent.expectedConcepts,
        unknowns: confirmedIntent.unknowns,
        forbiddenAssumptions: confirmedIntent.forbiddenAssumptions,
      };
    }
    const unverified = await client.query(
      `select display_name,verification_status
       from intentchord.task_workspace_snapshots
       where draft_revision_id=$1 and verification_status <> 'VERIFIED'`,
      [draft.row.id],
    );
    if (unverified.rowCount) {
      throw new HttpCommandError(
        422,
        "WORKSPACE_VERIFICATION_REQUIRED",
        "Every Workspace snapshot must be Backend-verified before Contract resolution.",
        unverified.rows,
      );
    }
    const nextContractRevisionResult = await client.query(
      "select coalesce(max(revision),0)+1 as revision from intentchord.contract_revisions where task_id=$1",
      [taskId],
    );
    const contractRevision = Number(nextContractRevisionResult.rows[0].revision);
    const contractRevisionId = randomUUID();
    const contract = resolveExecutionContract({
      contractId: contractRevisionId,
      title: contractInput.title,
      objective: contractInput.objective,
      taskMode: contractInput.taskMode,
      ...(intentResolutionForContract ? { intentResolution: intentResolutionForContract } : {}),
      ...(discoveryResolution ? { discoveryResolution } : {}),
      ownerRequirements: intentOwnerRequirements,
      workspaces: contractInput.workspaces,
      allowedPaths: contractInput.allowedPaths,
      excludedPaths: contractInput.excludedPaths,
      evidenceFiles: contractInput.evidenceFiles,
      identity: contractInput.identity,
      authorization: {
        readFiles: contractInput.readFiles,
        modifySource: contractInput.modifySource,
        runStaticValidation: contractInput.runStaticValidation,
        runTests: contractInput.runTests,
        build: contractInput.build,
        deploy: contractInput.deploy,
        restartServices: contractInput.restartServices,
        writeDatabase: contractInput.writeDatabase,
        changeEnvironment: contractInput.changeEnvironment,
        useNetwork: contractInput.useNetwork,
      },
      providerId: contractInput.providerId,
      modelId: contractInput.modelId,
      executionChannelId: contractInput.executionChannelId,
      reasoningProfile: contractInput.reasoningProfile,
      runtimeProfileId: contractInput.runtimeProfileId,
      ownerOverrideAccepted: contractInput.modelOverrideAccepted,
      ownerOverrideReason: contractInput.modelOverrideReason,
    });
    const parsed = executionContractSchema.parse(contract);
    const contractLint = lintResolvedContract(parsed);
    if (contractLint.length) {
      throw new HttpCommandError(422, "CONTRACT_LINT_BLOCKED", "The resolved Contract failed mandatory governance lint.", contractLint);
    }
    const hash = sha256(canonical(parsed));
    const supersededContracts = await client.query(
      `update intentchord.contract_revisions
       set status='SUPERSEDED',state_revision=state_revision+1
       where task_id=$1 and status <> 'SUPERSEDED'
       returning id,state_revision`,
      [taskId],
    );
    for (const superseded of supersededContracts.rows) {
      await audit(client, {
        aggregateType: "CONTRACT",
        aggregateId: superseded.id,
        eventType: "CONTRACT_SUPERSEDED",
        actor: ownerAuthority,
        taskId,
        contractRevisionId: superseded.id,
        revision: Number(superseded.state_revision),
        metadata: { reason: "NEW_CONTRACT_REVISION_RESOLVED" },
      });
    }
    await client.query(
      `insert into intentchord.contract_revisions(
        id,task_id,task_draft_revision_id,revision,state_revision,status,
        contract_content,content_sha256,policy_version,governance_version
      ) values($1,$2,$3,$4,0,'AWAITING_OWNER_APPROVAL',$5,$6,$7,$8)`,
      [
        contractRevisionId,
        taskId,
        draft.row.id,
        contractRevision,
        JSON.stringify(parsed),
        hash,
        parsed.policyVersion,
        GOVERNANCE_VERSION,
      ],
    );
    const taskRevision = currentRevision + 1;
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [taskId, taskRevision],
    );
    await audit(client, {
      aggregateType: "CONTRACT",
      aggregateId: contractRevisionId,
      eventType: "CONTRACT_RESOLVED",
      actor: "BACKEND",
      revision: 0,
      taskId,
      contractRevisionId,
      metadata: {
        contractRevision,
        contentSha256: hash,
        modelProfile: profileSnapshot(parsed),
        ownerOverride: {
          accepted: parsed.selectedConfiguration.ownerOverrideAccepted,
          reason: parsed.selectedConfiguration.ownerOverrideReason,
        },
        intentResolution: parsed.intentResolution,
      },
    });
  });
  return readTaskLifecycle(taskId);
}

async function loadContractForUpdate(client: PoolClient, contractRevisionId: string) {
  const result = await client.query(
    `select cr.*, ca.approved_at
     from intentchord.contract_revisions cr
     left join intentchord.contract_approvals ca on ca.contract_revision_id=cr.id
     where cr.id=$1 for update of cr`,
    [contractRevisionId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "CONTRACT_NOT_FOUND", "Contract revision not found.");
  return result.rows[0];
}

export async function approveContractRevision(contractRevisionId: string, command: unknown, ownerAuthority = OWNER_AUTHORITY_DEFAULT) {
  assertUuid(contractRevisionId, "contractRevisionId");
  const parsedCommand = approveContractCommandSchema.parse(command);
  const taskId = await transaction(async client => {
    // Contract ID is routing metadata only. Canonical lock order is TASK -> CONTEXT -> WORKSPACES -> CONTRACT.
    const routing = await lookupContractRouting(client, contractRevisionId);
    const taskRevision = await lockTask(client, routing.taskId);
    const currentDraft = await latestDraft(client, routing.taskId);
    const frozenContextRevisionId = requireUnifiedV2ScopeFreeze(currentDraft.draft);
    if (frozenContextRevisionId) await assertCurrentEffectiveContextAuthority(client, routing.taskId, frozenContextRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
    const row = await loadContractForUpdate(client, contractRevisionId);
    if (row.task_id !== routing.taskId) throw new ConflictError("Contract routing identity changed before authority lock.");
    if (Number(row.state_revision) !== parsedCommand.expectedRevision) throw new ConflictError();
    if (row.status !== "AWAITING_OWNER_APPROVAL") {
      throw new HttpCommandError(409, "CONTRACT_NOT_APPROVABLE", "Only the current awaiting Contract revision can be approved.");
    }
    if (row.content_sha256 !== parsedCommand.expectedContentSha256) {
      throw new ConflictError("The approved Contract hash does not match the authoritative revision.");
    }
    const content = approvedContract(asJson<ExecutionContract>(row.contract_content), new Date());
    const preflight = validatePreflight(content).filter(issue => issue.code !== "MISSING_OWNER_APPROVAL");
    if (preflight.length) {
      throw new HttpCommandError(422, "PREFLIGHT_FAILED", "The Contract cannot be approved until Backend preflight issues are resolved.", preflight);
    }
    await client.query(
      `insert into intentchord.contract_approvals(
        id,contract_revision_id,owner_reference,contract_content_sha256,approved_state_revision,approval_channel
      ) values($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        contractRevisionId,
        ownerAuthority,
        row.content_sha256,
        parsedCommand.expectedRevision,
        parsedCommand.approvalChannel,
      ],
    );
    await client.query(
      "update intentchord.contract_revisions set status='APPROVED',state_revision=state_revision+1 where id=$1",
      [contractRevisionId],
    );
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [row.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "CONTRACT",
      aggregateId: contractRevisionId,
      eventType: "CONTRACT_APPROVED",
      actor: ownerAuthority,
      revision: parsedCommand.expectedRevision + 1,
      taskId: row.task_id,
      contractRevisionId,
      metadata: {
        contentSha256: row.content_sha256,
        approvalChannel: parsedCommand.approvalChannel,
      },
    });
    return row.task_id as string;
  });
  return readTaskLifecycle(taskId);
}

function profileSnapshot(contract: ExecutionContract) {
  const model = modelRegistry[contract.selectedConfiguration.modelId];
  return {
    executor: contract.agentResolution.executionChannelName,
    agentProfileId: contract.agentResolution.profileId,
    providerId: contract.selectedConfiguration.providerId,
    modelId: contract.selectedConfiguration.modelId,
    executableModelIdentifier: contract.selectedConfiguration.modelId,
    reasoningProfile: contract.selectedConfiguration.reasoningProfile,
    runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
    modelProfileVersion: model.profileVersion,
    capabilityProfileSha256: sha256(canonical({
      allowedReasoningProfiles: model.allowedReasoningProfiles,
      maxRecommendedComplexity: model.maxRecommendedComplexity,
      recommendedTaskModes: model.recommendedTaskModes,
    })),
    allowedReasoningLevels: model.allowedReasoningProfiles,
    recommendationEngineVersion: "0.1",
    registryVersion: MODEL_REGISTRY_VERSION,
    ownerOverrideAccepted: contract.selectedConfiguration.ownerOverrideAccepted,
    ownerOverrideReason: contract.selectedConfiguration.ownerOverrideReason,
    recommendation: contract.configurationRecommendation,
  };
}

async function insertCompiledArtifact(
  client: PoolClient,
  input: {
    contractRevisionId: string;
    contract: ExecutionContract;
    locale: "en" | "ar";
    runId?: string;
    prompt: string;
    deliveryMethod?: string;
  },
) {
  const id = randomUUID();
  const bytes = Buffer.from(input.prompt, "utf8");
  await client.query(
    `insert into intentchord.compiled_contract_artifacts(
      id,contract_revision_id,run_id,compiled_bytes,content_sha256,compiler_version,
      governance_version,task_skill_profile_version,agent_environment,provider,
      model_identifier,model_profile_snapshot,reasoning_level,locale,delivery_state,delivery_method
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      input.contractRevisionId,
      input.runId ?? null,
      bytes,
      sha256(bytes),
      COMPILER_VERSION,
      GOVERNANCE_VERSION,
      input.contract.agentResolution.taskSkill.version,
      input.contract.agentResolution.executionChannelId,
      input.contract.selectedConfiguration.providerId,
      input.contract.selectedConfiguration.modelId,
      JSON.stringify(profileSnapshot(input.contract)),
      input.contract.selectedConfiguration.reasoningProfile,
      input.locale,
      input.deliveryMethod ? "DELIVERED" : "COMPILED",
      input.deliveryMethod ?? null,
    ],
  );
  return { id, sha256: sha256(bytes) };
}

export async function compileContractArtifact(contractRevisionId: string, command: unknown) {
  assertUuid(contractRevisionId, "contractRevisionId");
  const parsed = compileContractCommandSchema.parse(command);
  return transaction(async client => {
    const routing = await lookupContractRouting(client, contractRevisionId);
    await lockTask(client, routing.taskId);
    const currentDraft = await latestDraft(client, routing.taskId);
    const frozenContextRevisionId = requireUnifiedV2ScopeFreeze(currentDraft.draft);
    if (frozenContextRevisionId) await assertCurrentEffectiveContextAuthority(client, routing.taskId, frozenContextRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
    const current = await loadContractForUpdate(client, contractRevisionId);
    if (current.task_id !== routing.taskId) throw new ConflictError("Contract routing identity changed before authority lock.");
    if (Number(current.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (current.status !== "APPROVED" || !current.approved_at) {
      throw new HttpCommandError(409, "CONTRACT_NOT_APPROVED", "The exact Contract revision must be approved before Run creation.");
    }
    const contract = approvedContract(asJson<ExecutionContract>(current.contract_content), current.approved_at);
    const contractLint = lintResolvedContract(contract);
    if (contractLint.length) {
      throw new HttpCommandError(422, "CONTRACT_LINT_BLOCKED", "The approved Contract no longer passes mandatory governance lint.", contractLint);
    }
    return {
      contractRevisionId,
      locale: parsed.locale,
      status: "READY_FOR_RUN_BOUND_COMPILATION" as const,
      executableArtifactCreated: false,
      reason: "Executable bytes are compiled atomically only after the Backend issues a Run ID, binding marker, and active Context Lease.",
    };
  });
}

function runBindingMarker(nonce: Buffer) {
  return `IC-RUN-${nonce.toString("base64url").toUpperCase()}`;
}

function authoritativeContextLeaseFingerprint(
  contract: ExecutionContract,
  execution: {
    activeRunId: string;
    round: number;
    executionType: RunRecord["executionType"];
    parentRunId?: string;
    bindingMarker: string;
    correctionGaps?: string[];
    ownerCorrectionInstruction?: string;
    completedFacts?: string[];
    inheritedCheckIds?: string[];
  },
) {
  return `sha256:${sha256(canonical({
    contractId: contract.contractId,
    objective: contract.objective,
    taskMode: contract.taskMode,
    workspaces: contract.scope.workspaces,
    allowedPaths: contract.scope.allowedPaths,
    excludedPaths: contract.scope.excludedPaths,
    evidenceFiles: contract.scope.evidenceFiles,
    policyDecisionTrace: contract.policyDecisionTrace,
    selectedConfiguration: contract.selectedConfiguration,
    execution,
  }))}`;
}

async function persistSourceMutatingContextConsumption(
  client: PoolClient,
  input: {
    taskId: string;
    taskDraftRevisionId: string;
    contractRevisionId: string;
    contract: ExecutionContract;
    source: RunRecord["source"];
    executionType: RunRecord["executionType"];
  },
  runId: string,
): Promise<void> {
  if (input.source === "SYNTHETIC_FIXTURE" || input.executionType === "FIXTURE" || !input.contract.authorization.modifySource) return;
  const draftRow = await client.query<{ draft_projection: unknown }>(
    "select draft_projection from intentchord.task_draft_revisions where id=$1 and task_id=$2",
    [input.taskDraftRevisionId, input.taskId],
  );
  if (!draftRow.rowCount) {
    throw new HttpCommandError(409, "RUN_CONTEXT_DRAFT_AUTHORITY_REQUIRED", "Source-mutating Run consumption requires the exact Contract-bound Task Draft authority.");
  }
  const draft = asJson<TaskDraftInput>(draftRow.rows[0].draft_projection);
  if (draft.orchestrationVersion !== "UNIFIED_V1") return;
  const confirmation = draft.scopeConfirmation;
  if (!confirmation || confirmation.candidateIdentity.authorityVersion !== "CONTEXT_ASSEMBLY_V2" || !confirmation.authorityInputSha256) {
    throw new HttpCommandError(409, "SOURCE_MUTATING_RUN_V2_SCOPE_AUTHORITY_REQUIRED", "A non-fixture source-mutating UNIFIED Run requires an exact frozen V2 Scope Confirmation authority.");
  }
  await client.query(
    `insert into intentchord.context_forward_authority_consumptions(
      id,task_id,context_assembly_revision_id,task_draft_revision_id,scope_authority_input_sha256,candidate_scope_sha256,
      contract_revision_id,run_id,consumption_type
    ) values($1,$2,$3,$4,$5,$6,$7,$8,'SOURCE_MUTATING_RUN_STARTED')`,
    [
      randomUUID(),
      input.taskId,
      confirmation.candidateIdentity.contextAssemblyRevisionId,
      input.taskDraftRevisionId,
      confirmation.authorityInputSha256,
      confirmation.candidateIdentity.candidateScopeSha256,
      input.contractRevisionId,
      runId,
    ],
  );
}

async function createRunInTransaction(
  client: PoolClient,
  input: {
    taskId: string;
    contractRow: Record<string, unknown>;
    contract: ExecutionContract;
    locale: "en" | "ar";
    source: RunRecord["source"];
    executionType: RunRecord["executionType"];
    round: number;
    parentRunId?: string;
    lineageRootId?: string;
    correctionRound?: number;
    taskDraftRevisionId: string;
    contractStateRevision: number;
    correctionGaps?: string[];
    ownerCorrectionInstruction?: string;
    completedFacts?: string[];
    inheritedCheckIds?: string[];
  },
) {
  const runId = randomUUID();
  const nonce = randomBytes(24);
  const bindingMarker = runBindingMarker(nonce);
  const leaseBinding = {
    activeRunId: runId,
    round: input.round,
    executionType: input.executionType,
    parentRunId: input.parentRunId,
    bindingMarker,
    correctionGaps: input.correctionGaps ?? [],
    ownerCorrectionInstruction: input.ownerCorrectionInstruction ?? "",
    completedFacts: input.completedFacts ?? [],
    inheritedCheckIds: input.inheritedCheckIds ?? [],
  };
  const lease = contextLease(input.contract, leaseBinding);
  const leaseFingerprint = authoritativeContextLeaseFingerprint(input.contract, leaseBinding);
  const executionContext = {
    activeRunId: runId,
    round: input.round,
    executionType: input.executionType,
    parentRunId: input.parentRunId,
    bindingMarker,
    correctionGaps: input.correctionGaps,
    ownerCorrectionInstruction: input.ownerCorrectionInstruction,
    completedFacts: input.completedFacts,
    inheritedCheckIds: input.inheritedCheckIds,
    contextLease: { revision: lease.revision, fingerprint: leaseFingerprint },
  };
  const promptDiagnostics = compileAgentPromptDiagnostics(input.contract, input.locale, executionContext);
  const prompt = promptDiagnostics.prompt;
  if (!promptDiagnostics.executable) {
    const issueSummary = promptDiagnostics.issues.length
      ? promptDiagnostics.issues.map(issue => `${issue.code}: ${issue.message}`).join(" | ")
      : "NON_EXECUTABLE_RUN_CONTEXT";
    throw new HttpCommandError(
      422,
      "CONTRACT_LINT_BLOCKED",
      `The executable Contract failed mandatory governance lint and no Run was created. Prompt length=${prompt.length}. Issues=${issueSummary}`,
      {
        promptLength: prompt.length,
        issues: promptDiagnostics.issues,
      },
    );
  }
  const artifact = await insertCompiledArtifact(client, {
    contractRevisionId: input.contractRow.id as string,
    contract: input.contract,
    locale: input.locale,
    prompt,
    deliveryMethod: "MANUAL_TRANSFER",
  });
  const profile = profileSnapshot(input.contract);
  await client.query(
    `insert into intentchord.runs(
      id,task_id,contract_revision_id,compiled_artifact_id,state_revision,status,source,
      execution_type,round,parent_run_id,lineage_root_id,correction_round,
      binding_nonce_hash,binding_marker,profile_snapshot
    ) values($1,$2,$3,$4,0,'AWAITING_REPORT',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      runId,
      input.taskId,
      input.contractRow.id,
      artifact.id,
      input.source,
      input.executionType,
      input.round,
      input.parentRunId ?? null,
      input.lineageRootId ?? runId,
      input.correctionRound ?? 0,
      sha256(nonce),
      bindingMarker,
      JSON.stringify(profile),
    ],
  );
  await persistSourceMutatingContextConsumption(client, {
    taskId: input.taskId,
    taskDraftRevisionId: input.taskDraftRevisionId,
    contractRevisionId: input.contractRow.id as string,
    contract: input.contract,
    source: input.source,
    executionType: input.executionType,
  }, runId);

  await client.query(
    "update intentchord.compiled_contract_artifacts set run_id=$2 where id=$1",
    [artifact.id, runId],
  );
  await client.query(
    `insert into intentchord.context_leases(
      id,run_id,workspace_snapshot,contract_sha256,profile_snapshot,binding_marker,
      lease_revision,fingerprint,status,contract_revision_id,task_draft_revision_id,
      contract_state_revision,execution_context
    ) values($1,$2,$3,$4,$5,$6,0,$7,'ACTIVE',$8,$9,$10,$11)`,
    [
      randomUUID(),
      runId,
      JSON.stringify(input.contract.scope.workspaces),
      input.contractRow.content_sha256,
      JSON.stringify(profile),
      bindingMarker,
      leaseFingerprint,
      input.contractRow.id,
      input.taskDraftRevisionId,
      input.contractStateRevision,
      JSON.stringify({
        correctionGaps: input.correctionGaps ?? [],
        ownerCorrectionInstruction: input.ownerCorrectionInstruction ?? "",
        completedFacts: input.completedFacts ?? [],
        inheritedCheckIds: input.inheritedCheckIds ?? [],
      }),
    ],
  );
  await audit(client, {
    aggregateType: "CONTRACT",
    aggregateId: input.contractRow.id as string,
    eventType: "CONTRACT_COMPILED",
    taskId: input.taskId,
    contractRevisionId: input.contractRow.id as string,
    runId,
    metadata: { artifactId: artifact.id, sha256: artifact.sha256, executable: true },
  });
  await audit(client, {
    aggregateType: "RUN",
    aggregateId: runId,
    eventType: "RUN_CREATED",
    taskId: input.taskId,
    contractRevisionId: input.contractRow.id as string,
    runId,
    revision: 0,
    metadata: {
      round: input.round,
      parentRunId: input.parentRunId,
      lineageRootId: input.lineageRootId ?? runId,
      correctionRound: input.correctionRound ?? 0,
    },
  });
  await audit(client, {
    aggregateType: "RUN",
    aggregateId: runId,
    eventType: "CONTRACT_DELIVERED",
    taskId: input.taskId,
    contractRevisionId: input.contractRow.id as string,
    runId,
    metadata: { method: "MANUAL_TRANSFER", artifactId: artifact.id },
  });
  return runId;
}

export async function createRun(taskId: string, command: unknown) {
  assertUuid(taskId, "taskId");
  const parsed = createRunCommandSchema.parse(command);
  await verifyCurrentTaskWorkspaceFreshness(taskId);
  await transaction(async client => {
    const taskRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const currentDraft = await latestDraft(client, taskId);
    const frozenContextRevisionId = requireUnifiedV2ScopeFreeze(currentDraft.draft);
    if (frozenContextRevisionId) await assertCurrentEffectiveContextAuthority(client, taskId, frozenContextRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
    const resolved = await currentContractForUpdate(client, taskId);
    if (!resolved || resolved.row.status !== "APPROVED" || !resolved.row.approved_at) {
      throw new HttpCommandError(409, "APPROVED_CONTRACT_REQUIRED", "An approved current Contract revision is required.");
    }
    const open = await client.query(
      "select id,status from intentchord.runs where task_id=$1 and status in ('AWAITING_REPORT','REPORT_RECEIVED','REVIEW_READY') limit 1",
      [taskId],
    );
    if (open.rowCount) throw new HttpCommandError(409, "RUN_ALREADY_ACTIVE", `An unresolved Run already exists in state ${open.rows[0].status}.`);
    const pendingCorrection = await client.query(
      `select od.id,od.run_id
       from intentchord.owner_decisions od
       where od.run_id in (select id from intentchord.runs where task_id=$1)
         and od.decision_type='CORRECTION_REQUESTED'
         and od.consumed_at is null
       order by od.created_at desc limit 1`,
      [taskId],
    );
    if (pendingCorrection.rowCount) {
      throw new HttpCommandError(
        409,
        "CORRECTION_REQUIRED",
        "The latest Owner Decision requires a lineage-bound correction Run; a new INITIAL Run cannot bypass it.",
        pendingCorrection.rows[0],
      );
    }
    const priorContractRun = await client.query(
      `select id,status from intentchord.runs
       where contract_revision_id=$1 order by created_at desc limit 1`,
      [resolved.row.id],
    );
    if (priorContractRun.rowCount) {
      throw new HttpCommandError(
        409,
        "NEW_CONTRACT_REVISION_REQUIRED",
        "An approved Contract revision can govern only one INITIAL Run. Resolve and approve a new revision before starting another initial execution.",
        priorContractRun.rows[0],
      );
    }
    const roundResult = await client.query(
      "select coalesce(max(round),0)+1 as round from intentchord.runs where task_id=$1",
      [taskId],
    );
    await createRunInTransaction(client, {
      taskId,
      contractRow: resolved.row,
      contract: resolved.contract,
      locale: parsed.locale,
      source: parsed.source,
      executionType: parsed.executionType,
      round: Number(roundResult.rows[0].round),
      taskDraftRevisionId: resolved.row.task_draft_revision_id as string,
      contractStateRevision: Number(resolved.row.state_revision),
    });
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [taskId, taskRevision + 1],
    );
  });
  return readTaskLifecycle(taskId);
}

async function loadRunForUpdate(client: PoolClient, runId: string) {
  const result = await client.query(
    `select r.*, cr.contract_content, cr.content_sha256 as contract_sha256,
      cr.status as contract_status, cr.state_revision as contract_state_revision,
      cr.task_draft_revision_id as run_task_draft_revision_id,
      ca.approved_at, ca.owner_reference,
      cl.status as lease_status, cl.fingerprint as lease_fingerprint,
      cl.contract_revision_id as lease_contract_revision_id,
      cl.task_draft_revision_id as lease_task_draft_revision_id,
      cl.contract_state_revision as lease_contract_state_revision,
      cl.binding_marker as lease_binding_marker,
      cl.execution_context as lease_execution_context
     from intentchord.runs r
     join intentchord.contract_revisions cr on cr.id=r.contract_revision_id
     left join intentchord.contract_approvals ca on ca.contract_revision_id=cr.id
     left join intentchord.context_leases cl on cl.run_id=r.id
     where r.id=$1 for update of r`,
    [runId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "RUN_NOT_FOUND", "Run not found.");
  return result.rows[0];
}

function requireActiveContextLease(run: Record<string, unknown>) {
  if (run.lease_status !== "ACTIVE") {
    throw new HttpCommandError(409, "CONTEXT_LEASE_INACTIVE", "The Run Context Lease is not active.", { status: run.lease_status });
  }
  if (run.lease_binding_marker !== run.binding_marker) {
    throw new HttpCommandError(409, "CONTEXT_LEASE_BINDING_MISMATCH", "The Context Lease binding marker does not match the Run.");
  }
  if (run.lease_contract_revision_id !== run.contract_revision_id) {
    throw new HttpCommandError(409, "CONTEXT_LEASE_CONTRACT_MISMATCH", "The Context Lease is not bound to the Run Contract revision.");
  }
  if (run.lease_task_draft_revision_id !== run.run_task_draft_revision_id) {
    throw new HttpCommandError(409, "CONTEXT_LEASE_DRAFT_MISMATCH", "The Context Lease is not bound to the approved Task Draft revision.");
  }
  if (run.contract_status !== "APPROVED" || !run.approved_at) {
    throw new HttpCommandError(409, "CONTEXT_LEASE_CONTRACT_INACTIVE", "The Contract bound to the Context Lease is no longer approved.");
  }
  if (Number(run.lease_contract_state_revision) !== Number(run.contract_state_revision)) {
    throw new HttpCommandError(409, "CONTEXT_LEASE_STALE", "The Contract state revision no longer matches the active Context Lease.");
  }
  const contract = asJson<ExecutionContract>(run.contract_content);
  const leaseExecutionContext = asJson<{
    correctionGaps?: string[];
    ownerCorrectionInstruction?: string;
    completedFacts?: string[];
    inheritedCheckIds?: string[];
  }>(run.lease_execution_context ?? {});
  const expected = authoritativeContextLeaseFingerprint(contract, {
    activeRunId: String(run.id),
    round: Number(run.round),
    executionType: run.execution_type as RunRecord["executionType"],
    parentRunId: typeof run.parent_run_id === "string" ? run.parent_run_id : undefined,
    bindingMarker: String(run.binding_marker),
    correctionGaps: leaseExecutionContext.correctionGaps ?? [],
    ownerCorrectionInstruction: leaseExecutionContext.ownerCorrectionInstruction ?? "",
    completedFacts: leaseExecutionContext.completedFacts ?? [],
    inheritedCheckIds: leaseExecutionContext.inheritedCheckIds ?? [],
  });
  if (run.lease_fingerprint !== expected) {
    throw new HttpCommandError(409, "CONTEXT_LEASE_FINGERPRINT_MISMATCH", "The persisted Context Lease fingerprint does not match the authoritative Contract and Run lineage.");
  }
}


function boundRunIdentity(run: Record<string, unknown>, contract: ExecutionContract) {
  return {
    contractId: run.contract_revision_id,
    runId: run.id,
    round: Number(run.round),
    executionType: run.execution_type,
    parentRunId: typeof run.parent_run_id === "string" ? run.parent_run_id : undefined,
    bindingMarker: run.binding_marker,
    providerId: contract.selectedConfiguration.providerId,
    modelId: contract.selectedConfiguration.modelId,
    executionChannelId: contract.selectedConfiguration.executionChannelId,
    reasoningProfile: contract.selectedConfiguration.reasoningProfile,
    runtimeProfileId: contract.selectedConfiguration.runtimeProfileId,
  };
}

function bindingComparison(report: ExecutorReportEnvelope | undefined, bound: ReturnType<typeof boundRunIdentity>) {
  const fields = [
    "contractId",
    "runId",
    "round",
    "executionType",
    "parentRunId",
    "bindingMarker",
    "providerId",
    "modelId",
    "executionChannelId",
    "reasoningProfile",
    "runtimeProfileId",
  ] as const;
  const comparisons = Object.fromEntries(fields.map(field => [
    field,
    {
      claimed: report?.[field],
      bound: bound[field],
      matches: report ? (report[field] ?? null) === (bound[field] ?? null) : false,
    },
  ]));
  return {
    matches: report ? fields.every(field => (report[field] ?? null) === (bound[field] ?? null)) : false,
    fields: comparisons,
  };
}

type SourceEvidenceReference = Extract<ReportEvidenceReference, { kind: "SOURCE_EVIDENCE" }>;

function reportReferenceRelativePath(reference: ReportEvidenceReference): string | undefined {
  if (reference.kind === "SOURCE_EVIDENCE") return reference.relativePath;
  if (reference.kind === "INSPECTED_PATH" || reference.kind === "SUPPORTING_EVIDENCE") return reference.path;
  return undefined;
}

async function verifyAndPersistSourceEvidence(
  client: PoolClient,
  input: {
    runId: string;
    requirementId: string;
    observation: string;
    reference: SourceEvidenceReference;
    contract: ExecutionContract;
    signal?: AbortSignal;
    deadlineAt?: number;
  },
): Promise<void> {
  const workspace = input.contract.scope.workspaces.find(item => item.id === input.reference.workspaceId);
  if (!workspace) {
    throw new HttpCommandError(422, "SOURCE_EVIDENCE_WORKSPACE_UNKNOWN", "Source evidence names a Workspace outside the Contract.");
  }
  if (workspace.referenceType !== "LOCAL_PATH") {
    throw new HttpCommandError(
      422,
      "SOURCE_EVIDENCE_REMOTE_UNVERIFIED",
      "Remote source evidence requires a trusted connector or signed adapter and cannot be promoted by local file verification.",
    );
  }
  if (!input.contract.authorization.readFiles) {
    throw new HttpCommandError(422, "SOURCE_EVIDENCE_READ_NOT_AUTHORIZED", "The Contract does not authorize source-file verification.");
  }
  const normalizedRelativePath = input.reference.relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const containsPath = (boundary: string) => {
    const normalizedBoundary = boundary.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return normalizedRelativePath === normalizedBoundary || normalizedRelativePath.startsWith(`${normalizedBoundary}/`);
  };
  if (workspace.discoveryScopeMode === "NONE"
    || (workspace.discoveryScopeMode === "SELECTED_PATHS" && !workspace.allowedPaths.some(containsPath))) {
    throw new HttpCommandError(
      422,
      "SOURCE_EVIDENCE_PATH_OUTSIDE_READ_SCOPE",
      "Source evidence is outside the Workspace-specific effective read boundary.",
      { workspaceId: workspace.id, relativePath: input.reference.relativePath },
    );
  }
  if (workspace.excludedPaths.some(containsPath)) {
    throw new HttpCommandError(
      422,
      "SOURCE_EVIDENCE_PATH_EXCLUDED",
      "Source evidence points to a path explicitly excluded by the Contract.",
      { workspaceId: workspace.id, relativePath: input.reference.relativePath },
    );
  }

  // Report Source Evidence is a governed Workspace source read. The shared Backend source-read bridge
  // proves the current Registered Root Object and then resolves/opens the child through the same
  // parent-bound object authority used by indexing and Discovery. No source bytes are read by a
  // globally mutable absolute path.
  let captured;
  try {
    ({ captured } = await captureRegisteredWorkspaceSourceFile({
      workspaceId: workspace.id,
      relativePath: normalizedRelativePath,
      maxPrefixBytes: 0,
      countLines: input.reference.lineStart !== undefined && input.reference.lineEnd !== undefined,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    }));
  } catch (error) {
    const governedCode = terminalRuntimeGovernanceCode(error);
    if (governedCode) {
      throw new HttpCommandError(
        408,
        governedCode,
        governedCode === "WORKSPACE_INDEX_ABORTED"
          ? "The governed source-evidence read was aborted before a complete capture was proven."
          : "The governed source-evidence read exceeded its operation deadline before a complete capture was proven.",
        { workspaceId: workspace.id, relativePath: input.reference.relativePath },
      );
    }
    throw new HttpCommandError(
      422,
      "SOURCE_EVIDENCE_PATH_UNAVAILABLE",
      error instanceof Error ? error.message : "The source evidence file cannot be captured inside the verified Workspace boundary.",
      { workspaceId: workspace.id, relativePath: input.reference.relativePath },
    );
  }
  const contentSha256 = captured.content_hash.replace(/^sha256:/, "");
  if (contentSha256 !== input.reference.contentSha256) {
    throw new HttpCommandError(
      422,
      "SOURCE_EVIDENCE_HASH_MISMATCH",
      "The submitted source-evidence hash does not match the current file bytes.",
      {
        workspaceId: workspace.id,
        relativePath: input.reference.relativePath,
        expectedSha256: input.reference.contentSha256,
        actualSha256: contentSha256,
      },
    );
  }
  if (input.reference.lineStart !== undefined && input.reference.lineEnd !== undefined) {
    const lineCount = captured.line_count ?? 0;
    if (input.reference.lineEnd > lineCount) {
      throw new HttpCommandError(
        422,
        "SOURCE_EVIDENCE_LINE_RANGE_INVALID",
        "The submitted source-evidence line range exceeds the verified file length.",
        { lineCount, lineStart: input.reference.lineStart, lineEnd: input.reference.lineEnd },
      );
    }
  }

  await client.query(
    `insert into intentchord.source_evidence(
      id,run_id,requirement_id,workspace_registration_id,relative_path,symbol,
      line_start,line_end,content_sha256,observation,producer_type
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'BACKEND')
    on conflict do nothing`,
    [
      randomUUID(),
      input.runId,
      input.requirementId,
      input.reference.workspaceId,
      input.reference.relativePath,
      input.reference.symbol ?? null,
      input.reference.lineStart ?? null,
      input.reference.lineEnd ?? null,
      contentSha256,
      input.observation,
    ],
  );
}

async function persistBackendReportValidation(
  client: PoolClient,
  input: {
    runId: string;
    contract: ExecutionContract;
    bindingMatches: boolean;
  },
): Promise<void> {
  if (!input.contract.requiredChecks.some(check => check.id === "contract-validation" && check.required)) {
    return;
  }
  const batchId = randomUUID();
  const producerType = "BACKEND" as const;
  const producerId = "intentchord-backend/report-verifier-v1";
  const trustBasis = "INTERNAL_BACKEND";
  const checkId = "contract-validation";
  const status = input.bindingMatches ? "PASS" as const : "FAIL" as const;
  const details = input.bindingMatches
    ? "Backend verified the parsed report schema and exact active Contract/Run/profile binding."
    : "Backend verified the parsed report schema, but the executor-claimed identity does not match the active Contract/Run/profile binding.";
  const payloadSha256 = sha256(canonical({
    runId: input.runId,
    batchId,
    sequence: 0,
    sequenceTotal: 1,
    isTerminal: true,
    checkId,
    status,
    details,
    producerType,
    producerId,
    trustBasis,
    requestId: null,
  }));
  await client.query(
    `insert into intentchord.validation_evidence(
      id,run_id,check_id,status,producer_type,producer_id,trust_basis,request_id,details,
      integrity_sha256,payload_sha256,batch_id,sequence,sequence_total,is_terminal
    ) values($1,$2,$3,$4,$5,$6,$7,null,$8,$9,$9,$10,0,1,true)`,
    [
      randomUUID(),
      input.runId,
      checkId,
      status,
      producerType,
      producerId,
      trustBasis,
      details,
      payloadSha256,
      batchId,
    ],
  );
}

async function persistReportClaims(
  client: PoolClient,
  reportSubmissionId: string,
  report: ExecutorReportEnvelope,
  taskId: string,
  contract: ExecutionContract,
  governance: { signal?: AbortSignal; deadlineAt?: number } = {},
) {
  await client.query(
    `insert into intentchord.report_claims(
      id,report_submission_id,claim_type,claim_key,claim_status,claim_value
    ) values($1,$2,'REPORT_ENVELOPE','report',null,$3)`,
    [randomUUID(), reportSubmissionId, JSON.stringify(report)],
  );

  const attachedWorkspaceIds = new Set<string>((await client.query(
    `select distinct workspace_registration_id as id
     from intentchord.task_workspace_snapshots where task_id=$1`,
    [taskId],
  )).rows.map(row => String(row.id)));

  for (const finding of report.findings) {
    await client.query(
      `insert into intentchord.report_claims(
        id,report_submission_id,claim_type,claim_key,claim_status,claim_value
      ) values($1,$2,'FINDING',$3,$4,$5)`,
      [randomUUID(), reportSubmissionId, finding.claim, finding.status, JSON.stringify(finding)],
    );
    for (const reference of finding.evidenceRefs) {
      const workspaceId = "workspaceId" in reference ? reference.workspaceId : undefined;
      if (workspaceId && !attachedWorkspaceIds.has(workspaceId)) {
        throw new HttpCommandError(
          422,
          "REPORT_WORKSPACE_NOT_ATTACHED",
          "A structured report reference names a Workspace that is not attached to the Task.",
          { workspaceId, finding: finding.claim },
        );
      }
      const relativePath = reportReferenceRelativePath(reference);
      if (reference.kind === "SOURCE_EVIDENCE") {
        await verifyAndPersistSourceEvidence(client, {
          runId: report.runId,
          requirementId: finding.requirementId,
          observation: finding.claim,
          reference,
          contract,
          signal: governance.signal,
          deadlineAt: governance.deadlineAt,
        });
      }
      const sourceReference = JSON.stringify(reference);
      await client.query(
        `insert into intentchord.report_evidence_references(
          id,report_submission_id,workspace_registration_id,relative_path,
          reference_kind,source_reference,observation,evidence_type,source_producer,
          validation_relationship
        ) values($1,$2,$3,$4,$5,$6,$7,'EXECUTOR_REFERENCE','EXECUTOR_REPORT','CLAIMED_NOT_VALIDATED')`,
        [
          randomUUID(),
          reportSubmissionId,
          workspaceId ?? null,
          relativePath ?? null,
          reference.kind,
          sourceReference,
          finding.claim,
        ],
      );
    }
  }
  const requirementById = new Map(contract.executionPackage.mandatoryRequirements.map(requirement => [requirement.id, requirement]));
  for (const proof of report.requirementProofs) {
    const requirement = requirementById.get(proof.requirementId);
    if (!requirement) {
      throw new HttpCommandError(422, "REPORT_REQUIREMENT_UNKNOWN", "The report contains a proof row for an unknown mandatory requirement.", { requirementId: proof.requirementId });
    }
    await client.query(
      `insert into intentchord.report_claims(
        id,report_submission_id,claim_type,claim_key,claim_status,claim_value
      ) values($1,$2,'REQUIREMENT_PROOF',$3,$4,$5)`,
      [randomUUID(), reportSubmissionId, proof.requirementId, proof.classification, JSON.stringify(proof)],
    );
    const categories: Array<[string, ReportEvidenceReference[]]> = [
      ["source-behavior", proof.sourceBehaviorRefs],
      ["positive", proof.positiveProofRefs],
      ["negative-adversarial", proof.negativeAdversarialProofRefs],
      ["persistence-reload", proof.persistenceReloadProofRefs],
    ];
    for (const [category, references] of categories) {
      for (const reference of references) {
        const workspaceId = "workspaceId" in reference ? reference.workspaceId : undefined;
        if (workspaceId && !attachedWorkspaceIds.has(workspaceId)) {
          throw new HttpCommandError(
            422,
            "REPORT_WORKSPACE_NOT_ATTACHED",
            "A requirement proof names a Workspace that is not attached to the Task.",
            { workspaceId, requirementId: proof.requirementId, category },
          );
        }
        const relativePath = reportReferenceRelativePath(reference);
        if (reference.kind === "SOURCE_EVIDENCE") {
          await verifyAndPersistSourceEvidence(client, {
            runId: report.runId,
            requirementId: proof.requirementId,
            observation: `requirement:${proof.requirementId}:${category}`,
            reference,
            contract,
          });
        }
        await client.query(
          `insert into intentchord.report_evidence_references(
            id,report_submission_id,workspace_registration_id,relative_path,
            reference_kind,source_reference,observation,evidence_type,source_producer,
            validation_relationship
          ) values($1,$2,$3,$4,$5,$6,$7,'REQUIREMENT_PROOF_REFERENCE','EXECUTOR_REPORT','CLAIMED_NOT_VALIDATED')`,
          [
            randomUUID(),
            reportSubmissionId,
            workspaceId ?? null,
            relativePath ?? null,
            reference.kind,
            JSON.stringify(reference),
            `requirement:${proof.requirementId}:${category}`,
          ],
        );
      }
    }
  }

  for (const validation of report.validationResults) {
    await client.query(
      `insert into intentchord.report_claims(
        id,report_submission_id,claim_type,claim_key,claim_status,claim_value
      ) values($1,$2,'EXECUTOR_VALIDATION',$3,$4,$5)`,
      [randomUUID(), reportSubmissionId, validation.checkId, validation.status, JSON.stringify(validation)],
    );
  }
  for (const command of report.commands) {
    await client.query(
      `insert into intentchord.report_claims(
        id,report_submission_id,claim_type,claim_key,claim_status,claim_value
      ) values($1,$2,'EXECUTOR_COMMAND',$3,null,$4)`,
      [randomUUID(), reportSubmissionId, command.command, JSON.stringify(command)],
    );
  }
}

export async function submitRawReport(
  runId: string,
  raw: Buffer,
  contentType: string,
  expectedRevision: number,
  governance: { signal?: AbortSignal; deadlineAt?: number } = {},
) {
  assertUuid(runId, "runId");
  if (raw.length === 0 || raw.length > 2 * 1024 * 1024) {
    throw new HttpCommandError(413, "REPORT_SIZE_INVALID", "The raw report must be between 1 byte and 2MB.");
  }
  const outcome = await transaction(async client => {
    const run = await loadRunForUpdate(client, runId);
    if (Number(run.state_revision) !== expectedRevision) throw new ConflictError();
    if (run.status !== "AWAITING_REPORT") {
      throw new HttpCommandError(409, "RUN_NOT_AWAITING_REPORT", "The Run is not awaiting a report.");
    }
    requireActiveContextLease(run);
    const contract = approvedContract(asJson<ExecutionContract>(run.contract_content), run.approved_at);
    const bound = boundRunIdentity(run, contract);
    const submissionId = randomUUID();
    const initialComparison = bindingComparison(undefined, bound);

    // Preserve the exact bytes and Backend-bound identity before any decoding,
    // parsing, semantic interpretation, or executor-claim persistence occurs.
    await client.query(
      `insert into intentchord.report_submissions(
        id,run_id,raw_content,content_type,content_sha256,parser_version,
        parse_status,parse_errors,executor_claimed_identity,backend_bound_identity,binding_result,
        verified_sections,report_format
      ) values($1,$2,$3,$4,$5,$6,'RECEIVED','[]'::jsonb,'{}'::jsonb,$7,$8,'[]'::jsonb,'UNKNOWN')`,
      [
        submissionId,
        runId,
        raw,
        contentType.slice(0, 200),
        sha256(raw),
        PARSER_VERSION,
        JSON.stringify(bound),
        JSON.stringify(initialComparison),
      ],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "REPORT_RECEIVED",
      taskId: run.task_id as string,
      contractRevisionId: run.contract_revision_id as string,
      runId,
      revision: Number(run.state_revision),
      metadata: {
        submissionId,
        contentType,
        contentSha256: sha256(raw),
        rawBytes: raw.length,
      },
    });

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      text = "";
    }
    const parsed = parseAuthoritativeReport(text, contentType);
    const parsedReport = "report" in parsed ? parsed.report : undefined;
    const semanticIssues = parsedReport
      ? validateReportSemantics(contract, parsedReport)
      : [];
    const issues = Array.from(new Set([
      ...(text ? [] : ["The raw report is not valid UTF-8 text."]),
      ...("issues" in parsed ? parsed.issues : []),
      ...semanticIssues,
    ]));
    const acceptedReport = parsedReport && issues.length === 0 ? parsedReport : undefined;
    const comparison = bindingComparison(parsedReport, bound);
    const claimedIdentity = parsedReport ? {
      contractId: parsedReport.contractId,
      runId: parsedReport.runId,
      round: parsedReport.round,
      executionType: parsedReport.executionType,
      parentRunId: parsedReport.parentRunId,
      bindingMarker: parsedReport.bindingMarker,
      providerId: parsedReport.providerId,
      modelId: parsedReport.modelId,
      executionChannelId: parsedReport.executionChannelId,
      reasoningProfile: parsedReport.reasoningProfile,
      runtimeProfileId: parsedReport.runtimeProfileId,
    } : {};
    const verifiedSections = acceptedReport && "verifiedSections" in parsed ? parsed.verifiedSections : [];

    await client.query(
      `update intentchord.report_submissions
       set parse_status=$2,parse_errors=$3,executor_claimed_identity=$4,
           binding_result=$5,verified_sections=$6,report_format=$7
       where id=$1`,
      [
        submissionId,
        acceptedReport ? "PARSED" : "REJECTED",
        JSON.stringify(issues),
        JSON.stringify(claimedIdentity),
        JSON.stringify(comparison),
        JSON.stringify(verifiedSections),
        parsed.format,
      ],
    );

    if (!acceptedReport) {
      return { accepted: false as const, taskId: run.task_id as string, submissionId, issues };
    }
    await client.query("savepoint persist_report_claims");
    try {
      await persistReportClaims(client, submissionId, acceptedReport, run.task_id as string, contract, governance);
      await persistBackendReportValidation(client, {
        runId,
        contract,
        bindingMatches: comparison.matches,
      });
      await client.query("release savepoint persist_report_claims");
    } catch (error) {
      await client.query("rollback to savepoint persist_report_claims");
      await client.query("release savepoint persist_report_claims");
      const rejected = error instanceof HttpCommandError
        ? error
        : new HttpCommandError(
          422,
          "REPORT_EVIDENCE_REJECTED",
          error instanceof Error ? error.message : "The parsed report evidence could not be verified.",
        );
      await client.query(
        `update intentchord.report_submissions
         set parse_status='REJECTED',parse_errors=$2
         where id=$1`,
        [submissionId, JSON.stringify([`${rejected.code}: ${rejected.message}`])],
      );
      await audit(client, {
        aggregateType: "RUN",
        aggregateId: runId,
        eventType: "REPORT_EVIDENCE_REJECTED",
        taskId: run.task_id as string,
        contractRevisionId: run.contract_revision_id as string,
        runId,
        revision: Number(run.state_revision),
        metadata: {
          submissionId,
          code: rejected.code,
          details: rejected.details,
        },
      });
      return {
        accepted: false as const,
        taskId: run.task_id as string,
        submissionId,
        issues: [`${rejected.code}: ${rejected.message}`],
        rejectionCode: rejected.code,
      };
    }
    await client.query(
      `update intentchord.runs
       set status='REPORT_RECEIVED',state_revision=state_revision+1,updated_at=now()
       where id=$1`,
      [runId],
    );
    const taskRevision = await lockTask(client, run.task_id);
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [run.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "REPORT_PARSED",
      taskId: run.task_id as string,
      contractRevisionId: run.contract_revision_id as string,
      runId,
      revision: Number(run.state_revision) + 1,
      metadata: {
        submissionId,
        format: parsed.format,
        verifiedSections,
        bindingMatches: comparison.matches,
        identityInjected: false,
      },
    });
    return { accepted: true as const, taskId: run.task_id as string, submissionId, comparison };
  });
  if (!outcome.accepted) {
    throw new HttpCommandError(
      422,
      "rejectionCode" in outcome && outcome.rejectionCode ? outcome.rejectionCode : "REPORT_PARSE_REJECTED",
      "The raw report was preserved, but the report or its evidence could not be accepted.",
      {
        reportSubmissionId: outcome.submissionId,
        issues: outcome.issues,
      },
    );
  }
  return readTaskLifecycle(outcome.taskId);
}

type TrustedValidationRow = {
  check_id: string;
  status: "PASS" | "FAIL" | "EVIDENCE_REQUIRED";
  details: string;
  producer_type: string;
  producer_id: string | null;
  trust_basis: string | null;
  request_id: string | null;
  batch_id: string | null;
  sequence: number | string | null;
  sequence_total: number | string | null;
  is_terminal: boolean;
  integrity_sha256: string | null;
  payload_sha256: string | null;
  receipt_request_id: string | null;
};

type PersistedReportReferenceRow = {
  observation: string;
  reference_kind: ReportEvidenceReference["kind"];
  source_reference: unknown;
  workspace_registration_id: string | null;
  relative_path: string | null;
};

type TrustedSourceEvidenceRow = {
  requirement_id: string;
  workspace_registration_id: string;
  relative_path: string;
  symbol: string | null;
  line_start: number | string | null;
  line_end: number | string | null;
  content_sha256: string;
  observation: string;
  producer_type: "BACKEND" | "ADAPTER" | "SIGNED_HARNESS" | "OWNER_RUNTIME";
};

type TrustedArtifactEvidenceRow = {
  requirement_id: string;
  artifact_id: string;
  artifact_sha256: string;
  manifest_relationship: string | null;
  producer_type: "BACKEND" | "SIGNED_HARNESS" | "OWNER_RUNTIME";
};

type TrustedTraceRow = {
  sequence: number | string;
  command: string;
  capability: keyof ExecutionContract["authorization"] | null;
  authorization_result: "AUTHORIZED" | "UNAUTHORIZED" | "UNKNOWN";
  producer_type: string;
  producer_id: string | null;
  trust_basis: string | null;
  request_id: string | null;
  occurred_at: Date | string;
  integrity_sha256: string | null;
  batch_id: string | null;
  sequence_total: number | string | null;
  is_terminal: boolean;
  previous_event_sha256: string | null;
  event_sha256: string | null;
  receipt_request_id: string | null;
};

function validTrustedProducerRow(row: {
  producer_type: string;
  producer_id: string | null;
  trust_basis: string | null;
  request_id?: string | null;
  receipt_request_id?: string | null;
}): boolean {
  if (!row.producer_id) return false;
  if (row.producer_type === "BACKEND") {
    return row.trust_basis === "INTERNAL_BACKEND" && !row.request_id;
  }
  if (row.producer_type === "HARNESS" || row.producer_type === "ADAPTER") {
    return row.trust_basis === "SIGNED_HARNESS"
      && Boolean(row.request_id)
      && row.receipt_request_id === row.request_id;
  }
  if (row.producer_type === "OWNER_RUNTIME") {
    return row.trust_basis === "OWNER_SESSION" && !row.request_id;
  }
  return false;
}

function validateOneTrustedBatch<T extends {
  batch_id: string | null;
  sequence: number | string | null;
  sequence_total: number | string | null;
  is_terminal: boolean;
  producer_type: string;
  producer_id: string | null;
  trust_basis: string | null;
  request_id?: string | null;
  receipt_request_id?: string | null;
}>(batchId: string, values: T[]): { complete: T[]; issues: string[] } {
  const totalValues = new Set(values.map(row => Number(row.sequence_total)));
  const expectedTotal = totalValues.size === 1 ? [...totalValues][0] : Number.NaN;
  const sequences = values.map(row => Number(row.sequence)).sort((left, right) => left - right);
  const contiguous = Number.isInteger(expectedTotal)
    && expectedTotal > 0
    && values.length === expectedTotal
    && sequences.every((sequence, index) => sequence === index);
  const terminal = values.filter(row => row.is_terminal);
  const producerTypes = new Set(values.map(row => row.producer_type));
  const producerIds = new Set(values.map(row => row.producer_id));
  const trustBases = new Set(values.map(row => row.trust_basis));
  const trusted = values.every(validTrustedProducerRow)
    && producerTypes.size === 1
    && producerIds.size === 1
    && trustBases.size === 1;
  if (!contiguous || terminal.length !== 1 || Number(terminal[0]?.sequence) !== expectedTotal - 1 || !trusted) {
    return {
      complete: [],
      issues: [`Trusted evidence batch ${batchId} is incomplete, non-contiguous, unauthenticated, replay-unbound, or has an invalid terminal record.`],
    };
  }
  return { complete: values, issues: [] };
}

function completeTrustedBatches<T extends {
  batch_id: string | null;
  sequence: number | string | null;
  sequence_total: number | string | null;
  is_terminal: boolean;
  producer_type: string;
  producer_id: string | null;
  trust_basis: string | null;
  request_id?: string | null;
  receipt_request_id?: string | null;
}>(rows: T[], allowMultiple: boolean): { complete: T[]; issues: string[] } {
  if (!rows.length) return { complete: [], issues: ["No trusted evidence batch was recorded."] };
  if (rows.some(row => !row.batch_id)) {
    return { complete: [], issues: ["Trusted evidence contains a legacy or unsigned row without a batch identity."] };
  }
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const batchId = row.batch_id!;
    const values = groups.get(batchId) ?? [];
    values.push(row);
    groups.set(batchId, values);
  }
  if (!allowMultiple && groups.size !== 1) {
    return { complete: [], issues: ["Exactly one complete trusted evidence batch is allowed for this evidence channel."] };
  }
  const complete: T[] = [];
  const issues: string[] = [];
  for (const [batchId, values] of groups) {
    const result = validateOneTrustedBatch(batchId, values);
    complete.push(...result.complete);
    issues.push(...result.issues);
  }
  return { complete, issues };
}

function validationIntegrityIssues(runId: string, rows: TrustedValidationRow[]): string[] {
  const issues: string[] = [];
  for (const row of rows) {
    const expected = sha256(canonical({
      runId,
      batchId: row.batch_id,
      sequence: Number(row.sequence),
      sequenceTotal: Number(row.sequence_total),
      isTerminal: row.is_terminal,
      checkId: row.check_id,
      status: row.status,
      details: row.details,
      producerType: row.producer_type,
      producerId: row.producer_id,
      trustBasis: row.trust_basis,
      requestId: row.request_id,
    }));
    if (!row.payload_sha256 || row.payload_sha256 !== expected || row.integrity_sha256 !== expected) {
      issues.push(`Trusted validation check ${row.check_id} failed Backend payload-integrity verification.`);
    }
  }
  return issues;
}

function traceIntegrityIssues(runId: string, rows: TrustedTraceRow[], runCreatedAt: unknown): string[] {
  const issues: string[] = [];
  const ordered = [...rows].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  const runCreatedMs = Date.parse(asIso(runCreatedAt));
  let priorOccurredMs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];
    const occurredAt = asIso(row.occurred_at);
    const occurredMs = Date.parse(occurredAt);
    const expected = sha256(canonical({
      runId,
      batchId: row.batch_id,
      sequence: Number(row.sequence),
      sequenceTotal: Number(row.sequence_total),
      isTerminal: row.is_terminal,
      command: row.command,
      capability: row.capability,
      authorizationResult: row.authorization_result,
      occurredAt,
      previousEventSha256: row.previous_event_sha256,
      producerType: row.producer_type,
      producerId: row.producer_id,
      trustBasis: row.trust_basis,
      requestId: row.request_id,
    }));
    if (!row.event_sha256 || row.event_sha256 !== expected || row.integrity_sha256 !== expected) {
      issues.push(`Trusted tool-trace sequence ${row.sequence} failed Backend event-integrity verification.`);
    }
    if (!Number.isFinite(occurredMs)
      || occurredMs < runCreatedMs - 5 * 60_000
      || occurredMs > Date.now() + 5 * 60_000
      || occurredMs < priorOccurredMs) {
      issues.push(`Trusted tool-trace sequence ${row.sequence} has an invalid, out-of-window, or non-monotonic occurrence time.`);
    }
    priorOccurredMs = occurredMs;
    const previous = ordered[index - 1];
    if (index === 0 && row.previous_event_sha256) {
      issues.push("The first trusted tool-trace event unexpectedly names a previous event hash.");
    }
    if (index > 0 && row.previous_event_sha256 !== previous?.event_sha256) {
      issues.push(`Trusted tool-trace sequence ${row.sequence} does not chain to the prior event hash.`);
    }
  }
  return issues;
}

function independentVerdict(
  contract: ExecutionContract,
  report: ExecutorReportEnvelope,
  run: Record<string, unknown>,
  bindingMatches: boolean,
  verifiedSections: string[],
  independentRows: TrustedValidationRow[],
  toolTraceRows: TrustedTraceRow[],
  persistedReferences: PersistedReportReferenceRow[],
  trustedSourceEvidence: TrustedSourceEvidenceRow[],
  trustedArtifactEvidence: TrustedArtifactEvidenceRow[],
  inheritedCheckIds: string[],
): Verdict {
  const core = evaluateVerdict(contract, report, run.id as string, {
    round: Number(run.round),
    executionType: run.execution_type as RunRecord["executionType"],
    parentRunId: typeof run.parent_run_id === "string" ? run.parent_run_id : undefined,
    bindingMarker: run.binding_marker as string,
  });
  if (!bindingMatches) {
    return {
      ...core,
      classification: "VIOLATION",
      detectedViolations: Array.from(new Set([
        ...core.detectedViolations,
        "The executor-claimed report identity does not match the Backend-bound Run identity.",
      ])),
      contractComplianceSummary: "Backend binding comparison failed; no governed identity was injected into the report.",
      nextAction: "Resubmit the report with the exact Backend-bound Contract, Run, lineage, profile, and binding values.",
    };
  }
  if (core.classification === "VIOLATION") return core;

  const validationBatch = completeTrustedBatches(independentRows, true);
  const traceBatch = completeTrustedBatches(toolTraceRows, false);
  const validationIntegrity = validationIntegrityIssues(run.id as string, validationBatch.complete);
  const traceIntegrity = traceIntegrityIssues(run.id as string, traceBatch.complete, run.created_at);
  const trustedValidations = validationIntegrity.length ? [] : validationBatch.complete;
  const inheritedTrustedPassChecks = new Set(inheritedCheckIds);
  const trustedTrace = traceIntegrity.length
    ? []
    : traceBatch.complete.sort((left, right) => Number(left.sequence) - Number(right.sequence));

  const requiredSectionsMissing = reportSectionIds.filter(section => !verifiedSections.includes(section));
  const requiredChecks = contract.requiredChecks.filter(check => check.required);
  const failedChecks = trustedValidations.filter(item => item.status === "FAIL");
  const trustedPassChecks = new Set([
    ...inheritedTrustedPassChecks,
    ...trustedValidations.filter(item => item.status === "PASS").map(item => item.check_id),
  ]);
  const failedCheckIds = new Set(failedChecks.map(item => item.check_id));
  const missingChecks = requiredChecks.filter(check => !trustedPassChecks.has(check.id) || failedCheckIds.has(check.id));
  const checksRequiringCurrentEvidence = requiredChecks.filter(check => !inheritedTrustedPassChecks.has(check.id));
  const validationBatchIssues = independentRows.length || checksRequiringCurrentEvidence.length
    ? validationBatch.issues
    : [];
  const unauthorizedTrace = trustedTrace.filter(item => item.authorization_result === "UNAUTHORIZED");
  const unknownTrace = trustedTrace.filter(item => item.authorization_result === "UNKNOWN");

  if (validationIntegrity.length || traceIntegrity.length) {
    return {
      ...core,
      classification: "VIOLATION",
      detectedViolations: Array.from(new Set([
        ...core.detectedViolations,
        ...validationIntegrity,
        ...traceIntegrity,
      ])),
      evidenceGaps: [],
      contractComplianceSummary: "Persisted trusted evidence failed Backend integrity verification and cannot participate in a Verdict.",
      nextAction: "Reject the compromised evidence batch, investigate its producer and persistence path, then create a fresh bounded Run if authorized.",
    };
  }

  if (unauthorizedTrace.length) {
    return {
      ...core,
      classification: "VIOLATION",
      detectedViolations: Array.from(new Set([
        ...core.detectedViolations,
        ...unauthorizedTrace.map(item => `Trusted tool trace proves an unauthorized command at sequence ${item.sequence}.`),
      ])),
      evidenceGaps: [],
      contractComplianceSummary: "A complete trusted tool trace proves authorization non-compliance.",
      nextAction: "Create one bounded correction Run and do not repeat the unauthorized action.",
    };
  }

  const trustedCommandEvents = trustedTrace.map(item => item.command);
  const noCommandsAttested = trustedCommandEvents.length === 1
    && trustedCommandEvents[0] === "INTENTCHORD:NO_COMMANDS_EXECUTED";
  const trustedCommands = trustedCommandEvents.filter(command => command !== "INTENTCHORD:NO_COMMANDS_EXECUTED");
  const reportedCommands = report.commands.map(item => item.command);
  const commandHistoryMatches = noCommandsAttested
    ? reportedCommands.length === 0
    : trustedCommands.length === reportedCommands.length
      && trustedCommands.every((command, index) => command === reportedCommands[index]);
  if (!commandHistoryMatches) {
    return {
      ...core,
      classification: "VIOLATION",
      detectedViolations: Array.from(new Set([
        ...core.detectedViolations,
        "The executor-reported command history does not exactly match the complete trusted tool-trace batch.",
      ])),
      evidenceGaps: [],
      contractComplianceSummary: "The trusted command trace contradicts or is incomplete relative to the executor report.",
      nextAction: "Reject the mismatched report or trace, preserve both records, and submit one corrected run-bound report with an exact trusted command history.",
    };
  }

  const trustedTraceSequences = new Set(
    trustedTrace.filter(item => item.authorization_result === "AUTHORIZED").map(item => Number(item.sequence)),
  );
  // The parsed report envelope stored in report_claims is the authoritative report record.
  // report_evidence_references is a normalized read/index projection only; Verdict authority
  // must not depend on an observation-string join against that secondary projection.
  void persistedReferences;
  const trustedReferenceSatisfied = (
    reference: ReportEvidenceReference,
    requirementId: string,
  ) => {
    if (reference.kind === "SOURCE_EVIDENCE") {
      return trustedSourceEvidence.some(row =>
        row.requirement_id === requirementId
        && row.workspace_registration_id === reference.workspaceId
        && row.relative_path === reference.relativePath
        && row.content_sha256 === reference.contentSha256
        && (row.symbol ?? undefined) === reference.symbol
        && (row.line_start === null ? undefined : Number(row.line_start)) === reference.lineStart
        && (row.line_end === null ? undefined : Number(row.line_end)) === reference.lineEnd
        && row.producer_type === "BACKEND"
      );
    }
    if (reference.kind === "ARTIFACT_EVIDENCE") {
      return trustedArtifactEvidence.some(row =>
        row.requirement_id === requirementId
        && row.artifact_id === reference.artifactId
        && row.artifact_sha256 === reference.artifactSha256
        && (row.manifest_relationship ?? undefined) === reference.manifestRelationship
      );
    }
    if (reference.kind === "VALIDATION_CHECK") return trustedPassChecks.has(reference.checkId);
    if (reference.kind === "VALIDATION_EVIDENCE") {
      return trustedValidations.some(row => {
        if (row.check_id !== reference.checkId || row.status !== "PASS") return false;
        if (reference.producer === "BACKEND") return row.producer_type === "BACKEND";
        if (reference.producer === "OWNER_RUNTIME") return row.producer_type === "OWNER_RUNTIME";
        return row.producer_type === "HARNESS" || row.producer_type === "ADAPTER";
      });
    }
    if (reference.kind === "RUNTIME_EVIDENCE") {
      if (reference.runIdentity !== String(run.id)) return false;
      return trustedValidations.some(row =>
        row.check_id === reference.checkId
        && row.status === "PASS"
        && (reference.producer === "OWNER_RUNTIME"
          ? row.producer_type === "OWNER_RUNTIME"
          : row.producer_type === "HARNESS" || row.producer_type === "ADAPTER")
      );
    }
    if (reference.kind === "TOOL_TRACE_EVENT") return trustedTraceSequences.has(reference.sequence);
    return false;
  };
  const requirementReferences = (requirementId: string): ReportEvidenceReference[] => {
    const proof = report.requirementProofs.find(item => item.requirementId === requirementId);
    const proofRefs = proof ? [
      ...proof.sourceBehaviorRefs,
      ...proof.positiveProofRefs,
      ...proof.negativeAdversarialProofRefs,
      ...proof.persistenceReloadProofRefs,
    ] : [];
    const findingRefs = report.findings
      .filter(finding => finding.requirementId === requirementId)
      .flatMap(finding => finding.evidenceRefs);
    return [...proofRefs, ...findingRefs];
  };
  const trustedEvidenceTypeSatisfied = (
    requirementId: string,
    evidenceType: "SOURCE" | "ARTIFACT" | "VALIDATION" | "RUNTIME",
  ): boolean => requirementReferences(requirementId).some(reference => {
    if (evidenceType === "SOURCE" && reference.kind !== "SOURCE_EVIDENCE") return false;
    if (evidenceType === "ARTIFACT" && reference.kind !== "ARTIFACT_EVIDENCE") return false;
    if (evidenceType === "VALIDATION" && reference.kind !== "VALIDATION_EVIDENCE" && reference.kind !== "VALIDATION_CHECK") return false;
    if (evidenceType === "RUNTIME" && reference.kind !== "RUNTIME_EVIDENCE") return false;
    return trustedReferenceSatisfied(reference, requirementId);
  });
  const requirementProofGaps: string[] = [];
  const satisfiedRequirementOutcomes: string[] = [];
  const satisfiedRequirementIds = new Set<string>();
  for (const requirement of contract.executionPackage.mandatoryRequirements) {
    const proof = report.requirementProofs.find(item => item.requirementId === requirement.id);
    if (!proof) {
      requirementProofGaps.push(`Mandatory requirement has no authoritative proof row: ${requirement.id}.`);
      continue;
    }
    if (proof.classification !== "PASS") {
      requirementProofGaps.push(`Mandatory requirement ${requirement.id} was not classified PASS by the executor proof ledger.`);
    }
    const categories: Array<[string, boolean, ReportEvidenceReference[]]> = [
      ["source-behavior", requirement.proofProfile.sourceBehavior, proof.sourceBehaviorRefs],
      ["positive", requirement.proofProfile.positive, proof.positiveProofRefs],
      ["negative-adversarial", requirement.proofProfile.negativeAdversarial, proof.negativeAdversarialProofRefs],
      ["persistence-reload", requirement.proofProfile.persistenceReload, proof.persistenceReloadProofRefs],
    ];
    let satisfied = proof.classification === "PASS";
    for (const [category, required, references] of categories) {
      if (!required) continue;
      if (!references.some(reference => trustedReferenceSatisfied(reference, requirement.id))) {
        satisfied = false;
        requirementProofGaps.push(`Mandatory requirement ${requirement.id} lacks trusted ${category} proof.`);
      }
    }
    for (const evidenceType of requirement.requiredEvidenceTypes) {
      if (!trustedEvidenceTypeSatisfied(requirement.id, evidenceType)) {
        satisfied = false;
        requirementProofGaps.push(`Mandatory requirement ${requirement.id} lacks trusted ${evidenceType} evidence.`);
      }
    }
    if (satisfied) {
      satisfiedRequirementOutcomes.push(requirement.outcome);
      satisfiedRequirementIds.add(requirement.id);
    }
  }
  const provenFindingStatuses = new Set([
    "PROVEN",
    "PROVEN_BY_SOURCE",
    "PROVEN_BY_ARTIFACT",
    "PROVEN_BY_VALIDATION",
    "PROVEN_BY_RUNTIME",
  ]);
  const unprovenFindings = report.findings
    .filter(finding => provenFindingStatuses.has(finding.status))
    .filter(finding => {
      if (!satisfiedRequirementIds.has(finding.requirementId)) return true;
      return !finding.evidenceRefs.some(reference =>
        trustedReferenceSatisfied(reference, finding.requirementId)
      );
    });

  const preliminaryExecutorTrustGaps = new Set([
    "Executor claims, command outputs, inspected paths, and self-reported checks are not independent evidence.",
    "No PROVEN finding was supplied.",
    "One or more PROVEN findings have no structured evidence reference.",
  ]);
  const unresolvedCoreGaps = core.evidenceGaps.filter(gap =>
    !preliminaryExecutorTrustGaps.has(gap)
  );
  const evidenceGaps = [
    ...unresolvedCoreGaps,
    ...requiredSectionsMissing.map(section => `Required report section was not verified from raw report content: ${section}.`),
    ...validationBatchIssues,
    ...traceBatch.issues,
    ...validationIntegrity,
    ...traceIntegrity,
    ...missingChecks.map(check => `Trusted PASS evidence is missing for required check: ${check.id}.`),
    ...failedChecks.map(check => `Trusted validation failed: ${check.check_id}.`),
    ...unknownTrace.map(item => `Trusted tool-trace sequence ${item.sequence} could not be classified against the approved Contract.`),
    ...unprovenFindings.map(finding => `Proven finding has no matching trusted source, artifact, validation, runtime, or tool-trace evidence: ${finding.claim}.`),
    ...requirementProofGaps,
  ];
  const unsupportedClaims = Array.from(new Set([
    ...core.unsupportedClaims,
    ...report.findings
      .filter(item => !provenFindingStatuses.has(item.status) && item.status !== "CONTRADICTED")
      .map(item => item.claim),
  ]));

  if (evidenceGaps.length || unsupportedClaims.length) {
    return {
      ...core,
      classification: "EVIDENCE_REQUIRED",
      acceptedFacts: satisfiedRequirementOutcomes,
      evidenceGaps: Array.from(new Set(evidenceGaps.length ? evidenceGaps : [
        "Trusted independent evidence is required before accepting executor-reported closure.",
      ])),
      unsupportedClaims,
      contractComplianceSummary: "The report and verified evidence were preserved. Each finding is evaluated against its matching evidence class, while execution governance still requires complete trusted producer records.",
      nextAction: failedChecks.length
        ? `Repair and rerun the failed trusted validation: ${failedChecks[0].check_id}.`
        : traceBatch.issues.length
          ? "Record one complete run-bound trusted tool-trace batch, including an explicit no-commands event when no commands were executed, then reevaluate the same Run."
          : missingChecks.length
            ? `Provide trusted PASS evidence for the next unresolved required check: ${missingChecks[0].id}.`
            : requirementProofGaps.length
              ? "Supply the exact missing evidence class or proof category named in the requirement ledger, then reevaluate the same Run."
              : "Revise unsupported claims or provide their matching trusted evidence, then reevaluate the same Run.",
      trustedSatisfiedCheckIds: [...trustedPassChecks].filter(checkId => !failedCheckIds.has(checkId)),
      unresolvedCheckIds: missingChecks.map(check => check.id),
    };
  }

  const acceptedFacts = Array.from(new Set([
    ...satisfiedRequirementOutcomes,
    ...report.findings
      .filter(item => provenFindingStatuses.has(item.status) && satisfiedRequirementIds.has(item.requirementId))
      .filter(item => item.evidenceRefs.some(reference =>
        trustedReferenceSatisfied(reference, item.requirementId)
      ))
      .map(item => item.claim),
  ]));
  return {
    ...core,
    classification: "PASS",
    acceptedFacts,
    detectedViolations: [],
    evidenceGaps: [],
    unsupportedClaims: [],
    contractComplianceSummary: `Trusted evidence passed: ${requiredChecks.length}/${requiredChecks.length} required checks, ${trustedTrace.length} complete tool-trace event(s), and ${acceptedFacts.length} evidence-class-matched finding(s).`,
    nextAction: "Request the Owner decision for this independently verified Run.",
    trustedSatisfiedCheckIds: requiredChecks.map(check => check.id),
    unresolvedCheckIds: [],
  };
}

export async function evaluateRun(runId: string, command: unknown) {
  assertUuid(runId, "runId");
  const parsed = evaluateRunCommandSchema.parse(command);
  const taskId = await transaction(async client => {
    const run = await loadRunForUpdate(client, runId);
    if (Number(run.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (run.status !== "REPORT_RECEIVED") {
      throw new HttpCommandError(409, "PARSED_REPORT_REQUIRED", "A parsed raw report is required before Verdict evaluation.");
    }
    requireActiveContextLease(run);
    const existing = await client.query("select id from intentchord.verdicts where run_id=$1", [runId]);
    if (existing.rowCount) throw new HttpCommandError(409, "VERDICT_ALREADY_ISSUED", "The Run already has an immutable Verdict.");
    const submission = await client.query(
      `select rs.*, rc.claim_value as report_envelope
       from intentchord.report_submissions rs
       join intentchord.report_claims rc
         on rc.report_submission_id=rs.id and rc.claim_type='REPORT_ENVELOPE'
       where rs.run_id=$1 and rs.parse_status='PARSED'
       order by rs.received_at desc limit 1`,
      [runId],
    );
    if (!submission.rowCount) throw new HttpCommandError(409, "PARSED_REPORT_REQUIRED", "No parsed authoritative report exists for the Run.");
    const independent = await client.query(
      `select ve.check_id,ve.status,ve.details,ve.producer_type,ve.producer_id,ve.trust_basis,
        ve.request_id,ve.batch_id,ve.sequence,ve.sequence_total,ve.is_terminal,
        ve.integrity_sha256,ve.payload_sha256,
        tpr.request_id as receipt_request_id
       from intentchord.validation_evidence ve
       left join intentchord.trusted_producer_receipts tpr
         on tpr.request_id=ve.request_id
        and tpr.run_id=ve.run_id
        and tpr.producer_type=ve.producer_type
        and tpr.producer_id=ve.producer_id
        and tpr.trust_basis=ve.trust_basis
       where ve.run_id=$1 order by ve.captured_at,ve.id`,
      [runId],
    );
    const trace = await client.query(
      `select te.sequence,te.command,te.capability,te.authorization_result,te.producer_type,
        te.producer_id,te.trust_basis,te.request_id,te.occurred_at,te.integrity_sha256,
        te.batch_id,te.sequence_total,te.is_terminal,te.previous_event_sha256,te.event_sha256,
        tpr.request_id as receipt_request_id
       from intentchord.tool_trace_events te
       left join intentchord.trusted_producer_receipts tpr
         on tpr.request_id=te.request_id
        and tpr.run_id=te.run_id
        and tpr.producer_type=te.producer_type
        and tpr.producer_id=te.producer_id
        and tpr.trust_basis=te.trust_basis
       where te.run_id=$1 order by te.sequence`,
      [runId],
    );
    const persistedReferences = await client.query(
      `select observation,reference_kind,source_reference,workspace_registration_id,relative_path
       from intentchord.report_evidence_references
       where report_submission_id=$1 order by created_at,id`,
      [submission.rows[0].id],
    );
    const trustedSourceEvidence = await client.query(
      `select requirement_id,workspace_registration_id,relative_path,symbol,line_start,line_end,
        content_sha256,observation,producer_type
       from intentchord.source_evidence
       where run_id=$1 order by created_at,id`,
      [runId],
    );
    const trustedArtifactEvidence = await client.query(
      `select requirement_id,artifact_id,artifact_sha256,manifest_relationship,producer_type
       from intentchord.artifact_evidence
       where run_id=$1 order by created_at,id`,
      [runId],
    );
    const inheritedValidation = await client.query(
      `select check_id from intentchord.inherited_validation_evidence
       where run_id=$1 order by check_id`,
      [runId],
    );
    const report = asJson<ExecutorReportEnvelope>(submission.rows[0].report_envelope);
    const contract = approvedContract(asJson<ExecutionContract>(run.contract_content), run.approved_at);
    const comparison = asJson<{ matches: boolean }>(submission.rows[0].binding_result);
    const verifiedSections = asJson<string[]>(submission.rows[0].verified_sections ?? []);
    const verdict = independentVerdict(
      contract,
      report,
      run,
      comparison.matches,
      verifiedSections,
      independent.rows as TrustedValidationRow[],
      trace.rows as TrustedTraceRow[],
      persistedReferences.rows as PersistedReportReferenceRow[],
      trustedSourceEvidence.rows as TrustedSourceEvidenceRow[],
      trustedArtifactEvidence.rows as TrustedArtifactEvidenceRow[],
      inheritedValidation.rows.map(row => String(row.check_id)),
    );
    const verdictId = randomUUID();
    await client.query(
      `insert into intentchord.verdicts(
        id,run_id,report_submission_id,classification,verdict_content,engine_version
      ) values($1,$2,$3,$4,$5,$6)`,
      [verdictId, runId, submission.rows[0].id, verdict.classification, JSON.stringify(verdict), VERDICT_ENGINE_VERSION],
    );
    await client.query(
      `update intentchord.runs
       set status='REVIEW_READY',state_revision=state_revision+1,updated_at=now()
       where id=$1`,
      [runId],
    );
    await client.query(
      `update intentchord.context_leases set status='CONSUMED',lease_revision=lease_revision+1
       where run_id=$1 and status='ACTIVE'`,
      [runId],
    );
    const taskRevision = await lockTask(client, run.task_id);
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [run.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "VERDICT_ISSUED",
      taskId: run.task_id,
      contractRevisionId: run.contract_revision_id,
      runId,
      revision: Number(run.state_revision) + 1,
      metadata: {
        verdictId,
        classification: verdict.classification,
        trustedValidationCount: independent.rowCount,
        trustedToolTraceCount: trace.rowCount,
      },
    });
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "CONTEXT_LEASE_CONSUMED",
      taskId: run.task_id,
      contractRevisionId: run.contract_revision_id,
      runId,
      metadata: { verdictId },
    });
    return run.task_id as string;
  });
  return readTaskLifecycle(taskId);
}


async function claimTrustedProducerReceipt(
  client: PoolClient,
  runId: string,
  producer: TrustedProducerContext,
) {
  if (producer.trustBasis !== "SIGNED_HARNESS") return;
  if (!producer.requestId || !producer.routePath || !producer.bodySha256) {
    throw new HttpCommandError(
      401,
      "TRUSTED_PRODUCER_RECEIPT_INCOMPLETE",
      "A signed producer request is missing replay-protection metadata.",
    );
  }
  try {
    await client.query(
      `insert into intentchord.trusted_producer_receipts(
        request_id,run_id,producer_type,producer_id,trust_basis,route_path,body_sha256
      ) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        producer.requestId,
        runId,
        producer.producerType,
        producer.producerId,
        producer.trustBasis,
        producer.routePath,
        producer.bodySha256,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpCommandError(409, "TRUSTED_PRODUCER_REPLAY", "The signed producer request ID has already been consumed.");
    }
    throw error;
  }
}

export async function recordValidationEvidence(
  runId: string,
  command: unknown,
  producer: TrustedProducerContext,
) {
  assertUuid(runId, "runId");
  const parsed = validationEvidenceCommandSchema.parse(command);
  if (!(["BACKEND", "HARNESS", "OWNER_RUNTIME"] as string[]).includes(producer.producerType)) {
    throw new HttpCommandError(403, "VALIDATION_PRODUCER_NOT_AUTHORIZED", "This trusted producer type cannot record validation evidence.");
  }
  const taskId = await transaction(async client => {
    const run = await loadRunForUpdate(client, runId);
    if (Number(run.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (run.status !== "REPORT_RECEIVED") {
      throw new HttpCommandError(409, "REPORT_RECEIVED_REQUIRED", "Independent validation must be recorded after report receipt and before Verdict issuance.");
    }
    requireActiveContextLease(run);
    await claimTrustedProducerReceipt(client, runId, producer);
    const contract = asJson<ExecutionContract>(run.contract_content);
    const approvedCheck = contract.requiredChecks.find(
      check => check.id === parsed.checkId && check.required,
    );
    if (!approvedCheck) {
      throw new HttpCommandError(
        422,
        "VALIDATION_CHECK_NOT_APPROVED",
        "Trusted validation evidence may only target a required check frozen in the approved Contract.",
        { checkId: parsed.checkId },
      );
    }
    if (requiredCheckSatisfactionMode(approvedCheck) !== "TRUSTED_PRODUCER") {
      throw new HttpCommandError(
        409,
        "VALIDATION_CHECK_BACKEND_AUTOMATIC",
        "This required check is satisfied automatically by the Backend and cannot be submitted through a trusted-producer validation batch.",
        { checkId: parsed.checkId },
      );
    }
    const inheritedCheck = await client.query(
      `select source_validation_evidence_id from intentchord.inherited_validation_evidence
       where run_id=$1 and check_id=$2 limit 1`,
      [runId, parsed.checkId],
    );
    if (inheritedCheck.rowCount) {
      throw new HttpCommandError(
        409,
        "INHERITED_VALIDATION_CHECK_ALREADY_SATISFIED",
        "A correction Run cannot resubmit a trusted check already inherited from its parent Run.",
        { checkId: parsed.checkId, sourceValidationEvidenceId: inheritedCheck.rows[0].source_validation_evidence_id },
      );
    }
    const batch = await client.query(
      `select sequence,sequence_total,is_terminal,producer_type,producer_id,trust_basis
       from intentchord.validation_evidence
       where run_id=$1 and batch_id=$2 order by sequence for update`,
      [runId, parsed.batchId],
    );
    if (batch.rows.some(row => row.is_terminal)) {
      throw new HttpCommandError(409, "VALIDATION_BATCH_ALREADY_CLOSED", "The trusted validation batch already contains its terminal record.");
    }
    if (batch.rowCount !== parsed.sequence) {
      throw new HttpCommandError(409, "VALIDATION_BATCH_SEQUENCE_GAP", "Trusted validation evidence must arrive contiguously without gaps or replay.", {
        expectedSequence: batch.rowCount,
        receivedSequence: parsed.sequence,
      });
    }
    if (batch.rows.some(row => Number(row.sequence_total) !== parsed.sequenceTotal || row.producer_type !== producer.producerType || row.producer_id !== producer.producerId || row.trust_basis !== producer.trustBasis)) {
      throw new HttpCommandError(409, "VALIDATION_BATCH_IDENTITY_MISMATCH", "A validation batch cannot change producer identity or sequence total.");
    }
    const duplicateCheck = await client.query(
      `select id from intentchord.validation_evidence
       where run_id=$1 and check_id=$2 limit 1`,
      [runId, parsed.checkId],
    );
    if (duplicateCheck.rowCount) {
      throw new HttpCommandError(
        409,
        "VALIDATION_CHECK_REPLAY",
        "A Run cannot record the same trusted-producer check more than once across validation batches.",
      );
    }
    const payloadSha256 = sha256(canonical({
      runId,
      batchId: parsed.batchId,
      sequence: parsed.sequence,
      sequenceTotal: parsed.sequenceTotal,
      isTerminal: parsed.isTerminal,
      checkId: parsed.checkId,
      status: parsed.status,
      details: parsed.details,
      producerType: producer.producerType,
      producerId: producer.producerId,
      trustBasis: producer.trustBasis,
      requestId: producer.requestId ?? null,
    }));
    if (parsed.integritySha256 && parsed.integritySha256 !== payloadSha256) {
      throw new HttpCommandError(
        422,
        "VALIDATION_INTEGRITY_MISMATCH",
        "The claimed validation integrity hash does not match the Backend canonical payload hash.",
      );
    }
    await client.query(
      `insert into intentchord.validation_evidence(
        id,run_id,check_id,status,producer_type,producer_id,trust_basis,request_id,details,
        integrity_sha256,payload_sha256,batch_id,sequence,sequence_total,is_terminal
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        randomUUID(),
        runId,
        parsed.checkId,
        parsed.status,
        producer.producerType,
        producer.producerId,
        producer.trustBasis,
        producer.requestId ?? null,
        parsed.details,
        payloadSha256,
        payloadSha256,
        parsed.batchId,
        parsed.sequence,
        parsed.sequenceTotal,
        parsed.isTerminal,
      ],
    );
    await client.query(
      "update intentchord.runs set state_revision=state_revision+1,updated_at=now() where id=$1",
      [runId],
    );
    const taskRevision = await lockTask(client, run.task_id);
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [run.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "VALIDATION_RECORDED",
      actor: producer.authority,
      taskId: run.task_id,
      contractRevisionId: run.contract_revision_id,
      runId,
      revision: Number(run.state_revision) + 1,
      metadata: {
        checkId: parsed.checkId,
        status: parsed.status,
        batchId: parsed.batchId,
        sequence: parsed.sequence,
        sequenceTotal: parsed.sequenceTotal,
        terminal: parsed.isTerminal,
        trustBasis: producer.trustBasis,
      },
    });
    return run.task_id as string;
  });
  return readTaskLifecycle(taskId);
}

const commandCapabilityRules: Array<{
  capability: keyof ExecutionContract["authorization"];
  pattern: RegExp;
}> = [
  {
    capability: "modifySource",
    pattern: /(?:\bapply_patch\b|\b(?:set|add)-content\b|\bout-file\b|\b(?:remove|copy|move|rename|new)-item\b|\b(?:del|erase|rm|mv|cp|touch)\b|\bsed\s+-i\b|\btee\b|\bfind\b[^\r\n]*(?:-delete|-exec\s+(?:rm|mv|cp))|\bgit\s+(?:add|checkout|restore|reset|clean|commit|merge|rebase)\b)/i,
  },
  { capability: "runStaticValidation", pattern: /\b(lint|tsc|typecheck|static\s+validation|cargo\s+check)\b/i },
  { capability: "runTests", pattern: /\b(test|vitest|jest|pytest|cargo\s+test)\b/i },
  { capability: "build", pattern: /\b(build|cargo\s+build|next\s+build|npm\s+run\s+build)\b/i },
  { capability: "deploy", pattern: /\b(deploy|publish|release)\b/i },
  { capability: "restartServices", pattern: /(?:\brestart-service\b|\bservice\b[^\r\n]*\brestart\b|\bsystemctl\s+(?:restart|reload)\b)/i },
  { capability: "writeDatabase", pattern: /\b(insert|update|delete|alter|drop|truncate|create\s+(?:table|index|schema|database|role)|migrate|migration|psql)\b/i },
  { capability: "changeEnvironment", pattern: /(?:\bsetx\b|\bexport\s+[A-Za-z_][A-Za-z0-9_]*=|\$env:[A-Za-z_][A-Za-z0-9_]*\s*=|\b(?:write|set|add)-content\b[^\r\n]*\.env(?:\.|\b))/i },
  { capability: "useNetwork", pattern: /(?:\bcurl\b|\bwget\b|\binvoke-webrequest\b|\binvoke-restmethod\b|https?:\/\/|\bgit\s+(?:push|pull|fetch|clone)\b)/i },
  {
    capability: "readFiles",
    pattern: /(?:\b(?:read|get-content|type|cat|rg|grep|findstr|select-string|head|tail|get-childitem|get-item|test-path|resolve-path)\b|\bfind\b|\bgit\s+(?:status|diff|show|log|rev-parse|ls-files)\b)/i,
  },
];

function deriveToolTraceAuthorization(
  command: string,
  claimedCapability: keyof ExecutionContract["authorization"] | undefined,
  contract: ExecutionContract,
) {
  if (command === "INTENTCHORD:NO_COMMANDS_EXECUTED") {
    if (claimedCapability) {
      throw new HttpCommandError(422, "TRACE_CAPABILITY_MISMATCH", "A no-command trace attestation cannot claim a capability.");
    }
    return { capability: undefined, authorizationResult: "AUTHORIZED" as const };
  }

  const matchedCapabilities = Array.from(new Set(
    commandCapabilityRules
      .filter(rule => rule.pattern.test(command))
      .map(rule => rule.capability),
  ));
  const matched = matchedCapabilities.length === 1 ? matchedCapabilities[0] : undefined;

  // A compound or ambiguous command is never silently reduced to its least
  // sensitive token. The producer must split it into atomic trace events;
  // otherwise the Backend records UNKNOWN and the Verdict cannot PASS.
  if (matchedCapabilities.length > 1) {
    if (claimedCapability) {
      throw new HttpCommandError(
        422,
        "TRACE_COMMAND_AMBIGUOUS",
        "The command maps to multiple capabilities. Split it into atomic tool-trace events before claiming authorization.",
        { matchedCapabilities },
      );
    }
    return { capability: undefined, authorizationResult: "UNKNOWN" as const };
  }

  if (claimedCapability && matched !== claimedCapability) {
    throw new HttpCommandError(
      422,
      "TRACE_CAPABILITY_MISMATCH",
      "The claimed capability does not match the Backend command classification.",
    );
  }
  if (!matched) return { capability: undefined, authorizationResult: "UNKNOWN" as const };
  const effective = contract.policyDecisionTrace.some(
    item => item.capability === matched && item.effective,
  );
  return {
    capability: matched,
    authorizationResult: effective ? "AUTHORIZED" as const : "UNAUTHORIZED" as const,
  };
}

function requireValidTraceTime(
  occurredAt: string,
  runCreatedAt: unknown,
  previousOccurredAt?: unknown,
): void {
  const occurredMs = Date.parse(occurredAt);
  const runCreatedMs = Date.parse(asIso(runCreatedAt));
  const previousMs = previousOccurredAt ? Date.parse(asIso(previousOccurredAt)) : undefined;
  if (!Number.isFinite(occurredMs)
    || occurredMs < runCreatedMs - 5 * 60_000
    || occurredMs > Date.now() + 5 * 60_000
    || (previousMs !== undefined && Number.isFinite(previousMs) && occurredMs < previousMs)) {
    throw new HttpCommandError(
      422,
      "TOOL_TRACE_TIME_INVALID",
      "Tool-trace timestamps must be valid, within the Run time window, and nondecreasing by sequence.",
    );
  }
}

export async function recordToolTrace(
  runId: string,
  command: unknown,
  producer: TrustedProducerContext,
) {
  assertUuid(runId, "runId");
  const parsed = toolTraceCommandSchema.parse(command);
  if (!(["ADAPTER", "HARNESS", "OWNER_RUNTIME"] as string[]).includes(producer.producerType)) {
    throw new HttpCommandError(403, "TRACE_PRODUCER_NOT_AUTHORIZED", "This trusted producer type cannot record tool-trace evidence.");
  }
  const taskId = await transaction(async client => {
    const run = await loadRunForUpdate(client, runId);
    if (Number(run.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (run.status !== "REPORT_RECEIVED") {
      throw new HttpCommandError(409, "REPORT_RECEIVED_REQUIRED", "Tool trace must be recorded after report receipt and before Verdict issuance.");
    }
    requireActiveContextLease(run);
    await claimTrustedProducerReceipt(client, runId, producer);
    const otherTraceBatch = await client.query(
      `select batch_id from intentchord.tool_trace_events
       where run_id=$1 and batch_id is not null and batch_id<>$2 limit 1`,
      [runId, parsed.batchId],
    );
    if (otherTraceBatch.rowCount) {
      throw new HttpCommandError(409, "TOOL_TRACE_BATCH_ALREADY_BOUND", "A Run accepts exactly one trusted tool-trace batch.", otherTraceBatch.rows[0]);
    }
    const batch = await client.query(
      `select sequence,sequence_total,is_terminal,producer_type,producer_id,trust_basis,event_sha256,occurred_at
       from intentchord.tool_trace_events
       where run_id=$1 and batch_id=$2 order by sequence for update`,
      [runId, parsed.batchId],
    );
    if (batch.rows.some(row => row.is_terminal)) {
      throw new HttpCommandError(409, "TOOL_TRACE_BATCH_ALREADY_CLOSED", "The trusted tool-trace batch already contains its terminal record.");
    }
    if (batch.rowCount !== parsed.sequence) {
      throw new HttpCommandError(409, "TOOL_TRACE_SEQUENCE_GAP", "Trusted tool trace must arrive contiguously without gaps or replay.", {
        expectedSequence: batch.rowCount,
        receivedSequence: parsed.sequence,
      });
    }
    if (batch.rows.some(row => Number(row.sequence_total) !== parsed.sequenceTotal || row.producer_type !== producer.producerType || row.producer_id !== producer.producerId || row.trust_basis !== producer.trustBasis)) {
      throw new HttpCommandError(409, "TOOL_TRACE_BATCH_IDENTITY_MISMATCH", "A tool-trace batch cannot change producer identity or sequence total.");
    }
    const previous = batch.rows[batch.rows.length - 1];
    if (parsed.sequence > 0 && parsed.previousEventSha256 !== previous?.event_sha256) {
      throw new HttpCommandError(409, "TOOL_TRACE_CHAIN_MISMATCH", "The tool-trace event does not chain to the prior Backend-issued event hash.");
    }
    const contract = asJson<ExecutionContract>(run.contract_content);
    requireValidTraceTime(parsed.occurredAt, run.created_at, previous?.occurred_at);
    const derived = deriveToolTraceAuthorization(parsed.command, parsed.capability, contract);
    if (parsed.authorizationResult !== derived.authorizationResult) {
      throw new HttpCommandError(422, "TRACE_AUTHORIZATION_MISMATCH", "The claimed authorization result does not match the Backend classification.");
    }
    const eventSha256 = sha256(canonical({
      runId,
      batchId: parsed.batchId,
      sequence: parsed.sequence,
      sequenceTotal: parsed.sequenceTotal,
      isTerminal: parsed.isTerminal,
      command: parsed.command,
      capability: derived.capability ?? null,
      authorizationResult: derived.authorizationResult,
      occurredAt: parsed.occurredAt,
      previousEventSha256: parsed.previousEventSha256 ?? null,
      producerType: producer.producerType,
      producerId: producer.producerId,
      trustBasis: producer.trustBasis,
      requestId: producer.requestId ?? null,
    }));
    await client.query(
      `insert into intentchord.tool_trace_events(
        id,run_id,sequence,command,capability,authorization_result,producer_type,
        producer_id,trust_basis,request_id,occurred_at,integrity_sha256,batch_id,sequence_total,
        is_terminal,previous_event_sha256,event_sha256
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        randomUUID(),
        runId,
        parsed.sequence,
        parsed.command,
        derived.capability ?? null,
        derived.authorizationResult,
        producer.producerType,
        producer.producerId,
        producer.trustBasis,
        producer.requestId ?? null,
        parsed.occurredAt,
        eventSha256,
        parsed.batchId,
        parsed.sequenceTotal,
        parsed.isTerminal,
        parsed.previousEventSha256 ?? null,
        eventSha256,
      ],
    );
    await client.query(
      "update intentchord.runs set state_revision=state_revision+1,updated_at=now() where id=$1",
      [runId],
    );
    const taskRevision = await lockTask(client, run.task_id);
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [run.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "TOOL_TRACE_RECORDED",
      actor: producer.authority,
      taskId: run.task_id,
      contractRevisionId: run.contract_revision_id,
      runId,
      revision: Number(run.state_revision) + 1,
      metadata: {
        batchId: parsed.batchId,
        sequence: parsed.sequence,
        sequenceTotal: parsed.sequenceTotal,
        terminal: parsed.isTerminal,
        capability: derived.capability ?? null,
        authorizationResult: derived.authorizationResult,
        eventSha256,
        trustBasis: producer.trustBasis,
      },
    });
    return run.task_id as string;
  });
  return readTaskLifecycle(taskId);
}


export async function recordToolTraceBatch(
  runId: string,
  command: unknown,
  producer: TrustedProducerContext,
) {
  assertUuid(runId, "runId");
  const parsed = toolTraceBatchCommandSchema.parse(command);
  if (!(["ADAPTER", "HARNESS", "OWNER_RUNTIME"] as string[]).includes(producer.producerType)) {
    throw new HttpCommandError(403, "TRACE_PRODUCER_NOT_AUTHORIZED", "This trusted producer type cannot record tool-trace evidence.");
  }
  const taskId = await transaction(async client => {
    const run = await loadRunForUpdate(client, runId);
    if (Number(run.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (run.status !== "REPORT_RECEIVED") {
      throw new HttpCommandError(409, "REPORT_RECEIVED_REQUIRED", "Tool trace must be recorded after report receipt and before Verdict issuance.");
    }
    requireActiveContextLease(run);
    await claimTrustedProducerReceipt(client, runId, producer);
    const existing = await client.query(
      "select batch_id from intentchord.tool_trace_events where run_id=$1 limit 1 for update",
      [runId],
    );
    if (existing.rowCount) {
      throw new HttpCommandError(409, "TOOL_TRACE_BATCH_ALREADY_BOUND", "A Run accepts exactly one trusted tool-trace batch.", existing.rows[0]);
    }

    let previousEventSha256: string | undefined;
    let previousOccurredAt: string | undefined;
    const results: Array<{ sequence: number; eventSha256: string; authorizationResult: string; capability?: string }> = [];
    for (const [sequence, event] of parsed.events.entries()) {
      const contract = asJson<ExecutionContract>(run.contract_content);
      requireValidTraceTime(event.occurredAt, run.created_at, previousOccurredAt);
      const derived = deriveToolTraceAuthorization(event.command, event.capability, contract);
      if (event.authorizationResult !== derived.authorizationResult) {
        throw new HttpCommandError(422, "TRACE_AUTHORIZATION_MISMATCH", "The claimed authorization result does not match the Backend classification.", { sequence });
      }
      const eventSha256 = sha256(canonical({
        runId,
        batchId: parsed.batchId,
        sequence,
        sequenceTotal: parsed.events.length,
        isTerminal: sequence === parsed.events.length - 1,
        command: event.command,
        capability: derived.capability ?? null,
        authorizationResult: derived.authorizationResult,
        occurredAt: event.occurredAt,
        previousEventSha256: previousEventSha256 ?? null,
        producerType: producer.producerType,
        producerId: producer.producerId,
        trustBasis: producer.trustBasis,
        requestId: producer.requestId ?? null,
      }));
      await client.query(
        `insert into intentchord.tool_trace_events(
          id,run_id,sequence,command,capability,authorization_result,producer_type,
          producer_id,trust_basis,request_id,occurred_at,integrity_sha256,batch_id,sequence_total,
          is_terminal,previous_event_sha256,event_sha256
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          randomUUID(),
          runId,
          sequence,
          event.command,
          derived.capability ?? null,
          derived.authorizationResult,
          producer.producerType,
          producer.producerId,
          producer.trustBasis,
          producer.requestId ?? null,
          event.occurredAt,
          eventSha256,
          parsed.batchId,
          parsed.events.length,
          sequence === parsed.events.length - 1,
          previousEventSha256 ?? null,
          eventSha256,
        ],
      );
      results.push({
        sequence,
        eventSha256,
        authorizationResult: derived.authorizationResult,
        ...(derived.capability ? { capability: String(derived.capability) } : {}),
      });
      previousEventSha256 = eventSha256;
      previousOccurredAt = event.occurredAt;
    }

    await client.query(
      "update intentchord.runs set state_revision=state_revision+1,updated_at=now() where id=$1",
      [runId],
    );
    const taskRevision = await lockTask(client, run.task_id);
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [run.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "TOOL_TRACE_RECORDED",
      actor: producer.authority,
      taskId: run.task_id,
      contractRevisionId: run.contract_revision_id,
      runId,
      revision: Number(run.state_revision) + 1,
      metadata: {
        batchId: parsed.batchId,
        sequenceTotal: parsed.events.length,
        terminal: true,
        trustBasis: producer.trustBasis,
        events: results,
      },
    });
    return run.task_id as string;
  });
  return readTaskLifecycle(taskId);
}

export async function recordOwnerDecision(
  runId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(runId, "runId");
  const parsed = ownerDecisionCommandSchema.parse(command);
  const taskId = await transaction(async client => {
    const run = await loadRunForUpdate(client, runId);
    if (Number(run.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (run.status !== "REVIEW_READY") {
      throw new HttpCommandError(409, "VERDICT_REQUIRED", "The Run must have a Verdict before an Owner Decision.");
    }
    const verdict = await client.query(
      "select id,classification from intentchord.verdicts where run_id=$1",
      [runId],
    );
    if (!verdict.rowCount) throw new HttpCommandError(409, "VERDICT_REQUIRED", "The Run must have a Verdict.");
    if (parsed.decisionType === "ACCEPTED" && verdict.rows[0].classification !== "PASS") {
      throw new HttpCommandError(422, "PASS_REQUIRED", "ACCEPTED is allowed only for an independently proven PASS.");
    }
    if (parsed.decisionType === "ACCEPTED_WITH_OVERRIDE" && (!parsed.reason || parsed.reason.trim().length < 12)) {
      throw new HttpCommandError(422, "OVERRIDE_REASON_REQUIRED", "A documented Owner override reason of at least 12 characters is required.");
    }
    if (parsed.decisionType === "CORRECTION_REQUESTED" && (!parsed.reason || parsed.reason.trim().length < 12)) {
      throw new HttpCommandError(422, "CORRECTION_REASON_REQUIRED", "A bounded correction reason of at least 12 characters is required.");
    }
    if (parsed.decisionType === "ACKNOWLEDGED") {
      const existingAcknowledgement = await client.query(
        "select id from intentchord.owner_decisions where run_id=$1 and decision_type='ACKNOWLEDGED' limit 1",
        [runId],
      );
      if (existingAcknowledgement.rowCount) {
        throw new HttpCommandError(409, "OWNER_ACKNOWLEDGEMENT_ALREADY_RECORDED", "The Run result has already been acknowledged.");
      }
    }
    const existingTerminal = await client.query(
      `select id,decision_type from intentchord.owner_decisions
       where run_id=$1 and decision_type <> 'ACKNOWLEDGED'
       order by created_at desc,id desc limit 1`,
      [runId],
    );
    if (existingTerminal.rowCount) {
      throw new HttpCommandError(409, "OWNER_DECISION_ALREADY_RECORDED", "A terminal Owner Decision already exists for this Run.", existingTerminal.rows[0]);
    }
    const decisionId = randomUUID();
    await client.query(
      `insert into intentchord.owner_decisions(
        id,verdict_id,run_id,owner_reference,decision_type,reason,run_state_revision
      ) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        decisionId,
        verdict.rows[0].id,
        runId,
        ownerAuthority,
        parsed.decisionType,
        parsed.reason ?? null,
        parsed.expectedRevision,
      ],
    );
    await client.query(
      `update intentchord.runs
       set status=$2,state_revision=state_revision+1,updated_at=now()
       where id=$1`,
      [runId, parsed.decisionType === "ACKNOWLEDGED" ? "REVIEW_READY" : "DECIDED"],
    );
    const taskRevision = await lockTask(client, run.task_id);
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [run.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "OWNER_DECISION_RECORDED",
      actor: ownerAuthority,
      taskId: run.task_id,
      contractRevisionId: run.contract_revision_id,
      runId,
      revision: parsed.expectedRevision + 1,
      metadata: {
        decisionId,
        decisionType: parsed.decisionType,
        verdictClassification: verdict.rows[0].classification,
        reason: parsed.reason ?? null,
        evidenceBasedPass: verdict.rows[0].classification === "PASS",
      },
    });
    return run.task_id as string;
  });
  return readTaskLifecycle(taskId);
}

export async function startCorrection(
  runId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
) {
  assertUuid(runId, "runId");
  const parsed = startCorrectionCommandSchema.parse(command);
  const taskId = await transaction(async client => {
    // Run ID is routing metadata only. Canonical lock order is TASK -> CONTEXT -> WORKSPACES -> CONTRACT -> RUN.
    const route = await client.query<{ task_id: string; contract_revision_id: string }>(
      `select task_id,contract_revision_id from intentchord.runs where id=$1`,
      [runId],
    );
    if (!route.rowCount) throw new HttpCommandError(404, "RUN_NOT_FOUND", "Run not found.");
    const taskRevision = await lockTask(client, route.rows[0].task_id);
    const currentDraft = await latestDraft(client, route.rows[0].task_id);
    const frozenContextRevisionId = requireUnifiedV2ScopeFreeze(currentDraft.draft);
    if (frozenContextRevisionId) await assertCurrentEffectiveContextAuthority(client, route.rows[0].task_id, frozenContextRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
    const currentResolved = await currentContractForUpdate(client, route.rows[0].task_id);
    if (!currentResolved || currentResolved.row.status !== "APPROVED" || !currentResolved.row.approved_at) {
      throw new HttpCommandError(409, "CORRECTION_CURRENT_AUTHORITY_CONTRACT_REQUIRED", "Correction execution requires an approved Contract resolved from the current confirmed Scope authority. Rebase and approve a current Contract before starting the correction child.");
    }
    const parent = await loadRunForUpdate(client, runId);
    if (parent.task_id !== route.rows[0].task_id || parent.contract_revision_id !== route.rows[0].contract_revision_id) throw new ConflictError("Run routing identity changed before authority lock.");
    if (Number(parent.state_revision) !== parsed.expectedRevision) throw new ConflictError();
    if (parent.status !== "DECIDED") {
      throw new HttpCommandError(409, "CORRECTION_DECISION_REQUIRED", "A recorded correction decision is required.");
    }
    if (parent.correction_started_at) {
      throw new HttpCommandError(409, "CORRECTION_ALREADY_STARTED", "This parent Run already has a correction child.");
    }
    const decision = await client.query(
      `select od.id,od.decision_type,od.verdict_id,od.reason,od.consumed_at,v.verdict_content
       from intentchord.owner_decisions od
       join intentchord.verdicts v on v.id=od.verdict_id
       where od.run_id=$1
       order by od.created_at desc,od.id desc limit 1
       for update of od`,
      [runId],
    );
    if (!decision.rowCount || decision.rows[0].decision_type !== "CORRECTION_REQUESTED") {
      throw new HttpCommandError(409, "CORRECTION_NOT_REQUESTED", "The Owner Decision does not request correction.");
    }
    if (decision.rows[0].consumed_at) {
      throw new HttpCommandError(409, "CORRECTION_DECISION_ALREADY_CONSUMED", "The correction decision has already been consumed by a child Run.");
    }
    const existing = await client.query(
      "select child_run_id from intentchord.correction_rounds where parent_run_id=$1 or owner_decision_id=$2 limit 1",
      [runId, decision.rows[0].id],
    );
    if (existing.rowCount) {
      throw new HttpCommandError(409, "CORRECTION_ALREADY_STARTED", "The correction decision already governs a child Run.", existing.rows[0]);
    }
    const verdict = asJson<Verdict>(decision.rows[0].verdict_content);
    const unresolvedCheckGaps = (verdict.unresolvedCheckIds ?? [])
      .map(checkId => `Complete trusted check ${checkId}.`);
    const nonRedundantEvidenceGaps = verdict.evidenceGaps.filter(gap =>
      !/^Trusted PASS evidence is missing for required check:/i.test(gap)
      && !/^Mandatory requirement .+ lacks trusted .+ proof\.?$/i.test(gap)
    );
    const correctionGaps = Array.from(new Set([
      ...verdict.detectedViolations,
      ...unresolvedCheckGaps,
      ...nonRedundantEvidenceGaps,
      ...verdict.unsupportedClaims,
    ])).filter(Boolean);
    if (!correctionGaps.length) {
      throw new HttpCommandError(422, "CORRECTION_GAPS_REQUIRED", "A correction Run requires explicit unresolved gaps from the governing Verdict.");
    }
    const historicalAcceptedFacts = [...verdict.acceptedFacts];
    const roundResult = await client.query(
      "select coalesce(max(round),0)+1 as round from intentchord.runs where task_id=$1",
      [parent.task_id],
    );
    // A Correction child is NEW execution authority. Execute the exact CURRENT approved Contract
    // whose authority was locked and validated before the parent Run lock; never validate S2/current
    // authority and execute the parent's historical Contract1/S1. Parent decision/gaps/evidence remain lineage provenance.
    const contract = currentResolved.contract;
    const sameExactExecutionAuthority = String(currentResolved.row.id) === String(parent.contract_revision_id);
    const { completedFacts, inheritedCheckIds } = resolveCorrectionOperationalInheritance({
      sameExactExecutionAuthority,
      historicalAcceptedFacts,
      trustedSatisfiedCheckIds: verdict.trustedSatisfiedCheckIds ?? [],
      contract,
    });
    const childRunId = await createRunInTransaction(client, {
      taskId: parent.task_id,
      contractRow: {
        id: currentResolved.row.id,
        content_sha256: currentResolved.row.content_sha256,
      },
      contract,
      locale: parsed.locale,
      source: "CORRECTION_REPORT",
      executionType: "CORRECTION",
      round: Number(roundResult.rows[0].round),
      parentRunId: runId,
      lineageRootId: parent.lineage_root_id,
      correctionRound: Number(parent.correction_round) + 1,
      taskDraftRevisionId: currentResolved.row.task_draft_revision_id as string,
      contractStateRevision: Number(currentResolved.row.state_revision),
      correctionGaps,
      ownerCorrectionInstruction: String(decision.rows[0].reason ?? "").trim(),
      completedFacts,
      inheritedCheckIds,
    });
    if (inheritedCheckIds.length) {
      const sourceValidationRows = await client.query(
        `select distinct on (check_id) check_id,source_validation_evidence_id
         from (
           select ve.check_id,ve.id as source_validation_evidence_id
           from intentchord.validation_evidence ve
           where ve.run_id=$1 and ve.status='PASS' and ve.check_id=any($2::text[])
           union all
           select ive.check_id,ive.source_validation_evidence_id
           from intentchord.inherited_validation_evidence ive
           where ive.run_id=$1 and ive.check_id=any($2::text[])
         ) trusted_sources
         order by check_id,source_validation_evidence_id`,
        [runId, inheritedCheckIds],
      );
      const sourceByCheck = new Map(sourceValidationRows.rows.map(row => [String(row.check_id), String(row.source_validation_evidence_id)]));
      const missingInheritedSources = inheritedCheckIds.filter(checkId => !sourceByCheck.has(checkId));
      if (missingInheritedSources.length) {
        throw new HttpCommandError(
          409,
          "CORRECTION_INHERITED_EVIDENCE_MISSING",
          "The governing Verdict references trusted checks whose immutable source evidence cannot be found.",
          { missingCheckIds: missingInheritedSources },
        );
      }
      for (const checkId of inheritedCheckIds) {
        await client.query(
          `insert into intentchord.inherited_validation_evidence(
            id,run_id,parent_run_id,check_id,source_validation_evidence_id
          ) values($1,$2,$3,$4,$5)`,
          [randomUUID(), childRunId, runId, checkId, sourceByCheck.get(checkId)],
        );
      }
    }
    const correctionRoundId = randomUUID();
    await client.query(
      `insert into intentchord.correction_rounds(
        id,task_id,parent_run_id,child_run_id,governing_verdict_id,owner_decision_id
      ) values($1,$2,$3,$4,$5,$6)`,
      [
        correctionRoundId,
        parent.task_id,
        runId,
        childRunId,
        decision.rows[0].verdict_id,
        decision.rows[0].id,
      ],
    );
    await client.query(
      `update intentchord.owner_decisions
       set consumed_at=now(),consumed_by_run_id=$2 where id=$1 and consumed_at is null`,
      [decision.rows[0].id, childRunId],
    );
    await client.query(
      `update intentchord.runs
       set correction_started_at=now(),state_revision=state_revision+1,updated_at=now()
       where id=$1`,
      [runId],
    );
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [parent.task_id, taskRevision + 1],
    );
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: runId,
      eventType: "CORRECTION_DECISION_CONSUMED",
      actor: ownerAuthority,
      taskId: parent.task_id,
      contractRevisionId: parent.contract_revision_id,
      runId,
      revision: parsed.expectedRevision + 1,
      metadata: { childRunId, ownerDecisionId: decision.rows[0].id, correctionRoundId },
    });
    await audit(client, {
      aggregateType: "RUN",
      aggregateId: childRunId,
      eventType: "CORRECTION_STARTED",
      actor: ownerAuthority,
      taskId: parent.task_id,
      contractRevisionId: currentResolved.row.id,
      runId: childRunId,
      metadata: {
        parentRunId: runId,
        parentContractRevisionId: parent.contract_revision_id,
        currentAuthorityContractRevisionId: currentResolved.row.id,
        ownerDecisionId: decision.rows[0].id,
        governingVerdictId: decision.rows[0].verdict_id,
        correctionGaps,
        sameExactExecutionAuthority,
        rebasedExecutionAuthority: !sameExactExecutionAuthority,
        historicalParentAcceptedFactsCount: historicalAcceptedFacts.length,
        completedFacts,
        inheritedCheckIds,
      },
    });
    return parent.task_id as string;
  });
  return readTaskLifecycle(taskId);
}

export async function readTaskHistory(taskId: string) {
  assertUuid(taskId, "taskId");
  const task = await readTaskLifecycle(taskId);
  if (!task) throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
  const result = await databaseQuery(
    `select id,aggregate_type,aggregate_id,event_type,actor_authority,
      related_revision,related_contract_revision_id,related_run_id,metadata,created_at
     from intentchord.audit_events
     where related_task_id=$1 or (aggregate_type='TASK' and aggregate_id=$1)
     order by created_at,id`,
    [taskId],
  );
  return result.rows.map(row => ({
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    actorAuthority: row.actor_authority,
    relatedRevision: row.related_revision === null ? undefined : Number(row.related_revision),
    relatedContractRevisionId: row.related_contract_revision_id ?? undefined,
    relatedRunId: row.related_run_id ?? undefined,
    metadata: asJson<Json>(row.metadata),
    createdAt: asIso(row.created_at),
  }));
}

export async function rawCompiledArtifact(artifactId: string) {
  assertUuid(artifactId, "artifactId");
  const result = await databaseQuery(
    `select compiled_bytes,content_sha256,compiler_version,governance_version,
      model_identifier,reasoning_level,locale,compiled_at,delivery_state,delivery_method
     from intentchord.compiled_contract_artifacts where id=$1`,
    [artifactId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "ARTIFACT_NOT_FOUND", "Compiled Contract artifact not found.");
  const row = result.rows[0];
  return {
    text: (row.compiled_bytes as Buffer).toString("utf8"),
    sha256: row.content_sha256,
    compilerVersion: row.compiler_version,
    governanceVersion: row.governance_version,
    modelIdentifier: row.model_identifier,
    reasoningLevel: row.reasoning_level,
    locale: row.locale,
    compiledAt: asIso(row.compiled_at),
    deliveryState: row.delivery_state,
    deliveryMethod: row.delivery_method ?? undefined,
  };
}
