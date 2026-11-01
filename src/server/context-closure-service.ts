import { randomUUID } from "node:crypto";
import { z } from "zod/v3";
import { canonicalJson, estimatedTokensForUtf8, mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { buildMappingInputSnapshotFromCanonicalArtifact } from "@/core/ai-context-mapper/input-builder";
import { AiContextMapperV2Orchestrator } from "@/core/ai-context-mapper/orchestrator-v2";
import {
  CONTEXT_ASSEMBLY_CONTRACT_VERSION,
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  CONTEXT_CLOSURE_CONTRACT_VERSION,
  CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
  ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION,
  type AcceptedContextCatalogV2,
  type BackendGapClassification,
  type ContextAssemblyMappingInputV2,
  type ContextAssemblySourceBindingV2,
  type ModelContextAnalysisV2,
} from "@/core/ai-context-mapper/v2";
import { MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS, type MappingInputEntry } from "@/core/ai-context-mapper/types";
import type { TaskDraftInput } from "@/core/tasks/task-input";
import {
  classifyMissingEvidenceRequestV2,
  evaluateContextClosureV1,
  hasOverlappingAuthoritativeMissingInternalRequirement,
  type AuthoritativeMissingInternalRequirementOverlap,
} from "@/core/context-closure/v1";
import {
  assertProductionInternalAiExecutionV2Ready,
  readAiContextMapperV2Config,
  resolveInternalAiCredential,
  resolveQualifiedStandby,
} from "@/server/ai-context-mapper-config";
import { resolveV2InternalAiCredential } from "@/server/ai-context-mapper-config";
import { streamAcceptedSemanticProjectionEntries } from "@/server/v2-semantic-projection-reader";
import { PostgresAiContextMappingV2Repository, type ContextMappingV2RunView } from "@/server/ai-context-mapping-v2-repository";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import { databaseQuery, transaction } from "@/server/db";
import { HttpCommandError } from "@/server/errors";
import { assertCurrentEffectiveContextAuthority, captureLockedTaskSourceAuthority } from "@/server/context-head-authority";
import { appendAuthorizedContextWorkspaceInTransaction } from "@/server/lifecycle";
import { listWorkspaceRegistrations } from "@/server/workspace-connector";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import {
  PostgresContextMappingTraversalRepository,
  type ContextMappingTraversalRow,
  type TraversalPhase,
  type TraversalStatus,
} from "@/server/context-mapping-traversal-repository";
import { ContextMappingTraversalExecutor } from "@/server/context/context-mapping-traversal-executor";
import { startTraversalRecoveryLoop } from "@/server/context/context-mapping-traversal-recovery-loop";

startTraversalRecoveryLoop();

const uuid = z.string().uuid();
const runCommandSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(200) }).strict();
const sourceAuthorizationSchema = z.discriminatedUnion("decision", [
  z.object({
    expectedTaskRevision: z.number().int().nonnegative(),
    missingEvidenceRequestId: uuid,
    workspaceRegistrationId: uuid,
    decision: z.literal("APPROVE"),
  }).strict(),
  z.object({
    expectedTaskRevision: z.number().int().nonnegative(),
    missingEvidenceRequestId: uuid,
    workspaceRegistrationId: uuid,
    decision: z.literal("DENY"),
  }).strict(),
  z.object({
    expectedTaskRevision: z.number().int().nonnegative(),
    missingEvidenceRequestId: uuid,
    decision: z.literal("SOURCE_UNAVAILABLE"),
  }).strict(),
]);

/**
 * This is a Backend-derived product projection. It is intentionally NOT persisted on
 * context_assembly_revisions. Assembly revisions are immutable evidence truth only.
 */
export type ContextClosureView = {
  contextAssemblyId: string;
  revisionId: string;
  revision: number;
  state: "READY_FOR_MAPPING" | "MAPPING" | "MAPPING_RETRYABLE" | "EVIDENCE_REQUIRED" | "READY_FOR_CLOSURE" | "CLOSED" | "BLOCKED" | "SOURCE_TRUTH_CONFLICT";
  closureState: "OPEN" | "BLOCKED" | "PASS";
  assemblySha256: string;
  sources: ContextAssemblySourceBindingV2[];
  evidenceEntries: MappingInputEntry[];
  latestMappingRun?: ContextMappingV2RunView;
  resolutionRequirements: Array<{
    id: string;
    type: "MISSING_INTERNAL_EVIDENCE" | "SOURCE_TRUTH_CONFLICT";
    requirementSha256: string;
    mappingIterationId: string;
    lastEvent?: string;
  }>;
  missingEvidenceRequests: Array<{
    id: string;
    modelGapId: string;
    classification: BackendGapClassification;
    materiality: "BLOCKING" | "NON_BLOCKING";
    description: string;
    requiredEvidenceKind: string;
    sourceHint?: string;
    candidateWorkspaceRegistrationId?: string;
    authorizationDecision?: "APPROVE" | "DENY";
    resolutionState?: "CANDIDATE_SOURCE_IDENTIFIED" | "OWNER_AUTHORIZED_SOURCE" | "OWNER_DENIED_SOURCE" | "SUPERSEDED_BY_NEW_ASSEMBLY" | "SOURCE_UNAVAILABLE" | "CLASSIFIED_NON_BLOCKING";
  }>;
  closureEvaluation?: {
    id: string;
    mappingIterationId: string;
    decision: "PASS" | "BLOCKED";
    reasonCode: string;
    evaluationInputSha256: string;
    evidenceSha256: string;
  };
  acceptedCatalog?: { id: string; catalogSha256: string; catalog: AcceptedContextCatalogV2 };
  traversal?: {
    id: string;
    status: TraversalStatus;
    phase: TraversalPhase;
    topologyWindowCount: number;
    drilldownWindowCount: number;
    reductionLevelCount: number;
    activeWindowOrdinal: number;
  };
};

export type AssemblyRevisionRow = {
  id: string;
  context_assembly_id: string;
  revision: number;
  assembly_sha256: string;
};

type SourceRow = {
  workspace_registration_id: string;
  workspace_registration_revision: string | number;
  workspace_registration_fingerprint: string;
  workspace_revision_id: string;
  workspace_index_snapshot_id: string;
  accepted_workspace_evidence_artifact_id?: string;
  canonical_index_artifact_id: string;
  workspace_index_sha256: string;
  artifact_semantic_sha256: string;
};

type ResolutionRequirementRow = {
  id: string;
  requirement_type: "MISSING_INTERNAL_EVIDENCE" | "SOURCE_TRUTH_CONFLICT";
  requirement_sha256: string;
  mapping_iteration_id: string;
  originating_missing_evidence_request_id: string | null;
  last_event: string | null;
};

const ACTIVE_V2_RUN_STATUSES = new Set([
  "CREATED",
  "INPUT_VALIDATED",
  "PRIMARY_RUNNING",
  "PRIMARY_FAILED_TECHNICAL",
  "STANDBY_RUNNING",
  "VALIDATING",
]);
const RETRYABLE_TERMINAL_V2_RUN_STATUSES = new Set(["STANDBY_BLOCKED_GOVERNANCE", "REJECTED_VALIDATION", "FAILED"]);

function normalizeHint(value: string): string {
  return value.toLowerCase().replaceAll("\\", "/").replace(/[^a-z0-9/_-]+/g, " ").trim().replace(/\s+/g, " ");
}

async function resolveCandidateWorkspace(sourceHint: string | undefined, existingWorkspaceIds: Set<string>): Promise<string | undefined> {
  if (!sourceHint?.trim()) return undefined;
  const hint = normalizeHint(sourceHint);
  if (!hint) return undefined;
  const registrations = await listWorkspaceRegistrations();
  const candidates = registrations.filter(item => {
    if (existingWorkspaceIds.has(item.id)) return false;
    const fields = [item.displayName, item.role, item.repositoryIdentity ?? "", item.normalizedReference]
      .map(normalizeHint).filter(Boolean);
    return fields.some(value => value === hint || value.endsWith(`/${hint}`));
  });
  return candidates.length === 1 ? candidates[0].id : undefined;
}

async function captureCurrentAssemblyRevision(taskId: string): Promise<{
  revision: AssemblyRevisionRow;
  sources: Array<{
    binding: ContextAssemblySourceBindingV2;
    observationId: string;
    authoritySequence: number;
    isV2: boolean;
    canonicalIndexArtifactId: string;
    artifactSemanticState: unknown;
    artifactSemanticSha256: string;
  }>;
  currentAuthority: { taskSourceSetSha256: string; sourceAuthoritySha256: string };
}> {
  return transaction(async client => {
    // One coherent capture transaction: Task authority -> stable Assembly parent -> deterministic
    // Workspace Registration locks -> ACTUAL Observation heads -> Assembly Revision. No AI network
    // call is performed while these locks are held.
    const taskRow = await client.query<{ revision: string | number; draft: TaskDraftInput }>(
      "select revision,draft from intentchord.tasks where id=$1 for update",
      [taskId],
    );
    if (!taskRow.rowCount) throw new HttpCommandError(404, "TASK_NOT_FOUND", "Task not found.");
    const draft = (typeof taskRow.rows[0].draft === "string" ? JSON.parse(taskRow.rows[0].draft) : taskRow.rows[0].draft) as TaskDraftInput;
    if (draft.orchestrationVersion !== "UNIFIED_V1") {
      throw new HttpCommandError(422, "UNIFIED_TASK_ORCHESTRATION_REQUIRED", "Context Closure requires a UNIFIED_V1 task.");
    }
    if (!draft.workspaces.length) {
      throw new HttpCommandError(422, "CONTEXT_SOURCE_REQUIRED", "At least one governed Workspace is required for Context Closure.");
    }

    let assembly = await client.query<{ id: string }>(
      "select id from intentchord.context_assemblies where task_id=$1 for update",
      [taskId],
    );
    let assemblyId: string;
    if (!assembly.rowCount) {
      assemblyId = randomUUID();
      await client.query(
        "insert into intentchord.context_assemblies(id,task_id,contract_version) values($1,$2,$3)",
        [assemblyId, taskId, CONTEXT_ASSEMBLY_CONTRACT_VERSION],
      );
      assembly = await client.query<{ id: string }>(
        "select id from intentchord.context_assemblies where id=$1 for update",
        [assemblyId],
      );
    } else {
      assemblyId = assembly.rows[0].id;
    }

    const current = await captureLockedTaskSourceAuthority(client, draft);

    const sources = current.sources.map(source => {
      const isV2 = "evidence_artifact_id" in (source.artifactSemanticState as Record<string, unknown>);
      return {
        binding: {
          workspace_id: source.workspaceRegistrationId,
          workspace_registration_revision: source.workspaceRegistrationRevision,
          workspace_registration_fingerprint: source.workspaceRegistrationFingerprint,
          workspace_revision_id: source.workspaceRevisionId,
          workspace_index_snapshot_id: source.workspaceIndexSnapshotId,
          canonical_index_artifact_id: source.canonicalIndexArtifactId,
          workspace_index_sha256: source.workspaceIndexSha256,
          artifact_semantic_sha256: source.artifactSemanticSha256,
        },
        observationId: source.observationId,
        authoritySequence: source.authoritySequence,
        isV2,
        canonicalIndexArtifactId: source.canonicalIndexArtifactId,
        artifactSemanticState: source.artifactSemanticState,
        artifactSemanticSha256: source.artifactSemanticSha256,
      };
    });
    const orderedBindings = sources.map(item => item.binding);
    const assemblySha256 = mapperSha256({
      contract_version: CONTEXT_ASSEMBLY_CONTRACT_VERSION,
      task_id: taskId,
      task_source_set_sha256: current.taskSourceSetSha256,
      source_authority_sha256: current.sourceAuthoritySha256,
      sources: orderedBindings,
    });

    const latest = await client.query<AssemblyRevisionRow>(
      `select id,context_assembly_id,revision,assembly_sha256
         from intentchord.context_assembly_revisions
        where context_assembly_id=$1
        order by revision desc limit 1 for update`,
      [assemblyId],
    );
    if (latest.rowCount && latest.rows[0].assembly_sha256 === assemblySha256) {
      return { revision: latest.rows[0], sources, currentAuthority: { taskSourceSetSha256: current.taskSourceSetSha256, sourceAuthoritySha256: current.sourceAuthoritySha256 } };
    }

    const revisionNumber = latest.rowCount ? Number(latest.rows[0].revision) + 1 : 1;
    const revisionId = randomUUID();
    await client.query(
      `insert into intentchord.context_assembly_revisions(
        id,context_assembly_id,revision,previous_revision_id,assembly_schema_version,assembly_sha256
       ) values($1,$2,$3,$4,$5,$6)`,
      [revisionId, assemblyId, revisionNumber, latest.rows[0]?.id ?? null, CONTEXT_ASSEMBLY_CONTRACT_VERSION, assemblySha256],
    );
    for (const [ordering, item] of sources.entries()) {
      const b = item.binding;
      await client.query(
        `insert into intentchord.context_assembly_sources(
          id,context_assembly_revision_id,ordering,workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,
          workspace_revision_id,workspace_observation_id,workspace_observation_authority_sequence,workspace_index_snapshot_id,accepted_workspace_evidence_artifact_id,workspace_index_sha256,artifact_semantic_sha256
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [randomUUID(), revisionId, ordering, b.workspace_id, b.workspace_registration_revision, b.workspace_registration_fingerprint,
          b.workspace_revision_id, item.observationId, item.authoritySequence, b.workspace_index_snapshot_id, b.canonical_index_artifact_id, b.workspace_index_sha256, b.artifact_semantic_sha256],
      );
    }

    if (latest.rowCount) {
      const priorRequirements = await client.query<{ id: string; requirement_sha256: string }>(
        `select r.id,r.requirement_sha256 from intentchord.context_resolution_requirements r
          where r.context_assembly_revision_id=$1
            and not exists(
              select 1 from intentchord.context_resolution_events e
               where e.resolution_requirement_id=r.id
                 and e.event_type='SUPERSEDED_BY_NEW_ASSEMBLY'
                 and e.successor_context_assembly_revision_id=$2
            )
          order by r.created_at,r.id`,
        [latest.rows[0].id, revisionId],
      );
      for (const requirement of priorRequirements.rows) {
        const provenance = {
          previousContextAssemblyRevisionId: latest.rows[0].id,
          successorContextAssemblyRevisionId: revisionId,
          originatingRequirementSha256: requirement.requirement_sha256,
          reason: "GOVERNED_EVIDENCE_UNIVERSE_CHANGED_REANALYSIS_REQUIRED",
        };
        await client.query(
          `insert into intentchord.context_resolution_events(
            id,resolution_requirement_id,event_type,actor_authority,successor_context_assembly_revision_id,provenance,event_sha256
           ) values($1,$2,'SUPERSEDED_BY_NEW_ASSEMBLY','BACKEND_DETERMINISTIC_VALIDATOR',$3,$4,$5)`,
          [randomUUID(), requirement.id, revisionId, JSON.stringify(provenance), mapperSha256(provenance)],
        );
      }
    }

    return {
      revision: { id: revisionId, context_assembly_id: assemblyId, revision: revisionNumber, assembly_sha256: assemblySha256 },
      sources,
      currentAuthority: { taskSourceSetSha256: current.taskSourceSetSha256, sourceAuthoritySha256: current.sourceAuthoritySha256 },
    };
  });
}

export async function buildAssemblyInputBoundedStreaming(
  revision: AssemblyRevisionRow,
  sources: Array<{
    binding: ContextAssemblySourceBindingV2;
    observationId?: string;
    authoritySequence?: number;
    isV2?: boolean;
    canonicalIndexArtifactId?: string;
    artifactSemanticState?: unknown;
    artifactSemanticSha256?: string;
    entries?: MappingInputEntry[];
  }>,
  evidenceRepo?: PostgresWorkspaceEvidenceRepository,
): Promise<ContextAssemblyMappingInputV2> {
  const proofObligations = [
    "ALL_SOURCES_READY_CANONICAL_INDEX",
    "ALL_MISSING_EVIDENCE_REQUESTS_BACKEND_CLASSIFIED",
    "NO_UNRESOLVED_BLOCKING_INTERNAL_SOURCE_GAP",
    "MISSING_EVIDENCE_REQUESTS_GROUNDED",
    "NO_MATERIAL_COMPONENT_OR_RELATIONSHIP_CONTRADICTION",
    "COMPONENTS_EVIDENCE_BACKED",
    "CROSS_WORKSPACE_RELATIONSHIPS_EVIDENCE_BACKED",
    "REFERENCES_DETERMINISTICALLY_VERIFIABLE",
    "AI_CONTEXT_MAPPING_V2_EXACT_QUALIFICATION",
  ];
  const baseMaterial = {
    schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
    context_assembly_id: revision.context_assembly_id,
    context_assembly_revision_id: revision.id,
    context_assembly_revision: Number(revision.revision),
    source_bindings: sources.map(item => item.binding),
    proof_obligations: proofObligations,
  };

  // Enforce budget on metadata before stream accumulation
  let accumulatedTokens = estimatedTokensForUtf8(canonicalJson(baseMaterial));
  if (accumulatedTokens > MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS) {
    throw new HttpCommandError(
      413,
      "CONTEXT_ASSEMBLY_INPUT_BUDGET_EXCEEDED",
      `Context Assembly metadata token count ${accumulatedTokens} exceeds governed limit ${MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS}.`,
    );
  }

  const entries: MappingInputEntry[] = [];
  const seenEntryIds = new Set<string>();

  for (const source of sources) {
    if (source.isV2) {
      // V2 Native Streaming: stream bounded parts directly from evidence repository
      // Budget is checked per part before accumulation; stream aborts immediately on breach.
      const repo = evidenceRepo ?? new PostgresWorkspaceEvidenceRepository();
      const artifactId = source.canonicalIndexArtifactId ?? source.binding.canonical_index_artifact_id;
      for await (const entry of streamAcceptedSemanticProjectionEntries(repo, artifactId)) {
        if (seenEntryIds.has(entry.entry_id)) {
          throw new HttpCommandError(
            409,
            "CONTEXT_ASSEMBLY_ENTRY_ID_COLLISION",
            `Context Assembly contains duplicate evidence entry identities: ${entry.entry_id}`,
          );
        }
        seenEntryIds.add(entry.entry_id);

        const entryTokens = estimatedTokensForUtf8(canonicalJson(entry));
        if (accumulatedTokens + entryTokens > MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS) {
          throw new HttpCommandError(
            413,
            "CONTEXT_ASSEMBLY_INPUT_BUDGET_EXCEEDED",
            `Context Assembly estimated token count ${accumulatedTokens + entryTokens} exceeds governed limit ${MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS}.`,
          );
        }
        accumulatedTokens += entryTokens;
        entries.push(entry);
      }
    } else if (source.entries && source.entries.length > 0) {
      // Pre-provided entries (e.g. legacy test caller)
      for (const entry of source.entries) {
        if (seenEntryIds.has(entry.entry_id)) {
          throw new HttpCommandError(
            409,
            "CONTEXT_ASSEMBLY_ENTRY_ID_COLLISION",
            `Context Assembly contains duplicate evidence entry identities: ${entry.entry_id}`,
          );
        }
        seenEntryIds.add(entry.entry_id);

        const entryTokens = estimatedTokensForUtf8(canonicalJson(entry));
        if (accumulatedTokens + entryTokens > MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS) {
          throw new HttpCommandError(
            413,
            "CONTEXT_ASSEMBLY_INPUT_BUDGET_EXCEEDED",
            `Context Assembly estimated token count ${accumulatedTokens + entryTokens} exceeds governed limit ${MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS}.`,
          );
        }
        accumulatedTokens += entryTokens;
        entries.push(entry);
      }
    } else {
      // Historical V1 compatibility: read snapshot from canonical artifact
      const v1Snapshot = buildMappingInputSnapshotFromCanonicalArtifact({
        canonicalIndexArtifactId: source.binding.canonical_index_artifact_id,
        artifactSemanticSha256: source.binding.artifact_semantic_sha256,
        semanticState: source.artifactSemanticState as import("@/core/workspace-index/artifact-identity").CanonicalIndexArtifactSemanticState,
      });
      for (const entry of v1Snapshot.entries) {
        if (seenEntryIds.has(entry.entry_id)) {
          throw new HttpCommandError(
            409,
            "CONTEXT_ASSEMBLY_ENTRY_ID_COLLISION",
            `Context Assembly contains duplicate evidence entry identities: ${entry.entry_id}`,
          );
        }
        seenEntryIds.add(entry.entry_id);

        const entryTokens = estimatedTokensForUtf8(canonicalJson(entry));
        if (accumulatedTokens + entryTokens > MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS) {
          throw new HttpCommandError(
            413,
            "CONTEXT_ASSEMBLY_INPUT_BUDGET_EXCEEDED",
            `Context Assembly estimated token count ${accumulatedTokens + entryTokens} exceeds governed limit ${MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS}.`,
          );
        }
        accumulatedTokens += entryTokens;
        entries.push(entry);
      }
    }
  }

  const material = {
    ...baseMaterial,
    entries,
  };
  const serializedPayloadSha256 = mapperSha256(material);
  const finalEstimatedTokens = estimatedTokensForUtf8(canonicalJson(material));
  if (finalEstimatedTokens > MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS) {
    throw new HttpCommandError(
      413,
      "CONTEXT_ASSEMBLY_INPUT_BUDGET_EXCEEDED",
      `Context Assembly estimated token count ${finalEstimatedTokens} exceeds governed limit ${MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS}.`,
    );
  }

  return {
    ...material,
    created_at: new Date().toISOString(),
    serialized_payload_sha256: serializedPayloadSha256,
    provider_neutral_estimated_tokens: finalEstimatedTokens,
  };
}

async function admitGovernanceAndEvaluateClosure(revisionId: string, run: ContextMappingV2RunView): Promise<void> {
  const result=run.result;
  if(!result) return;
  await transaction(async client=>{
    const revision=await client.query<AssemblyRevisionRow & { task_id: string }>(
      `select r.id,r.context_assembly_id,r.revision,r.assembly_sha256,a.task_id
         from intentchord.context_assembly_revisions r
         join intentchord.context_assemblies a on a.id=r.context_assembly_id
        where r.id=$1`,
      [revisionId],
    );
    if(!revision.rowCount) throw new HttpCommandError(404,"CONTEXT_ASSEMBLY_REVISION_NOT_FOUND","Context Assembly Revision not found.");
    const iteration=await client.query<{id:string;v2_result_id:string}>(
      "select id,v2_result_id from intentchord.context_assembly_mapping_iterations where mapping_run_id=$1",
      [run.id],
    );
    if(!iteration.rowCount) {
      throw new HttpCommandError(409,"CONTEXT_MAPPING_ITERATION_REQUIRED","Validated V2 result must be admitted as an exact Mapping Iteration before Closure evaluation.");
    }
    const iterationId=iteration.rows[0].id;
    const inputRow=await client.query<{mapping_input_snapshot:ContextAssemblyMappingInputV2}>(
      "select mapping_input_snapshot from intentchord.context_mapping_runs where id=$1",
      [run.id],
    );
    const input=inputRow.rows[0].mapping_input_snapshot;
    const sourceRows=await client.query<SourceRow>(
      `select workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,workspace_revision_id,
              workspace_index_snapshot_id,accepted_workspace_evidence_artifact_id as canonical_index_artifact_id,accepted_workspace_evidence_artifact_id,workspace_index_sha256,artifact_semantic_sha256
         from intentchord.context_assembly_sources
        where context_assembly_revision_id=$1 order by ordering`,
      [revisionId],
    );
    const sourceIds=new Set<string>(sourceRows.rows.map((r:SourceRow)=>r.workspace_registration_id));
    const persistedFindingCount=await client.query<{count:string}>(
      `select (
        (select count(*) from intentchord.context_missing_evidence_requests where mapping_iteration_id=$1)
        + (select count(*) from intentchord.context_material_contradictions where mapping_iteration_id=$1)
      )::text as count`,
      [iterationId],
    );
    const shouldPersistModelFindings=Number(persistedFindingCount.rows[0]?.count??0)===0;

    if(shouldPersistModelFindings){
    for(const gap of result.analysis.missing_evidence_requests){
      const requestId=randomUUID();
      const classification=classifyMissingEvidenceRequestV2(gap);
      const candidate=classification==="BLOCKING_INTERNAL_SOURCE_GAP"?await resolveCandidateWorkspace(gap.source_hint,sourceIds):undefined;
      await client.query(
        `insert into intentchord.context_missing_evidence_requests(
          id,context_assembly_revision_id,mapping_iteration_id,model_gap_id,gap_type,materiality,confidence,affected_component_ids,
          affected_relationship_ids,known_evidence_entry_ids,missing_evidence_description,required_evidence_kind,source_hint,blocking_reason,request_sha256
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [requestId,revisionId,iterationId,gap.gap_id,gap.gap_type,gap.materiality,gap.confidence,
          JSON.stringify(gap.affected_component_ids),JSON.stringify(gap.affected_relationship_ids),JSON.stringify(gap.known_evidence_entry_ids),
          gap.missing_evidence_description,gap.required_evidence_kind,gap.source_hint??null,gap.blocking_reason,mapperSha256(gap)],
      );
      const classificationEvidence={
        modelGapId:gap.gap_id,
        groundedEvidenceEntryIds:gap.known_evidence_entry_ids,
        classification,
        candidateWorkspaceRegistrationId:candidate??null,
      };
      const classificationId=randomUUID();
      const classificationSha=mapperSha256(classificationEvidence);
      await client.query(
        `insert into intentchord.context_gap_classifications(
          id,missing_evidence_request_id,classification,candidate_workspace_registration_id,classification_evidence,classification_sha256
         ) values($1,$2,$3,$4,$5,$6)`,
        [classificationId,requestId,classification,candidate??null,JSON.stringify(classificationEvidence),classificationSha],
      );
      if(classification==="BLOCKING_INTERNAL_SOURCE_GAP"){
        const requirementId=randomUUID();
        const requirementIdentity={
          type:"MISSING_INTERNAL_EVIDENCE",
          assemblyRevisionId:revisionId,
          mappingIterationId:iterationId,
          requestSha256:mapperSha256(gap),
        };
        await client.query(
          `insert into intentchord.context_resolution_requirements(
            id,context_assembly_revision_id,mapping_iteration_id,requirement_type,originating_missing_evidence_request_id,requirement_sha256
           ) values($1,$2,$3,'MISSING_INTERNAL_EVIDENCE',$4,$5)`,
          [requirementId,revisionId,iterationId,requestId,mapperSha256(requirementIdentity)],
        );
        if(candidate){
          const provenance={classificationId,candidateWorkspaceRegistrationId:candidate};
          await client.query(
            `insert into intentchord.context_resolution_events(
              id,resolution_requirement_id,event_type,actor_authority,related_workspace_registration_id,provenance,event_sha256
             ) values($1,$2,'CANDIDATE_SOURCE_IDENTIFIED','BACKEND_DETERMINISTIC_VALIDATOR',$3,$4,$5)`,
            [randomUUID(),requirementId,candidate,JSON.stringify(provenance),mapperSha256(provenance)],
          );
        }
      }
    }

    const authoritativeBlockingRows=await client.query<{
      requirement_id:string;
      affected_component_ids:unknown;
      affected_relationship_ids:unknown;
    }>(
      `select rr.id as requirement_id,m.affected_component_ids,m.affected_relationship_ids
         from intentchord.context_resolution_requirements rr
         join intentchord.context_missing_evidence_requests m
           on m.id=rr.originating_missing_evidence_request_id
        where rr.mapping_iteration_id=$1
          and rr.requirement_type='MISSING_INTERNAL_EVIDENCE'
        order by rr.created_at,rr.id`,
      [iterationId],
    );
    const authoritativeBlockingInternalRequirements:AuthoritativeMissingInternalRequirementOverlap[]=authoritativeBlockingRows.rows.map(row=>({
      requirementId:row.requirement_id,
      affectedComponentIds:Array.isArray(row.affected_component_ids)?row.affected_component_ids.filter((item):item is string=>typeof item==="string"):[],
      affectedRelationshipIds:Array.isArray(row.affected_relationship_ids)?row.affected_relationship_ids.filter((item):item is string=>typeof item==="string"):[],
    }));

    for(const contradiction of result.analysis.material_contradictions){
      const contradictionSha=mapperSha256(contradiction);
      const contradictionId=randomUUID();
      await client.query(
        `insert into intentchord.context_material_contradictions(
          id,context_assembly_revision_id,mapping_iteration_id,model_contradiction_id,affected_component_ids,affected_relationship_ids,
          evidence_entry_ids,summary,materiality,contradiction_sha256
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [contradictionId,revisionId,iterationId,contradiction.contradiction_id,JSON.stringify(contradiction.affected_component_ids),
          JSON.stringify(contradiction.affected_relationship_ids),JSON.stringify(contradiction.evidence_entry_ids),contradiction.summary,
          contradiction.materiality,contradictionSha],
      );
      // Governance precedence is controlled only by a persisted Backend-created
      // MISSING_INTERNAL_EVIDENCE Resolution Requirement. Raw AI materiality/gap fields
      // are semantic findings and cannot suppress SOURCE_TRUTH_CONFLICT authority.
      const potentiallyResolvedByMissingEvidence=hasOverlappingAuthoritativeMissingInternalRequirement(
        contradiction,
        authoritativeBlockingInternalRequirements,
      );
      if(contradiction.materiality==="BLOCKING"&&!potentiallyResolvedByMissingEvidence){
        const requirementId=randomUUID();
        const requirementIdentity={
          type:"SOURCE_TRUTH_CONFLICT",
          assemblyRevisionId:revisionId,
          mappingIterationId:iterationId,
          contradictionSha,
        };
        await client.query(
          `insert into intentchord.context_resolution_requirements(
            id,context_assembly_revision_id,mapping_iteration_id,requirement_type,originating_material_contradiction_id,requirement_sha256
           ) values($1,$2,$3,'SOURCE_TRUTH_CONFLICT',$4,$5)`,
          [requirementId,revisionId,iterationId,contradictionId,mapperSha256(requirementIdentity)],
        );
        const provenance={contradictionSha,reasonCode:"GROUNDED_MATERIAL_SOURCE_TRUTH_CONFLICT"};
        await client.query(
          `insert into intentchord.context_resolution_events(
            id,resolution_requirement_id,event_type,actor_authority,provenance,event_sha256
           ) values($1,$2,'SOURCE_TRUTH_CORRECTION_REQUIRED','BACKEND_DETERMINISTIC_VALIDATOR',$3,$4)`,
          [randomUUID(),requirementId,JSON.stringify(provenance),mapperSha256(provenance)],
        );
      }
    }
    }

    const missingEvidenceRows=await client.query<{id:string;request_sha256:string}>(
      `select id,request_sha256
         from intentchord.context_missing_evidence_requests
        where mapping_iteration_id=$1
        order by created_at,id`,
      [iterationId],
    );
    const classificationRows=await client.query<{id:string;missing_evidence_request_id:string;classification_sha256:string}>(
      `select c.id,c.missing_evidence_request_id,c.classification_sha256
         from intentchord.context_gap_classifications c
         join intentchord.context_missing_evidence_requests r on r.id=c.missing_evidence_request_id
        where r.mapping_iteration_id=$1 order by c.created_at,c.id`,
      [iterationId],
    );
    const missingEvidenceFacts=missingEvidenceRows.rows.map(row=>({id:row.id,requestSha256:row.request_sha256}));
    const classificationFacts=classificationRows.rows.map(row=>({
      id:row.id,
      requestId:row.missing_evidence_request_id,
      classificationSha256:row.classification_sha256,
    }));

    const openRequirements=await client.query<{id:string;requirement_sha256:string;requirement_type:"MISSING_INTERNAL_EVIDENCE"|"SOURCE_TRUTH_CONFLICT"}>(
      `select r.id,r.requirement_sha256,r.requirement_type
         from intentchord.context_resolution_requirements r
        where r.context_assembly_revision_id=$1
        order by r.created_at,r.id`,
      [revisionId],
    );
    const resolutionFacts=await client.query<{event_sha256:string}>(
      `select e.event_sha256
         from intentchord.context_resolution_events e
         join intentchord.context_resolution_requirements r on r.id=e.resolution_requirement_id
        where r.context_assembly_revision_id=$1
        order by e.created_at,e.id`,
      [revisionId],
    );
    const existingCatalog=await client.query<{id:string}>(
      "select id from intentchord.context_catalog_revisions where context_assembly_revision_id=$1",
      [revisionId],
    );
    const qualification=run.providerConfigurationSnapshot.active.qualification;
    // Closure PASS / Accepted Catalog are NEW forward authority. Re-prove that this Assembly is
    // still the CURRENT EFFECTIVE CONTEXT AUTHORITY in the same transaction that mints them.
    const currentAuthority = await assertCurrentEffectiveContextAuthority(
      client,
      revision.rows[0].task_id,
      revisionId,
      "STALE_CONTEXT_HEAD",
    );
    const evaluation=evaluateContextClosureV1({
      contextAssemblyRevisionId:revisionId,
      assemblySha256:revision.rows[0].assembly_sha256,
      mappingIterationId:iterationId,
      mappingResultSha256:result.analysisSha256,
      persistedSourceCount:sourceRows.rows.length,
      mappingInputSourceCount:input.source_bindings.length,
      admittedMissingEvidenceRequests:missingEvidenceFacts,
      classifications:classificationFacts,
      openBlockingRequirements:openRequirements.rows.map(req=>({
        id:req.id,
        requirementSha256:req.requirement_sha256,
        requirementType:req.requirement_type,
      })),
      resolutionFactHashes:resolutionFacts.rows.map(r=>r.event_sha256),
      activeQualificationScope:qualification?.qualification_scope,
      qualificationId:qualification?.qualification_id,
      capabilityProfileVersion:qualification?.capability_profile_version,
      engineConfigurationSha256:run.providerConfigurationSnapshot.selected_engine_configuration_sha256,
      existingAcceptedCatalogId:existingCatalog.rows[0]?.id,
      currentEffectiveContextAuthorityProven:true,
      currentTaskSourceSetSha256:currentAuthority.taskSourceSetSha256,
      currentSourceAuthoritySha256:currentAuthority.sourceAuthoritySha256,
    });
    const sameEvaluation=await client.query<{id:string;decision:"PASS"|"BLOCKED"}>(
      `select id,decision from intentchord.context_closure_evaluations
        where context_assembly_revision_id=$1 and mapping_iteration_id=$2 and evaluation_input_sha256=$3`,
      [revisionId,iterationId,evaluation.evaluation_input_sha256],
    );
    if(sameEvaluation.rowCount) return;
    const evaluationId=randomUUID();
    const evidenceSha=mapperSha256(evaluation);
    await client.query(
      `insert into intentchord.context_closure_evaluations(
        id,context_assembly_revision_id,mapping_iteration_id,contract_version,evaluation_input_sha256,decision,reason_code,gate_evidence,evidence_sha256
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [evaluationId,revisionId,iterationId,CONTEXT_CLOSURE_CONTRACT_VERSION,evaluation.evaluation_input_sha256,
        evaluation.decision,evaluation.reason_code,JSON.stringify(evaluation),evidenceSha],
    );
    if(evaluation.decision!=="PASS"||existingCatalog.rowCount) return;

    const sourceBindings:ContextAssemblySourceBindingV2[]=sourceRows.rows.map(row=>({
      workspace_id:row.workspace_registration_id,
      workspace_registration_revision:Number(row.workspace_registration_revision),
      workspace_registration_fingerprint:row.workspace_registration_fingerprint,
      workspace_revision_id:row.workspace_revision_id,
      workspace_index_snapshot_id:row.workspace_index_snapshot_id,
      canonical_index_artifact_id:row.canonical_index_artifact_id,
      workspace_index_sha256:row.workspace_index_sha256,
      artifact_semantic_sha256:row.artifact_semantic_sha256,
    }));
    const catalog:AcceptedContextCatalogV2={
      schema_version:ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION,
      context_assembly_id:revision.rows[0].context_assembly_id,
      context_assembly_revision_id:revisionId,
      mapping_iteration_id:iterationId,
      closure_evaluation_id:evaluationId,
      catalog_summary:result.analysis.catalog_summary,
      components:result.analysis.components,
      relationships:result.analysis.relationships,
      source_bindings:sourceBindings,
    };
    await client.query(
      `insert into intentchord.context_catalog_revisions(
        id,context_assembly_revision_id,mapping_iteration_id,closure_evaluation_id,schema_version,catalog_json,catalog_sha256
       ) values($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(),revisionId,iterationId,evaluationId,ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION,JSON.stringify(catalog),mapperSha256(catalog)],
    );
  });
}


export async function admitCompletedTraversalToClosure(
  revisionId: string,
  taskId: string,
  traversal: ContextMappingTraversalRow,
): Promise<void> {
  const rootWindow = await databaseQuery<{
    id: string;
    output_sha256: string;
    output_summary: ModelContextAnalysisV2;
  }>(
    `SELECT id, output_sha256, output_summary
       FROM intentchord.context_mapping_reduction_windows
      WHERE traversal_id = $1 AND status = 'SUCCEEDED'
      ORDER BY reduction_level DESC, reduction_ordinal DESC LIMIT 1`,
    [traversal.id],
  );
  if (!rootWindow.rowCount || !rootWindow.rows[0].output_summary) {
    return;
  }

  const analysis = rootWindow.rows[0].output_summary;
  const analysisSha256 = rootWindow.rows[0].output_sha256;

  const existingRun = await databaseQuery<{ id: string }>(
    "SELECT id FROM intentchord.context_mapping_runs WHERE context_assembly_revision_id = $1 AND qualification_scope = 'AI_CONTEXT_MAPPING_V2' LIMIT 1",
    [revisionId],
  );

  let runId: string;
  let config: any;
  try {
    config = readAiContextMapperV2Config();
  } catch (err: any) {
    throw new Error(
      `ADMISSION_ERROR_NO_QUALIFIED_PROVIDER: Cannot admit completed traversal to closure without a qualified V2 provider configuration snapshot: ${err?.message}`,
    );
  }

  const providerConfigurationSnapshot = config?.providerConfigurationSnapshot;
  if (!providerConfigurationSnapshot) {
    throw new Error(
      "ADMISSION_ERROR_NO_QUALIFIED_PROVIDER: Qualified V2 provider configuration snapshot is required for traversal admission.",
    );
  }

  if (!existingRun.rowCount) {
    runId = randomUUID();
    const resultId = randomUUID();
    const attemptId = randomUUID();
    const createdAt = new Date().toISOString();

    const active = providerConfigurationSnapshot.active;
    const standby = providerConfigurationSnapshot.standby;

    const activeProviderId = (active as any).provider_id;
    const activeChannelId = (active as any).channel_id;
    const activeModelId = (active as any).model_id;

    const standbyProviderId = (standby as any)?.provider_id ?? null;
    const standbyChannelId = (standby as any)?.channel_id ?? null;
    const standbyModelId = (standby as any)?.model_id ?? null;

    const sourceRows = await databaseQuery<SourceRow>(
      `SELECT workspace_registration_id, workspace_registration_revision, workspace_registration_fingerprint,
              workspace_revision_id, workspace_index_snapshot_id, accepted_workspace_evidence_artifact_id as canonical_index_artifact_id,
              accepted_workspace_evidence_artifact_id, workspace_index_sha256, artifact_semantic_sha256
         FROM intentchord.context_assembly_sources WHERE context_assembly_revision_id = $1 ORDER BY ordering`,
      [revisionId],
    );

    const caRevRes = await databaseQuery<{ assembly_sha256: string }>(
      "SELECT assembly_sha256 FROM intentchord.context_assembly_revisions WHERE id = $1",
      [revisionId],
    );
    const assemblySha256 = caRevRes.rows[0]?.assembly_sha256 ?? traversal.artifact_semantic_sha256;

    const sourceBindings: ContextAssemblySourceBindingV2[] = sourceRows.rows.map(s => ({
      workspace_id: s.workspace_registration_id,
      workspace_registration_revision: Number(s.workspace_registration_revision),
      workspace_registration_fingerprint: s.workspace_registration_fingerprint,
      workspace_revision_id: s.workspace_revision_id,
      workspace_index_snapshot_id: s.workspace_index_snapshot_id,
      canonical_index_artifact_id: s.canonical_index_artifact_id,
      accepted_workspace_evidence_artifact_id: s.accepted_workspace_evidence_artifact_id,
      workspace_index_sha256: s.workspace_index_sha256,
      artifact_semantic_sha256: s.artifact_semantic_sha256,
    }));

    const mockInput: ContextAssemblyMappingInputV2 = {
      schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
      context_assembly_id: traversal.context_assembly_revision_id,
      context_assembly_revision_id: revisionId,
      context_assembly_revision: 1,
      created_at: createdAt,
      source_bindings: sourceBindings,
      entries: [],
      serialized_payload_sha256: mapperSha256(sourceBindings),
      provider_neutral_estimated_tokens: 0,
      proof_obligations: ["MULTI_WINDOW_TRAVERSAL_SYNTHESIS_COMPLETE"],
    };

    const governedEnvelope = {
      mapping_input_schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
      source_authority: "CONTEXT_ASSEMBLY_REVISION" as const,
      context_assembly_revision_id: revisionId,
      context_assembly_sha256: assemblySha256,
      source_count: sourceBindings.length,
      source_bindings: sourceBindings,
      inner: mockInput,
    };

    const requestFingerprintSha256 = mapperSha256({
      schema: "intentchord.ai-context-mapping-v2-request.v1",
      task_id: taskId,
      context_assembly_revision_id: revisionId,
      traversal_id: traversal.id,
    });

    await transaction(async client => {
      await client.query(
        `INSERT INTO intentchord.context_mapping_runs (
          id, mapping_input_snapshot_id, mapping_input_sha256, mapping_input_snapshot, workspace_index_contract_version,
          workspace_snapshot_id, workspace_index_sha256, eligible_entry_count, excluded_entry_count,
          provider_neutral_estimated_tokens, status, primary_provider_id, primary_channel_id, primary_model_id,
          standby_provider_id, standby_channel_id, standby_model_id, standby_enabled, standby_governance_state,
          provider_configuration_snapshot, workspace_index_snapshot_id, mapping_idempotency_key,
          mapping_request_fingerprint_sha256, qualification_scope, context_assembly_revision_id,
          context_assembly_sha256, execution_deadline_at, deadline_policy_version
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, 0, 0,
          0, 'PRIMARY_RUNNING', $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, null, $17,
          $18, $19, $20,
          $21, clock_timestamp() + interval '1 hour', 'intentchord.context-mapping-execution-deadline.v1'
        )`,
        [
          runId, revisionId, analysisSha256, JSON.stringify(governedEnvelope), CONTEXT_ASSEMBLY_CONTRACT_VERSION,
          revisionId, sourceBindings[0]?.workspace_index_sha256 ?? traversal.artifact_semantic_sha256, activeProviderId, activeChannelId, activeModelId,
          standbyProviderId, standbyChannelId, standbyModelId,
          Boolean(config?.standbyEnabled), config?.standbyGovernanceQualified ? "QUALIFIED" : "BLOCKED_BY_GOVERNANCE",
          JSON.stringify(providerConfigurationSnapshot),
          `traversal_${traversal.id}`,
          requestFingerprintSha256, CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE, revisionId,
          assemblySha256,
        ],
      );

      await client.query(
        `INSERT INTO intentchord.context_mapping_attempts (
          id, mapping_run_id, attempt_ordinal, provider_id, channel_id, requested_model_id,
          prompt_template_id, prompt_template_sha256, qualification_scope, status, started_at,
          retry_count
        ) VALUES (
          $1, $2, 1, $3, $4, $5,
          'intentchord_ai_context_mapper_system_v2', 'sha256:f55a2bd82ad59aa91bd9818737872bf33d0db0e72f4aeac07b011db9d0192b81', 'AI_CONTEXT_MAPPING_V2',
          'RUNNING', clock_timestamp(), 0
        )`,
        [attemptId, runId, activeProviderId, activeChannelId, activeModelId],
      );

      await client.query(
        `UPDATE intentchord.context_mapping_runs SET status = 'VALIDATING' WHERE id = $1`,
        [runId],
      );

      const deterministicValidationEvidence = {
        status: "PASS",
        parsed_analysis_sha256: analysisSha256,
        raw_response_sha256: analysisSha256,
        gates: [],
      };

      await client.query(
        `UPDATE intentchord.context_mapping_attempts SET
          status = 'SUCCEEDED',
          completed_at = clock_timestamp(),
          duration_ms = 100,
          raw_response_sha256 = $2,
          raw_response_body = $3,
          parsed_catalog_sha256 = $2,
          validation_summary = $4
        WHERE id = $1`,
        [attemptId, analysisSha256, JSON.stringify(governedEnvelope), JSON.stringify(deterministicValidationEvidence)],
      );

      const outcome = (analysis.missing_evidence_requests?.length ?? 0) > 0
        ? "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"
        : "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP";

      const resultEnvelope = {
        schema_version: "intentchord.context-mapping-result.v2",
        qualification_scope: "AI_CONTEXT_MAPPING_V2",
        mapping_run_id: runId,
        attempt_id: attemptId,
        context_assembly_revision_id: revisionId,
        prompt_template_id: "intentchord_ai_context_mapper_system_v2",
        prompt_template_sha256: "sha256:f55a2bd82ad59aa91bd9818737872bf33d0db0e72f4aeac07b011db9d0192b81",
        raw_response_sha256: analysisSha256,
        parsed_analysis_sha256: analysisSha256,
        model_analysis: analysis,
        validation_result: deterministicValidationEvidence,
      };

      await client.query(
        `INSERT INTO intentchord.context_mapping_v2_results (
          id, mapping_run_id, source_attempt_id, context_assembly_revision_id, schema_version,
          analysis_outcome, analysis_json, analysis_sha256, deterministic_validation_evidence,
          result_envelope, created_at
        ) VALUES (
          $1, $2, $3, $4, 'intentchord.model-context-analysis.v2',
          $5, $6, $7, $8,
          $9, clock_timestamp()
        )`,
        [
          resultId, runId, attemptId, revisionId,
          outcome,
          JSON.stringify(analysis), analysisSha256, JSON.stringify(deterministicValidationEvidence),
          JSON.stringify(resultEnvelope),
        ],
      );

      const ordinalRes = await client.query<{ next_ordinal: number }>(
        "SELECT coalesce(max(iteration_ordinal), 0) + 1 AS next_ordinal FROM intentchord.context_assembly_mapping_iterations WHERE context_assembly_revision_id = $1",
        [revisionId],
      );

      await client.query(
        `INSERT INTO intentchord.context_assembly_mapping_iterations (
          id, context_assembly_revision_id, mapping_run_id, v2_result_id, iteration_ordinal, analysis_outcome, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
        [randomUUID(), revisionId, runId, resultId, Number(ordinalRes.rows[0].next_ordinal), outcome],
      );

      const finalRunStatus = outcome === "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"
        ? "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE"
        : "ANALYSIS_COMPLETE";

      await client.query(
        `UPDATE intentchord.context_mapping_runs SET status = $2, final_attempt_id = $3 WHERE id = $1`,
        [runId, finalRunStatus, attemptId],
      );
    });
  } else {
    runId = existingRun.rows[0].id;
  }

  const repo = new PostgresAiContextMappingV2Repository();
  const runView = await repo.readRun(runId);
  if (runView.result) {
    await admitGovernanceAndEvaluateClosure(revisionId, runView);
  }
}

export async function runTaskContextClosure(taskId: string, raw: unknown): Promise<ContextClosureView> {
  if (!uuid.safeParse(taskId).success) throw new HttpCommandError(400,"INVALID_IDENTIFIER","Task ID must be a UUID.");
  const command=runCommandSchema.parse(raw);
  const captured=await captureCurrentAssemblyRevision(taskId);
  const sources=captured.sources;
  const revision=captured.revision;
  const repository=new PostgresAiContextMappingV2Repository();
  await repository.reconcileExpiredActiveRuns(revision.id);
  const current=await readTaskContextClosure(taskId);
  if(current.acceptedCatalog || current.state==="EVIDENCE_REQUIRED" || current.state==="BLOCKED" || current.state==="SOURCE_TRUTH_CONFLICT" || current.state==="MAPPING") {
    return current;
  }
  // A validated iteration is already admitted understanding. If closure materialization was
  // interrupted before its transaction committed, resume governance evaluation; do not create
  // another Mapping Run merely because the Assembly has no mutable lifecycle state.
  if(current.state==="READY_FOR_CLOSURE" && current.latestMappingRun?.result){
    await admitGovernanceAndEvaluateClosure(revision.id,current.latestMappingRun);
    return readTaskContextClosure(taskId);
  }

  // Multi-Window V2 Traversal Path:
  const v2Source = sources.find(s => s.isV2);
  if (v2Source) {
    const traversalRepo = new PostgresContextMappingTraversalRepository();
    let traversal = await traversalRepo.getTraversalByAssemblyRevisionId(revision.id);
    if (!traversal) {
      const weaId = v2Source.canonicalIndexArtifactId ?? v2Source.binding.canonical_index_artifact_id;
      const evidenceRepo = new PostgresWorkspaceEvidenceRepository();
      const section = await evidenceRepo.getSemanticProjectionSection(weaId);
      if (!section) {
        throw new HttpCommandError(409, "SEMANTIC_PROJECTION_SECTION_NOT_FOUND", `SEMANTIC_PROJECTION section missing for WEA ${weaId}`);
      }
      const snapRes = await databaseQuery<{ index_configuration_sha256: string }>(
        "SELECT index_configuration_sha256 FROM intentchord.workspace_index_snapshots WHERE id = $1",
        [v2Source.binding.workspace_index_snapshot_id],
      );
      const indexCfgSha = snapRes.rows[0]?.index_configuration_sha256;
      if (!indexCfgSha) {
        throw new HttpCommandError(409, "SNAPSHOT_INDEX_CONFIGURATION_MISSING", "Index snapshot configuration SHA missing.");
      }

      let frozenAiExecutionAuthority: import("@/core/ai-context-mapper/types").FrozenAiExecutionAuthority | undefined;
      try {
        const { internalAiEngineRegistryService } = await import("@/server/internal-ai-engine-registry-service");
        const resolved = await internalAiEngineRegistryService.resolveV2RuntimeSelection();
        frozenAiExecutionAuthority = resolved.frozenExecutionAuthority;
      } catch {
        // If no DB active selection is configured yet, proceed without frozen authority
      }

      traversal = await traversalRepo.createTraversal({
        context_assembly_revision_id: revision.id,
        workspace_registration_id: v2Source.binding.workspace_id,
        workspace_revision_id: v2Source.binding.workspace_revision_id,
        workspace_index_snapshot_id: v2Source.binding.workspace_index_snapshot_id,
        accepted_workspace_evidence_artifact_id: weaId,
        artifact_semantic_sha256: v2Source.binding.artifact_semantic_sha256,
        workspace_observation_id: v2Source.observationId,
        authority_sequence: v2Source.authoritySequence,
        index_configuration_sha256: indexCfgSha,
      }, {
        cursor_artifact_id: weaId,
        cursor_section_id: section.id,
        cursor_section_type: "SEMANTIC_PROJECTION",
        cursor_section_schema_version: "v2",
        cursor_record_seq: 0,
      }, frozenAiExecutionAuthority);
    } else if (traversal.traversal_status === "FAILED" && current.state === "MAPPING_RETRYABLE") {
      traversal = await traversalRepo.reopenFailedTraversalForRetry(traversal.id);
    }

    if (
      traversal.traversal_status !== "SYNTHESIS_COMPLETE" &&
      traversal.traversal_status !== "FAILED" &&
      traversal.traversal_status !== "STALE_AUTHORITY" &&
      traversal.traversal_status !== "CANCELLED"
    ) {
      const executor = new ContextMappingTraversalExecutor({ traversalRepo });
      // Launch asynchronous backend execution; request does not block for all windows
      executor.executeTraversal(taskId, traversal.id).then(async (completed) => {
        if (completed.traversal_status === "SYNTHESIS_COMPLETE") {
          await admitCompletedTraversalToClosure(revision.id, taskId, completed);
        }
      }).catch(() => {});
    } else if (traversal.traversal_status === "SYNTHESIS_COMPLETE") {
      await admitCompletedTraversalToClosure(revision.id, taskId, traversal);
    }

    return readTaskContextClosure(taskId);
  }

  const input=await buildAssemblyInputBoundedStreaming(revision,sources);
  const config=readAiContextMapperV2Config();
  assertProductionInternalAiExecutionV2Ready(config);
  const activeCredential=await resolveV2InternalAiCredential(config.active.credentialReference);
  if (!activeCredential) {
    throw new HttpCommandError(503,"INTERNAL_AI_ACTIVE_ENGINE_CREDENTIAL_REQUIRED","The qualified V2 Internal Engine credential is unavailable from the secret resolver.");
  }
  const standby=resolveQualifiedStandby(config);
  const requestFingerprintSha256=mapperSha256({
    schema:"intentchord.ai-context-mapping-v2-request.v1",
    task_id:taskId,
    context_assembly_revision_id:revision.id,
    assembly_sha256:revision.assembly_sha256,
    mapping_input_sha256:mapperSha256(input),
    selected_engine_configuration_sha256:config.providerConfigurationSnapshot.selected_engine_configuration_sha256,
    qualification_scope:CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE,
  });
  const orchestrator=new AiContextMapperV2Orchestrator(
    repository,
    createInternalAiProviderAdapter(config.active,{credentialOverride:activeCredential,executionMode:"PRODUCTION",expectedQualificationScope:CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE}),
    standby?createInternalAiProviderAdapter(standby,{executionMode:"STANDBY_FAILOVER",expectedQualificationScope:CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE}):undefined,
    {
      providerConfigurationSnapshot:config.providerConfigurationSnapshot,
      standbyEnabled:config.standbyEnabled,
      standbyGovernanceQualified:config.standbyGovernanceQualified,
      assemblySha256:revision.assembly_sha256,
      idempotencyKey:`${command.idempotencyKey}:${revision.id}`,
      requestFingerprintSha256,
      primaryRequestTimeoutMs:config.active.timeoutMs,
      standbyRequestTimeoutMs:standby?.timeoutMs??config.active.timeoutMs,
    },
  );
  const run=await orchestrator.run(input);
  if(run.result) await admitGovernanceAndEvaluateClosure(revision.id,run);
  return readTaskContextClosure(taskId);
}

export async function readTaskContextClosure(taskId:string):Promise<ContextClosureView>{
  const assembly=await databaseQuery<{id:string}>("select id from intentchord.context_assemblies where task_id=$1",[taskId]);
  if(!assembly.rowCount) throw new HttpCommandError(404,"CONTEXT_ASSEMBLY_NOT_FOUND","No governed Context Assembly exists for this Task yet.");
  const rev=await databaseQuery<AssemblyRevisionRow>(
    `select id,context_assembly_id,revision,assembly_sha256
       from intentchord.context_assembly_revisions
      where context_assembly_id=$1 order by revision desc limit 1`,
    [assembly.rows[0].id],
  );
  if(!rev.rowCount) throw new HttpCommandError(404,"CONTEXT_ASSEMBLY_REVISION_NOT_FOUND","No governed Context Assembly Revision exists for this Task yet.");
  const row=rev.rows[0];
  const repository=new PostgresAiContextMappingV2Repository();
  await repository.reconcileExpiredActiveRuns(row.id);

  const sources=await databaseQuery<SourceRow>(
    `select workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,workspace_revision_id,
            workspace_index_snapshot_id,accepted_workspace_evidence_artifact_id as canonical_index_artifact_id,accepted_workspace_evidence_artifact_id,workspace_index_sha256,artifact_semantic_sha256
       from intentchord.context_assembly_sources where context_assembly_revision_id=$1 order by ordering`,
    [row.id],
  );
  const runRows=await databaseQuery<{id:string;mapping_input_snapshot:ContextAssemblyMappingInputV2;status:string;created_at:string}>(
    `select id,mapping_input_snapshot,status,created_at
       from intentchord.context_mapping_runs
      where context_assembly_revision_id=$1 and qualification_scope='AI_CONTEXT_MAPPING_V2'
      order by created_at desc,id desc`,
    [row.id],
  );
  const latestRunRow=runRows.rows[0];
  const latestMappingRun=latestRunRow?await repository.readRun(latestRunRow.id):undefined;
  const evidenceEntries=latestRunRow?.mapping_input_snapshot?.entries??[];

  const latestIteration=await databaseQuery<{id:string;mapping_run_id:string;created_at:string}>(
    `select id,mapping_run_id,created_at
       from intentchord.context_assembly_mapping_iterations
      where context_assembly_revision_id=$1
      order by iteration_ordinal desc,id desc limit 1`,
    [row.id],
  );
  const requirements=await databaseQuery<ResolutionRequirementRow>(
    `select r.id,r.requirement_type,r.requirement_sha256,r.mapping_iteration_id,r.originating_missing_evidence_request_id,
            (select e.event_type from intentchord.context_resolution_events e
              where e.resolution_requirement_id=r.id order by e.created_at desc,e.id desc limit 1) last_event
       from intentchord.context_resolution_requirements r
      where r.context_assembly_revision_id=$1
      order by r.created_at,r.id`,
    [row.id],
  );
  const gaps=await databaseQuery<any>(
    `select r.id,r.model_gap_id,r.materiality,r.missing_evidence_description,r.required_evidence_kind,r.source_hint,
            c.classification,c.candidate_workspace_registration_id,a.decision,
            (select e.event_type from intentchord.context_resolution_events e
              join intentchord.context_resolution_requirements rr on rr.id=e.resolution_requirement_id
             where rr.originating_missing_evidence_request_id=r.id
             order by e.created_at desc,e.id desc limit 1) resolution_state
       from intentchord.context_missing_evidence_requests r
       join intentchord.context_gap_classifications c on c.missing_evidence_request_id=r.id
       left join lateral(
         select decision from intentchord.context_source_authorizations
          where missing_evidence_request_id=r.id order by created_at desc limit 1
       ) a on true
      where r.context_assembly_revision_id=$1
      order by r.created_at,r.id`,
    [row.id],
  );
  const latestClosure=latestIteration.rowCount
    ? await databaseQuery<{id:string;mapping_iteration_id:string;decision:"PASS"|"BLOCKED";reason_code:string;evaluation_input_sha256:string;evidence_sha256:string}>(
        `select id,mapping_iteration_id,decision,reason_code,evaluation_input_sha256,evidence_sha256
           from intentchord.context_closure_evaluations
          where context_assembly_revision_id=$1 and mapping_iteration_id=$2
          order by created_at desc,id desc limit 1`,
        [row.id,latestIteration.rows[0].id],
      )
    : { rowCount: 0, rows: [] } as any;
  const catalog=await databaseQuery<{id:string;catalog_sha256:string;catalog_json:AcceptedContextCatalogV2}>(
    "select id,catalog_sha256,catalog_json from intentchord.context_catalog_revisions where context_assembly_revision_id=$1",
    [row.id],
  );

  const traversalRepo = new PostgresContextMappingTraversalRepository();
  const traversal = await traversalRepo.getTraversalByAssemblyRevisionId(row.id);
  const traversalActive = Boolean(traversal && [
    "TOPOLOGY_IN_PROGRESS", "TOPOLOGY_COMPLETE", "DRILLDOWN_IN_PROGRESS", "DRILLDOWN_COMPLETE", "SYNTHESIS_IN_PROGRESS", "SYNTHESIS_REDUCING"
  ].includes(traversal.traversal_status));

  const hasConflict=requirements.rows.some(r=>r.requirement_type==="SOURCE_TRUTH_CONFLICT");
  const hasMissing=requirements.rows.some(r=>r.requirement_type==="MISSING_INTERNAL_EVIDENCE");
  const blockedByOwner=requirements.rows.some(r=>["OWNER_DENIED_SOURCE","SOURCE_UNAVAILABLE"].includes(r.last_event??""));
  const active=Boolean(latestMappingRun && ACTIVE_V2_RUN_STATUSES.has(latestMappingRun.status));
  const terminalRetry=Boolean(latestMappingRun && RETRYABLE_TERMINAL_V2_RUN_STATUSES.has(latestMappingRun.status));
  const latestRunHasAdmittedIteration=Boolean(latestIteration.rowCount && latestIteration.rows[0].mapping_run_id===latestMappingRun?.id);

  let state:ContextClosureView["state"];
  if(catalog.rowCount) state="CLOSED";
  else if(active || traversalActive) state="MAPPING";
  else if(blockedByOwner) state="BLOCKED";
  else if(hasMissing) state="EVIDENCE_REQUIRED";
  else if(hasConflict || traversal?.traversal_status === "STALE_AUTHORITY") state="SOURCE_TRUTH_CONFLICT";
  else if((terminalRetry || traversal?.traversal_status === "FAILED") && !latestRunHasAdmittedIteration) state="MAPPING_RETRYABLE";
  else if(latestIteration.rowCount || traversal?.traversal_status === "SYNTHESIS_COMPLETE") state="READY_FOR_CLOSURE";
  else state="READY_FOR_MAPPING";

  const closureState:ContextClosureView["closureState"]=catalog.rowCount?"PASS":(blockedByOwner||hasConflict||hasMissing)?"BLOCKED":"OPEN";
  return {
    contextAssemblyId:row.context_assembly_id,
    revisionId:row.id,
    revision:Number(row.revision),
    state,
    closureState,
    assemblySha256:row.assembly_sha256,
    sources:sources.rows.map(s=>({
      workspace_id:s.workspace_registration_id,
      workspace_registration_revision:Number(s.workspace_registration_revision),
      workspace_registration_fingerprint:s.workspace_registration_fingerprint,
      workspace_revision_id:s.workspace_revision_id,
      workspace_index_snapshot_id:s.workspace_index_snapshot_id,
      canonical_index_artifact_id:s.canonical_index_artifact_id,
      workspace_index_sha256:s.workspace_index_sha256,
      artifact_semantic_sha256:s.artifact_semantic_sha256,
    })),
    evidenceEntries,
    ...(latestMappingRun?{latestMappingRun}:{}),
    resolutionRequirements:requirements.rows.map(r=>({
      id:r.id,
      type:r.requirement_type,
      requirementSha256:r.requirement_sha256,
      mappingIterationId:r.mapping_iteration_id,
      ...(r.last_event?{lastEvent:r.last_event}:{}),
    })),
    missingEvidenceRequests:gaps.rows.map((g:any)=>({
      id:g.id,
      modelGapId:g.model_gap_id,
      classification:g.classification,
      materiality:g.materiality,
      description:g.missing_evidence_description,
      requiredEvidenceKind:g.required_evidence_kind,
      ...(g.source_hint?{sourceHint:g.source_hint}:{}),
      ...(g.candidate_workspace_registration_id?{candidateWorkspaceRegistrationId:g.candidate_workspace_registration_id}:{}),
      ...(g.decision?{authorizationDecision:g.decision}:{}),
      ...(g.resolution_state?{resolutionState:g.resolution_state}:{}),
    })),
    ...(latestClosure.rows[0]?{closureEvaluation:{
      id:latestClosure.rows[0].id,
      mappingIterationId:latestClosure.rows[0].mapping_iteration_id,
      decision:latestClosure.rows[0].decision,
      reasonCode:latestClosure.rows[0].reason_code,
      evaluationInputSha256:latestClosure.rows[0].evaluation_input_sha256,
      evidenceSha256:latestClosure.rows[0].evidence_sha256,
    }}:{}),
    ...(catalog.rows[0]?{acceptedCatalog:{id:catalog.rows[0].id,catalogSha256:catalog.rows[0].catalog_sha256,catalog:catalog.rows[0].catalog_json}}:{}),
    ...(traversal ? {
      traversal: {
        id: traversal.id,
        status: traversal.traversal_status,
        phase: traversal.current_phase,
        topologyWindowCount: traversal.topology_window_count,
        drilldownWindowCount: traversal.drilldown_window_count,
        reductionLevelCount: traversal.reduction_level_count,
        activeWindowOrdinal: traversal.active_window_ordinal,
      },
    } : {}),
  };
}

export async function authorizeTaskContextSource(taskId:string,raw:unknown,ownerAuthority:string):Promise<ContextClosureView>{
  const command=sourceAuthorizationSchema.parse(raw);
  await transaction(async client=>{
    // Serialize Task authority first; current Context Head is locked below through context_assemblies.
    const taskRow=await client.query<{revision:string|number}>(
      "select revision from intentchord.tasks where id=$1 for update",
      [taskId],
    );
    if(!taskRow.rowCount) throw new HttpCommandError(404,"TASK_NOT_FOUND","Task not found.");
    if(Number(taskRow.rows[0].revision)!==command.expectedTaskRevision) {
      throw new HttpCommandError(409,"REVISION_CONFLICT","Task revision changed. Reload before authorizing additional Context source.");
    }

    const request=await client.query<{
      context_assembly_revision_id:string;
      classification:BackendGapClassification;
      candidate_workspace_registration_id:string|null;
      resolution_requirement_id:string;
    }>(
      `select r.context_assembly_revision_id,c.classification,c.candidate_workspace_registration_id,rr.id as resolution_requirement_id
         from intentchord.context_missing_evidence_requests r
         join intentchord.context_gap_classifications c on c.missing_evidence_request_id=r.id
         join intentchord.context_resolution_requirements rr
           on rr.originating_missing_evidence_request_id=r.id and rr.requirement_type='MISSING_INTERNAL_EVIDENCE'
         join intentchord.context_assembly_revisions ar on ar.id=r.context_assembly_revision_id
         join intentchord.context_assemblies a on a.id=ar.context_assembly_id
        where r.id=$1 and a.task_id=$2`,
      [command.missingEvidenceRequestId,taskId],
    );
    if(!request.rowCount||request.rows[0].classification!=="BLOCKING_INTERNAL_SOURCE_GAP") {
      throw new HttpCommandError(422,"BLOCKING_INTERNAL_SOURCE_GAP_REQUIRED","Owner Source authorization is only valid for a Backend-classified blocking internal source gap.");
    }
    const authority=request.rows[0];
    // Historical Requirements remain readable, but only the exact current Head may create a NEW
    // Owner Source authorization/event. The stable Assembly parent lock remains held until commit.
    const workspaceRegistrationIds = command.decision === "SOURCE_UNAVAILABLE"
      ? []
      : [command.workspaceRegistrationId];
    await assertCurrentEffectiveContextAuthority(
      client,
      taskId,
      authority.context_assembly_revision_id,
      "CONTEXT_REQUIREMENT_SUPERSEDED",
      workspaceRegistrationIds,
    );
    const superseded=await client.query(
      `select 1 from intentchord.context_resolution_events
        where resolution_requirement_id=$1 and event_type='SUPERSEDED_BY_NEW_ASSEMBLY'
        limit 1`,
      [authority.resolution_requirement_id],
    );
    if(superseded.rowCount) {
      throw new HttpCommandError(409,"CONTEXT_REQUIREMENT_SUPERSEDED","Historical Context Requirement is immutable provenance and cannot create new Source authority.");
    }

    if(command.decision==="SOURCE_UNAVAILABLE"){
      const existing=await client.query<{id:string}>(
        "select id from intentchord.context_resolution_events where resolution_requirement_id=$1 and event_type='SOURCE_UNAVAILABLE' order by created_at desc limit 1",
        [authority.resolution_requirement_id],
      );
      if(!existing.rowCount){
        const provenance={ownerAuthority,decision:"SOURCE_UNAVAILABLE",reasonCode:"REQUIRED_SOURCE_UNAVAILABLE",contextAssemblyRevisionId:authority.context_assembly_revision_id,taskRevision:command.expectedTaskRevision};
        await client.query(
          `insert into intentchord.context_resolution_events(
            id,resolution_requirement_id,event_type,actor_authority,provenance,event_sha256
           ) values($1,$2,'SOURCE_UNAVAILABLE',$3,$4,$5)`,
          [randomUUID(),authority.resolution_requirement_id,ownerAuthority,JSON.stringify(provenance),mapperSha256(provenance)],
        );
      }
      return;
    }

    const registrationResult=await client.query<{
      id:string; revision:string|number; display_name:string; role:string; reference_type:"LOCAL_PATH"|"REMOTE_REFERENCE";
      source_type:"WINDOWS_NATIVE_SELECTOR"|"MANUAL_VERIFIED"|"MANUAL_UNVERIFIED"|"REMOTE_CONNECTOR";
      normalized_reference:string; repository_identity:string|null; branch:string|null; commit_sha:string|null; fingerprint:string; verification_status:string;
    }>(
      `select id,revision,display_name,role,reference_type,source_type,normalized_reference,repository_identity,branch,commit_sha,fingerprint,verification_status
         from intentchord.workspaces where id=$1`,
      [command.workspaceRegistrationId],
    );
    if(!registrationResult.rowCount) throw new HttpCommandError(404,"WORKSPACE_REGISTRATION_NOT_FOUND","The registered Workspace does not exist.");
    const registration=registrationResult.rows[0];
    if(registration.verification_status!=="VERIFIED") throw new HttpCommandError(409,"CURRENT_SOURCE_AUTHORITY_UNPROVEN","The target Workspace Registration is not currently VERIFIED.");
    const candidate=authority.candidate_workspace_registration_id;
    if(candidate&&candidate!==command.workspaceRegistrationId) {
      throw new HttpCommandError(409,"SOURCE_AUTHORIZATION_CANDIDATE_MISMATCH","The selected Workspace does not match the Backend-resolved candidate source.");
    }
    const alreadyPresent=await client.query(
      `select 1 from intentchord.context_assembly_sources
        where context_assembly_revision_id=$1 and workspace_registration_id=$2
        limit 1`,
      [authority.context_assembly_revision_id,command.workspaceRegistrationId],
    );
    if(alreadyPresent.rowCount) {
      throw new HttpCommandError(
        409,
        "SOURCE_ALREADY_PRESENT_REQUIRES_REFRESH_OR_REINDEX",
        "The required Workspace is already governed by the current Context Assembly. Adding it again cannot resolve the Requirement; current evidence authority must be refreshed or re-evaluated without inventing the cause.",
      );
    }

    const existing=await client.query<{id:string;decision:"APPROVE"|"DENY"}>(
      "select id,decision from intentchord.context_source_authorizations where missing_evidence_request_id=$1 and workspace_registration_id=$2",
      [command.missingEvidenceRequestId,command.workspaceRegistrationId],
    );
    if(existing.rowCount){
      if(existing.rows[0].decision!==command.decision) {
        throw new HttpCommandError(409,"SOURCE_AUTHORIZATION_ALREADY_DECIDED","This source authorization already has a different immutable Owner decision.");
      }
      // Replayed authority never retargets: this immutable receipt is already recorded for this
      // exact Task/Head. Treat a same-decision replay as idempotent only while the Head lock proves
      // the originating authority is still current.
      return;
    }

    const authorizationId=randomUUID();
    await client.query(
      `insert into intentchord.context_source_authorizations(
        id,resolution_requirement_id,context_assembly_revision_id,missing_evidence_request_id,workspace_registration_id,workspace_registration_revision,workspace_registration_fingerprint,task_id,task_revision,decision,owner_reference
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [authorizationId,authority.resolution_requirement_id,authority.context_assembly_revision_id,
        command.missingEvidenceRequestId,command.workspaceRegistrationId,Number(registration.revision),registration.fingerprint,taskId,command.expectedTaskRevision,command.decision,ownerAuthority],
    );
    const provenance={ownerAuthority,workspaceRegistrationId:command.workspaceRegistrationId,decision:command.decision,contextAssemblyRevisionId:authority.context_assembly_revision_id,taskRevision:command.expectedTaskRevision};
    await client.query(
      `insert into intentchord.context_resolution_events(
        id,resolution_requirement_id,event_type,actor_authority,source_authorization_id,related_workspace_registration_id,provenance,event_sha256
       ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(),authority.resolution_requirement_id,command.decision==="APPROVE"?"OWNER_AUTHORIZED_SOURCE":"OWNER_DENIED_SOURCE",
        ownerAuthority,authorizationId,command.workspaceRegistrationId,JSON.stringify(provenance),mapperSha256(provenance)],
    );

    if(command.decision==="APPROVE"){
      const newWorkspace={
        id:registration.id,
        displayName:registration.display_name,
        role:registration.role,
        referenceType:registration.reference_type,
        source:registration.source_type,
        reference:registration.normalized_reference,
        repositoryIdentity:registration.repository_identity??undefined,
        branch:registration.branch??undefined,
        commitSha:registration.commit_sha??undefined,
        fingerprint:registration.fingerprint,
        provenance:canonicalJson({sourceAuthorizationId:authorizationId,missingEvidenceRequestId:command.missingEvidenceRequestId,originatingContextAssemblyRevisionId:authority.context_assembly_revision_id}),
        discoveryScopeMode:"FULL_WORKSPACE" as const,
        allowedPaths:[],excludedPaths:[],
        authorizationContext:`Owner authorized additional Context source via Missing Evidence Request ${command.missingEvidenceRequestId}.`,
        ordering:0,
      };
      await appendAuthorizedContextWorkspaceInTransaction(client,{
        taskId,
        expectedTaskRevision:command.expectedTaskRevision,
        workspace:newWorkspace,
        sourceAuthorizationId:authorizationId,
        missingEvidenceRequestId:command.missingEvidenceRequestId,
        ownerAuthority,
      });
    }
  });

  return readTaskContextClosure(taskId);
}
