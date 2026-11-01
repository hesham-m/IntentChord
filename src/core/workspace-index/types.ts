import type { JsonValue } from "@/core/truth/project-truth-hash";

export const CANONICAL_WORKSPACE_INDEX_CONTRACT_TYPE = "canonical_workspace_index" as const;
export const CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION = "1.0.0" as const;
export const WORKSPACE_INDEXER_NAME = "intentchord-workspace-indexer" as const;
export const WORKSPACE_INDEXER_VERSION = "1.4.0" as const;
export const PARSER_REGISTRY_VERSION = "workspace-parser-registry/v2" as const;
export const RELATION_REGISTRY_VERSION = "workspace-relation-registry/v1" as const;
export const DELTA_SCHEMA_VERSION = "workspace-index-delta/v4" as const;
export const COMPARISON_ENGINE_VERSION = "workspace-index-comparison/v4" as const;

export type ContractStatus = "COMPLETE" | "COMPLETE_WITH_GAPS";
export type CandidateStatus = ContractStatus | "REJECTED";
export type EntityType = "FILE" | "FACT";
export type FileKind =
  | "SOURCE_CODE"
  | "MARKDOWN"
  | "CSV"
  | "JSON"
  | "YAML"
  | "TOML"
  | "XML"
  | "SCRIPT"
  | "MANIFEST"
  | "CONFIGURATION"
  | "BINARY"
  | "UNKNOWN";
export type FileEncoding = "UTF8" | "UTF16LE" | "BINARY" | "UNKNOWN";
export type ParseStatus = "PARSED" | "NOT_APPLICABLE" | "METADATA_ONLY" | "RESTRICTED" | "UNSUPPORTED" | "FAILED";
export type SensitivityState = "NORMAL" | "SENSITIVE" | "SECRET" | "CREDENTIAL_LIKE" | "OWNER_RESTRICTED";
export type CoverageStage =
  | "DISCOVERED"
  | "METADATA_INDEXED"
  | "CONTENT_READABLE"
  | "STRUCTURE_PARSED"
  | "FACTS_EXTRACTED"
  | "RELATIONS_RESOLVED";
export type CoverageState = "COMPLETE" | "PARTIAL" | "METADATA_ONLY" | "RESTRICTED" | "UNSUPPORTED" | "FAILED";
export type ContentAvailabilityState = "AVAILABLE" | "METADATA_ONLY" | "RESTRICTED" | "UNREADABLE" | "BINARY" | "MISSING";
export type ContentScopeType = "FULL_FILE" | "BYTE_RANGE" | "LINE_RANGE" | "NORMALIZED_FRAGMENT";
export type FactType =
  | "SYMBOL"
  | "IMPORT"
  | "DEPENDENCY"
  | "ROUTE"
  | "SERVICE"
  | "COMPONENT"
  | "TEST"
  | "CONFIGURATION"
  | "SCRIPT"
  | "DOCUMENTATION"
  | "DATABASE_ENTITY";
export type RelationType =
  | "CONTAINS"
  | "DECLARES"
  | "IMPORTS"
  | "DEPENDS_ON"
  | "CALLS"
  | "IMPLEMENTS"
  | "CONFIGURES"
  | "EXPOSES_ROUTE"
  | "HANDLES_EVENT"
  | "READS_FROM"
  | "WRITES_TO"
  | "TESTS"
  | "VALIDATES"
  | "REFERENCES";
export type RelationDirection = "DIRECTED" | "UNDIRECTED";
export type ExtractionMethod =
  | "PARSER_EXACT"
  | "AST_DERIVED"
  | "MANIFEST_DECLARED"
  | "TEXT_PATTERN"
  | "HEURISTIC"
  | "DOCUMENTED_CLAIM";
export type Certainty = "EXACT" | "DERIVED" | "HEURISTIC" | "UNRESOLVED";
export type EvidenceRole = "CANONICAL_EVIDENCE" | "SIGNAL_ONLY" | "UNRESOLVED";
export type FailureStage =
  | "DISCOVERY"
  | "METADATA"
  | "CONTENT_READ"
  | "DECODING"
  | "PARSING"
  | "FACT_EXTRACTION"
  | "RELATION_RESOLUTION"
  | "HASHING"
  | "CONTRACT_ASSEMBLY";
export type FailureRecoverability =
  | "RETRYABLE"
  | "REQUIRES_OWNER_PERMISSION"
  | "REQUIRES_PARSER_SUPPORT"
  | "PERMANENT_FOR_THIS_REVISION";
export type FailureImpact = "LOCAL" | "CONTEXT_DEGRADING" | "REVISION_INCOMPLETE" | "CONTRACT_BLOCKING";
export type LineageState = "NEW" | "CONTINUED" | "RENAMED_OR_MOVED" | "UNPROVEN";

export type SourceLocation = {
  line_range?: { start: number; end: number };
  byte_range?: { start: number; end: number };
  ast_node_path?: string;
  symbol_path?: string;
  normalized_signature?: string;
};

export type WorkspaceBinding = {
  source_binding_id: string;
  binding_type: "LOCAL_FILESYSTEM" | "REMOTE_REFERENCE" | "FIXTURE";
  normalized_reference: string;
  device_name?: string;
  platform?: string;
  repository_identity?: string;
  branch?: string;
  commit_sha?: string;
  metadata: Record<string, JsonValue>;
};

export type WorkspaceIdentity = {
  workspace_instance_id: string;
  workspace_revision_id: string;
  previous_revision_id: string | null;
  source_binding_id: string;
};

export type GenerationMetadata = {
  indexing_session_id: string;
  indexer_name: string;
  indexer_version: string;
  parser_registry_version: string;
  relation_registry_version: string;
  started_at: string;
  completed_at: string;
};

export type WorkspaceFileRecord = {
  workspace_file_id: string;
  file_revision_id: string;
  relative_path: string;
  file_name: string;
  file_kind: FileKind;
  language?: string;
  size_bytes: number;
  content_hash: string;
  metadata_hash: string;
  encoding: FileEncoding;
  parse_status: ParseStatus;
  sensitivity_state: SensitivityState;
  coverage_stage: CoverageStage;
  coverage_state: CoverageState;
  content_ref_id?: string;
  lineage_state: LineageState;
  previous_file_revision_id?: string;
  possible_lineage?: {
    previous_workspace_file_id: string;
    reason: string;
    confidence: "LOW" | "MEDIUM" | "HIGH";
  };
};

export type FactProvenance = {
  workspace_revision_id: string;
  file_revision_id: string;
  file_content_hash: string;
  source_location: SourceLocation;
  extractor_id: string;
  extractor_version: string;
  extraction_method: ExtractionMethod;
  evidence_hash: string;
};

export type WorkspaceFactRecord = {
  workspace_fact_id: string;
  fact_revision_id: string;
  fact_type: FactType;
  qualified_name: string;
  display_name: string;
  attributes: Record<string, JsonValue>;
  source_file_revision_id: string;
  source_location: SourceLocation;
  parent_fact_revision_id?: string;
  extraction_method: ExtractionMethod;
  extractor_id: string;
  extractor_version: string;
  certainty: Certainty;
  evidence_role: EvidenceRole;
  provenance: FactProvenance;
};

export type RelationEndpoint = {
  entity_type: EntityType;
  entity_revision_id: string;
};

export type RelationEvidenceReference = {
  file_revision_id: string;
  source_location: SourceLocation;
  evidence_hash: string;
  extractor_id: string;
  extractor_version: string;
};

export type WorkspaceRelationRecord = {
  workspace_relation_id: string;
  relation_revision_id: string;
  relation_type: RelationType;
  source: RelationEndpoint;
  target: RelationEndpoint;
  direction: RelationDirection;
  attributes: Record<string, JsonValue>;
  evidence_refs: RelationEvidenceReference[];
  extraction_method: ExtractionMethod;
  extractor_id: string;
  extractor_version: string;
  certainty: Certainty;
  evidence_role: EvidenceRole;
};

export type ContentReferenceRecord = {
  content_ref_id: string;
  file_revision_id: string;
  content_hash: string;
  content_kind: FileKind;
  media_type: string;
  encoding: FileEncoding;
  size_bytes: number;
  retrieval_ref: string;
  sensitivity_class: SensitivityState;
  availability_state: ContentAvailabilityState;
  scope_type: ContentScopeType;
};

export type WorkspaceIndexSnapshot = {
  files: WorkspaceFileRecord[];
  facts: WorkspaceFactRecord[];
  relations: WorkspaceRelationRecord[];
  content_references: ContentReferenceRecord[];
};

export type WorkspaceCoverageSummary = {
  total_discovered_files: number;
  metadata_indexed_files: number;
  fully_parsed_files: number;
  partially_parsed_files: number;
  metadata_only_files: number;
  restricted_files: number;
  unsupported_files: number;
  failed_files: number;
  fact_count_by_type: Partial<Record<FactType, number>>;
  relation_count_by_type: Partial<Record<RelationType, number>>;
  parser_coverage_by_language: Record<string, {
    discovered_files: number;
    parsed_files: number;
    partial_files: number;
    unsupported_files: number;
  }>;
};

export type WorkspaceIndexFailure = {
  failure_id: string;
  file_revision_id?: string;
  stage: FailureStage;
  failure_type: string;
  error_code: string;
  sanitized_message: string;
  extractor_id?: string;
  extractor_version?: string;
  occurred_at: string;
  recoverability: FailureRecoverability;
  impact: FailureImpact;
};

export type FileDelta = {
  added: WorkspaceFileRecord[];
  modified: Array<{ before_file_revision_id: string; after: WorkspaceFileRecord }>;
  deleted: Array<{ workspace_file_id: string; file_revision_id: string; relative_path: string }>;
  renamed_or_moved: Array<{
    workspace_file_id: string;
    from_file_revision_id: string;
    from_relative_path: string;
    to: WorkspaceFileRecord;
  }>;
};

export type FactDelta = {
  added: WorkspaceFactRecord[];
  modified: Array<{ before_fact_revision_id: string; after: WorkspaceFactRecord }>;
  removed: Array<{ workspace_fact_id: string; fact_revision_id: string }>;
  lineage_changed: Array<{
    workspace_fact_id: string;
    from_fact_revision_id: string;
    to_fact_revision_id: string;
    reason: string;
  }>;
};

export type RelationDelta = {
  added: WorkspaceRelationRecord[];
  modified: Array<{ before_relation_revision_id: string; after: WorkspaceRelationRecord }>;
  removed: Array<{ workspace_relation_id: string; relation_revision_id: string }>;
};

export type ContentReferenceDelta = {
  added: ContentReferenceRecord[];
  modified: Array<{ before_content_ref_id: string; after: ContentReferenceRecord }>;
  removed: Array<{ content_ref_id: string; file_revision_id: string }>;
  sensitivity_changed: Array<{
    content_ref_id: string;
    from: SensitivityState;
    to: SensitivityState;
  }>;
};

export type WorkspaceIndexDelta = {
  delta_id: string;
  from_workspace_revision_id: string | null;
  to_workspace_revision_id: string;
  delta_schema_version: string;
  comparison_engine_version: string;
  generated_at: string;
  files: FileDelta;
  facts: FactDelta;
  relations: RelationDelta;
  content_references: ContentReferenceDelta;
};

export type WorkspaceIndexIntegrity = {
  workspace_tree_fingerprint: string;
  canonical_payload_hash: string;
  file_count: number;
  fact_count: number;
  relation_count: number;
  content_reference_count: number;
};

export type CanonicalWorkspaceIndexContract = {
  contract_type: typeof CANONICAL_WORKSPACE_INDEX_CONTRACT_TYPE;
  contract_version: typeof CANONICAL_WORKSPACE_INDEX_CONTRACT_VERSION;
  contract_id: string;
  contract_status: ContractStatus;
  workspace: WorkspaceIdentity;
  source_binding: WorkspaceBinding;
  generation: GenerationMetadata;
  snapshot: WorkspaceIndexSnapshot;
  delta: WorkspaceIndexDelta | null;
  coverage: WorkspaceCoverageSummary;
  failures: WorkspaceIndexFailure[];
  integrity: WorkspaceIndexIntegrity;
};

export type RenameHint = {
  from_relative_path: string;
  to_relative_path: string;
  confidence: "PROVEN" | "POSSIBLE";
  evidence: string;
};

export type GitWorkspaceEnrichment = {
  repository_identity?: string;
  branch?: string;
  commit_sha?: string;
  rename_hints: RenameHint[];
  diagnostics: Array<{ command: string; state: "PASS" | "NOT_GIT" | "TIMEOUT" | "ERROR" }>;
};

export type WorkspaceIndexRequest = {
  workspace_instance_id: string;
  root_path: string;
  /** Backend-resolved root object identity captured immediately before governed traversal. */
  authorized_root_identity?: { real_path: string; identity: import("@/core/workspace-index/filesystem-object-authority").ProofGradeFilesystemObjectIdentity };
  source_binding_id?: string;
  binding_type?: WorkspaceBinding["binding_type"];
  previous_contract?: CanonicalWorkspaceIndexContract;
  /** R2-F: Predecessor sealed attestation authority for bootstrap continuity. */
  predecessor_attestation?: { closed_boundary_usn: number | null; journal_id: string; volume_serial: string; policy_hash: string } | null;
  /** V2 OBSERVATION RESULT AUTHORITY: Previous observation head for B1 chronology classification. */
  previous_observation?: { workspace_revision_id: string; accepted_workspace_evidence_artifact_id: string } | null;
  /** V2 OBSERVATION RESULT AUTHORITY: Server-owned callback to query persisted observation history for revisionWasKnown. */
  was_revision_previously_observed?: (workspaceRevisionId: string) => Promise<boolean>;
  indexing_session_id?: string;
  started_at?: string;
  completed_at?: string;
  /** Internal deterministic clock used only to stamp terminal completion after terminal candidate validation succeeds. */
  now?: () => string;
  /** Internal deterministic failure-occurrence clock; production defaults to wall-clock time at each recorded failure. */
  failure_now?: () => string;
  /** Internal deterministic chronology-test observer; production callers leave undefined. */
  terminal_validation_observer?: (event: "TERMINAL_CANDIDATE_VALIDATED" | "FINAL_PROJECTION_VALIDATED") => void;
  /** Internal deterministic authority factory; one produced authority is owned for the full index operation. */
  filesystem_object_authority_factory?: () => import("@/core/workspace-index/filesystem-object-authority").WorkspaceFilesystemObjectAuthority;
  max_parse_bytes?: number;
  budgets?: Partial<import("@/core/workspace-index/adapters/filesystem").WorkspaceIndexBudgets>;
  /** Internal Backend-owned duration policy. Production callers use the governed v1 policy; tests may inject deterministic bounds. */
  duration_policy?: import("@/core/workspace-index/duration-governance").WorkspaceDurationGovernance;
  /** Internal monotonic wall-clock anchor for the full governed attempt, including pre-index source authority. */
  attempt_started_at_ms?: number;
  /** Internal exact phase-authority handoff. Used by the registered Snapshot service to continue the same FINALIZATION deadline through persistence. */
  on_duration_phase_authority?: (authority: import("@/core/workspace-index/duration-governance").WorkspaceDurationPhaseAuthority) => void;
  signal?: AbortSignal;
  capture_stream_factory?: import("@/core/workspace-index/adapters/filesystem").WorkspaceCaptureStreamFactory;
  /** Internal deterministic race-test hook; production callers leave undefined. */
  capture_before_open?: (absolutePath: string) => void | Promise<void>;
  /** Internal deterministic directory substitution test hook; production callers leave undefined. */
  inventory_before_directory_open?: (absolutePath: string) => void | Promise<void>;
  on_progress?: (progress: import("@/core/workspace-index/adapters/filesystem").WorkspaceProgressEvidence) => void;
  owner_restricted_paths?: string[];
  git_enrichment?: GitWorkspaceEnrichment;
};

export type TechnicalValidationDiagnostic = {
  code: string;
  severity: "ERROR" | "WARNING";
  message: string;
  path?: string;
};

export type TechnicalValidationResult = {
  status: CandidateStatus;
  contract?: CanonicalWorkspaceIndexContract;
  diagnostics: TechnicalValidationDiagnostic[];
  delta_status: "NOT_PRESENT" | "ACCEPTED" | "REJECTED";
};
