import {
  buildMappingInputSnapshot,
  buildMappingInputSnapshotFromCanonicalArtifact,
} from "@/core/ai-context-mapper/input-builder";
import { canonicalWorkspaceIndexContractSchema } from "@/core/workspace-index/schema";
import {
  resolveCandidateScopeFromMappingInput,
  TaskContextBindingError,
} from "@/core/tasks/candidate-scope";
import type {
  TaskCandidateScope,
  TaskContextAnalysisBinding,
} from "@/core/tasks/task-input";
import { PostgresAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { HttpCommandError } from "@/server/errors";
import { readPersistedWorkspaceIndexMappingAuthority } from "@/server/workspace-index-snapshot-service";

export async function validateAndResolveTaskContextBinding(
  binding: TaskContextAnalysisBinding,
  boundWorkspaceIds: string[],
): Promise<TaskCandidateScope> {
  const authority = await readPersistedWorkspaceIndexMappingAuthority(binding.workspaceIndexSnapshotId);
  const snapshot = authority.snapshot;
  if (snapshot.status !== "READY") {
    throw new HttpCommandError(409, "READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", "Mapping requires a persisted READY Workspace Index Snapshot.");
  }

  let mappingInput;
  if (snapshot.sourceMode === "REGISTERED_WORKSPACE" && authority.artifact) {
    if (snapshot.canonicalIndexArtifactId) {
      mappingInput = buildMappingInputSnapshotFromCanonicalArtifact({
        canonicalIndexArtifactId: authority.artifact.id,
        artifactSemanticSha256: authority.artifact.semanticSha256,
        semanticState: authority.artifact.semanticState as import("@/core/workspace-index/artifact-identity").CanonicalIndexArtifactSemanticState,
      });
    } else if (snapshot.acceptedWorkspaceEvidenceArtifactId) {
      throw new HttpCommandError(409, "READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", "V2 Mapping through the Registered Mapping Authority reader is not yet supported. Use the V2 Context Mapping path.");
    } else {
      throw new HttpCommandError(409, "READY_WORKSPACE_INDEX_SNAPSHOT_REQUIRED", "Mapping requires a persisted READY Workspace Index Snapshot.");
    }
  } else {
    if (!snapshot.canonicalIndex) {
      throw new HttpCommandError(409, "WORKSPACE_INDEX_PAYLOAD_MISSING", "Workspace Index Snapshot payload is missing.");
    }
    const canonicalIndex = canonicalWorkspaceIndexContractSchema.parse(snapshot.canonicalIndex);
    mappingInput = buildMappingInputSnapshot(canonicalIndex);
  }

  const mappingRepository = new PostgresAiContextMappingRepository();
  const run = await mappingRepository.readRun(binding.mappingRunId);
  if (!run) {
    throw new HttpCommandError(404, "MAPPING_RUN_NOT_FOUND", `Mapping run ${binding.mappingRunId} was not found.`);
  }

  if (run.workspaceIndexSnapshotId && run.workspaceIndexSnapshotId !== binding.workspaceIndexSnapshotId) {
    throw new HttpCommandError(409, "MAPPING_RUN_WORKSPACE_SNAPSHOT_MISMATCH", "The mapping run does not match the bound Workspace Index Snapshot.");
  }

  if (!run.proposal) {
    throw new HttpCommandError(409, "VALIDATED_PROPOSAL_REQUIRED", "A validated Context Proposal is required.");
  }

  try {
    return resolveCandidateScopeFromMappingInput({
      binding,
      workspaceIndexSnapshotId: binding.workspaceIndexSnapshotId,
      mappingRunId: run.id,
      proposalId: run.proposal.id,
      proposalSha256: run.proposal.proposalSha256,
      ownerVerdictState: run.ownerVerdictState,
      catalog: run.proposal.modelProposal,
      ownerContextDecisions: run.ownerContextDecisions,
      mappingInputEntries: mappingInput.entries,
      boundWorkspaceIds,
    });
  } catch (error) {
    if (error instanceof TaskContextBindingError) {
      throw new HttpCommandError(422, error.code, error.message, error.details);
    }
    throw error;
  }
}
