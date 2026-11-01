import sampleWorkspaceIndex from "../../../reports/architecture-validation/samples/canonical-workspace-index-v1.sample.json";
import { buildMappingInputSnapshot } from "@/core/ai-context-mapper/input-builder";
import {
  INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
  type InternalAiProviderConfigurationSnapshotV3,
  type MappingInputSnapshot,
  type ModelProposedContextCatalogV1,
} from "@/core/ai-context-mapper/types";
import type { CanonicalWorkspaceIndexContract } from "@/core/workspace-index/types";
import { deriveInternalAiEngineConfigurationSha256 } from "@/core/ai-context-mapper/engine-registry";

export function sampleCanonicalWorkspaceIndex(): CanonicalWorkspaceIndexContract {
  return structuredClone(sampleWorkspaceIndex) as CanonicalWorkspaceIndexContract;
}

export function sampleMappingInput(): MappingInputSnapshot {
  return buildMappingInputSnapshot(sampleCanonicalWorkspaceIndex(), { createdAt: "2026-08-04T10:00:00.000Z" });
}

export function validCatalog(input = sampleMappingInput()): ModelProposedContextCatalogV1 {
  return {
    schema_version: MODEL_PROPOSED_CATALOG_SCHEMA_VERSION,
    catalog_summary: "One documentation context is proposed from the indexed evidence.",
    contexts: [{
      context_id: "ctx_documentation",
      display_name: "Documentation",
      context_kind: "documentation",
      summary: "Documentation represented by the indexed Markdown entry.",
      responsibilities: ["Document the indexed Workspace."],
      workspace_ids: [...input.eligible_workspace_ids],
      evidence_entry_ids: input.entries.map(entry => entry.entry_id),
      interfaces: [],
      unknowns: [],
      confidence: "high",
      rationale: "The supplied entry is a parsed Markdown document with exact documentation evidence.",
    }],
    relationships: [],
    unmapped_entries: [],
    global_unknowns: [],
    warnings: [],
  };
}

export function sampleInternalAiProviderConfiguration(input: {
  primaryProviderId?: string;
  primaryChannelId?: string;
  primaryModelId?: string;
  standbyProviderId?: string;
  standbyChannelId?: string;
  standbyModelId?: string;
  standbyEnabled?: boolean;
  standbyGovernanceQualified?: boolean;
  includeStandbySnapshot?: boolean;
} = {}): InternalAiProviderConfigurationSnapshotV3 {
  const standbyEnabled = input.standbyEnabled ?? false;
  const standbyGovernanceQualified = input.standbyGovernanceQualified ?? false;
  const includeStandbySnapshot = input.includeStandbySnapshot ?? standbyEnabled;
  const activeEngineId = "test-active-engine";
  const activeRevision = "1";
  const standbyEngineId = "test-standby-engine";
  const standbyRevision = "1";
  const capability = "AI_CONTEXT_MAPPING_V1/test-capability";
  const activeMaterial = {
    engineId: activeEngineId,
    engineConfigRevision: activeRevision,
    providerId: input.primaryProviderId ?? "zai",
    channelId: input.primaryChannelId ?? "zai_direct_chat_completions_v4",
    modelId: input.primaryModelId ?? "glm-4.7-flash",
    endpoint: "https://primary.example.test/v1/chat/completions",
    credentialReference: "PRIMARY_TEST_KEY",
    transportProfileId: "chat_completions_json_object_v1" as const,
    behaviorProfileId: "zai_error_semantics_v1" as const,
    capabilityProfileVersion: capability,
    timeoutMs: 60_000,
  };
  const standbyMaterial = {
    engineId: standbyEngineId,
    engineConfigRevision: standbyRevision,
    providerId: input.standbyProviderId ?? "sambanova",
    channelId: input.standbyChannelId ?? "sambanova_direct_chat_completions_v1",
    modelId: input.standbyModelId ?? "gpt-oss-120b",
    endpoint: "https://standby.example.test/v1/chat/completions",
    credentialReference: "STANDBY_TEST_KEY",
    transportProfileId: "chat_completions_json_schema_v1" as const,
    behaviorProfileId: "sambanova_error_semantics_v1" as const,
    capabilityProfileVersion: capability,
    timeoutMs: 60_000,
  };
  const activeFingerprint = deriveInternalAiEngineConfigurationSha256(activeMaterial);
  const standbyFingerprint = deriveInternalAiEngineConfigurationSha256(standbyMaterial);
  return {
    schema_version: INTERNAL_AI_PROVIDER_CONFIGURATION_SCHEMA_VERSION,
    registry_schema_version: "intentchord.internal-ai-engine-registry.v2",
    selected_engine_id: activeEngineId,
    selected_engine_config_revision: activeRevision,
    selected_engine_configuration_sha256: activeFingerprint,
    selection_policy: { selection_policy_id: "test-single", selection_policy_version: "1", selection_mode: "SINGLE" },
    active: {
      role: "ACTIVE", engine_id: activeEngineId, engine_config_revision: activeRevision, engine_configuration_sha256: activeFingerprint,
      provider_id: activeMaterial.providerId, channel_id: activeMaterial.channelId, model_id: activeMaterial.modelId,
      endpoint: activeMaterial.endpoint, credential_reference: activeMaterial.credentialReference,
      transport_profile_id: activeMaterial.transportProfileId, behavior_profile_id: activeMaterial.behaviorProfileId, capability_profile_version: capability, owner_enabled: true,
      qualification: { qualification_id: "test-active-qualification", engine_id: activeEngineId, engine_config_revision: activeRevision, engine_configuration_sha256: activeFingerprint, qualification_status: "QUALIFIED", qualification_scope: "AI_CONTEXT_MAPPING_V1", qualified_at: "2026-08-18T00:00:00.000Z", qualified_by: "SYSTEM_OWNER", evidence_reference: "benchmark:test-active", capability_profile_version: capability },
      timeout_ms: activeMaterial.timeoutMs,
    },
    ...(includeStandbySnapshot ? { standby: {
      role: "STANDBY" as const, engine_id: standbyEngineId, engine_config_revision: standbyRevision, engine_configuration_sha256: standbyFingerprint,
      provider_id: standbyMaterial.providerId, channel_id: standbyMaterial.channelId, model_id: standbyMaterial.modelId,
      endpoint: standbyMaterial.endpoint, credential_reference: standbyMaterial.credentialReference,
      transport_profile_id: standbyMaterial.transportProfileId, behavior_profile_id: standbyMaterial.behaviorProfileId, capability_profile_version: capability, owner_enabled: false,
      ...(standbyGovernanceQualified ? { qualification: { qualification_id: "test-standby-qualification", engine_id: standbyEngineId, engine_config_revision: standbyRevision, engine_configuration_sha256: standbyFingerprint, qualification_status: "QUALIFIED" as const, qualification_scope: "AI_CONTEXT_MAPPING_V1" as const, qualified_at: "2026-08-18T00:00:00.000Z", qualified_by: "SYSTEM_OWNER", evidence_reference: "benchmark:test-standby", capability_profile_version: capability } } : {}),
      timeout_ms: standbyMaterial.timeoutMs,
    } } : {}),
    failover_policy: { enabled: standbyEnabled, governance_qualified: standbyGovernanceQualified, technical_failure_only: true, validation_failure_failover: false },
  };
}
