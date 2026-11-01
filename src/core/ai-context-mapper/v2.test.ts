import { describe, expect, it } from "vitest";
import { bindInternalAiEngineConfiguration, resolveSingleQualifiedInternalAiEngine } from "@/core/ai-context-mapper/engine-registry";
import { AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2 } from "@/core/ai-context-mapper/prompt-v2";
import { validateModelContextAnalysisV2 } from "@/core/ai-context-mapper/validator-v2";
import {
  CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
  MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
  type ContextAssemblyMappingInputV2,
} from "@/core/ai-context-mapper/v2";
import type { InternalAiQualificationRecord } from "@/core/ai-context-mapper/types";

const sha = `sha256:${"a".repeat(64)}`;
const policy = { selectionPolicyId: "single", selectionPolicyVersion: "1", selectionMode: "SINGLE" as const };

function mappingInput(): ContextAssemblyMappingInputV2 {
  return {
    schema_version: CONTEXT_ASSEMBLY_MAPPING_INPUT_SCHEMA_VERSION,
    context_assembly_id: "assembly_001",
    context_assembly_revision_id: "assembly_revision_001",
    context_assembly_revision: 1,
    created_at: "2026-08-18T12:00:00.000Z",
    source_bindings: [
      {
        workspace_id: "workspace_server",
        workspace_registration_revision: 1,
        workspace_registration_fingerprint: "workspace-fingerprint-server",
        workspace_revision_id: "workspace_revision_server",
        workspace_index_snapshot_id: "snapshot_server",
        canonical_index_artifact_id: "artifact_server",
        workspace_index_sha256: sha,
        artifact_semantic_sha256: sha,
      },
    ],
    entries: [
      {
        entry_id: "entry_server_update",
        workspace_id: "workspace_server",
        normalized_path: "src/update/publisher.ts",
        entry_type: "FILE",
        language_or_format: "typescript",
        size_bytes: 100,
        content_or_metadata_fingerprint: sha,
        index_supported_signals: {
          file_kind: "SOURCE",
          parse_status: "PARSED",
          coverage_state: "COVERED",
          fact_signals: [],
          relation_signals: [],
        },
      },
    ],
    serialized_payload_sha256: sha,
    provider_neutral_estimated_tokens: 200,
    proof_obligations: ["evidence-backed-components", "missing-evidence-grounding"],
  };
}

function validMissingEvidenceAnalysis() {
  return {
    schema_version: MODEL_CONTEXT_ANALYSIS_SCHEMA_VERSION_V2,
    analysis_outcome: "ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE" as const,
    catalog_summary: "Server-side update publication is evidenced; the consuming implementation is missing from the governed source universe.",
    components: [
      {
        component_id: "ctx_update_channel",
        display_name: "Update Channel",
        context_kind: "service" as const,
        summary: "Publishes update state.",
        responsibilities: ["Publish update state"],
        workspace_ids: ["workspace_server"],
        evidence_entry_ids: ["entry_server_update"],
        interfaces: ["update contract"],
        unknowns: ["Client consumer implementation"],
        confidence: "high" as const,
        rationale: "The governed server evidence proves the publisher side only.",
      },
    ],
    relationships: [],
    missing_evidence_requests: [
      {
        gap_id: "gap_client_consumer",
        gap_type: "INTERNAL_SOURCE" as const,
        affected_component_ids: ["ctx_update_channel"],
        affected_relationship_ids: [],
        known_evidence_entry_ids: ["entry_server_update"],
        missing_evidence_description: "Client-side update consumer / updater implementation is required.",
        required_evidence_kind: "Client-side source implementing the update consumer contract",
        source_hint: "Client",
        blocking_reason: "The logical Update Channel cannot be closed across its producer/consumer boundary.",
        materiality: "BLOCKING" as const,
        confidence: "high" as const,
      },
    ],
    material_contradictions: [],
    global_unknowns: [],
    warnings: [],
  };
}

describe("AI_CONTEXT_MAPPING_V2 semantic contract", () => {
  it("represents a grounded material Missing Evidence Request without granting Workspace or Closure authority", () => {
    const result = validateModelContextAnalysisV2(JSON.stringify(validMissingEvidenceAnalysis()), mappingInput());
    expect(result.status).toBe("PASS");
    expect(result.parsed_analysis?.analysis_outcome).toBe("ANALYSIS_REQUIRES_ADDITIONAL_EVIDENCE");
    expect(result.parsed_analysis?.missing_evidence_requests[0]).toMatchObject({
      gap_type: "INTERNAL_SOURCE",
      materiality: "BLOCKING",
      known_evidence_entry_ids: ["entry_server_update"],
    });
    expect(JSON.stringify(result.parsed_analysis)).not.toContain("workspace_to_add");
    expect(JSON.stringify(result.parsed_analysis)).not.toContain("CONTEXT_CLOSURE");
  });

  it("rejects model attempts to manufacture Context Closure authority", () => {
    const invalid = { ...validMissingEvidenceAnalysis(), context_closure: "PASS" };
    const result = validateModelContextAnalysisV2(JSON.stringify(invalid), mappingInput());
    expect(result.status).toBe("FAIL");
    expect(result.gates.some(gate => gate.gate === "JSON_SCHEMA" && gate.status === "FAIL")).toBe(true);
  });

  it("keeps the V2 prompt engine/provider independent and explicitly denies Workspace authority", () => {
    expect(AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2).toContain("AI_CONTEXT_MAPPING_V2");
    expect(AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2).toContain("NO Workspace");
    expect(AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2).toContain("You do NOT decide Context Closure");
    expect(AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V2).not.toMatch(/Mistral|Z\.AI|SambaNova/i);
  });

  it("does not treat an existing V1 qualification as V2 qualification", () => {
    const engine = bindInternalAiEngineConfiguration({
      engineId: "engine-a",
      engineConfigRevision: "1",
      providerId: "provider-a",
      channelId: "chat-v1",
      modelId: "model-a",
      endpoint: "https://provider-a.example.test/v1/chat",
      credentialReference: "ENGINE_A_KEY",
      transportProfileId: "chat_completions_json_object_v1",
      behaviorProfileId: "zai_error_semantics_v1",
      capabilityProfileVersion: "cap-v1",
      timeoutMs: 60000,
    });
    const v1: InternalAiQualificationRecord = {
      qualificationId: "qual-v1",
      engineId: engine.engineId,
      engineConfigRevision: engine.engineConfigRevision,
      engineConfigurationSha256: engine.engineConfigurationSha256,
      qualificationStatus: "QUALIFIED",
      qualificationScope: "AI_CONTEXT_MAPPING_V1",
      qualifiedAt: "2026-08-18T00:00:00.000Z",
      qualifiedBy: "SYSTEM_OWNER",
      evidenceReference: "qualification:v1",
      capabilityProfileVersion: engine.capabilityProfileVersion,
    };
    expect(() => resolveSingleQualifiedInternalAiEngine({
      engines: [engine], qualifications: [v1], ownerEnabledEngineIds: [engine.engineId], selectionPolicy: policy,
      qualificationScope: "AI_CONTEXT_MAPPING_V2",
    })).toThrow(/AI_CONTEXT_MAPPING_V2/);

    const v2: InternalAiQualificationRecord = { ...v1, qualificationId: "qual-v2", qualificationScope: "AI_CONTEXT_MAPPING_V2", evidenceReference: "qualification:v2" };
    expect(resolveSingleQualifiedInternalAiEngine({
      engines: [engine], qualifications: [v2], ownerEnabledEngineIds: [engine.engineId], selectionPolicy: policy,
      qualificationScope: "AI_CONTEXT_MAPPING_V2",
    }).qualification.qualificationScope).toBe("AI_CONTEXT_MAPPING_V2");
  });
});
