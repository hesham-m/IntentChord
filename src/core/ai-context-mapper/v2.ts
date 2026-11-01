import type {
  Confidence,
  ContextKind,
  ContextRelationshipType,
  InternalAiProviderConfigurationSnapshotV3,
  MappingInputEntry,
  ProviderId,
  SafeRateLimitMetadata,
  SafeUsageMetadata,
} from "@/core/ai-context-mapper/types";

export const CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE = "AI_CONTEXT_MAPPING_V2" as const;
export const CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION = "intentchord.context-assembly-mapping-input.v1" as const;
export const MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2 = "intentchord.model-context-analysis.v2" as const;
export const CONTEXT_MAPPING_RESULT_SCHEMA_VERSION_V2 = "intentchord.context-mapping-result.v2" as const;
export const CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2 = "intentchord_ai_context_mapper_system_v2" as const;
export const CONTEXT_ASSEMBLY_CONTRACT_VERSION = "intentchord.context-assembly.v1" as const;
export const CONTEXT_CLOSURE_CONTRACT_VERSION = "intentchord.context-closure.v1" as const;
export const ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION = "intentchord.accepted-context-catalog.v1" as const;

export type ContextAssemblySourceBindingV2 = {
  workspace_id: string;
  workspace_registration_revision: number;
  workspace_registration_fingerprint: string;
  workspace_revision_id: string;
  workspace_index_snapshot_id: string;
  canonical_index_artifact_id: string;
  accepted_workspace_evidence_artifact_id?: string;
  workspace_index_sha256: string;
  artifact_semantic_sha256: string;
};

export type ContextAssemblyMappingInputV2 = {
  schema_version: typeof CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION;
  context_assembly_id: string;
  context_assembly_revision_id: string;
  context_assembly_revision: number;
  created_at: string;
  source_bindings: ContextAssemblySourceBindingV2[];
  entries: MappingInputEntry[];
  serialized_payload_sha256: string;
  provider_neutral_estimated_tokens: number;
  proof_obligations: string[];
};


export type MappingProviderRequestV2 = {
  mapping_input: ContextAssemblyMappingInputV2;
  system_prompt: string;
  user_payload: string;
  output_json_schema: Record<string, unknown>;
  timeout_ms: number;
};

export type ContextComponentV2 = {
  component_id: string;
  display_name: string;
  context_kind: ContextKind;
  summary: string;
  responsibilities: string[];
  workspace_ids: string[];
  evidence_entry_ids: string[];
  interfaces: string[];
  unknowns: string[];
  confidence: Confidence;
  rationale: string;
};

export type ContextRelationshipV2 = {
  relationship_id: string;
  from_component_id: string;
  to_component_id: string;
  relationship_type: ContextRelationshipType;
  evidence_entry_ids: string[];
  confidence: Confidence;
  rationale: string;
};

export type MissingEvidenceGapTypeV2 =
  | "INTERNAL_SOURCE"
  | "EXTERNAL_DEPENDENCY"
  | "NON_BLOCKING_UNRESOLVED"
  | "OPTIONAL_CONTEXT_GAP";

export type MissingEvidenceRequestV2 = {
  gap_id: string;
  gap_type: MissingEvidenceGapTypeV2;
  affected_component_ids: string[];
  affected_relationship_ids: string[];
  known_evidence_entry_ids: string[];
  missing_evidence_description: string;
  required_evidence_kind: string;
  source_hint?: string;
  blocking_reason: string;
  materiality: "BLOCKING" | "NON_BLOCKING";
  confidence: Confidence;
};

export type MaterialContradictionV2 = {
  contradiction_id: string;
  affected_component_ids: string[];
  affected_relationship_ids: string[];
  evidence_entry_ids: string[];
  summary: string;
  materiality: "BLOCKING" | "NON_BLOCKING";
};

export type ModelContextAnalysisV2 = {
  schema_version: typeof MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2;
  analysis_outcome: "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP" | "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE";
  catalog_summary: string;
  components: ContextComponentV2[];
  relationships: ContextRelationshipV2[];
  missing_evidence_requests: MissingEvidenceRequestV2[];
  material_contradictions: MaterialContradictionV2[];
  global_unknowns: string[];
  warnings: string[];
};

export type ContextMappingV2ValidationGate =
  | "JSON_PARSE"
  | "JSON_SCHEMA"
  | "ASSEMBLY_BINDING"
  | "COMPONENT_ID_UNIQUENESS"
  | "RELATIONSHIP_ID_UNIQUENESS"
  | "RELATIONSHIP_ENDPOINT_INTEGRITY"
  | "WORKSPACE_REFERENCE_INTEGRITY"
  | "ENTRY_REFERENCE_INTEGRITY"
  | "COMPONENT_EVIDENCE_COVERAGE"
  | "CROSS_WORKSPACE_RELATIONSHIP_EVIDENCE"
  | "NONEMPTY_COMPONENT_ANALYSIS"
  | "MISSING_EVIDENCE_GROUNDING"
  | "CONTRADICTION_GROUNDING"
  | "OUTCOME_CONSISTENCY"
  | "NO_AUTHORITY_LANGUAGE_FIELDS"
  | "OUTPUT_SIZE_BOUND";

export type ContextMappingV2ValidationResult = {
  status: "PASS" | "FAIL";
  gates: Array<{ gate: ContextMappingV2ValidationGate; status: "PASS" | "FAIL"; code?: string; message?: string }>;
  parsed_analysis?: ModelContextAnalysisV2;
  raw_response_sha256: string;
  parsed_analysis_sha256?: string;
};

export type ContextMappingResultEnvelopeV2 = {
  schema_version: typeof CONTEXT_MAPPING_RESULT_SCHEMA_VERSION_V2;
  qualification_scope: typeof CONTEXT_MAPPING_V2_QUALIFICATION_SCOPE;
  context_assembly_id: string;
  context_assembly_revision_id: string;
  mapping_run_id: string;
  attempt_id: string;
  attempt_ordinal: number;
  provider_id: ProviderId;
  channel_id: string;
  requested_model_id: string;
  response_model_id?: string;
  provider_request_id?: string;
  provider_system_fingerprint_if_available?: string;
  provider_configuration_snapshot: InternalAiProviderConfigurationSnapshotV3;
  prompt_template_id: typeof CONTEXT_MAPPING_PROMPT_TEMPLATE_ID_V2;
  prompt_template_sha256: string;
  raw_response_sha256: string;
  parsed_analysis_sha256: string;
  started_at: string;
  completed_at: string;
  usage_metadata: SafeUsageMetadata;
  rate_limit_metadata: SafeRateLimitMetadata;
  validation_result: ContextMappingV2ValidationResult;
  model_analysis: ModelContextAnalysisV2;
};

export type BackendGapClassification =
  | "BLOCKING_INTERNAL_SOURCE_GAP"
  | "EXTERNAL_DEPENDENCY"
  | "NON_BLOCKING_UNRESOLVED"
  | "OPTIONAL_CONTEXT_GAP";

export type ContextClosureState = "OPEN" | "BLOCKED" | "PASS";
export type ContextResolutionRequirementType = "MISSING_INTERNAL_EVIDENCE" | "SOURCE_TRUTH_CONFLICT";
export type ContextResolutionEventType =
  | "CANDIDATE_SOURCE_IDENTIFIED"
  | "OWNER_AUTHORIZED_SOURCE"
  | "OWNER_DENIED_SOURCE"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_TRUTH_CORRECTION_REQUIRED"
  | "SUPERSEDED_BY_NEW_ASSEMBLY";

export type ContextAssemblyBinding = {
  contextAssemblyId: string;
  contextAssemblyRevisionId: string;
  contextAssemblyRevision: number;
  mappingIterationId: string;
  closureEvaluationId: string;
  acceptedCatalogRevisionId: string;
  acceptedCatalogSha256: string;
};

export type AcceptedContextCatalogV2 = {
  schema_version: typeof ACCEPTED_CONTEXT_CATALOG_SCHEMA_VERSION;
  context_assembly_id: string;
  context_assembly_revision_id: string;
  mapping_iteration_id: string;
  closure_evaluation_id: string;
  catalog_summary: string;
  components: ContextComponentV2[];
  relationships: ContextRelationshipV2[];
  source_bindings: ContextAssemblySourceBindingV2[];
};

export type ContextClosureEvaluationV1 = {
  contract_version: typeof CONTEXT_CLOSURE_CONTRACT_VERSION;
  context_assembly_revision_id: string;
  mapping_iteration_id: string;
  evaluation_input_sha256: string;
  decision: "PASS" | "BLOCKED";
  reason_code: string;
  gates: Array<{ gate: string; status: "PASS" | "FAIL"; evidence?: string }>;
};

/**
 * Governed mapping input snapshot envelope — the JSONB persisted in
 * context_mapping_runs.mapping_input_snapshot.
 *
 * For V2 (Sectioned Evidence), this envelope wraps the full
 * ContextAssemblyMappingInputV2 (including source_bindings[]) and adds
 * assembly-level authority fields validated by Migration 016's
 * context_mapping_run_insert_snapshot_guard.
 *
 * V2 does NOT carry singular top-level artifact/snapshot fields —
 * source-level authority is validated against context_assembly_sources.
 */
export type GovernedMappingInputSnapshotEnvelopeV2 = {
  mapping_input_schema_version: typeof CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION;
  source_authority: "CONTEXT_ASSEMBLY_REVISION";
  context_assembly_revision_id: string;
  context_assembly_sha256: string;
  source_count: number;
  source_bindings: ContextAssemblySourceBindingV2[];
  /** The inner V2 assembly mapping input (carried for orchestration). */
  inner: ContextAssemblyMappingInputV2;
};
