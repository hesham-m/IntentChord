import type { JsonValue } from "@/core/truth/project-truth-hash";

export const MAPPING_INPUT_SCHEMA_VERSION = "intentchord.ai-context-mapping-input.v1" as const;
export const B1_MAPPING_INPUT_SCHEMA_VERSION = "intentchord.ai-context-mapping-input.v2" as const;
export const MODEL_PROPOSED_CATALOG_SCHEMA_VERSION = "intentchord.model-proposed-context-catalog.v1" as const;
export const MAPPING_RESULT_SCHEMA_VERSION = "intentchord.context-mapping-result.v1" as const;
export const PROMPT_TEMPLATE_ID = "intentchord_ai_context_mapper_system_v1" as const;
export const INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION_V2 = "intentchord.internal-ai-provider-configuration.v2" as const;
export const INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION = "intentchord.internal-ai-provider-configuration.v3" as const;
export const INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION_V1 = "intentchord.internal-ai-engine-registry.v1" as const;
export const INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION = "intentchord.internal-ai-engine-registry.v2" as const;
export const INTERNAL_AI_ENGINE_CONFIGURATION_IDENTITY_VERSION = "intentchord.internal-ai-engine-configuration-identity.v1" as const;
export const INTERNAL_AI_QUALIFICATION_SCOPE_V1 = "AI_CONTEXT_MAPPING_V1" as const;
export const INTERNAL_AI_QUALIFICATION_SCOPE_V2 = "AI_CONTEXT_MAPPING_V2" as const;
/** Historical/default alias retained for V1 source compatibility. */
export const INTERNAL_AI_QUALIFICATION_SCOPE = INTERNAL_AI_QUALIFICATION_SCOPE_V1;
export const INTERNAL_AI_SELECTION_POLICY_MODE = "SINGLE" as const;
export const INTERNAL_AI_TRANSPORT_PROFILE_IDS = [
  "chat_completions_json_object_v1",
  "chat_completions_json_schema_v1",
] as const;
export const INTERNAL_AI_BEHAVIOR_PROFILE_IDS = [
  "zai_error_semantics_v1",
  "sambanova_error_semantics_v1",
  "openai_chat_completions_error_semantics_v1",
] as const;

export type ProviderId = string;
export type InternalAiTransportProfileId = typeof INTERNAL_AI_TRANSPORT_PROFILE_IDS[number] | (string & {});
export type InternalAiBehaviorProfileId = typeof INTERNAL_AI_BEHAVIOR_PROFILE_IDS[number] | (string & {});
export type InternalAiEngineRole = "ACTIVE" | "CANDIDATE" | "STANDBY";
export type InternalAiQualificationScope = typeof INTERNAL_AI_QUALIFICATION_SCOPE_V1 | typeof INTERNAL_AI_QUALIFICATION_SCOPE_V2;
export type InternalAiQualificationStatus = "QUALIFIED" | "REVOKED" | "EXPIRED";
export type CapabilityProfileVersion = string;

export type InternalAiEngineConfigurationMaterial = {
  engineId: string;
  engineConfigRevision: string;
  providerId: ProviderId;
  channelId: string;
  modelId: string;
  endpoint: string;
  credentialReference: string;
  transportProfileId: InternalAiTransportProfileId;
  behaviorProfileId: InternalAiBehaviorProfileId;
  capabilityProfileVersion: CapabilityProfileVersion;
  timeoutMs: number;
};

export type InternalAiEngineDefinition = InternalAiEngineConfigurationMaterial & {
  engineConfigurationSha256: string;
  /** First-class Vendor binding (ADR-001 §3.3). Not part of the configuration fingerprint. */
  vendorId?: string | null;
};

export type InternalAiQualificationRecord = {
  qualificationId: string;
  engineId: string;
  engineConfigRevision: string;
  engineConfigurationSha256: string;
  qualificationStatus: InternalAiQualificationStatus;
  qualificationScope: InternalAiQualificationScope;
  qualifiedAt: string;
  qualifiedBy: string;
  evidenceReference: string;
  capabilityProfileVersion: CapabilityProfileVersion;
};

export type InternalAiSelectionPolicy = {
  selectionPolicyId: string;
  selectionPolicyVersion: string;
  selectionMode: typeof INTERNAL_AI_SELECTION_POLICY_MODE;
};

export type InternalAiQualificationSnapshotV2 = {
  qualification_id: string;
  engine_id: string;
  engine_config_revision: string;
  qualification_status: "QUALIFIED";
  qualification_scope: InternalAiQualificationScope;
  qualified_at: string;
  qualified_by: string;
  evidence_reference: string;
  capability_profile_version: string;
};

export type InternalAiEngineIdentitySnapshotV2 = {
  role: InternalAiEngineRole;
  engine_id: string;
  engine_config_revision: string;
  provider_id: ProviderId;
  channel_id: string;
  model_id: string;
  endpoint: string;
  credential_reference: string;
  transport_profile_id: InternalAiTransportProfileId;
  behavior_profile_id: InternalAiBehaviorProfileId;
  capability_profile_version: string;
  owner_enabled: boolean;
  qualification?: InternalAiQualificationSnapshotV2;
  timeout_ms: number;
};

/** Historical v1.0.1 candidate snapshot shape. Persisted historical rows, if any, remain read as stored truth. */
export type InternalAiProviderConfigurationSnapshotV2 = {
  schema_version: typeof INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION_V2;
  registry_schema_version: typeof INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION_V1;
  selected_engine_id: string;
  selected_engine_config_revision: string;
  selection_policy: {
    selection_policy_id: string;
    selection_policy_version: string;
    selection_mode: typeof INTERNAL_AI_SELECTION_POLICY_MODE;
  };
  active: InternalAiEngineIdentitySnapshotV2;
  candidate?: InternalAiEngineIdentitySnapshotV2;
  standby?: InternalAiEngineIdentitySnapshotV2;
  failover_policy: {
    enabled: boolean;
    governance_qualified: boolean;
    technical_failure_only: true;
    validation_failure_failover: false;
  };
};

export type InternalAiQualificationSnapshot = InternalAiQualificationSnapshotV2 & {
  engine_configuration_sha256: string;
};

export type InternalAiEngineIdentitySnapshot = Omit<InternalAiEngineIdentitySnapshotV2, "qualification"> & {
  engine_configuration_sha256: string;
  qualification?: InternalAiQualificationSnapshot;
};

export type InternalAiProviderConfigurationSnapshotV3 = {
  schema_version: typeof INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION;
  registry_schema_version: typeof INTERNAL_AI_ENGINE_REGISTRY_SCHEMA_VERSION;
  selected_engine_id: string;
  selected_engine_config_revision: string;
  selected_engine_configuration_sha256: string;
  selection_policy: {
    selection_policy_id: string;
    selection_policy_version: string;
    selection_mode: typeof INTERNAL_AI_SELECTION_POLICY_MODE;
  };
  active: InternalAiEngineIdentitySnapshot;
  candidate?: InternalAiEngineIdentitySnapshot;
  standby?: InternalAiEngineIdentitySnapshot;
  failover_policy: {
    enabled: boolean;
    governance_qualified: boolean;
    technical_failure_only: true;
    validation_failure_failover: false;
  };
};

/** @deprecated historical alias retained for source compatibility only. */
export type InternalAiProviderConfigurationSnapshotV1 = InternalAiProviderConfigurationSnapshotV2;

export type LegacyInternalAiProviderConfigurationSnapshot = {
  primary: { provider_id: string; channel_id: string; model_id: string };
  standby: {
    provider_id: string;
    channel_id: string;
    model_id: string;
    enabled: boolean;
    governance_state: "BLOCKED_BY_GOVERNANCE" | "QUALIFIED";
  };
};

export type InternalAiProviderConfigurationSnapshot =
  | InternalAiProviderConfigurationSnapshotV3
  | InternalAiProviderConfigurationSnapshotV2
  | LegacyInternalAiProviderConfigurationSnapshot;

export const MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS = Number(
  (typeof process !== "undefined" && process.env?.MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS) || 96_000,
);
export const MAX_MODEL_OUTPUT_ESTIMATED_TOKENS = 24_000;

export type MappingInputEntryType = "FILE";

export type MappingInputEntry = {
  entry_id: string;
  workspace_id: string;
  normalized_path: string;
  entry_type: MappingInputEntryType;
  language_or_format: string;
  size_bytes: number;
  content_or_metadata_fingerprint: string;
  index_supported_signals: {
    file_kind: string;
    parse_status: string;
    coverage_state: string;
    fact_signals: Array<{
      fact_type: string;
      qualified_name: string;
      display_name: string;
      attributes: Record<string, JsonValue>;
      certainty: string;
      evidence_role: string;
    }>;
    relation_signals: Array<{
      relation_type: string;
      direction: string;
      source_entry_or_entity_id: string;
      target_entry_or_entity_id: string;
      certainty: string;
      evidence_role: string;
    }>;
  };
};

type MappingInputSnapshotBase = {
  mapping_input_snapshot_id: string;
  workspace_index_contract_version: string;
  workspace_snapshot_id: string;
  workspace_index_sha256: string;
  created_at: string;
  eligible_workspace_ids: string[];
  eligible_entry_count: number;
  excluded_entry_count: number;
  serialized_payload_sha256: string;
  provider_neutral_estimated_tokens: number;
  secret_policy_status: "PASS";
  entries: MappingInputEntry[];
};

export type LegacyMappingInputSnapshot = MappingInputSnapshotBase & {
  mapping_input_schema_version: typeof MAPPING_INPUT_SCHEMA_VERSION;
};

export type B1CanonicalArtifactMappingInputSnapshot = MappingInputSnapshotBase & {
  mapping_input_schema_version: typeof B1_MAPPING_INPUT_SCHEMA_VERSION;
  source_authority: "CANONICAL_INDEX_ARTIFACT";
  canonical_index_artifact_id: string;
  artifact_semantic_sha256: string;
};

export type MappingInputSnapshot = LegacyMappingInputSnapshot | B1CanonicalArtifactMappingInputSnapshot;

export const contextKinds = [
  "application", "service", "library", "module", "data_store", "integration",
  "infrastructure", "workflow", "policy", "test_suite", "documentation",
  "cross_cutting", "unknown",
] as const;
export type ContextKind = typeof contextKinds[number];

export const relationshipTypes = [
  "contains", "depends_on", "calls", "reads_from", "writes_to", "implements",
  "tests", "documents", "governs", "integrates_with", "shares_contract_with", "unknown",
] as const;
export type ContextRelationshipType = typeof relationshipTypes[number];

export type Confidence = "high" | "medium" | "low";

export type ProposedContext = {
  context_id: string;
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

export type ProposedContextRelationship = {
  relationship_id: string;
  from_context_id: string;
  to_context_id: string;
  relationship_type: ContextRelationshipType;
  evidence_entry_ids: string[];
  confidence: Confidence;
  rationale: string;
};

export type UnmappedEntry = {
  entry_id: string;
  reason_code: "insufficient_evidence" | "ambiguous" | "technical_noise" | "generated_or_vendor" | "out_of_mapper_scope";
  explanation: string;
};

export type ModelProposedContextCatalogV1 = {
  schema_version: typeof MODEL_PROPOSED_CATALOG_SCHEMA_VERSION;
  catalog_summary: string;
  contexts: ProposedContext[];
  relationships: ProposedContextRelationship[];
  unmapped_entries: UnmappedEntry[];
  global_unknowns: string[];
  warnings: string[];
};

export type ValidationGateName =
  | "JSON_PARSE"
  | "JSON_SCHEMA"
  | "INPUT_FINGERPRINT_BINDING"
  | "WORKSPACE_REFERENCE_INTEGRITY"
  | "ENTRY_REFERENCE_INTEGRITY"
  | "CONTEXT_ID_UNIQUENESS"
  | "RELATIONSHIP_ID_UNIQUENESS"
  | "RELATIONSHIP_ENDPOINT_INTEGRITY"
  | "NO_SELF_RELATIONSHIP"
  | "ENTRY_COVERAGE_ACCOUNTING"
  | "NO_UNKNOWN_PROPERTIES"
  | "NO_AUTHORITY_LANGUAGE_FIELDS"
  | "OUTPUT_SIZE_BOUND";

export type ValidationGateResult = {
  gate: ValidationGateName;
  status: "PASS" | "FAIL";
  code?: string;
  message?: string;
};

export type CatalogValidationResult = {
  status: "PASS" | "FAIL";
  gates: ValidationGateResult[];
  parsed_catalog?: ModelProposedContextCatalogV1;
  raw_response_sha256: string;
  parsed_catalog_sha256?: string;
};

export type MappingRunStatus =
  | "CREATED"
  | "INPUT_VALIDATED"
  | "PRIMARY_RUNNING"
  | "PRIMARY_FAILED_TECHNICAL"
  | "STANDBY_BLOCKED_GOVERNANCE"
  | "STANDBY_RUNNING"
  | "VALIDATING"
  | "AWAITING_OWNER_REVIEW"
  | "REJECTED_VALIDATION"
  | "FAILED"
  | "OWNER_ACCEPTED"
  | "OWNER_REJECTED"
  | "ANALYSIS_COMPLETE"
  | "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE";

export type ProviderAttemptStatus = "RUNNING" | "SUCCEEDED" | "FAILED_TECHNICAL" | "FAILED_VALIDATION";

export type NormalizedProviderErrorCode =
  | "PRIMARY_RATE_LIMITED"
  | "PRIMARY_DAILY_LIMIT_REACHED"
  | "PRIMARY_PROVIDER_UNAVAILABLE"
  | "PRIMARY_NETWORK_TIMEOUT"
  | "PRIMARY_MODEL_UNAVAILABLE_OR_REMOVED"
  | "PRIMARY_AUTH_MISSING_OR_INVALID"
  | "PRIMARY_PERMISSION_DENIED"
  | "PRIMARY_REQUEST_INVALID"
  | "PRIMARY_PROMPT_TOO_LONG"
  | "PRIMARY_RESPONSE_NOT_JSON"
  | "PRIMARY_SCHEMA_INVALID"
  | "PRIMARY_REFERENTIAL_INTEGRITY_FAILED"
  | "PRIMARY_COVERAGE_INVALID"
  | "STANDBY_QUOTA_EXHAUSTED"
  | "STANDBY_PROVIDER_BUSY"
  | "STANDBY_NETWORK_TIMEOUT"
  | "STANDBY_MODEL_UNAVAILABLE_OR_REMOVED"
  | "STANDBY_PROVIDER_UNAVAILABLE"
  | "STANDBY_AUTH_INVALID"
  | "STANDBY_REQUEST_INVALID"
  | "STANDBY_RESPONSE_NOT_JSON"
  | "STANDBY_SCHEMA_INVALID"
  | "STANDBY_REFERENTIAL_INTEGRITY_FAILED"
  | "STANDBY_COVERAGE_INVALID"
  | "MAPPER_CONFIGURATION_BLOCKED"
  | "MAPPER_INPUT_BUDGET_EXCEEDED"
  | "MAPPER_INPUT_SECRET_POLICY_FAILED"
  | "MAPPER_ORPHANED_ACTIVE_EXECUTION"
  | "UNKNOWN_PROVIDER_ERROR";

// Scalar usage counters and the bounded top-level key diagnostics are both valid.
export type SafeUsageMetadata = Record<string, number | string | boolean | null | string[]>;
export type SafeRateLimitMetadata = Record<string, string | number | null>;

export type ProviderAttemptResponse = {
  raw_model_content: string;
  response_model_id?: string;
  provider_request_id?: string;
  provider_system_fingerprint?: string;
  usage_metadata: SafeUsageMetadata;
  rate_limit_metadata: SafeRateLimitMetadata;
  raw_provider_body: string;
};

export type MappingProviderRequest = {
  mapping_input: MappingInputSnapshot;
  system_prompt: string;
  user_payload: string;
  output_json_schema: Record<string, unknown>;
  timeout_ms: number;
};

export interface AiContextMapperProviderAdapter {
  readonly provider_id: ProviderId;
  readonly channel_id: string;
  readonly model_id: string;
  execute(request: MappingProviderRequest): Promise<ProviderAttemptResponse>;
}

export interface AiContextMapperProviderAdapterV2 {
  readonly provider_id: ProviderId;
  readonly channel_id: string;
  readonly model_id: string;
  execute(request: import("@/core/ai-context-mapper/v2").MappingProviderRequestV2): Promise<ProviderAttemptResponse>;
}

export type MappingAttemptView = {
  id: string;
  runId: string;
  ordinal: number;
  providerId: ProviderId;
  channelId: string;
  requestedModelId: string;
  responseModelId?: string;
  providerRequestId?: string;
  providerSystemFingerprint?: string;
  status: ProviderAttemptStatus;
  normalizedErrorCode?: NormalizedProviderErrorCode;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  rawResponseSha256?: string;
  parsedCatalogSha256?: string;
  validationResult?: CatalogValidationResult | import("@/core/ai-context-mapper/v2").ContextMappingV2ValidationResult;
  usageMetadata: SafeUsageMetadata;
  rateLimitMetadata: SafeRateLimitMetadata;
};

export type OwnerContextDecisionView = {
  id: string;
  runId: string;
  proposalId: string;
  contextId: string;
  contextSha256: string;
  decision: "ACCEPT" | "REJECT";
  note?: string;
  ownerReference: string;
  createdAt: string;
};

export type MappingProposalView = {
  id: string;
  runId: string;
  attemptId: string;
  proposalSha256: string;
  schemaVersion: string;
  validationEvidence: CatalogValidationResult;
  resultEnvelope: ContextMappingResultEnvelope;
  modelProposal: ModelProposedContextCatalogV1;
  createdAt: string;
};

export type MappingRunView = {
  id: string;
  status: MappingRunStatus;
  mappingInputSnapshotId: string;
  mappingInputSha256: string;
  workspaceSnapshotId: string;
  workspaceIndexSha256: string;
  workspaceIndexSnapshotId?: string;
  canonicalIndexArtifactId?: string;
  artifactSemanticSha256?: string;
  eligibleEntryCount: number;
  excludedEntryCount: number;
  estimatedTokens: number;
  primaryProviderId: ProviderId;
  primaryChannelId: string;
  primaryModelId: string;
  standbyProviderId?: ProviderId;
  standbyChannelId?: string;
  standbyModelId?: string;
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshot;
  standbyEnabled: boolean;
  standbyGovernanceState: "BLOCKED_BY_GOVERNANCE" | "QUALIFIED";
  finalAttemptId?: string;
  ownerVerdictState: "PENDING" | "ACCEPTED" | "REJECTED";
  ownerVerdictNote?: string;
  createdAt: string;
  updatedAt: string;
  proposal?: MappingProposalView;
  ownerContextDecisions: OwnerContextDecisionView[];
};


export type CustomerMappingProposalView = Omit<MappingProposalView, "resultEnvelope">;

export type CustomerMappingRunView = Omit<
  MappingRunView,
  | "primaryProviderId"
  | "primaryChannelId"
  | "primaryModelId"
  | "standbyProviderId"
  | "standbyChannelId"
  | "standbyModelId"
  | "providerConfigurationSnapshot"
  | "standbyEnabled"
  | "standbyGovernanceState"
  | "proposal"
> & {
  proposal?: CustomerMappingProposalView;
};

export type CustomerMappingAttemptView = Omit<
  MappingAttemptView,
  | "providerId"
  | "channelId"
  | "requestedModelId"
  | "responseModelId"
  | "providerRequestId"
  | "providerSystemFingerprint"
  | "normalizedErrorCode"
  | "retryCount"
  | "usageMetadata"
  | "rateLimitMetadata"
>;

export type ContextMappingResultEnvelope = {
  schema_version: typeof MAPPING_RESULT_SCHEMA_VERSION;
  mapping_run_id: string;
  mapping_input_snapshot_id: string;
  mapping_input_sha256: string;
  attempt_id: string;
  attempt_ordinal: number;
  provider_id: ProviderId;
  channel_id: string;
  requested_model_id: string;
  response_model_id?: string;
  provider_request_id?: string;
  provider_system_fingerprint_if_available?: string;
  prompt_template_id: typeof PROMPT_TEMPLATE_ID;
  prompt_template_sha256: string;
  raw_response_sha256: string;
  parsed_catalog_sha256: string;
  started_at: string;
  completed_at: string;
  usage_metadata: SafeUsageMetadata;
  rate_limit_metadata: SafeRateLimitMetadata;
  validation_result: CatalogValidationResult;
  model_proposal: ModelProposedContextCatalogV1;
};

export const AI_EXECUTION_AUTHORITY_IDENTITY_VERSION = "intentchord.ai-execution-authority.v1" as const;

export type InternalAiEngineState = "ENABLED" | "DISABLED";

export type InternalAiEngineRow = {
  engine_id: string;
  display_name: string;
  engine_state: InternalAiEngineState;
  created_at: string;
  updated_at: string;
};

export type InternalAiEngineRevisionRow = {
  id: string;
  engine_id: string;
  engine_config_revision: string;
  provider_id: ProviderId;
  vendor_id: string | null;
  channel_id: string;
  model_id: string;
  endpoint: string;
  credential_reference: string;
  transport_profile_id: InternalAiTransportProfileId;
  behavior_profile_id: InternalAiBehaviorProfileId;
  capability_profile_version: string;
  timeout_ms: number;
  engine_configuration_sha256: string;
  created_at: string;
};

export type InternalAiQualificationRow = {
  id: string;
  qualification_id: string;
  engine_id: string;
  engine_config_revision: string;
  engine_configuration_sha256: string;
  qualification_status: InternalAiQualificationStatus;
  qualification_scope: InternalAiQualificationScope;
  qualified_at: string;
  qualified_by: string;
  evidence_reference: string;
  capability_profile_version: string;
  created_at: string;
};

export type InternalAiAdminSelectionRow = {
  qualification_scope: InternalAiQualificationScope;
  active_engine_id: string;
  active_engine_config_revision: string;
  active_engine_configuration_sha256: string;
  active_qualification_id: string;
  standby_engine_id: string | null;
  standby_engine_config_revision: string | null;
  standby_engine_configuration_sha256: string | null;
  standby_qualification_id: string | null;
  standby_enabled: boolean;
  selection_authority_sequence: string | number;
  selected_by: string;
  updated_at: string;
};

export type InternalAiEngineView = {
  engineId: string;
  displayName: string;
  state: InternalAiEngineState;
  createdAt: string;
  updatedAt: string;
  latestRevision?: string;
  credentialPresent: boolean;
};

export type InternalAiEngineDetailView = InternalAiEngineView & {
  revisions: InternalAiEngineDefinition[];
  qualifications: InternalAiQualificationRecord[];
};

export type InternalAiAdminSelectionView = {
  qualificationScope: InternalAiQualificationScope;
  active: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    credentialPresent: boolean;
  };
  standby?: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    credentialPresent: boolean;
  };
  standbyEnabled: boolean;
  selectionAuthoritySequence: number;
  selectedBy: string;
  updatedAt: string;
};

export type FrozenAiExecutionAuthority = {
  aiExecutionAuthoritySha256: string;
  qualificationScope: InternalAiQualificationScope;
  selectionAuthoritySequence: number;
  active: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    capabilityProfileVersion: string;
  };
  standby?: {
    engineId: string;
    engineConfigRevision: string;
    engineConfigurationSha256: string;
    qualificationId: string;
    capabilityProfileVersion: string;
  };
  providerConfigurationSnapshot: InternalAiProviderConfigurationSnapshotV3;
};

