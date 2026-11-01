import {
  B1_MAPPING_INPUT_SCHEMA_VERSION,
  MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
  MAPPING_INPUT_SCHEMA_VERSION,
  type B1CanonicalArtifactMappingInputSnapshot,
  type LegacyMappingInputSnapshot,
  type MappingInputEntry,
  type MappingInputSnapshot,
} from "@/core/ai-context-mapper/types";
import { AiContextMapperError } from "@/core/ai-context-mapper/errors";
import { canonicalJson, estimatedTokensForUtf8, mapperSha256, stableMapperId } from "@/core/ai-context-mapper/canonical";
import { mappingInputSnapshotSchema } from "@/core/ai-context-mapper/schema";
import {
  CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION,
  canonicalIndexArtifactSemanticStateSha256,
  type CanonicalIndexArtifactSemanticState,
  type CanonicalIndexArtifactSnapshot,
} from "@/core/workspace-index/artifact-identity";
import { canonicalWorkspaceIndexHash } from "@/core/workspace-index/canonical";
import { canonicalIndexArtifactSnapshotSchema } from "@/core/workspace-index/schema";
import {
  CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
  type CanonicalWorkspaceIndexContract,
  type WorkspaceFileRecord,
  type WorkspaceIndexSnapshot,
} from "@/core/workspace-index/types";
import { validateCanonicalWorkspaceIndexContract } from "@/core/workspace-index/validator";

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

type MapperWorkspaceSnapshot = WorkspaceIndexSnapshot | CanonicalIndexArtifactSnapshot;

function assertSecretPolicy(snapshot: MapperWorkspaceSnapshot, sourceBindingMetadata: Record<string, unknown> = {}): void {
  const contentRefs = new Map(snapshot.content_references.map(reference => [reference.file_revision_id, reference]));
  for (const file of snapshot.files) {
    const reference = contentRefs.get(file.file_revision_id);
    if (["SECRET", "CREDENTIAL_LIKE", "OWNER_RESTRICTED"].includes(file.sensitivity_state)) {
      if (reference?.availability_state === "AVAILABLE") {
        throw new AiContextMapperError("MAPPER_INPUT_SECRET_POLICY_FAILED", `Sensitive entry ${file.relative_path} is marked AVAILABLE.`);
      }
    }
  }
  const serializedMetadata = canonicalJson(sourceBindingMetadata).toLowerCase();
  if (/api[_-]?key|password|passwd|secret[_-]?value|access[_-]?token/.test(serializedMetadata)) {
    throw new AiContextMapperError("MAPPER_INPUT_SECRET_POLICY_FAILED", "Source-binding metadata contains a prohibited secret-like field.");
  }
}

function fileFingerprint(file: WorkspaceFileRecord): string {
  return file.content_hash || file.metadata_hash;
}

function buildEntry(workspaceId: string, snapshot: MapperWorkspaceSnapshot, file: WorkspaceFileRecord): MappingInputEntry {
  const facts = snapshot.facts.filter(fact => fact.source_file_revision_id === file.file_revision_id);
  const factRevisionIds = new Set(facts.map(fact => fact.fact_revision_id));
  const relations = snapshot.relations.filter(relation =>
    relation.source.entity_revision_id === file.file_revision_id
    || relation.target.entity_revision_id === file.file_revision_id
    || factRevisionIds.has(relation.source.entity_revision_id)
    || factRevisionIds.has(relation.target.entity_revision_id));
  return {
    entry_id: stableMapperId("mie", {
      workspace_id: workspaceId,
      file_revision_id: file.file_revision_id,
      normalized_path: normalizedPath(file.relative_path),
    }),
    workspace_id: workspaceId,
    normalized_path: normalizedPath(file.relative_path),
    entry_type: "FILE",
    language_or_format: file.language ?? file.file_kind,
    size_bytes: file.size_bytes,
    content_or_metadata_fingerprint: fileFingerprint(file),
    index_supported_signals: {
      file_kind: file.file_kind,
      parse_status: file.parse_status,
      coverage_state: file.coverage_state,
      fact_signals: facts.map(fact => ({
        fact_type: fact.fact_type,
        qualified_name: fact.qualified_name,
        display_name: fact.display_name,
        attributes: fact.attributes,
        certainty: fact.certainty,
        evidence_role: fact.evidence_role,
      })).sort((left, right) => left.qualified_name.localeCompare(right.qualified_name)),
      relation_signals: relations.map(relation => ({
        relation_type: relation.relation_type,
        direction: relation.direction,
        source_entry_or_entity_id: relation.source.entity_revision_id,
        target_entry_or_entity_id: relation.target.entity_revision_id,
        certainty: relation.certainty,
        evidence_role: relation.evidence_role,
      })).sort((left, right) => `${left.relation_type}|${left.source_entry_or_entity_id}|${left.target_entry_or_entity_id}`.localeCompare(`${right.relation_type}|${right.source_entry_or_entity_id}|${right.target_entry_or_entity_id}`)),
    },
  };
}

function governedEntries(input: {
  workspaceId: string;
  snapshot: MapperWorkspaceSnapshot;
  maxEstimatedTokens?: number;
}): {
  entries: MappingInputEntry[];
  excludedEntryCount: number;
  serializedPayloadSha256: string;
  estimatedTokens: number;
} {
  const eligibleFiles = input.snapshot.files.filter(file => file.sensitivity_state === "NORMAL");
  const excludedEntryCount = input.snapshot.files.length - eligibleFiles.length;
  const entries = eligibleFiles.map(file => buildEntry(input.workspaceId, input.snapshot, file)).sort((left, right) =>
    left.workspace_id.localeCompare(right.workspace_id)
    || left.normalized_path.localeCompare(right.normalized_path)
    || left.entry_id.localeCompare(right.entry_id));
  if (!entries.length) throw new AiContextMapperError("MAPPER_INPUT_EMPTY", "The Canonical Workspace Index contains no eligible mapping entries.");
  const serializedEntries = canonicalJson(entries);
  const estimatedTokens = estimatedTokensForUtf8(serializedEntries);
  const maxEstimatedTokens = input.maxEstimatedTokens ?? MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS;
  if (estimatedTokens > maxEstimatedTokens) {
    throw new AiContextMapperError("MAPPER_INPUT_BUDGET_EXCEEDED", `Estimated input ${estimatedTokens} exceeds the provider-neutral budget ${maxEstimatedTokens}.`, { estimatedTokens, maxEstimatedTokens });
  }
  return {
    entries,
    excludedEntryCount,
    serializedPayloadSha256: mapperSha256(entries),
    estimatedTokens,
  };
}

/**
 * Legacy Canonical Workspace Index V1 mapping path. This remains the governed compatibility path for
 * historical/pre-B1 and ADVANCED_DIAGNOSTIC snapshots.
 */
export function buildMappingInputSnapshot(
  rawContract: unknown,
  options: { createdAt?: string; maxEstimatedTokens?: number } = {},
): LegacyMappingInputSnapshot {
  const validation = validateCanonicalWorkspaceIndexContract(rawContract);
  if (!validation.contract || validation.status === "REJECTED") {
    throw new AiContextMapperError("MAPPER_WORKSPACE_INDEX_INVALID", "The Canonical Workspace Index Contract failed deterministic validation.", validation.diagnostics);
  }
  const contract = validation.contract;
  assertSecretPolicy(contract.snapshot, contract.source_binding.metadata);
  const governed = governedEntries({
    workspaceId: contract.workspace.workspace_instance_id,
    snapshot: contract.snapshot,
    maxEstimatedTokens: options.maxEstimatedTokens,
  });
  const createdAt = options.createdAt ?? new Date().toISOString();
  const workspaceIndexSha256 = canonicalWorkspaceIndexHash(contract);
  const snapshotId = stableMapperId("mis", {
    workspace_snapshot_id: contract.workspace.workspace_revision_id,
    workspace_index_sha256: workspaceIndexSha256,
    serialized_payload_sha256: governed.serializedPayloadSha256,
  });
  return assertMappingInputSnapshotIntegrity({
    mapping_input_schema_version: MAPPING_INPUT_SCHEMA_VERSION,
    mapping_input_snapshot_id: snapshotId,
    workspace_index_contract_version: contract.contract_version,
    workspace_snapshot_id: contract.workspace.workspace_revision_id,
    workspace_index_sha256: workspaceIndexSha256,
    created_at: createdAt,
    eligible_workspace_ids: [contract.workspace.workspace_instance_id],
    eligible_entry_count: governed.entries.length,
    excluded_entry_count: governed.excludedEntryCount,
    serialized_payload_sha256: governed.serializedPayloadSha256,
    provider_neutral_estimated_tokens: governed.estimatedTokens,
    secret_policy_status: "PASS",
    entries: governed.entries,
  }, { maxEstimatedTokens: options.maxEstimatedTokens }) as LegacyMappingInputSnapshot;
}

/**
 * Registered B1 authoritative mapping path. Semantic mapping identity derives only from the persisted
 * intrinsic Canonical Index Artifact and not from observation/predecessor-specific V1 projections.
 */
export function buildMappingInputSnapshotFromCanonicalArtifact(
  input: {
    canonicalIndexArtifactId: string;
    artifactSemanticSha256: string;
    semanticState: CanonicalIndexArtifactSemanticState;
  },
  options: { createdAt?: string; maxEstimatedTokens?: number } = {},
): B1CanonicalArtifactMappingInputSnapshot {
  if (input.semanticState.schema !== CANONICAL_INDEX_ARTIFACT_SEMANTIC_STATE_VERSION) {
    throw new AiContextMapperError("MAPPER_WORKSPACE_INDEX_INVALID", "The persisted Canonical Index Artifact uses an unsupported intrinsic semantic-state version.");
  }
  const parsedSnapshot = canonicalIndexArtifactSnapshotSchema.safeParse(input.semanticState.snapshot);
  if (!parsedSnapshot.success) {
    throw new AiContextMapperError(
      "MAPPER_WORKSPACE_INDEX_INVALID",
      "The persisted Canonical Index Artifact Snapshot failed deterministic structural validation.",
      parsedSnapshot.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  const recomputedSemanticSha256 = canonicalIndexArtifactSemanticStateSha256(input.semanticState);
  if (recomputedSemanticSha256 !== input.artifactSemanticSha256) {
    throw new AiContextMapperError("MAPPER_WORKSPACE_INDEX_INVALID", "The persisted Canonical Index Artifact semantic hash does not match its exact intrinsic payload.");
  }
  assertSecretPolicy(parsedSnapshot.data);
  const governed = governedEntries({
    workspaceId: input.semanticState.workspace_instance_id,
    snapshot: parsedSnapshot.data,
    maxEstimatedTokens: options.maxEstimatedTokens,
  });
  const snapshotId = stableMapperId("mis", {
    source_authority: "CANONICAL_INDEX_ARTIFACT",
    canonical_index_artifact_id: input.canonicalIndexArtifactId,
    artifact_semantic_sha256: input.artifactSemanticSha256,
    workspace_snapshot_id: input.semanticState.workspace_revision_id,
    serialized_payload_sha256: governed.serializedPayloadSha256,
  });
  return assertMappingInputSnapshotIntegrity({
    mapping_input_schema_version: B1_MAPPING_INPUT_SCHEMA_VERSION,
    source_authority: "CANONICAL_INDEX_ARTIFACT",
    canonical_index_artifact_id: input.canonicalIndexArtifactId,
    artifact_semantic_sha256: input.artifactSemanticSha256,
    mapping_input_snapshot_id: snapshotId,
    workspace_index_contract_version: CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION,
    workspace_snapshot_id: input.semanticState.workspace_revision_id,
    workspace_index_sha256: input.artifactSemanticSha256,
    created_at: options.createdAt ?? new Date().toISOString(),
    eligible_workspace_ids: [input.semanticState.workspace_instance_id],
    eligible_entry_count: governed.entries.length,
    excluded_entry_count: governed.excludedEntryCount,
    serialized_payload_sha256: governed.serializedPayloadSha256,
    provider_neutral_estimated_tokens: governed.estimatedTokens,
    secret_policy_status: "PASS",
    entries: governed.entries,
  }, { maxEstimatedTokens: options.maxEstimatedTokens }) as B1CanonicalArtifactMappingInputSnapshot;
}

export function mappingInputSemanticPayload(input: MappingInputSnapshot): unknown {
  if (input.mapping_input_schema_version === B1_MAPPING_INPUT_SCHEMA_VERSION) {
    const { created_at: _createdAt, ...semantic } = input;
    return semantic;
  }
  return input;
}

export function mappingInputSemanticSha256(input: MappingInputSnapshot): string {
  return mapperSha256(mappingInputSemanticPayload(input));
}

export function assertMappingInputSnapshotIntegrity(
  rawInput: unknown,
  options: { maxEstimatedTokens?: number } = {},
): MappingInputSnapshot {
  const parsed = mappingInputSnapshotSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AiContextMapperError(
      "MAPPER_INPUT_INTEGRITY_FAILED",
      "The Mapping Input Snapshot failed its structural contract.",
      parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  const input = parsed.data;
  const canonicalEntries = canonicalJson(input.entries);
  const expectedPayloadSha256 = mapperSha256(input.entries);
  const expectedEstimatedTokens = estimatedTokensForUtf8(canonicalEntries);
  const expectedSnapshotId = input.mapping_input_schema_version === B1_MAPPING_INPUT_SCHEMA_VERSION
    ? stableMapperId("mis", {
      source_authority: "CANONICAL_INDEX_ARTIFACT",
      canonical_index_artifact_id: input.canonical_index_artifact_id,
      artifact_semantic_sha256: input.artifact_semantic_sha256,
      workspace_snapshot_id: input.workspace_snapshot_id,
      serialized_payload_sha256: expectedPayloadSha256,
    })
    : stableMapperId("mis", {
      workspace_snapshot_id: input.workspace_snapshot_id,
      workspace_index_sha256: input.workspace_index_sha256,
      serialized_payload_sha256: expectedPayloadSha256,
    });
  const sortedEntries = [...input.entries].sort((left, right) =>
    left.workspace_id.localeCompare(right.workspace_id)
    || left.normalized_path.localeCompare(right.normalized_path)
    || left.entry_id.localeCompare(right.entry_id));
  if (canonicalJson(sortedEntries) !== canonicalEntries) {
    throw new AiContextMapperError("MAPPER_INPUT_INTEGRITY_FAILED", "Mapping Input entries are not in canonical stable order.");
  }
  if (input.serialized_payload_sha256 !== expectedPayloadSha256
    || input.mapping_input_snapshot_id !== expectedSnapshotId
    || input.provider_neutral_estimated_tokens !== expectedEstimatedTokens) {
    throw new AiContextMapperError("MAPPER_INPUT_INTEGRITY_FAILED", "Mapping Input hash, identity, or deterministic token estimate does not match its exact entries.");
  }
  if (input.mapping_input_schema_version === B1_MAPPING_INPUT_SCHEMA_VERSION
      && input.workspace_index_sha256 !== input.artifact_semantic_sha256) {
    throw new AiContextMapperError("MAPPER_INPUT_INTEGRITY_FAILED", "Registered B1 Mapping Input is not hash-bound to its Canonical Index Artifact semantic state.");
  }
  const maxEstimatedTokens = options.maxEstimatedTokens ?? MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS;
  if (expectedEstimatedTokens > maxEstimatedTokens) {
    throw new AiContextMapperError(
      "MAPPER_INPUT_BUDGET_EXCEEDED",
      `Estimated input ${expectedEstimatedTokens} exceeds the provider-neutral budget ${maxEstimatedTokens}.`,
      { estimatedTokens: expectedEstimatedTokens, maxEstimatedTokens },
    );
  }
  return input;
}
