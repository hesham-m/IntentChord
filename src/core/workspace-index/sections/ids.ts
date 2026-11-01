import { sha256Canonical } from "@/core/truth/project-truth-hash";
import {
  CANDIDATE_EVIDENCE_ID_SCHEMA_V1,
  DELTA_LINEAGE_RECORD_ID_SCHEMA_V1,
  SOURCE_CONTINUITY_ATTESTATION_ID_SCHEMA_V1,
} from "@/core/workspace-index/sections/sectioned-contracts";

/**
 * Attempt-scoped and lineage identity derivations (SPEC V3 2.5 / 2.6 / 2.7). Exact schemas;
 * deterministic; no undefined "entry material" survives (entry_material is the complete v4-delta
 * sub-entry object).
 */

/** US-2: binds ONLY the immutable attempt; lifecycle contents never feed the id. */
export function continuityAttestationId(snapshotOperationId: string): string {
  return `wca_${sha256Canonical({
    schema: SOURCE_CONTINUITY_ATTESTATION_ID_SCHEMA_V1,
    snapshot_operation_id: snapshotOperationId,
  })}`;
}

/** US-3a: attempt-scoped candidate-evidence id; lives only inside the bounded evidence blob. */
export function candidateEvidenceId(
  snapshotOperationId: string,
  openedBoundaryUsn: number | null,
): string {
  return `wce_${sha256Canonical({
    schema: CANDIDATE_EVIDENCE_ID_SCHEMA_V1,
    snapshot_operation_id: snapshotOperationId,
    opened_boundary_usn: openedBoundaryUsn,
  })}`;
}

export const DELTA_LINEAGE_ENTRY_KINDS = [
  "file_added",
  "file_modified",
  "file_deleted",
  "file_renamed_or_moved",
  "fact_added",
  "fact_modified",
  "fact_removed",
  "fact_lineage_changed",
  "relation_added",
  "relation_modified",
  "relation_removed",
  "content_reference_added",
  "content_reference_modified",
  "content_reference_removed",
  "content_reference_sensitivity_changed",
] as const;
export type DeltaLineageEntryKind = (typeof DELTA_LINEAGE_ENTRY_KINDS)[number];

/** US-3b: deterministic purely from immutable final entry material. */
export function deltaLineageRecordId(input: {
  workspaceRevisionId: string;
  entryKind: DeltaLineageEntryKind;
  entryMaterial: unknown;
}): string {
  return `wdl_${sha256Canonical({
    schema: DELTA_LINEAGE_RECORD_ID_SCHEMA_V1,
    workspace_revision_id: input.workspaceRevisionId,
    section_type: "DELTA_LINEAGE",
    entry_kind: input.entryKind,
    entry_material: input.entryMaterial,
  })}`;
}
