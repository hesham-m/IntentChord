import { canonicalJson, sha256Canonical } from "@/core/truth/project-truth-hash";
import type {
  CanonicalWorkspaceIndexContract,
  WorkspaceIndexIntegrity,
  WorkspaceIndexSnapshot,
} from "@/core/workspace-index/types";

export { canonicalJson, sha256Canonical };

export const WORKSPACE_SOURCE_STATE_FINGERPRINT_VERSION = "intentchord.workspace-source-state-fingerprint/v2" as const;

export function stableWorkspaceIndexId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Canonical(value)}`;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizedSourcePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export type WorkspaceSourceStateFileMaterial = {
  relative_path: string;
  size_bytes: number;
  content_hash: string;
};

/**
 * Canonical Workspace Source-State fingerprint material is intentionally limited to source-intrinsic state.
 * Index/parser/policy classifications (language, kind, sensitivity, parse status, metadata_hash) do not participate.
 */
export function workspaceSourceStateFingerprintFromFiles(files: WorkspaceSourceStateFileMaterial[]): string {
  const sourceFiles = files
    .map(file => ({
      relative_path: normalizedSourcePath(file.relative_path),
      size_bytes: file.size_bytes,
      content_hash: file.content_hash,
    }))
    .sort((left, right) => compareText(left.relative_path, right.relative_path) || compareText(left.content_hash, right.content_hash));
  return `sha256:${sha256Canonical({ schema: WORKSPACE_SOURCE_STATE_FINGERPRINT_VERSION, files: sourceFiles })}`;
}

export function normalizedWorkspaceIndexSnapshot(snapshot: WorkspaceIndexSnapshot): WorkspaceIndexSnapshot {
  return {
    files: [...snapshot.files].sort((left, right) =>
      compareText(left.relative_path, right.relative_path)
      || compareText(left.file_revision_id, right.file_revision_id)),
    facts: [...snapshot.facts].sort((left, right) =>
      compareText(left.fact_type, right.fact_type)
      || compareText(left.qualified_name, right.qualified_name)
      || compareText(left.fact_revision_id, right.fact_revision_id)),
    relations: [...snapshot.relations].sort((left, right) =>
      compareText(left.relation_type, right.relation_type)
      || compareText(left.source.entity_revision_id, right.source.entity_revision_id)
      || compareText(left.target.entity_revision_id, right.target.entity_revision_id)
      || compareText(left.relation_revision_id, right.relation_revision_id)),
    content_references: [...snapshot.content_references].sort((left, right) =>
      compareText(left.file_revision_id, right.file_revision_id)
      || compareText(left.content_ref_id, right.content_ref_id)),
  };
}

export function workspaceTreeFingerprint(snapshot: WorkspaceIndexSnapshot): string {
  return workspaceSourceStateFingerprintFromFiles(normalizedWorkspaceIndexSnapshot(snapshot).files);
}

export function canonicalWorkspaceIndexPayload(contract: CanonicalWorkspaceIndexContract): unknown {
  return {
    contract_type: contract.contract_type,
    contract_version: contract.contract_version,
    contract_id: contract.contract_id,
    contract_status: contract.contract_status,
    workspace: contract.workspace,
    source_binding: contract.source_binding,
    generation: contract.generation,
    snapshot: normalizedWorkspaceIndexSnapshot(contract.snapshot),
    delta: contract.delta,
    coverage: contract.coverage,
    failures: contract.failures,
    integrity: {
      workspace_tree_fingerprint: contract.integrity.workspace_tree_fingerprint,
      file_count: contract.integrity.file_count,
      fact_count: contract.integrity.fact_count,
      relation_count: contract.integrity.relation_count,
      content_reference_count: contract.integrity.content_reference_count,
    },
  };
}

export function canonicalWorkspaceIndexHash(contract: CanonicalWorkspaceIndexContract): string {
  return `sha256:${sha256Canonical(canonicalWorkspaceIndexPayload(contract))}`;
}

export function deriveWorkspaceIndexIntegrity(
  contract: Omit<CanonicalWorkspaceIndexContract, "integrity"> & { integrity?: never },
): WorkspaceIndexIntegrity {
  const normalized = normalizedWorkspaceIndexSnapshot(contract.snapshot);
  const base: CanonicalWorkspaceIndexContract = {
    ...contract,
    snapshot: normalized,
    integrity: {
      workspace_tree_fingerprint: workspaceTreeFingerprint(normalized),
      canonical_payload_hash: "",
      file_count: normalized.files.length,
      fact_count: normalized.facts.length,
      relation_count: normalized.relations.length,
      content_reference_count: normalized.content_references.length,
    },
  };
  return {
    ...base.integrity,
    canonical_payload_hash: canonicalWorkspaceIndexHash(base),
  };
}

export function finalizeWorkspaceIndexContract(
  contract: Omit<CanonicalWorkspaceIndexContract, "integrity">,
): CanonicalWorkspaceIndexContract {
  const normalizedContract = { ...contract, snapshot: normalizedWorkspaceIndexSnapshot(contract.snapshot) };
  return {
    ...normalizedContract,
    integrity: deriveWorkspaceIndexIntegrity(normalizedContract),
  };
}
