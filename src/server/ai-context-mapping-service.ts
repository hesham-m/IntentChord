import { z } from "zod/v3";
import {
  buildMappingInputSnapshot,
  buildMappingInputSnapshotFromCanonicalArtifact,
  mappingInputSemanticSha256,
} from "@/core/ai-context-mapper/input-builder";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import { AiContextMapperError } from "@/core/ai-context-mapper/errors";
import { AiContextMapperOrchestrator } from "@/core/ai-context-mapper/orchestrator";
import { AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256 } from "@/core/ai-context-mapper/prompt";
import {
  INTERNAL_AI_QUALIFICATION_SCOPE_V1,
  MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
  type CustomerMappingAttemptView,
  type CustomerMappingRunView,
  type MappingAttemptView,
  type MappingRunView,
} from "@/core/ai-context-mapper/types";
import { canonicalWorkspaceIndexHash } from "@/core/workspace-index/canonical";
import { canonicalWorkspaceIndexContractSchema } from "@/core/workspace-index/schema";
import {
  ExistingMappingRunError,
  PostgresAiContextMappingRepository,
} from "@/server/ai-context-mapping-repository";
import {
  assertProductionInternalAiExecutionReady,
  readAiContextMapperConfig,
  resolveInternalAiCredential,
  resolveQualifiedStandby,
} from "@/server/ai-context-mapper-config";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import { HttpCommandError } from "@/server/errors";
import { readPersistedWorkspaceIndexMappingAuthority } from "@/server/workspace-index-snapshot-service";

const uuidSchema = z.string().uuid();
const createMappingRunCommandSchema = z.object({
  workspaceIndexSnapshotId: uuidSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

const contextDecisionSchema = z.object({
  contextId: z.string().trim().min(1).max(200),
  decision: z.enum(["ACCEPT", "REJECT"]),
  note: z.string().trim().max(5000).optional(),
}).strict();

const ownerReviewCommandSchema = z.union([
  z.object({
    verdict: z.enum(["ACCEPT", "REJECT"]),
    contextDecisions: z.array(contextDecisionSchema).min(1),
    note: z.string().trim().max(5000).optional(),
  }).strict(),
  z.object({
    verdict: z.literal("REJECT"),
    rejectEntireProposal: z.literal(true),
    note: z.string().trim().max(5000).optional(),
  }).strict(),
]);

function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) throw new HttpCommandError(400, "INVALID_IDENTIFIER", `${label} must be a UUID.`);
}

function mappingHttpError(error: AiContextMapperError): HttpCommandError {
  const status = error.code === "MAPPER_INPUT_BUDGET_EXCEEDED" ? 413 : 422;
  return new HttpCommandError(status, error.code, error.message, error.details);
}

export type AiContextMappingCreateOperation = {
  run: MappingRunView;
  created: boolean;
};

export async function createAiContextMappingRunOperation(raw: unknown): Promise<AiContextMappingCreateOperation> {
  const config = readAiContextMapperConfig();
  assertProductionInternalAiExecutionReady(config);
  const activeCredential = resolveInternalAiCredential(config.active);
  if (!activeCredential) {
    throw new HttpCommandError(503, "AI_CONTEXT_MAPPER_PRIMARY_KEY_REQUIRED", "The configured Active Internal AI credential is required; missing Active authentication never triggers failover.");
  }
  const qualifiedStandby = resolveQualifiedStandby(config);
  const command = createMappingRunCommandSchema.parse(raw);
  const authority = await readPersistedWorkspaceIndexMappingAuthority(command.workspaceIndexSnapshotId);
  const persistedSnapshot = authority.snapshot;
  if (persistedSnapshot.status !== "READY") {
    throw new HttpCommandError(409, "READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", "Mapping requires a persisted READY Workspace Index Snapshot.");
  }

  let input;
  let governingWorkspaceIndexSha256: string;
  try {
    if (persistedSnapshot.sourceMode === "REGISTERED_WORKSPACE" && authority.artifact) {
      if (persistedSnapshot.canonicalIndexArtifactId) {
        if (!persistedSnapshot.workspaceRevisionId
            || authority.artifact.id !== persistedSnapshot.canonicalIndexArtifactId
            || authority.artifact.semanticState.workspace_revision_id !== persistedSnapshot.workspaceRevisionId) {
          throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_ARTIFACT_BINDING_REQUIRED", "Registered B1 Mapping requires the backend-persisted intrinsic Canonical Index Artifact binding.");
        }
        input = buildMappingInputSnapshotFromCanonicalArtifact({
          canonicalIndexArtifactId: authority.artifact.id,
          artifactSemanticSha256: authority.artifact.semanticSha256,
          semanticState: authority.artifact.semanticState as import("@/core/workspace-index/artifact-identity").CanonicalIndexArtifactSemanticState,
        });
        governingWorkspaceIndexSha256 = authority.artifact.semanticSha256;
        if (input.workspace_index_sha256 !== governingWorkspaceIndexSha256
            || input.canonical_index_artifact_id !== persistedSnapshot.canonicalIndexArtifactId) {
          throw new HttpCommandError(409, "MAPPER_ARTIFACT_HASH_BINDING_FAILED", "The Registered B1 Mapping Input does not bind to the persisted intrinsic Canonical Index Artifact.");
        }
      } else if (persistedSnapshot.acceptedWorkspaceEvidenceArtifactId) {
        if (!persistedSnapshot.workspaceRevisionId
            || authority.artifact.id !== persistedSnapshot.acceptedWorkspaceEvidenceArtifactId) {
          throw new HttpCommandError(409, "REGISTERED_V2_MAPPING_EVIDENCE_ARTIFACT_BINDING_REQUIRED", "Registered V2 Mapping requires the backend-persisted Workspace Evidence Artifact binding.");
        }
        throw new HttpCommandError(409, "READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", "V2 Mapping through the Registered Mapping Authority reader is not yet supported. Use the V2 Context Mapping path.");
      } else {
        throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_AUTHORITY_BINDING_REQUIRED", "Registered Mapping requires either a Canonical Index Artifact or Workspace Evidence Artifact binding.");
      }
    } else {
      if (persistedSnapshot.sourceMode === "REGISTERED_WORKSPACE" && persistedSnapshot.canonicalIndexArtifactId) {
        throw new HttpCommandError(409, "REGISTERED_B1_MAPPING_ARTIFACT_BINDING_REQUIRED", "A Registered B1 Snapshot cannot fall back from its persisted intrinsic Canonical Index Artifact authority to the legacy V1 projection.");
      }
      if (persistedSnapshot.sourceMode === "REGISTERED_WORKSPACE" && persistedSnapshot.acceptedWorkspaceEvidenceArtifactId) {
        throw new HttpCommandError(409, "REGISTERED_V2_MAPPING_EVIDENCE_ARTIFACT_BINDING_REQUIRED", "A Registered V2 Snapshot requires the Workspace Evidence Artifact to be resolved through the Mapping Authority reader.");
      }
      if (!persistedSnapshot.canonicalIndex || !persistedSnapshot.canonicalSha256) {
        throw new HttpCommandError(409, "READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", "Legacy/diagnostic Mapping requires a persisted READY Canonical Workspace Index V1 Snapshot.");
      }
      const canonicalIndex = canonicalWorkspaceIndexContractSchema.parse(persistedSnapshot.canonicalIndex);
      const recomputedCanonicalSha = canonicalWorkspaceIndexHash(canonicalIndex);
      if (recomputedCanonicalSha !== persistedSnapshot.canonicalSha256) {
        throw new HttpCommandError(409, "WORKSPACE_INDEX_SNAPSHOT_INTEGRITY_FAILED", "The persisted Canonical Snapshot hash no longer matches its exact payload.");
      }
      input = buildMappingInputSnapshot(canonicalIndex);
      governingWorkspaceIndexSha256 = persistedSnapshot.canonicalSha256;
      if (input.workspace_index_sha256 !== governingWorkspaceIndexSha256) {
        throw new HttpCommandError(409, "MAPPER_SNAPSHOT_HASH_BINDING_FAILED", "The Mapping Input Snapshot does not bind to the persisted Canonical Snapshot hash.");
      }
    }
  } catch (error) {
    if (error instanceof AiContextMapperError) throw mappingHttpError(error);
    throw error;
  }

  const mappingRequestFingerprintSha256 = mapperSha256({
    schema: "intentchord.ai-context-mapping-request.v2",
    workspace_index_snapshot_id: persistedSnapshot.id,
    source_mode: persistedSnapshot.sourceMode,
    governing_workspace_index_sha256: governingWorkspaceIndexSha256,
    ...(input.mapping_input_schema_version === "intentchord.ai-context-mapping-input.v2"
      ? { canonical_index_artifact_id: input.canonical_index_artifact_id }
      : {}),
    mapping_input_schema_version: input.mapping_input_schema_version,
    mapping_input_sha256: mappingInputSemanticSha256(input),
    max_estimated_tokens: MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
    internal_engine_execution_configuration: {
      schema_version: config.providerConfigurationSnapshot.schema_version,
      registry_schema_version: config.providerConfigurationSnapshot.registry_schema_version,
      selected_engine_id: config.providerConfigurationSnapshot.selected_engine_id,
      selected_engine_config_revision: config.providerConfigurationSnapshot.selected_engine_config_revision,
      selected_engine_configuration_sha256: config.providerConfigurationSnapshot.selected_engine_configuration_sha256,
      selection_policy: config.providerConfigurationSnapshot.selection_policy,
      active: config.providerConfigurationSnapshot.active,
      candidate: config.providerConfigurationSnapshot.candidate ?? null,
      standby: config.providerConfigurationSnapshot.standby,
      failover_policy: config.providerConfigurationSnapshot.failover_policy,
    },
    prompt_template_sha256: AI_CONTEXT_MAPPER_PROMPT_TEMPLATE_SHA256,
    validator_schema: "intentchord.model-proposed-context-catalog.v1",
  });
  const repository = new PostgresAiContextMappingRepository({
    workspaceIndexSnapshotId: persistedSnapshot.id,
    idempotencyKey: command.idempotencyKey,
    requestFingerprintSha256: mappingRequestFingerprintSha256,
  });
  const existing = await repository.findIdempotentRun(command.idempotencyKey, mappingRequestFingerprintSha256);
  if (existing) return { run: existing, created: false };

  const primary = createInternalAiProviderAdapter(config.active, {
    credentialOverride: activeCredential,
    executionMode: "PRODUCTION",
    expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V1,
  });
  const standby = qualifiedStandby
    ? createInternalAiProviderAdapter(qualifiedStandby, {
        executionMode: "STANDBY_FAILOVER",
        expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V1,
      })
    : undefined;
  const orchestrator = new AiContextMapperOrchestrator(repository, primary, standby, {
    standbyEnabled: config.standbyEnabled,
    standbyGovernanceQualified: config.standbyGovernanceQualified,
    providerConfigurationSnapshot: config.providerConfigurationSnapshot,
    primaryRequestTimeoutMs: config.active.timeoutMs,
    standbyRequestTimeoutMs: qualifiedStandby?.timeoutMs ?? config.active.timeoutMs,
  });
  try {
    return { run: await orchestrator.run(input), created: true };
  } catch (error) {
    if (error instanceof ExistingMappingRunError) return { run: error.run, created: false };
    throw error;
  }
}

export async function createAiContextMappingRun(raw: unknown): Promise<MappingRunView> {
  return (await createAiContextMappingRunOperation(raw)).run;
}

export async function readAiContextMappingRun(runId: string): Promise<MappingRunView> {
  assertUuid(runId, "Mapping run ID");
  return new PostgresAiContextMappingRepository().readRun(runId);
}

export async function listAiContextMappingAttempts(runId: string): Promise<MappingAttemptView[]> {
  assertUuid(runId, "Mapping run ID");
  const repository = new PostgresAiContextMappingRepository();
  await repository.readRun(runId);
  return repository.listAttempts(runId);
}

export async function recordAiContextMappingOwnerVerdict(runId: string, raw: unknown, ownerAuthority: string): Promise<MappingRunView> {
  assertUuid(runId, "Mapping run ID");
  const command = ownerReviewCommandSchema.parse(raw);
  const repository = new PostgresAiContextMappingRepository();
  let contextDecisions: Array<{ contextId: string; decision: "ACCEPT" | "REJECT"; note?: string }>;
  if ("rejectEntireProposal" in command) {
    const run = await repository.readRun(runId);
    if (!run.proposal) throw new HttpCommandError(409, "VALIDATED_PROPOSAL_REQUIRED", "A validated Proposal is required before Owner review.");
    contextDecisions = run.proposal.modelProposal.contexts.map(context => ({ contextId: context.context_id, decision: "REJECT" }));
  } else {
    contextDecisions = command.contextDecisions;
  }
  return repository.recordOwnerReview({
    runId,
    verdict: command.verdict,
    contextDecisions,
    ...(command.note ? { note: command.note } : {}),
    ownerAuthority,
    createdAt: new Date().toISOString(),
  });
}

export function toCustomerMappingAttemptView(attempt: MappingAttemptView): CustomerMappingAttemptView {
  return {
    id: attempt.id,
    runId: attempt.runId,
    ordinal: attempt.ordinal,
    status: attempt.status,
    startedAt: attempt.startedAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.durationMs !== undefined ? { durationMs: attempt.durationMs } : {}),
    ...(attempt.rawResponseSha256 ? { rawResponseSha256: attempt.rawResponseSha256 } : {}),
    ...(attempt.parsedCatalogSha256 ? { parsedCatalogSha256: attempt.parsedCatalogSha256 } : {}),
    ...(attempt.validationResult ? { validationResult: attempt.validationResult } : {}),
  };
}

export function toCustomerMappingRunView(run: MappingRunView): CustomerMappingRunView {
  return {
    id: run.id,
    status: run.status,
    mappingInputSnapshotId: run.mappingInputSnapshotId,
    mappingInputSha256: run.mappingInputSha256,
    workspaceSnapshotId: run.workspaceSnapshotId,
    workspaceIndexSha256: run.workspaceIndexSha256,
    ...(run.workspaceIndexSnapshotId ? { workspaceIndexSnapshotId: run.workspaceIndexSnapshotId } : {}),
    ...(run.canonicalIndexArtifactId ? { canonicalIndexArtifactId: run.canonicalIndexArtifactId } : {}),
    ...(run.artifactSemanticSha256 ? { artifactSemanticSha256: run.artifactSemanticSha256 } : {}),
    eligibleEntryCount: run.eligibleEntryCount,
    excludedEntryCount: run.excludedEntryCount,
    estimatedTokens: run.estimatedTokens,
    ...(run.finalAttemptId ? { finalAttemptId: run.finalAttemptId } : {}),
    ownerVerdictState: run.ownerVerdictState,
    ...(run.ownerVerdictNote ? { ownerVerdictNote: run.ownerVerdictNote } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.proposal ? {
      proposal: {
        id: run.proposal.id,
        runId: run.proposal.runId,
        attemptId: run.proposal.attemptId,
        proposalSha256: run.proposal.proposalSha256,
        schemaVersion: run.proposal.schemaVersion,
        validationEvidence: run.proposal.validationEvidence,
        modelProposal: run.proposal.modelProposal,
        createdAt: run.proposal.createdAt,
      },
    } : {}),
    ownerContextDecisions: run.ownerContextDecisions,
  };
}
