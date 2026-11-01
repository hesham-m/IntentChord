import { canonicalJson, normalizedWorkspaceIndexSnapshot, sha256Canonical, stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import {
  DEFAULT_WORKSPACE_INDEX_BUDGETS,
  WORKSPACE_FILE_CLASSIFICATION_POLICY_ID,
  WORKSPACE_SENSITIVITY_POLICY_ID,
  WORKSPACE_TRAVERSAL_POLICY_ID,
  normalizeAuthorityRelativePath,
  type WorkspaceIndexBudgets,
} from "@/core/workspace-index/adapters/filesystem";
import { CSV_BOUNDED_PROFILE_PARSER_ID, CSV_BOUNDED_PROFILE_PARSER_VERSION } from "@/core/workspace-index/csv-profile";
import {
  DEFAULT_WORKSPACE_DURATION_GOVERNANCE,
  workspaceDurationConfigurationIdentity,
  type WorkspaceDurationConfigurationIdentity,
  type WorkspaceDurationGovernance,
} from "@/core/workspace-index/duration-governance";
import {
  CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
  COMPARISON_ENGINE_VERSION,
  DELTA_SCHEMA_VERSION,
  PARSER_REGISTRY_VERSION,
  RELATION_REGISTRY_VERSION,
  WORKSPACE_INDEXER_NAME,
  WORKSPACE_INDEXER_VERSION,
  type CanonicalWorkspaceIndexContract,
  type WorkspaceFactRecord,
  type WorkspaceFileRecord,
  type WorkspaceIndexFailure,
  type WorkspaceIndexSnapshot,
  type WorkspaceRelationRecord,
} from "@/core/workspace-index/types";

export const WORKSPACE_REVISION_MODEL_VERSION = "intentchord.workspace-revision-model/v2" as const;
export const CANONICAL_INDEX_ARTIFACT_MODEL_VERSION = "intentchord.canonical-index-artifact/v6" as const;
export const CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION = "intentchord.canonical-index-artifact-semantic-state/v6" as const;
export const WORKSPACE_OBSERVATION_MODEL_VERSION = "intentchord.workspace-observation/v1" as const;
export const DEFAULT_DEEP_PARSE_BYTES = 2 * 1024 * 1024;

export type WorkspaceObservationResult =
  | "FIRST_INDEXED"
  | "SOURCE_UNCHANGED"
  | "SOURCE_CHANGED"
  | "KNOWN_STATE_RESTORED"
  | "SOURCE_UNCHANGED_INDEX_REFRESHED"
  | "SOURCE_PROVEN_INDEX_FAILED";

export type WorkspaceIndexConfigurationDescriptor = {
  schema: typeof CANONICAL_INDEX_ARTIFACT_MODEL_VERSION;
  canonical_contract_version: typeof CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION;
  indexer: { name: typeof WORKSPACE_INDEXER_NAME; version: typeof WORKSPACE_INDEXER_VERSION };
  parser_registry_version: typeof PARSER_REGISTRY_VERSION;
  relation_registry_version: typeof RELATION_REGISTRY_VERSION;
  traversal_policy_id: typeof WORKSPACE_TRAVERSAL_POLICY_ID;
  file_classification_policy_id: typeof WORKSPACE_FILE_CLASSIFICATION_POLICY_ID;
  sensitivity_policy_id: typeof WORKSPACE_SENSITIVITY_POLICY_ID;
  csv_profile: { parser_id: typeof CSV_BOUNDED_PROFILE_PARSER_ID; parser_version: typeof CSV_BOUNDED_PROFILE_PARSER_VERSION };
  deep_parse_bytes: number;
  budgets: WorkspaceIndexBudgets;
  duration_governance: WorkspaceDurationConfigurationIdentity;
};

export type CanonicalIndexArtifactSemanticFailure = Omit<WorkspaceIndexFailure, "failure_id" | "occurred_at" | "file_revision_id"> & {
  file_revision_id?: string;
};

export type CanonicalIndexArtifactFactProvenance = Omit<WorkspaceFactRecord["provenance"], "workspace_revision_id">;
export type CanonicalIndexArtifactFactRecord = Omit<WorkspaceFactRecord, "provenance"> & {
  provenance: CanonicalIndexArtifactFactProvenance;
};
export type CanonicalIndexArtifactSnapshot = Omit<WorkspaceIndexSnapshot, "facts"> & {
  facts: CanonicalIndexArtifactFactRecord[];
};

export type CanonicalIndexArtifactSemanticState = {
  schema: typeof CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION;
  workspace_instance_id: string;
  workspace_revision_id: string;
  contract_status: CanonicalWorkspaceIndexContract["contract_status"];
  snapshot: CanonicalIndexArtifactSnapshot;
  coverage: CanonicalWorkspaceIndexContract["coverage"];
  failures: CanonicalIndexArtifactSemanticFailure[];
};

export type CanonicalArtifactQualification = {
  qualified: boolean;
  retryable_failure_codes: string[];
};

export function workspaceIndexConfigurationDescriptor(input: {
  maxParseBytes?: number;
  budgets?: Partial<WorkspaceIndexBudgets>;
  durationGovernance?: WorkspaceDurationGovernance;
} = {}): WorkspaceIndexConfigurationDescriptor {
  return {
    schema: CANONICAL_INDEX_ARTIFACT_MODEL_VERSION,
    canonical_contract_version: CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
    indexer: { name: WORKSPACE_INDEXER_NAME, version: WORKSPACE_INDEXER_VERSION },
    parser_registry_version: PARSER_REGISTRY_VERSION,
    relation_registry_version: RELATION_REGISTRY_VERSION,
    traversal_policy_id: WORKSPACE_TRAVERSAL_POLICY_ID,
    file_classification_policy_id: WORKSPACE_FILE_CLASSIFICATION_POLICY_ID,
    sensitivity_policy_id: WORKSPACE_SENSITIVITY_POLICY_ID,
    csv_profile: { parser_id: CSV_BOUNDED_PROFILE_PARSER_ID, parser_version: CSV_BOUNDED_PROFILE_PARSER_VERSION },
    deep_parse_bytes: input.maxParseBytes ?? DEFAULT_DEEP_PARSE_BYTES,
    budgets: { ...DEFAULT_WORKSPACE_INDEX_BUDGETS, ...input.budgets },
    duration_governance: workspaceDurationConfigurationIdentity(input.durationGovernance ?? DEFAULT_WORKSPACE_DURATION_GOVERNANCE),
  };
}

export function workspaceIndexConfigurationSha256(descriptor: WorkspaceIndexConfigurationDescriptor): string {
  return `sha256:${sha256Canonical(descriptor)}`;
}

// ---------------------------------------------------------------------------
// R6 — Frozen Continuity Policy Descriptor + Hash
// ---------------------------------------------------------------------------

/**
 * R6 frozen continuity policy descriptor.
 *
 * Semantic material is EXACTLY the four fields below — no more, no less.
 * The sha256 over this descriptor is the authoritative currentPolicyHash
 * governing continuity attestation.
 */
export type ContinuityR6PolicyDescriptor = {
  traversalPolicyId: typeof WORKSPACE_TRAVERSAL_POLICY_ID;
  classificationPolicyId: typeof WORKSPACE_FILE_CLASSIFICATION_POLICY_ID;
  sensitivityPolicyId: typeof WORKSPACE_SENSITIVITY_POLICY_ID;
  ownerRestrictedPaths: string[];
};

/**
 * Builds the frozen R6 continuity policy descriptor.
 *
 * ownerRestrictedPaths must come from the governed workspace/index authority
 * (the current operation's governed scope).  Each path is canonicalized
 * through the SAME authority used for filesystem traversal:
 * normalizeAuthorityRelativePath — which normalizes separators, collapses
 * repeated slashes, strips leading "./" and trailing "/", and rejects
 * absolute paths, "." / ".." segments, and NUL.
 *
 * After normalization: deduplicate, then sort deterministically.
 */
export function buildContinuityR6PolicyDescriptor(
  ownerRestrictedPaths: string[],
): ContinuityR6PolicyDescriptor {
  const canonicalPaths = [...new Set(
    ownerRestrictedPaths.map(p => normalizeAuthorityRelativePath(p)),
  )].filter(p => p.length > 0).sort();
  return {
    traversalPolicyId: WORKSPACE_TRAVERSAL_POLICY_ID,
    classificationPolicyId: WORKSPACE_FILE_CLASSIFICATION_POLICY_ID,
    sensitivityPolicyId: WORKSPACE_SENSITIVITY_POLICY_ID,
    ownerRestrictedPaths: canonicalPaths,
  };
}

/**
 * Computes the frozen R6 continuity policy hash.
 *
 * This is the SINGLE SOURCE for currentPolicyHash.
 * Uses the existing canonical hash authority (sha256Canonical).
 */
export function continuityR6PolicyHash(ownerRestrictedPaths: string[]): string {
  return `sha256:${sha256Canonical(buildContinuityR6PolicyDescriptor(ownerRestrictedPaths))}`;
}

export function canonicalIndexArtifactId(workspaceRevisionId: string, indexConfigurationSha256: string): string {
  return stableWorkspaceIndexId("cia", {
    schema: CANONICAL_INDEX_ARTIFACT_MODEL_VERSION,
    workspace_revision_id: workspaceRevisionId,
    index_configuration_sha256: indexConfigurationSha256,
  });
}

/**
 * Retryable runtime/index-attempt outcomes are not immutable Canonical Artifact truth.
 * Source-state incompleteness fails earlier in the Indexer; this guard prevents transient semantic failures
 * from claiming the deterministic Revision + Config Artifact identity.
 */
export function canonicalIndexArtifactQualification(contract: CanonicalWorkspaceIndexContract): CanonicalArtifactQualification {
  const retryableFailureCodes = contract.failures
    .filter(failure => failure.recoverability === "RETRYABLE")
    .map(failure => failure.error_code)
    .sort();
  return { qualified: retryableFailureCodes.length === 0, retryable_failure_codes: retryableFailureCodes };
}

function normalizedArtifactRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function normalizedCanonicalIndexArtifactSnapshot(snapshot: CanonicalIndexArtifactSnapshot): CanonicalIndexArtifactSnapshot {
  const compare = (left: string, right: string) => left === right ? 0 : left < right ? -1 : 1;
  return {
    files: [...snapshot.files].sort((left, right) => compare(left.relative_path, right.relative_path) || compare(left.file_revision_id, right.file_revision_id)),
    facts: [...snapshot.facts].sort((left, right) => compare(left.fact_type, right.fact_type) || compare(left.qualified_name, right.qualified_name) || compare(left.fact_revision_id, right.fact_revision_id)),
    relations: [...snapshot.relations].sort((left, right) => compare(left.relation_type, right.relation_type) || compare(left.source.entity_revision_id, right.source.entity_revision_id) || compare(left.target.entity_revision_id, right.target.entity_revision_id) || compare(left.relation_revision_id, right.relation_revision_id)),
    content_references: [...snapshot.content_references].sort((left, right) => compare(left.file_revision_id, right.file_revision_id) || compare(left.content_ref_id, right.content_ref_id)),
  };
}

function intrinsicWorkspaceFileId(input: {
  workspaceInstanceId: string;
  file: WorkspaceFileRecord;
}): string {
  return stableWorkspaceIndexId("wfi", {
    schema: "intentchord.workspace-file-logical-identity/v2",
    workspace_instance_id: input.workspaceInstanceId,
    normalized_relative_path: normalizedArtifactRelativePath(input.file.relative_path),
  });
}

function intrinsicFileRevisionId(input: {
  workspaceFileId: string;
  file: WorkspaceFileRecord;
}): string {
  return stableWorkspaceIndexId("fir", {
    schema: "intentchord.file-revision-intrinsic/v2",
    workspace_file_id: input.workspaceFileId,
    content_hash: input.file.content_hash,
    size_bytes: input.file.size_bytes,
  });
}

function factPosition(fact: WorkspaceFactRecord): number {
  return fact.source_location.byte_range?.start
    ?? fact.source_location.line_range?.start
    ?? Number.MAX_SAFE_INTEGER;
}

function factLogicalOrdering(left: WorkspaceFactRecord, right: WorkspaceFactRecord): number {
  return factPosition(left) - factPosition(right)
    || left.qualified_name.localeCompare(right.qualified_name)
    || left.display_name.localeCompare(right.display_name)
    || canonicalJson(left.source_location).localeCompare(canonicalJson(right.source_location))
    || left.fact_type.localeCompare(right.fact_type);
}

function relationLogicalId(
  entityType: "FILE" | "FACT",
  revisionId: string,
  fileLogicalByRevision: Map<string, string>,
  factLogicalByRevision: Map<string, string>,
): string {
  const logical = entityType === "FILE" ? fileLogicalByRevision.get(revisionId) : factLogicalByRevision.get(revisionId);
  if (!logical) throw new Error(`CANONICAL_ARTIFACT_RELATION_ENDPOINT_MISSING:${entityType}:${revisionId}`);
  return logical;
}

/**
 * Produces the intrinsic, predecessor-independent semantic state for a registered B1 Canonical Index Artifact.
 * Canonical Workspace Index V1 remains the observation-specific compatibility projection.
 * Entity revision identities are local to each logical entity and do not inherit whole-Workspace revision churn.
 */
export function canonicalIndexArtifactSemanticState(contract: CanonicalWorkspaceIndexContract): CanonicalIndexArtifactSemanticState {
  const workspaceInstanceId = contract.workspace.workspace_instance_id;
  const workspaceRevisionId = contract.workspace.workspace_revision_id;
  const sourceSnapshot = normalizedWorkspaceIndexSnapshot(contract.snapshot);

  const fileLogicalByRevision = new Map<string, string>();
  const fileRevisionByRevision = new Map<string, string>();
  const contentRefByOldId = new Map<string, string>();

  const files = sourceSnapshot.files.map(file => {
    const workspaceFileId = intrinsicWorkspaceFileId({ workspaceInstanceId, file });
    const fileRevisionId = intrinsicFileRevisionId({ workspaceFileId, file });
    const contentRefId = stableWorkspaceIndexId("wcr", {
      workspace_instance_id: workspaceInstanceId,
      workspace_file_id: workspaceFileId,
    });
    fileLogicalByRevision.set(file.file_revision_id, workspaceFileId);
    fileRevisionByRevision.set(file.file_revision_id, fileRevisionId);
    if (file.content_ref_id) contentRefByOldId.set(file.content_ref_id, contentRefId);
    const {
      lineage_state: _lineageState,
      previous_file_revision_id: _previousFileRevisionId,
      possible_lineage: _possibleLineage,
      ...intrinsic
    } = file;
    return {
      ...intrinsic,
      workspace_file_id: workspaceFileId,
      file_revision_id: fileRevisionId,
      ...(file.content_ref_id ? { content_ref_id: contentRefId } : {}),
      lineage_state: "UNPROVEN" as const,
    };
  });

  const factLogicalByRevision = new Map<string, string>();
  const factsBySource = new Map<string, WorkspaceFactRecord[]>();
  for (const fact of sourceSnapshot.facts) {
    const items = factsBySource.get(fact.source_file_revision_id) ?? [];
    items.push(fact);
    factsBySource.set(fact.source_file_revision_id, items);
  }

  for (const [oldSourceRevisionId, sourceFacts] of factsBySource) {
    const intrinsicWorkspaceFileId = fileLogicalByRevision.get(oldSourceRevisionId);
    if (!intrinsicWorkspaceFileId) throw new Error(`CANONICAL_ARTIFACT_FACT_SOURCE_MISSING:${oldSourceRevisionId}`);
    const occurrenceBySignature = new Map<string, number>();
    for (const fact of [...sourceFacts].sort(factLogicalOrdering)) {
      const identitySignature = fact.source_location.normalized_signature ?? fact.qualified_name;
      const occurrenceKey = `${fact.fact_type}|${identitySignature}`;
      const occurrenceOrdinal = occurrenceBySignature.get(occurrenceKey) ?? 0;
      occurrenceBySignature.set(occurrenceKey, occurrenceOrdinal + 1);
      factLogicalByRevision.set(fact.fact_revision_id, stableWorkspaceIndexId("wfa", {
        schema: "intentchord.workspace-fact-logical-identity/v2",
        workspace_instance_id: workspaceInstanceId,
        workspace_file_id: intrinsicWorkspaceFileId,
        fact_type: fact.fact_type,
        normalized_signature: identitySignature,
        occurrence_ordinal: occurrenceOrdinal,
      }));
    }
  }

  const factRevisionByRevision = new Map<string, string>();
  for (const fact of sourceSnapshot.facts) {
    const workspaceFactId = factLogicalByRevision.get(fact.fact_revision_id);
    const intrinsicSourceRevisionId = fileRevisionByRevision.get(fact.source_file_revision_id);
    if (!workspaceFactId || !intrinsicSourceRevisionId) throw new Error(`CANONICAL_ARTIFACT_FACT_REVISION_SOURCE_MISSING:${fact.fact_revision_id}`);
    const parentWorkspaceFactId = fact.parent_fact_revision_id
      ? factLogicalByRevision.get(fact.parent_fact_revision_id)
      : undefined;
    if (fact.parent_fact_revision_id && !parentWorkspaceFactId) throw new Error(`CANONICAL_ARTIFACT_PARENT_FACT_MISSING:${fact.parent_fact_revision_id}`);
    factRevisionByRevision.set(fact.fact_revision_id, stableWorkspaceIndexId("far", {
      schema: "intentchord.fact-revision-intrinsic/v2",
      workspace_fact_id: workspaceFactId,
      fact_type: fact.fact_type,
      qualified_name: fact.qualified_name,
      display_name: fact.display_name,
      attributes: fact.attributes,
      source_location: fact.source_location,
      parent_workspace_fact_id: parentWorkspaceFactId ?? null,
      extraction_method: fact.extraction_method,
      extractor_id: fact.extractor_id,
      extractor_version: fact.extractor_version,
      certainty: fact.certainty,
      evidence_role: fact.evidence_role,
      evidence_hash: fact.provenance.evidence_hash,
    }));
  }

  const facts: CanonicalIndexArtifactFactRecord[] = sourceSnapshot.facts.map(fact => {
    const workspaceFactId = factLogicalByRevision.get(fact.fact_revision_id)!;
    const factRevisionId = factRevisionByRevision.get(fact.fact_revision_id)!;
    const sourceFileRevisionId = fileRevisionByRevision.get(fact.source_file_revision_id)!;
    const parentFactRevisionId = fact.parent_fact_revision_id
      ? factRevisionByRevision.get(fact.parent_fact_revision_id)
      : undefined;
    const { workspace_revision_id: _containerWorkspaceRevision, ...intrinsicProvenance } = fact.provenance;
    return {
      ...fact,
      workspace_fact_id: workspaceFactId,
      fact_revision_id: factRevisionId,
      source_file_revision_id: sourceFileRevisionId,
      ...(parentFactRevisionId ? { parent_fact_revision_id: parentFactRevisionId } : {}),
      provenance: {
        ...intrinsicProvenance,
        file_revision_id: sourceFileRevisionId,
      },
    };
  });

  const relations: WorkspaceRelationRecord[] = sourceSnapshot.relations.map(relation => {
    const sourceRevisionId = relation.source.entity_type === "FILE"
      ? fileRevisionByRevision.get(relation.source.entity_revision_id)
      : factRevisionByRevision.get(relation.source.entity_revision_id);
    const targetRevisionId = relation.target.entity_type === "FILE"
      ? fileRevisionByRevision.get(relation.target.entity_revision_id)
      : factRevisionByRevision.get(relation.target.entity_revision_id);
    if (!sourceRevisionId || !targetRevisionId) throw new Error(`CANONICAL_ARTIFACT_RELATION_REVISION_MISSING:${relation.relation_revision_id}`);
    const sourceLogicalId = relationLogicalId(relation.source.entity_type, relation.source.entity_revision_id, fileLogicalByRevision, factLogicalByRevision);
    const targetLogicalId = relationLogicalId(relation.target.entity_type, relation.target.entity_revision_id, fileLogicalByRevision, factLogicalByRevision);
    const workspaceRelationId = stableWorkspaceIndexId("wre", {
      schema: "intentchord.workspace-relation-logical-identity/v2",
      workspace_instance_id: workspaceInstanceId,
      relation_type: relation.relation_type,
      direction: relation.direction,
      source_logical_id: sourceLogicalId,
      target_logical_id: targetLogicalId,
    });
    const evidenceRefs = relation.evidence_refs
      .map(ref => ({ ...ref, file_revision_id: fileRevisionByRevision.get(ref.file_revision_id) ?? ref.file_revision_id }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const intrinsicEvidence = relation.evidence_refs
      .map(ref => ({
        workspace_file_id: fileLogicalByRevision.get(ref.file_revision_id) ?? ref.file_revision_id,
        source_location: ref.source_location,
        evidence_hash: ref.evidence_hash,
        extractor_id: ref.extractor_id,
        extractor_version: ref.extractor_version,
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const relationRevisionId = stableWorkspaceIndexId("rer", {
      schema: "intentchord.relation-revision-intrinsic/v2",
      workspace_relation_id: workspaceRelationId,
      relation_type: relation.relation_type,
      direction: relation.direction,
      source_logical_id: sourceLogicalId,
      target_logical_id: targetLogicalId,
      attributes: relation.attributes,
      evidence: intrinsicEvidence,
      extraction_method: relation.extraction_method,
      extractor_id: relation.extractor_id,
      extractor_version: relation.extractor_version,
      certainty: relation.certainty,
      evidence_role: relation.evidence_role,
    });
    return {
      ...relation,
      workspace_relation_id: workspaceRelationId,
      relation_revision_id: relationRevisionId,
      source: { ...relation.source, entity_revision_id: sourceRevisionId },
      target: { ...relation.target, entity_revision_id: targetRevisionId },
      evidence_refs: evidenceRefs,
    };
  });

  const contentReferences = sourceSnapshot.content_references.map(ref => ({
    ...ref,
    content_ref_id: contentRefByOldId.get(ref.content_ref_id)
      ?? stableWorkspaceIndexId("wcr", {
        workspace_instance_id: workspaceInstanceId,
        workspace_file_id: fileLogicalByRevision.get(ref.file_revision_id) ?? ref.content_ref_id,
      }),
    file_revision_id: fileRevisionByRevision.get(ref.file_revision_id) ?? ref.file_revision_id,
  }));

  // Boundary/observation evidence (for example a deliberately non-followed symlink) is governed
  // evidence about how this Observation encountered the filesystem. It is not intrinsic semantic
  // Artifact state when the boundary member is intentionally excluded from Source Revision identity.
  const failures: CanonicalIndexArtifactSemanticFailure[] = contract.failures
    .filter(item => item.error_code !== "SYMLINK_NOT_FOLLOWED" && item.failure_type !== "SYMLINK_NOT_FOLLOWED")
    .map(item => ({
      ...(item.file_revision_id ? { file_revision_id: fileRevisionByRevision.get(item.file_revision_id) ?? item.file_revision_id } : {}),
      stage: item.stage,
      failure_type: item.failure_type,
      error_code: item.error_code,
      sanitized_message: item.sanitized_message,
      ...(item.extractor_id ? { extractor_id: item.extractor_id } : {}),
      ...(item.extractor_version ? { extractor_version: item.extractor_version } : {}),
      recoverability: item.recoverability,
      impact: item.impact,
    })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const intrinsicContractStatus = failures.length > 0 || files.some(file => file.coverage_state !== "COMPLETE")
    ? "COMPLETE_WITH_GAPS" as const
    : "COMPLETE" as const;

  return {
    schema: CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION,
    workspace_instance_id: workspaceInstanceId,
    workspace_revision_id: workspaceRevisionId,
    contract_status: intrinsicContractStatus,
    snapshot: normalizedCanonicalIndexArtifactSnapshot({ files, facts, relations, content_references: contentReferences }),
    coverage: contract.coverage,
    failures,
  };
}

export function canonicalIndexArtifactSemanticStateSha256(state: CanonicalIndexArtifactSemanticState): string {
  return `sha256:${sha256Canonical(state)}`;
}

export function canonicalIndexArtifactSemanticSha256(contract: CanonicalWorkspaceIndexContract): string {
  return canonicalIndexArtifactSemanticStateSha256(canonicalIndexArtifactSemanticState(contract));
}

export function workspaceIndexDeltaArtifactId(input: {
  fromArtifactId: string;
  toArtifactId: string;
}): string {
  return stableWorkspaceIndexId("wida", {
    from_canonical_index_artifact_id: input.fromArtifactId,
    to_canonical_index_artifact_id: input.toArtifactId,
    delta_schema_version: DELTA_SCHEMA_VERSION,
    comparison_engine_version: COMPARISON_ENGINE_VERSION,
  });
}

export function classifyWorkspaceObservation(input: {
  previousRevisionId?: string;
  previousArtifactId?: string;
  currentRevisionId: string;
  currentArtifactId: string;
  revisionWasKnown: boolean;
}): WorkspaceObservationResult {
  if (!input.previousRevisionId) return "FIRST_INDEXED";
  if (input.previousRevisionId === input.currentRevisionId) {
    return input.previousArtifactId === input.currentArtifactId
      ? "SOURCE_UNCHANGED"
      : "SOURCE_UNCHANGED_INDEX_REFRESHED";
  }
  return input.revisionWasKnown ? "KNOWN_STATE_RESTORED" : "SOURCE_CHANGED";
}
