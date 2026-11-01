import type { PoolClient } from "pg";
import { canonicalJson, mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { classifyCurrentEffectiveContextAuthority, taskSourceSetAuthoritySha256V1 } from "@/core/context-authority/current-effective-context";
import type { TaskDraftInput } from "@/core/tasks/task-input";
import { databaseQuery, transaction } from "@/server/db";
import { HttpCommandError } from "@/server/errors";

type Queryable = Pick<PoolClient, "query">;

export type CurrentContextHead = {
  contextAssemblyId: string;
  contextAssemblyRevisionId: string;
  revision: number;
  assemblySha256: string;
};

export type CurrentEffectiveSourceAuthority = {
  workspaceRegistrationId: string;
  ordering: number;
  workspaceRegistrationRevision: number;
  workspaceRegistrationFingerprint: string;
  workspaceRevisionId: string;
  workspaceIndexSnapshotId: string;
  canonicalIndexArtifactId: string;
  workspaceIndexSha256: string;
  artifactSemanticSha256: string;
  artifactSemanticState: Record<string, unknown>;
  observationId: string;
  authoritySequence: number;
};

export type CurrentEffectiveContextAuthorityProof = {
  status: "CURRENT";
  head: CurrentContextHead;
  taskRevision: number;
  taskSourceSetSha256: string;
  sourceAuthoritySha256: string;
  sources: CurrentEffectiveSourceAuthority[];
};


export type CurrentEffectiveContextAuthorityEvaluation =
  | CurrentEffectiveContextAuthorityProof
  | { status: "DRIFT" | "UNPROVEN"; head?: CurrentContextHead; details: Array<Record<string, unknown>> };

export type FrozenContextSourceAuthorityStatus =
  | { status: "CURRENT"; taskSourceSetSha256: string; sourceAuthoritySha256: string }
  | { status: "DRIFT"; details: Array<Record<string, unknown>> }
  | { status: "UNPROVEN"; details: Array<Record<string, unknown>> };

function runtimeDatabase(): Queryable {
  return { query: databaseQuery as PoolClient["query"] };
}

function asDraft(value: unknown): TaskDraftInput {
  return (typeof value === "string" ? JSON.parse(value) : value) as TaskDraftInput;
}

function sourceSetMaterial(draft: TaskDraftInput) {
  return [...draft.workspaces]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(workspace => ({
      workspaceRegistrationId: workspace.id,
      workspaceRegistrationFingerprint: workspace.fingerprint,
      ordering: workspace.ordering,
    }));
}

function frozenSourceSetMaterial(rows: Array<{
  workspace_registration_id: string;
  workspace_registration_fingerprint: string;
  ordering: string | number;
}>) {
  return [...rows]
    .sort((a, b) => a.workspace_registration_id.localeCompare(b.workspace_registration_id))
    .map(row => ({
      workspaceRegistrationId: row.workspace_registration_id,
      workspaceRegistrationFingerprint: row.workspace_registration_fingerprint,
      ordering: Number(row.ordering),
    }));
}

function taskSourceSetSha256FromDraft(draft: TaskDraftInput): string {
  return taskSourceSetAuthoritySha256V1(sourceSetMaterial(draft));
}

function taskSourceSetSha256FromFrozen(rows: Array<{ workspace_registration_id: string; workspace_registration_fingerprint: string; ordering: string | number }>): string {
  return taskSourceSetAuthoritySha256V1(frozenSourceSetMaterial(rows));
}

async function resolveCurrentContextHead(queryable: Queryable, taskId: string): Promise<CurrentContextHead | undefined> {
  const result = await queryable.query<{
    context_assembly_id: string;
    context_assembly_revision_id: string;
    revision: string | number;
    assembly_sha256: string;
  }>(
    `select a.id as context_assembly_id,
            r.id as context_assembly_revision_id,
            r.revision,
            r.assembly_sha256
       from intentchord.context_assemblies a
       join lateral (
         select id,revision,assembly_sha256
           from intentchord.context_assembly_revisions
          where context_assembly_id=a.id
          order by revision desc
          limit 1
       ) r on true
      where a.task_id=$1`,
    [taskId],
  );
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  return {
    contextAssemblyId: row.context_assembly_id,
    contextAssemblyRevisionId: row.context_assembly_revision_id,
    revision: Number(row.revision),
    assemblySha256: row.assembly_sha256,
  };
}

export async function readCurrentContextHead(taskId: string): Promise<CurrentContextHead | undefined> {
  return resolveCurrentContextHead(runtimeDatabase(), taskId);
}

/** Lock the stable Context Assembly parent and derive the immutable lineage Head. */
export async function lockCurrentContextHead(client: PoolClient, taskId: string): Promise<CurrentContextHead> {
  const assembly = await client.query<{ id: string }>(
    "select id from intentchord.context_assemblies where task_id=$1 for update",
    [taskId],
  );
  if (!assembly.rowCount) {
    throw new HttpCommandError(409, "CURRENT_CONTEXT_HEAD_REQUIRED", "The Task has no governed Context Assembly authority yet.");
  }
  const head = await client.query<{ id: string; revision: string | number; assembly_sha256: string }>(
    `select id,revision,assembly_sha256
       from intentchord.context_assembly_revisions
      where context_assembly_id=$1
      order by revision desc
      limit 1`,
    [assembly.rows[0].id],
  );
  if (!head.rowCount) {
    throw new HttpCommandError(409, "CURRENT_CONTEXT_HEAD_REQUIRED", "The Task Context Assembly has no persisted Revision.");
  }
  return {
    contextAssemblyId: assembly.rows[0].id,
    contextAssemblyRevisionId: head.rows[0].id,
    revision: Number(head.rows[0].revision),
    assemblySha256: head.rows[0].assembly_sha256,
  };
}

export async function assertCurrentContextHead(
  client: PoolClient,
  taskId: string,
  expectedContextAssemblyRevisionId: string,
  errorCode = "STALE_CONTEXT_HEAD",
): Promise<CurrentContextHead> {
  const head = await lockCurrentContextHead(client, taskId);
  if (head.contextAssemblyRevisionId !== expectedContextAssemblyRevisionId) {
    throw new HttpCommandError(409, errorCode, "The requested Context authority belongs to a historical Context Assembly Revision. Reload the current Context Head before creating new forward authority.", {
      expectedContextAssemblyRevisionId,
      currentContextAssemblyRevisionId: head.contextAssemblyRevisionId,
      currentContextAssemblyRevision: head.revision,
    });
  }
  return head;
}

type LockedWorkspaceAuthorityRow = {
  id: string;
  revision: string | number;
  fingerprint: string;
  verification_status: string;
};

type ObservationAuthorityHeadRow = {
  observation_id: string | null;
  authority_sequence: string | number | null;
  observation_result: string | null;
  workspace_revision_id: string | null;
  canonical_index_artifact_id: string | null;
  accepted_workspace_evidence_artifact_id: string | null;
  index_configuration_sha256: string | null;
  snapshot_id: string | null;
  snapshot_status: string | null;
  snapshot_attempt_status: string | null;
  snapshot_registration_revision: string | number | null;
  snapshot_registration_fingerprint: string | null;
  snapshot_workspace_revision_id: string | null;
  snapshot_artifact_id: string | null;
  snapshot_canonical_sha256: string | null;
  snapshot_evidence_artifact_id: string | null;
  snapshot_source_continuity_attestation_id: string | null;
  artifact_id: string | null;
  artifact_semantic_sha256: string | null;
  artifact_semantic_json: Record<string, unknown> | null;
  evidence_artifact_id: string | null;
  evidence_artifact_semantic_sha256: string | null;
};

/**
 * Resolve the ACTUAL Observation authority head first, then qualify that exact head.
 * No READY/success filter participates in head selection, so a newer failed/incomplete
 * Observation makes current authority UNPROVEN instead of falling back to older success.
 *
 * Caller must already hold the Task row lock. Workspace Registration rows are locked here
 * in deterministic ID order and remain locked through the surrounding authority transaction.
 */
export async function captureLockedTaskSourceAuthority(
  client: PoolClient,
  draft: TaskDraftInput,
  additionalWorkspaceRegistrationIds: string[] = [],
): Promise<{ taskSourceSetSha256: string; sourceAuthoritySha256: string; sources: CurrentEffectiveSourceAuthority[] }> {
  if (draft.orchestrationVersion !== "UNIFIED_V1") {
    throw new HttpCommandError(422, "UNIFIED_TASK_ORCHESTRATION_REQUIRED", "Current effective Context authority requires a UNIFIED_V1 Task.");
  }
  if (!draft.workspaces.length) {
    throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "The Task has no governed Workspace source set.");
  }

  const taskWorkspaceIds = [...draft.workspaces].map(w => w.id);
  const orderedWorkspaceIds = Array.from(new Set([...taskWorkspaceIds, ...additionalWorkspaceRegistrationIds])).sort();
  const locked = await client.query<LockedWorkspaceAuthorityRow>(
    `select id,revision,fingerprint,verification_status
       from intentchord.workspaces
      where id=any($1::uuid[])
      order by id
      for update`,
    [orderedWorkspaceIds],
  );
  if (locked.rows.filter((row: LockedWorkspaceAuthorityRow) => taskWorkspaceIds.includes(row.id)).length !== taskWorkspaceIds.length) {
    throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "One or more Task Workspace registrations no longer exist.");
  }
  const lockedById = new Map<string, LockedWorkspaceAuthorityRow>(locked.rows.map((row: LockedWorkspaceAuthorityRow) => [row.id, row]));
  const sources: CurrentEffectiveSourceAuthority[] = [];

  for (const workspace of [...draft.workspaces].sort((a, b) => a.ordering - b.ordering || a.id.localeCompare(b.id))) {
    const registration = lockedById.get(workspace.id);
    if (!registration || registration.verification_status !== "VERIFIED") {
      throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "Current Workspace Registration authority is not VERIFIED.", { workspaceRegistrationId: workspace.id });
    }

    const head = await client.query<ObservationAuthorityHeadRow>(
      `select h.id as observation_id,h.authority_sequence,h.observation_result,h.workspace_revision_id,
              h.canonical_index_artifact_id,h.accepted_workspace_evidence_artifact_id,h.index_configuration_sha256,
              s.id as snapshot_id,s.status as snapshot_status,s.index_attempt_status as snapshot_attempt_status,
              s.workspace_registration_revision as snapshot_registration_revision,s.workspace_registration_fingerprint as snapshot_registration_fingerprint,
              s.workspace_revision_id as snapshot_workspace_revision_id,s.canonical_index_artifact_id as snapshot_artifact_id,s.canonical_sha256 as snapshot_canonical_sha256,
              s.accepted_workspace_evidence_artifact_id as snapshot_evidence_artifact_id,
              s.source_continuity_attestation_id as snapshot_source_continuity_attestation_id,
              null as artifact_id,null as artifact_semantic_sha256,null as artifact_semantic_json,
              wea.id as evidence_artifact_id,wea.artifact_semantic_sha256 as evidence_artifact_semantic_sha256
         from lateral (
           select o.id,o.authority_sequence,o.observation_result,o.workspace_revision_id,
                  o.canonical_index_artifact_id,o.accepted_workspace_evidence_artifact_id,
                  o.index_configuration_sha256,o.snapshot_operation_id
             from intentchord.workspace_observations o
            where o.workspace_registration_id=$1
            order by o.authority_sequence desc
            limit 1
         ) h
         left join intentchord.workspace_index_snapshots s
           on s.id=h.snapshot_operation_id
          and s.workspace_registration_id=$1
          and s.workspace_observation_id=h.id
          and s.workspace_revision_id=h.workspace_revision_id
          and s.index_configuration_sha256=h.index_configuration_sha256
          and s.observation_result=h.observation_result
         left join intentchord.workspace_evidence_artifacts wea
           on wea.id=h.accepted_workspace_evidence_artifact_id
          and wea.workspace_registration_id=$1
          and wea.workspace_revision_id=h.workspace_revision_id
          and wea.index_configuration_sha256=h.index_configuration_sha256`,
      [workspace.id],
    );
    if (!head.rowCount) {
      throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "No current Workspace Observation authority head exists.", { workspaceRegistrationId: workspace.id });
    }
    const row = head.rows[0];
    const isV2Authority =
      row.accepted_workspace_evidence_artifact_id != null &&
      row.canonical_index_artifact_id == null;

    const baseQualified =
      row.observation_id &&
      row.snapshot_id &&
      row.snapshot_status === "READY" &&
      row.snapshot_attempt_status === "SUCCEEDED" &&
      Number(row.snapshot_registration_revision) === Number(registration.revision) &&
      row.snapshot_registration_fingerprint === registration.fingerprint &&
      row.snapshot_workspace_revision_id === row.workspace_revision_id;

    // Pre-launch V2-only policy: V1 CIA authority is obsolete and rejected.
    const v2Qualified =
      isV2Authority &&
      row.snapshot_source_continuity_attestation_id &&
      row.snapshot_evidence_artifact_id === row.accepted_workspace_evidence_artifact_id &&
      row.evidence_artifact_semantic_sha256;

    const qualified = baseQualified && v2Qualified;
    if (!qualified) {
      throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "The actual current Workspace Observation authority head is failed, incomplete, or lacks qualified READY Canonical Index authority.", {
        workspaceRegistrationId: workspace.id,
        observationId: row.observation_id,
        observationResult: row.observation_result,
        authoritySequence: row.authority_sequence === null ? null : Number(row.authority_sequence),
      });
    }

    sources.push({
      workspaceRegistrationId: workspace.id,
      ordering: workspace.ordering,
      workspaceRegistrationRevision: Number(registration.revision),
      workspaceRegistrationFingerprint: registration.fingerprint,
      workspaceRevisionId: row.workspace_revision_id!,
      workspaceIndexSnapshotId: row.snapshot_id!,
      canonicalIndexArtifactId: row.accepted_workspace_evidence_artifact_id!,
      workspaceIndexSha256: row.evidence_artifact_semantic_sha256!,
      artifactSemanticSha256: row.evidence_artifact_semantic_sha256!,
      artifactSemanticState: { workspace_instance_id: workspace.id, workspace_revision_id: row.workspace_revision_id, evidence_artifact_id: row.accepted_workspace_evidence_artifact_id },
      observationId: row.observation_id!,
      authoritySequence: Number(row.authority_sequence),
    });
  }

  const taskSourceSetSha256 = taskSourceSetSha256FromDraft(draft);
  const sourceAuthoritySha256 = mapperSha256({
    schema: "intentchord.current-workspace-observation-authority.v1",
    sources: sources.map(source => ({
      workspaceRegistrationId: source.workspaceRegistrationId,
      workspaceRegistrationRevision: source.workspaceRegistrationRevision,
      workspaceRegistrationFingerprint: source.workspaceRegistrationFingerprint,
      observationId: source.observationId,
      authoritySequence: source.authoritySequence,
      workspaceRevisionId: source.workspaceRevisionId,
      workspaceIndexSnapshotId: source.workspaceIndexSnapshotId,
      canonicalIndexArtifactId: source.canonicalIndexArtifactId,
      workspaceIndexSha256: source.workspaceIndexSha256,
      artifactSemanticSha256: source.artifactSemanticSha256,
    })),
  });
  return { taskSourceSetSha256, sourceAuthoritySha256, sources };
}

async function readLockedTaskDraft(client: PoolClient, taskId: string): Promise<{ revision: number; draftRevisionId: string; draftRevision: number; draft: TaskDraftInput }> {
  const task = await client.query<{ revision: string | number }>(
    "select revision from intentchord.tasks where id=$1 for update",
    [taskId],
  );
  if (!task.rowCount) throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
  const draft = await client.query<{ id: string; revision: string | number; draft_projection: unknown }>(
    `select id,revision,draft_projection
       from intentchord.task_draft_revisions
      where task_id=$1
      order by revision desc
      limit 1`,
    [taskId],
  );
  if (!draft.rowCount) throw new HttpCommandError(500, "DRAFT_REVISION_MISSING", "The Task has no authoritative Draft revision.");
  return {
    revision: Number(task.rows[0].revision),
    draftRevisionId: draft.rows[0].id,
    draftRevision: Number(draft.rows[0].revision),
    draft: asDraft(draft.rows[0].draft_projection),
  };
}

function frozenSourceMaterial(rows: Array<{
  workspace_registration_id: string;
  ordering: string | number;
  workspace_registration_revision: string | number;
  workspace_registration_fingerprint: string;
  workspace_revision_id: string;
  workspace_observation_id: string;
  workspace_observation_authority_sequence: string | number;
  workspace_index_snapshot_id: string;
  canonical_index_artifact_id: string;
  workspace_index_sha256: string;
  artifact_semantic_sha256: string;
}>) {
  return rows.map(row => ({
    workspaceRegistrationId: row.workspace_registration_id,
    ordering: Number(row.ordering),
    workspaceRegistrationRevision: Number(row.workspace_registration_revision),
    workspaceRegistrationFingerprint: row.workspace_registration_fingerprint,
    workspaceRevisionId: row.workspace_revision_id,
    observationId: row.workspace_observation_id,
    authoritySequence: Number(row.workspace_observation_authority_sequence),
    workspaceIndexSnapshotId: row.workspace_index_snapshot_id,
    canonicalIndexArtifactId: row.canonical_index_artifact_id,
    workspaceIndexSha256: row.workspace_index_sha256,
    artifactSemanticSha256: row.artifact_semantic_sha256,
  }));
}

/** Canonical transactional CURRENT EFFECTIVE CONTEXT AUTHORITY evaluator. */
export async function evaluateCurrentEffectiveContextAuthority(
  client: PoolClient,
  taskId: string,
  expectedContextAssemblyRevisionId: string,
  additionalWorkspaceRegistrationIds: string[] = [],
): Promise<CurrentEffectiveContextAuthorityEvaluation> {
  const task = await readLockedTaskDraft(client, taskId);
  let head: CurrentContextHead;
  try {
    head = await lockCurrentContextHead(client, taskId);
  } catch (error) {
    if (error instanceof HttpCommandError) return { status: "UNPROVEN", details: [{ reason: error.code, details: error.details ?? null }] };
    throw error;
  }
  const frozen = await client.query<{
    workspace_registration_id: string; ordering: string | number; workspace_registration_revision: string | number;
    workspace_registration_fingerprint: string; workspace_revision_id: string; workspace_observation_id: string; workspace_observation_authority_sequence: string | number; workspace_index_snapshot_id: string;
    canonical_index_artifact_id: string; workspace_index_sha256: string; artifact_semantic_sha256: string;
  }>(`select workspace_registration_id,ordering,workspace_registration_revision,workspace_registration_fingerprint,workspace_revision_id,
            workspace_observation_id,workspace_observation_authority_sequence,workspace_index_snapshot_id,
            accepted_workspace_evidence_artifact_id as canonical_index_artifact_id,
            workspace_index_sha256,artifact_semantic_sha256
       from intentchord.context_assembly_sources where context_assembly_revision_id=$1 order by ordering`,[expectedContextAssemblyRevisionId]);
  if (!frozen.rowCount) return { status: "UNPROVEN", head, details: [{ reason: "CONTEXT_ASSEMBLY_SOURCE_BINDINGS_MISSING" }] };

  let current: Awaited<ReturnType<typeof captureLockedTaskSourceAuthority>>;
  try { current = await captureLockedTaskSourceAuthority(client, task.draft, additionalWorkspaceRegistrationIds); }
  catch (error) {
    if (error instanceof HttpCommandError && error.code === "CURRENT_SOURCE_AUTHORITY_UNPROVEN") {
      return { status: "UNPROVEN", head, details: [{ reason: error.code, details: error.details ?? null }] };
    }
    throw error;
  }
  const frozenMaterial = frozenSourceMaterial(frozen.rows);
  const frozenTaskSourceSetSha256 = taskSourceSetSha256FromFrozen(frozen.rows);
  const consumption = await client.query<{ id: string }>(`select id from intentchord.context_forward_authority_consumptions
      where task_id=$1 and context_assembly_revision_id=$2 order by created_at,id limit 1`,[taskId,expectedContextAssemblyRevisionId]);
  const frozenById = new Map(frozenMaterial.map(item => [item.workspaceRegistrationId,item]));
  const classification = classifyCurrentEffectiveContextAuthority({
    assemblyIsHead: head.contextAssemblyRevisionId === expectedContextAssemblyRevisionId,
    taskSourceSetMatchesAssembly: frozenTaskSourceSetSha256 === current.taskSourceSetSha256,
    forwardAuthorityConsumed: Boolean(consumption.rowCount),
    sources: current.sources.map(source => ({
      workspaceRegistrationId: source.workspaceRegistrationId, registrationProven: true, observationHeadPresent: true, observationHeadQualifiedReady: true,
      frozenAuthorityMatchesCurrentHead: canonicalJson(frozenById.get(source.workspaceRegistrationId) ?? null) === canonicalJson({
        workspaceRegistrationId: source.workspaceRegistrationId, ordering: source.ordering, workspaceRegistrationRevision: source.workspaceRegistrationRevision,
        workspaceRegistrationFingerprint: source.workspaceRegistrationFingerprint, workspaceRevisionId: source.workspaceRevisionId,
        observationId: source.observationId, authoritySequence: source.authoritySequence,
        workspaceIndexSnapshotId: source.workspaceIndexSnapshotId, canonicalIndexArtifactId: source.canonicalIndexArtifactId,
        workspaceIndexSha256: source.workspaceIndexSha256, artifactSemanticSha256: source.artifactSemanticSha256,
      }),
    })),
  });
  if (classification !== "CURRENT") return { status: classification, head, details: [{ reason: classification === "DRIFT" ? "CURRENT_EFFECTIVE_CONTEXT_AUTHORITY_CHANGED" : "CURRENT_SOURCE_AUTHORITY_UNPROVEN", currentTaskSourceSetSha256: current.taskSourceSetSha256, frozenTaskSourceSetSha256, currentSourceAuthoritySha256: current.sourceAuthoritySha256, forwardAuthorityConsumed: Boolean(consumption.rowCount) }] };
  return { status: "CURRENT", head, taskRevision: task.revision, taskSourceSetSha256: current.taskSourceSetSha256, sourceAuthoritySha256: current.sourceAuthoritySha256, sources: current.sources };
}

/** Single reusable CURRENT EFFECTIVE CONTEXT AUTHORITY command gate. */
export async function assertCurrentEffectiveContextAuthority(
  client: PoolClient, taskId: string, expectedContextAssemblyRevisionId: string, errorCode = "STALE_CONTEXT_HEAD", additionalWorkspaceRegistrationIds: string[] = [],
): Promise<CurrentEffectiveContextAuthorityProof> {
  const evaluation = await evaluateCurrentEffectiveContextAuthority(client, taskId, expectedContextAssemblyRevisionId, additionalWorkspaceRegistrationIds);
  if (evaluation.status === "CURRENT") return evaluation;
  if (evaluation.status === "UNPROVEN") throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "Current source authority cannot be proven for new forward authority.", evaluation.details);
  const driftCode = errorCode === "STALE_CONTEXT_HEAD" ? "SOURCE_DRIFT_REBASE_REQUIRED" : errorCode;
  throw new HttpCommandError(409, driftCode, "The frozen Context Assembly differs from current effective Context authority.", evaluation.details);
}

export async function assertFrozenContextSourceAuthorityCurrent(client: PoolClient, contextAssemblyRevisionId: string): Promise<void> {
  const revision = await client.query<{ task_id: string }>(
    `select a.task_id from intentchord.context_assembly_revisions r join intentchord.context_assemblies a on a.id=r.context_assembly_id where r.id=$1`,
    [contextAssemblyRevisionId],
  );
  if (!revision.rowCount) throw new HttpCommandError(409, "CURRENT_SOURCE_AUTHORITY_UNPROVEN", "Frozen Context Assembly authority cannot be resolved.");
  await assertCurrentEffectiveContextAuthority(client, revision.rows[0].task_id, contextAssemblyRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED");
}

export async function assertFrozenContextForwardAuthorityCurrent(client: PoolClient, taskId: string, contextAssemblyRevisionId: string): Promise<CurrentContextHead> {
  return (await assertCurrentEffectiveContextAuthority(client, taskId, contextAssemblyRevisionId, "SOURCE_DRIFT_REBASE_REQUIRED")).head;
}

export async function readFrozenContextForwardAuthorityStatus(taskId: string, contextAssemblyRevisionId: string): Promise<{ head: CurrentContextHead | undefined; source: FrozenContextSourceAuthorityStatus; isHead: boolean }> {
  const head = await readCurrentContextHead(taskId);
  const evaluation = await transaction(client => evaluateCurrentEffectiveContextAuthority(client, taskId, contextAssemblyRevisionId));
  if (evaluation.status === "CURRENT") {
    return { head: evaluation.head, source: { status: "CURRENT", taskSourceSetSha256: evaluation.taskSourceSetSha256, sourceAuthoritySha256: evaluation.sourceAuthoritySha256 }, isHead: evaluation.head.contextAssemblyRevisionId === contextAssemblyRevisionId };
  }
  return { head: evaluation.head ?? head, source: { status: evaluation.status, details: evaluation.details }, isHead: (evaluation.head ?? head)?.contextAssemblyRevisionId === contextAssemblyRevisionId };
}
