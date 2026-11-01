import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { bindFindingEvidence } from "@/core/evidence/evidence-binder";
import { proofEvidenceRefSchema } from "@/core/evidence/evidence-types";
import {
  buildDiscoveryAssessment,
  discoveryOutputSha256,
} from "@/core/discovery/discovery-map";
import {
  discoveryAssessmentSchema,
  discoveryItemSchema,
  discoveryPlannerVersion,
  discoveryRunProjectionSchema,
  discoverySchemaVersion,
  type DiscoveryFindingInput,
  type DiscoveryItem,
  type DiscoveryRunProjection,
} from "@/core/discovery/discovery-schema";
import {
  boundedDiscoveryInputSha256,
  runDeterministicBoundedDiscovery,
  type BoundedDiscoveryInput,
} from "@/core/discovery/discovery-runner";
import type { DiscoveryWorkspaceBoundary } from "@/core/discovery/discovery-tools";
import { intentResolutionSchema, type IntentResolution } from "@/core/intelligence/intent-schema";
import {
  aiAdapterRegistry,
  assertAdapterBinding,
  providerBinding,
} from "@/core/providers/ai-role-routing";
import type { TaskDraftInput } from "@/core/tasks/task-input";
import { databaseQuery, transaction } from "@/server/db";
import { assertRegisteredWorkspaceSourceAuthority } from "@/server/workspace-connector";
import { ConflictError, HttpCommandError } from "@/server/errors";
import {
  completeDiscoveryRunCommandSchema,
  createDiscoveryRunCommandSchema,
  submitDiscoveryFindingsCommandSchema,
} from "@/server/schemas";
import { terminalRuntimeGovernanceCode } from "@/core/workspace-index/adapters/filesystem-errors";

const OWNER_AUTHORITY_DEFAULT = "owner:unknown";
type Queryable = Pick<PoolClient, "query">;
type Json = Record<string, unknown>;

function runtimeDatabase(): Queryable {
  return { query: databaseQuery as PoolClient["query"] };
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpCommandError(400, "INVALID_IDENTIFIER", `${label} must be a valid UUID.`);
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
    metadata?: Json;
  },
): Promise<void> {
  await client.query(
    `insert into intentchord.audit_events(
      id, aggregate_type, aggregate_id, event_type, actor_authority,
      related_revision, related_task_id, metadata
    ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.actor ?? "BACKEND",
      event.revision ?? null,
      event.taskId ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

async function lockTask(client: PoolClient, taskId: string, expectedRevision?: number): Promise<number> {
  const result = await client.query(
    "select id,revision from intentchord.tasks where id=$1 for update",
    [taskId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
  const revision = Number(result.rows[0].revision);
  if (expectedRevision !== undefined && revision !== expectedRevision) throw new ConflictError();
  return revision;
}

async function currentDiscoveryInput(client: PoolClient, taskId: string, governance: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<{
  taskDraftRevisionId: string;
  draft: TaskDraftInput;
  intentResolutionId: string;
  intent: IntentResolution;
  authorityFingerprint: string;
  workspaces: DiscoveryWorkspaceBoundary[];
}> {
  const draftResult = await client.query(
    `select id,draft_projection
     from intentchord.task_draft_revisions
     where task_id=$1 order by revision desc limit 1`,
    [taskId],
  );
  if (!draftResult.rowCount) {
    throw new HttpCommandError(500, "DRAFT_REVISION_MISSING", "The Task has no authoritative Draft revision.");
  }
  const taskDraftRevisionId = draftResult.rows[0].id as string;
  const draft = asJson<TaskDraftInput>(draftResult.rows[0].draft_projection);

  const intentResult = await client.query(
    `select id,resolution_content,authority_fingerprint
     from intentchord.intent_resolutions
     where task_id=$1 and task_draft_revision_id=$2 and status='CONFIRMED'
     order by revision desc limit 1`,
    [taskId, taskDraftRevisionId],
  );
  if (!intentResult.rowCount) {
    throw new HttpCommandError(
      422,
      "CONFIRMED_INTENT_REQUIRED",
      "Resolve and confirm the current Task intent before starting bounded discovery.",
    );
  }
  const intent = intentResolutionSchema.parse(asJson<IntentResolution>(intentResult.rows[0].resolution_content));

  const snapshots = await client.query(
    `select workspace_registration_id,display_name,reference_type,normalized_reference,verification_status,fingerprint
     from intentchord.task_workspace_snapshots
     where draft_revision_id=$1 order by ordering`,
    [taskDraftRevisionId],
  );
  const draftWorkspaceById = new Map(draft.workspaces.map(workspace => [workspace.id, workspace]));
  const workspaces: DiscoveryWorkspaceBoundary[] = [];
  for (const row of snapshots.rows) {
    const workspaceRegistrationId = row.workspace_registration_id as string;
    const projected = draftWorkspaceById.get(workspaceRegistrationId);
    if (!projected) {
      throw new HttpCommandError(409, "WORKSPACE_SNAPSHOT_MISMATCH", "The current Workspace projection does not match its authoritative snapshot.");
    }
    if (row.verification_status !== "VERIFIED") {
      throw new HttpCommandError(422, "WORKSPACE_VERIFICATION_REQUIRED", `${row.display_name} is not Backend-verified.`);
    }
    if (row.reference_type !== "LOCAL_PATH") {
      throw new HttpCommandError(
        422,
        "BUILT_IN_DISCOVERY_REQUIRES_LOCAL_WORKSPACE",
        `${row.display_name} requires an external connector-aware discovery adapter.`,
      );
    }
    // Built-in Discovery is a Registered Workspace source-acquisition path. Reuse the same current
    // Root Object authority gate as preflight/indexing and reject a Task snapshot that predates
    // governed re-verification instead of silently reading through a newer binding.
    const authorized = await assertRegisteredWorkspaceSourceAuthority(workspaceRegistrationId, governance);
    if (String(row.fingerprint) !== authorized.registration.fingerprint) {
      throw new HttpCommandError(409, "WORKSPACE_SNAPSHOT_STALE", `${row.display_name} was re-verified after this Task Workspace snapshot was frozen.`);
    }
    const discoveryScopeMode = projected.discoveryScopeMode
      ?? (projected.allowedPaths.length ? "SELECTED_PATHS" : draft.taskMode === "CONTROLLED_AUDIT" ? "FULL_WORKSPACE" : "NONE");
    workspaces.push({
      id: projected.id,
      displayName: projected.displayName,
      rootReference: authorized.registration.normalizedReference,
      authorizedRootRealPath: authorized.currentIdentity.realPath,
      authorizedRootObjectIdentity: authorized.currentIdentity.rootObjectIdentity,
      discoveryScopeMode,
      allowedPaths: projected.allowedPaths,
      excludedPaths: projected.excludedPaths,
    });
  }

  if (!workspaces.some(workspace => workspace.discoveryScopeMode !== "NONE")) {
    throw new HttpCommandError(422, "DISCOVERY_READ_BOUNDARY_REQUIRED", "Bounded discovery requires at least one approved read boundary.");
  }

  return {
    taskDraftRevisionId,
    draft,
    intentResolutionId: intentResult.rows[0].id as string,
    intent,
    authorityFingerprint: intentResult.rows[0].authority_fingerprint as string,
    workspaces,
  };
}

async function persistDeterministicDiscoveryResult(
  discoveryRunId: string,
  input: BoundedDiscoveryInput,
  result: Awaited<ReturnType<typeof runDeterministicBoundedDiscovery>>,
): Promise<void> {
  await transaction(async client => {
    const runResult = await client.query(
      "select * from intentchord.discovery_runs where id=$1 for update",
      [discoveryRunId],
    );
    if (!runResult.rowCount) throw new HttpCommandError(404, "DISCOVERY_RUN_NOT_FOUND", "Discovery Run not found.");
    const run = runResult.rows[0];
    if (run.status !== "RUNNING") {
      throw new HttpCommandError(409, "DISCOVERY_RUN_STATE_MISMATCH", `Expected RUNNING; received ${run.status}.`);
    }
    if (run.input_sha256 !== result.inputSha256 || run.authority_fingerprint !== input.authorityFingerprint) {
      throw new HttpCommandError(409, "DISCOVERY_CONTEXT_MISMATCH", "The discovery result does not match the frozen input or authority fingerprint.");
    }

    for (const item of result.items) {
      await client.query(
        `insert into intentchord.discovery_items(
          id,discovery_run_id,workspace_registration_id,relative_path,symbol,
          line_start,line_end,content_sha256,requirement_ids,relevance_reason,
          matched_concepts,match_score,item_state
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict do nothing`,
        [
          randomUUID(),
          discoveryRunId,
          item.workspaceId,
          item.relativePath,
          item.symbol ?? null,
          item.lineStart ?? null,
          item.lineEnd ?? null,
          item.contentSha256,
          JSON.stringify(item.requirementIds),
          item.relevanceReason,
          JSON.stringify(item.matchedConcepts),
          item.matchScore,
          item.state,
        ],
      );
    }

    const nextStateRevision = Number(run.state_revision) + 1;
    await client.query(
      `update intentchord.discovery_runs
       set status='READY_TO_COMPLETE',state_revision=$2,assessment=$3,evidence_gaps=$4,
         updated_at=now()
       where id=$1`,
      [
        discoveryRunId,
        nextStateRevision,
        JSON.stringify(result.assessment),
        JSON.stringify(result.evidenceGaps),
      ],
    );
    await audit(client, {
      aggregateType: "DISCOVERY_RUN",
      aggregateId: discoveryRunId,
      eventType: "DISCOVERY_MAP_RECORDED",
      actor: "BACKEND",
      revision: nextStateRevision,
      taskId: run.task_id,
      metadata: {
        itemCount: result.items.length,
        evidenceGapCount: result.evidenceGaps.length,
        assessment: result.assessment,
      },
    });
  });
}

async function failDiscoveryRun(discoveryRunId: string, error: unknown): Promise<void> {
  await transaction(async client => {
    const runResult = await client.query(
      "select task_id,state_revision,status from intentchord.discovery_runs where id=$1 for update",
      [discoveryRunId],
    );
    if (!runResult.rowCount) return;
    const row = runResult.rows[0];
    if (["COMPLETED", "EVIDENCE_REQUIRED", "SUPERSEDED"].includes(row.status)) return;
    const nextStateRevision = Number(row.state_revision) + 1;
    const governedCode = terminalRuntimeGovernanceCode(error);
    const message = error instanceof Error ? error.message : "DISCOVERY_EXECUTION_FAILED";
    const failureCode = governedCode ?? "DISCOVERY_EXECUTION_FAILED";
    await client.query(
      `update intentchord.discovery_runs
       set status='FAILED',state_revision=$2,failure_code=$3,
         failure_message=$4,updated_at=now()
       where id=$1`,
      [discoveryRunId, nextStateRevision, failureCode, message],
    );
    await audit(client, {
      aggregateType: "DISCOVERY_RUN",
      aggregateId: discoveryRunId,
      eventType: "DISCOVERY_RUN_FAILED",
      actor: "BACKEND",
      revision: nextStateRevision,
      taskId: row.task_id,
      metadata: { message, failureCode },
    });
  });
}

export async function createTaskDiscoveryRun(
  taskId: string,
  command: unknown,
  ownerAuthority = OWNER_AUTHORITY_DEFAULT,
  governance: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<DiscoveryRunProjection> {
  assertUuid(taskId, "taskId");
  const parsed = createDiscoveryRunCommandSchema.parse(command);

  let binding;
  try {
    binding = providerBinding(
      "DISCOVERY_INVESTIGATOR",
      parsed.discoveryProviderId,
      parsed.discoveryModelId,
      parsed.discoveryExecutionChannelId,
    );
    assertAdapterBinding(parsed.discoveryAdapterId, binding);
  } catch (error) {
    throw new HttpCommandError(
      422,
      "DISCOVERY_PROVIDER_BINDING_INVALID",
      error instanceof Error ? error.message : "The Discovery provider binding is invalid.",
    );
  }
  const adapter = aiAdapterRegistry[parsed.discoveryAdapterId];
  if (adapter.activation !== "BUILT_IN") {
    throw new HttpCommandError(
      501,
      "DISCOVERY_PROVIDER_ADAPTER_NOT_CONFIGURED",
      `${parsed.discoveryAdapterId} is registered for one-provider-per-role execution, but its external adapter is not configured in this deployment.`,
    );
  }
  if (parsed.discoveryAdapterId !== "DETERMINISTIC_BOUNDED_DISCOVERY") {
    throw new HttpCommandError(501, "DISCOVERY_PROVIDER_ADAPTER_NOT_CONFIGURED", "No built-in implementation exists for this Discovery adapter.");
  }

  const snapshot = await transaction(async client => {
    const taskRevision = await lockTask(client, taskId, parsed.expectedRevision);
    const current = await currentDiscoveryInput(client, taskId, governance);
    const active = await client.query(
      `select id,status from intentchord.discovery_runs
       where task_draft_revision_id=$1 and status in ('CREATED','RUNNING','AWAITING_FINDINGS','READY_TO_COMPLETE')
       limit 1`,
      [current.taskDraftRevisionId],
    );
    if (active.rowCount) {
      throw new HttpCommandError(409, "DISCOVERY_RUN_ALREADY_ACTIVE", "An active bounded Discovery Run already exists for the current Draft.", active.rows[0]);
    }
    const contract = await client.query(
      `select id from intentchord.contract_revisions
       where task_id=$1 and status <> 'SUPERSEDED' limit 1`,
      [taskId],
    );
    if (contract.rowCount) {
      throw new HttpCommandError(409, "DISCOVERY_MUST_PRECEDE_CONTRACT", "Bounded discovery must complete before resolving the current Contract revision.");
    }

    const discoveryInput: BoundedDiscoveryInput = {
      taskId,
      intentResolutionId: current.intentResolutionId,
      authorityFingerprint: current.authorityFingerprint,
      intent: current.intent,
      workspaces: current.workspaces,
      signal: governance.signal,
      deadlineAt: governance.deadlineAt,
    };
    const inputSha256 = boundedDiscoveryInputSha256(discoveryInput);
    const discoveryRunId = randomUUID();
    await client.query(
      `insert into intentchord.discovery_runs(
        id,task_id,task_draft_revision_id,intent_resolution_id,state_revision,status,
        schema_version,planner_version,adapter_id,provider_id,model_id,execution_channel_id,
        provider_invocation_state,authority_fingerprint,input_sha256,started_at
      ) values($1,$2,$3,$4,0,'RUNNING',$5,$6,$7,$8,$9,$10,'NOT_INVOKED',$11,$12,now())`,
      [
        discoveryRunId,
        taskId,
        current.taskDraftRevisionId,
        current.intentResolutionId,
        discoverySchemaVersion,
        discoveryPlannerVersion,
        parsed.discoveryAdapterId,
        binding.providerId,
        binding.modelId,
        binding.executionChannelId,
        current.authorityFingerprint,
        inputSha256,
      ],
    );
    const nextTaskRevision = taskRevision + 1;
    await client.query(
      "update intentchord.tasks set revision=$2,updated_at=now() where id=$1",
      [taskId, nextTaskRevision],
    );
    await audit(client, {
      aggregateType: "DISCOVERY_RUN",
      aggregateId: discoveryRunId,
      eventType: "DISCOVERY_RUN_STARTED",
      actor: ownerAuthority,
      revision: 0,
      taskId,
      metadata: {
        adapterId: parsed.discoveryAdapterId,
        providerBinding: binding,
        inputSha256,
        authorityFingerprint: current.authorityFingerprint,
        locale: parsed.locale,
      },
    });
    return { discoveryRunId, discoveryInput };
  });

  try {
    const result = await runDeterministicBoundedDiscovery(snapshot.discoveryInput);
    await persistDeterministicDiscoveryResult(snapshot.discoveryRunId, snapshot.discoveryInput, result);
  } catch (error) {
    await failDiscoveryRun(snapshot.discoveryRunId, error);
    if (terminalRuntimeGovernanceCode(error)) throw error;
    if (error instanceof HttpCommandError) throw error;
  }
  return readDiscoveryRun(snapshot.discoveryRunId);
}

async function loadDiscoveryRunForUpdate(client: PoolClient, discoveryRunId: string) {
  const result = await client.query(
    `select dr.*,ir.resolution_content
     from intentchord.discovery_runs dr
     join intentchord.intent_resolutions ir on ir.id=dr.intent_resolution_id
     where dr.id=$1 for update of dr`,
    [discoveryRunId],
  );
  if (!result.rowCount) throw new HttpCommandError(404, "DISCOVERY_RUN_NOT_FOUND", "Discovery Run not found.");
  return result.rows[0];
}

function requirementById(intent: IntentResolution): Map<string, IntentResolution["proposedRequirements"][number]> {
  return new Map(intent.proposedRequirements.map(requirement => [requirement.id, requirement]));
}

async function validateSourceEvidenceRefs(
  client: PoolClient,
  discoveryRunId: string,
  finding: DiscoveryFindingInput,
): Promise<void> {
  for (const rawReference of finding.evidenceRefs) {
    const reference = proofEvidenceRefSchema.parse(rawReference);
    if (reference.kind !== "SOURCE_EVIDENCE") continue;
    const matched = await client.query(
      `select 1 from intentchord.discovery_items
       where discovery_run_id=$1 and workspace_registration_id=$2 and relative_path=$3
         and content_sha256=$4 and requirement_ids ? $5
         and ($6::integer is null or line_start=$6)
         and ($7::integer is null or line_end=$7)
       limit 1`,
      [
        discoveryRunId,
        reference.workspaceId,
        reference.relativePath,
        reference.contentSha256,
        finding.requirementId,
        reference.lineStart ?? null,
        reference.lineEnd ?? null,
      ],
    );
    if (!matched.rowCount) {
      throw new HttpCommandError(
        422,
        "DISCOVERY_SOURCE_EVIDENCE_NOT_RECORDED",
        "A SOURCE_EVIDENCE reference must match an exact recorded Discovery item for the same requirement.",
        reference,
      );
    }
  }
}

export async function submitDiscoveryFindings(
  discoveryRunId: string,
  command: unknown,
): Promise<DiscoveryRunProjection> {
  assertUuid(discoveryRunId, "discoveryRunId");
  const parsed = submitDiscoveryFindingsCommandSchema.parse(command);
  await transaction(async client => {
    const run = await loadDiscoveryRunForUpdate(client, discoveryRunId);
    if (Number(run.state_revision) !== parsed.expectedStateRevision) throw new ConflictError();
    if (!["AWAITING_FINDINGS", "READY_TO_COMPLETE"].includes(run.status)) {
      throw new HttpCommandError(409, "DISCOVERY_RUN_NOT_ACCEPTING_FINDINGS", `Discovery Run state ${run.status} does not accept findings.`);
    }
    const intent = intentResolutionSchema.parse(asJson<IntentResolution>(run.resolution_content));
    const requirements = requirementById(intent);
    for (const finding of parsed.findings) {
      const requirement = requirements.get(finding.requirementId);
      if (!requirement) {
        throw new HttpCommandError(422, "DISCOVERY_REQUIREMENT_NOT_FOUND", `Unknown requirement ${finding.requirementId}.`);
      }
      await validateSourceEvidenceRefs(client, discoveryRunId, finding);
      const bound = bindFindingEvidence({
        ...finding,
        requiredEvidenceTypes: requirement.requiredEvidenceTypes,
      });
      if (bound.accepted) {
        for (const reference of bound.evidenceRefs) {
          if (reference.kind !== "SOURCE_EVIDENCE") continue;
          await client.query(
            `insert into intentchord.source_evidence(
              id,run_id,discovery_run_id,requirement_id,workspace_registration_id,
              relative_path,symbol,line_start,line_end,content_sha256,observation,producer_type
            ) values($1,null,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ADAPTER')
            on conflict do nothing`,
            [
              randomUUID(),
              discoveryRunId,
              finding.requirementId,
              reference.workspaceId,
              reference.relativePath,
              reference.symbol ?? null,
              reference.lineStart ?? null,
              reference.lineEnd ?? null,
              reference.contentSha256,
              finding.claim,
            ],
          );
        }
      }
      await client.query(
        `insert into intentchord.discovery_findings(
          id,discovery_run_id,requirement_id,claim,finding_status,evidence_refs,
          accepted,issues,producer_adapter_id
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          discoveryRunId,
          finding.requirementId,
          finding.claim,
          finding.status,
          JSON.stringify(finding.evidenceRefs),
          bound.accepted,
          JSON.stringify(bound.issues),
          run.adapter_id,
        ],
      );
    }
    const workspaceIds = new Set(
      (await client.query(
        `select workspace_registration_id
         from intentchord.task_workspace_snapshots
         where draft_revision_id=$1`,
        [run.task_draft_revision_id],
      )).rows.map(row => row.workspace_registration_id as string),
    );
    for (const request of parsed.scopeExpansionRequests) {
      if (!workspaceIds.has(request.workspaceId)) {
        throw new HttpCommandError(422, "DISCOVERY_SCOPE_WORKSPACE_NOT_BOUND", "Scope expansion must name a Workspace already bound to the Discovery Run.");
      }
      await client.query(
        `insert into intentchord.discovery_scope_expansion_requests(
          id,discovery_run_id,workspace_registration_id,requested_path,reason
        ) values($1,$2,$3,$4,$5)`,
        [randomUUID(), discoveryRunId, request.workspaceId, request.requestedPath, request.reason],
      );
    }
    const nextStateRevision = Number(run.state_revision) + 1;
    await client.query(
      `update intentchord.discovery_runs
       set status='READY_TO_COMPLETE',state_revision=$2,updated_at=now()
       where id=$1`,
      [discoveryRunId, nextStateRevision],
    );
    await audit(client, {
      aggregateType: "DISCOVERY_RUN",
      aggregateId: discoveryRunId,
      eventType: "DISCOVERY_FINDINGS_RECORDED",
      actor: "ADAPTER",
      revision: nextStateRevision,
      taskId: run.task_id,
      metadata: {
        findingCount: parsed.findings.length,
        scopeExpansionRequestCount: parsed.scopeExpansionRequests.length,
      },
    });
  });
  return readDiscoveryRun(discoveryRunId);
}

export async function completeDiscoveryRun(
  discoveryRunId: string,
  command: unknown,
): Promise<DiscoveryRunProjection> {
  assertUuid(discoveryRunId, "discoveryRunId");
  const parsed = completeDiscoveryRunCommandSchema.parse(command);
  await transaction(async client => {
    const run = await loadDiscoveryRunForUpdate(client, discoveryRunId);
    if (Number(run.state_revision) !== parsed.expectedStateRevision) throw new ConflictError();
    if (run.status !== "READY_TO_COMPLETE") {
      throw new HttpCommandError(409, "DISCOVERY_RUN_NOT_READY", `Discovery Run state ${run.status} is not ready to complete.`);
    }
    const intent = intentResolutionSchema.parse(asJson<IntentResolution>(run.resolution_content));
    const itemResult = await client.query(
      "select * from intentchord.discovery_items where discovery_run_id=$1 order by match_score desc,relative_path",
      [discoveryRunId],
    );
    const items: DiscoveryItem[] = itemResult.rows.map(row => discoveryItemSchema.parse({
      id: row.id,
      workspaceId: row.workspace_registration_id,
      relativePath: row.relative_path,
      ...(row.symbol ? { symbol: row.symbol } : {}),
      ...(row.line_start ? { lineStart: Number(row.line_start), lineEnd: Number(row.line_end) } : {}),
      contentSha256: row.content_sha256,
      requirementIds: asJson<string[]>(row.requirement_ids),
      relevanceReason: row.relevance_reason,
      matchedConcepts: asJson<string[]>(row.matched_concepts),
      matchScore: Number(row.match_score),
      state: row.item_state,
    }));
    const workspaceIds = [...new Set(items.map(item => item.workspaceId))];
    const assessment = run.assessment
      ? discoveryAssessmentSchema.parse(asJson(run.assessment))
      : buildDiscoveryAssessment({
        items,
        workspaceIds,
        requirementIds: intent.proposedRequirements.map(requirement => requirement.id),
      });
    const findingResult = await client.query(
      "select * from intentchord.discovery_findings where discovery_run_id=$1 order by created_at",
      [discoveryRunId],
    );
    const scopeRequests = await client.query(
      "select 1 from intentchord.discovery_scope_expansion_requests where discovery_run_id=$1 and status='PENDING' limit 1",
      [discoveryRunId],
    );
    const persistedEvidenceGaps = asJson<string[]>(run.evidence_gaps ?? []);
    const coverageGap = assessment.requirementCoverage.some(item => item.discoveredItemCount === 0);
    const rejectedFinding = findingResult.rows.some(row => !row.accepted);
    const finalStatus = scopeRequests.rowCount || persistedEvidenceGaps.length || coverageGap || rejectedFinding
      ? "EVIDENCE_REQUIRED" as const
      : "COMPLETED" as const;
    const outputSha256 = discoveryOutputSha256({
      items,
      assessment,
      findingCount: findingResult.rows.length,
      evidenceGaps: persistedEvidenceGaps,
    });
    const nextStateRevision = Number(run.state_revision) + 1;
    await client.query(
      `update intentchord.discovery_runs
       set status=$2,state_revision=$3,assessment=$4,output_sha256=$5,completed_at=now(),updated_at=now()
       where id=$1`,
      [discoveryRunId, finalStatus, nextStateRevision, JSON.stringify(assessment), outputSha256],
    );
    await client.query(
      "update intentchord.tasks set revision=revision+1,updated_at=now() where id=$1",
      [run.task_id],
    );
    await audit(client, {
      aggregateType: "DISCOVERY_RUN",
      aggregateId: discoveryRunId,
      eventType: "DISCOVERY_RUN_COMPLETED",
      actor: "BACKEND",
      revision: nextStateRevision,
      taskId: run.task_id,
      metadata: {
        status: finalStatus,
        outputSha256,
        assessment,
        findingCount: findingResult.rows.length,
      },
    });
  });
  return readDiscoveryRun(discoveryRunId);
}

export async function readDiscoveryRun(
  discoveryRunId: string,
  client: Queryable = runtimeDatabase(),
): Promise<DiscoveryRunProjection> {
  assertUuid(discoveryRunId, "discoveryRunId");
  const runResult = await client.query(
    "select * from intentchord.discovery_runs where id=$1",
    [discoveryRunId],
  );
  if (!runResult.rowCount) throw new HttpCommandError(404, "DISCOVERY_RUN_NOT_FOUND", "Discovery Run not found.");
  const run = runResult.rows[0];
  const itemsResult = await client.query(
    "select * from intentchord.discovery_items where discovery_run_id=$1 order by match_score desc,relative_path",
    [discoveryRunId],
  );
  const findingsResult = await client.query(
    "select * from intentchord.discovery_findings where discovery_run_id=$1 order by created_at",
    [discoveryRunId],
  );
  const scopeResult = await client.query(
    "select * from intentchord.discovery_scope_expansion_requests where discovery_run_id=$1 order by created_at",
    [discoveryRunId],
  );
  const binding = providerBinding(
    "DISCOVERY_INVESTIGATOR",
    run.provider_id,
    run.model_id,
    run.execution_channel_id,
  );
  return discoveryRunProjectionSchema.parse({
    id: run.id,
    taskId: run.task_id,
    taskDraftRevisionId: run.task_draft_revision_id,
    intentResolutionId: run.intent_resolution_id,
    stateRevision: Number(run.state_revision),
    status: run.status,
    schemaVersion: run.schema_version,
    plannerVersion: run.planner_version,
    adapterId: run.adapter_id,
    providerBinding: binding,
    providerInvocationState: run.provider_invocation_state,
    ...(run.external_invocation_id ? { externalInvocationId: run.external_invocation_id } : {}),
    authorityFingerprint: run.authority_fingerprint,
    inputSha256: run.input_sha256,
    ...(run.output_sha256 ? { outputSha256: run.output_sha256 } : {}),
    ...(run.assessment ? { assessment: asJson(run.assessment) } : {}),
    items: itemsResult.rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_registration_id,
      relativePath: row.relative_path,
      ...(row.symbol ? { symbol: row.symbol } : {}),
      ...(row.line_start ? { lineStart: Number(row.line_start), lineEnd: Number(row.line_end) } : {}),
      contentSha256: row.content_sha256,
      requirementIds: asJson<string[]>(row.requirement_ids),
      relevanceReason: row.relevance_reason,
      matchedConcepts: asJson<string[]>(row.matched_concepts),
      matchScore: Number(row.match_score),
      state: row.item_state,
    })),
    findings: findingsResult.rows.map(row => ({
      requirementId: row.requirement_id,
      claim: row.claim,
      status: row.finding_status,
      evidenceRefs: asJson(row.evidence_refs),
    })),
    evidenceGaps: asJson<string[]>(run.evidence_gaps ?? []),
    scopeExpansionRequests: scopeResult.rows.map(row => ({
      workspaceId: row.workspace_registration_id,
      requestedPath: row.requested_path,
      reason: row.reason,
    })),
    ...(run.started_at ? { startedAt: asIso(run.started_at) } : {}),
    ...(run.completed_at ? { completedAt: asIso(run.completed_at) } : {}),
    createdAt: asIso(run.created_at),
    updatedAt: asIso(run.updated_at),
  });
}

export async function readLatestDiscoveryRunForTask(
  taskId: string,
  client: Queryable = runtimeDatabase(),
): Promise<DiscoveryRunProjection | undefined> {
  assertUuid(taskId, "taskId");
  const result = await client.query(
    `select id from intentchord.discovery_runs
     where task_id=$1 and status <> 'SUPERSEDED'
     order by created_at desc limit 1`,
    [taskId],
  );
  if (!result.rowCount) return undefined;
  return readDiscoveryRun(result.rows[0].id as string, client);
}

const CONTRACT_DISCOVERY_PATHS_PER_REQUIREMENT = 2;
const CONTRACT_DISCOVERY_PATHS_TOTAL = 12;

export function discoveryContractSummary(discovery: DiscoveryRunProjection): {
  id: string;
  outputSha256: string;
  status: "COMPLETED" | "EVIDENCE_REQUIRED";
  completedAt: string;
  assessment: NonNullable<DiscoveryRunProjection["assessment"]>;
  requirementPaths: Array<{
    requirementId: string;
    paths: string[];
    totalPathCount: number;
    omittedPathCount: number;
  }>;
  evidenceGaps: string[];
} {
  if (!["COMPLETED", "EVIDENCE_REQUIRED"].includes(discovery.status)
    || !discovery.outputSha256
    || !discovery.completedAt
    || !discovery.assessment) {
    throw new Error("DISCOVERY_RUN_NOT_TERMINAL");
  }
  const requirementIds = [...new Set(discovery.items.flatMap(item => item.requirementIds))].sort();
  return {
    id: discovery.id,
    outputSha256: discovery.outputSha256,
    status: discovery.status as "COMPLETED" | "EVIDENCE_REQUIRED",
    completedAt: discovery.completedAt,
    assessment: discovery.assessment,
    requirementPaths: (() => {
      let remainingPathBudget = CONTRACT_DISCOVERY_PATHS_TOTAL;
      return requirementIds.map(requirementId => {
        const allPaths = [...new Set(discovery.items
          .filter(item => item.requirementIds.includes(requirementId))
          .map(item => `${item.workspaceId}:${item.relativePath}`))].sort();
        const selectedCount = Math.min(
          CONTRACT_DISCOVERY_PATHS_PER_REQUIREMENT,
          remainingPathBudget,
          allPaths.length,
        );
        const paths = allPaths.slice(0, selectedCount);
        remainingPathBudget -= selectedCount;
        return {
          requirementId,
          paths,
          totalPathCount: allPaths.length,
          omittedPathCount: allPaths.length - paths.length,
        };
      });
    })(),
    evidenceGaps: [...new Set([
      ...discovery.evidenceGaps,
      ...discovery.assessment.requirementCoverage
        .filter(item => item.discoveredItemCount === 0)
        .map(item => `${item.requirementId}: no discovered source candidate.`),
    ])],
  };
}

export async function supersedeDiscoveryRunsForTask(
  client: PoolClient,
  taskId: string,
  reason: string,
): Promise<void> {
  const result = await client.query(
    `update intentchord.discovery_runs
     set status='SUPERSEDED',state_revision=state_revision+1,updated_at=now(),
       failure_code=coalesce(failure_code,'SUPERSEDED'),failure_message=coalesce(failure_message,$2)
     where task_id=$1 and status not in ('SUPERSEDED')
     returning id,state_revision`,
    [taskId, reason],
  );
  for (const row of result.rows) {
    await audit(client, {
      aggregateType: "DISCOVERY_RUN",
      aggregateId: row.id,
      eventType: "DISCOVERY_RUN_SUPERSEDED",
      actor: OWNER_AUTHORITY_DEFAULT,
      revision: Number(row.state_revision),
      taskId,
      metadata: { reason },
    });
  }
}
