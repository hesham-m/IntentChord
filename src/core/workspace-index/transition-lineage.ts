import type { CanonicalWorkspaceIndexContract } from "@/core/workspace-index/types";

export const WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION = "intentchord.workspace-transition-lineage-evidence/v1" as const;

export type WorkspaceTransitionLineageEvidence = {
  schema: typeof WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION;
  renamed_or_moved: Array<{
    workspace_file_id: string;
    previous_file_revision_id: string;
    current_file_revision_id: string;
    from_relative_path: string;
    to_relative_path: string;
    evidence_scope: "CANONICAL_WORKSPACE_INDEX_V1_OBSERVATION_PROJECTION";
  }>;
};

/**
 * Extracts only lineage that the observation-specific Canonical Workspace Index V1 projection
 * already proved. The evidence is transition-scoped and never participates in intrinsic
 * Canonical Index Artifact identity or semantic hashing.
 */
export function deriveTransitionLineageEvidence(
  previous: CanonicalWorkspaceIndexContract,
  current: CanonicalWorkspaceIndexContract,
): WorkspaceTransitionLineageEvidence {
  const previousByRevision = new Map(previous.snapshot.files.map(file => [file.file_revision_id, file] as const));
  const renamedOrMoved = current.snapshot.files
    .filter(file => file.lineage_state === "RENAMED_OR_MOVED" && Boolean(file.previous_file_revision_id))
    .map(file => {
      const previousFile = previousByRevision.get(file.previous_file_revision_id!);
      if (!previousFile) {
        throw new Error("WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_MISMATCH");
      }
      return {
        workspace_file_id: file.workspace_file_id,
        previous_file_revision_id: previousFile.file_revision_id,
        current_file_revision_id: file.file_revision_id,
        from_relative_path: previousFile.relative_path,
        to_relative_path: file.relative_path,
        evidence_scope: "CANONICAL_WORKSPACE_INDEX_V1_OBSERVATION_PROJECTION" as const,
      };
    })
    .sort((left, right) => `${left.from_relative_path}|${left.to_relative_path}|${left.workspace_file_id}`.localeCompare(
      `${right.from_relative_path}|${right.to_relative_path}|${right.workspace_file_id}`,
    ));

  return {
    schema: WORKSPACE_TRANSITION_LINEAGE_EVIDENCE_VERSION,
    renamed_or_moved: renamedOrMoved,
  };
}
