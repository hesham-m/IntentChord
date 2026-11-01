import { describe, expect, it } from "vitest";
import { AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1, buildMapperUserPayload } from "@/core/ai-context-mapper/prompt";
import { modelProposedContextCatalogJsonSchema } from "@/core/ai-context-mapper/schema";
import { sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";
import { readAiContextMapperConfig } from "@/server/ai-context-mapper-config";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import { deriveInternalAiEngineConfigurationSha256 } from "@/core/ai-context-mapper/engine-registry";
import type { InternalAiEngineConfigurationMaterial, InternalAiQualificationScope } from "@/core/ai-context-mapper/types";

const envNames = [
  "AI_CONTEXT_MAPPER_ENABLED",
  "AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON",
  "AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON",
  "AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS",
  "AI_CONTEXT_MAPPER_SELECTION_POLICY_ID",
  "AI_CONTEXT_MAPPER_SELECTION_POLICY_VERSION",
  "AI_CONTEXT_MAPPER_SELECTION_POLICY_MODE",
  "AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID",
  "AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_REVISION",
  "AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID",
  "AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION",
  "AI_CONTEXT_MAPPER_STANDBY_ENABLED",
  "AI_CONTEXT_MAPPER_LIVE_PROVIDER_TESTS_ENABLED",
  "TEST_ACTIVE_KEY",
  "TEST_CANDIDATE_KEY",
  "TEST_STANDBY_KEY",
] as const;

async function withEnv<T>(work: () => Promise<T>): Promise<T> {
  const snapshot = new Map(envNames.map(n => [n, process.env[n]]));
  try {
    for (const n of envNames) delete process.env[n];
    return await work();
  } finally {
    for (const n of envNames) {
      const v = snapshot.get(n);
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

function providerRequest() {
  const input = sampleMappingInput();
  return {
    mapping_input: input,
    system_prompt: AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1,
    user_payload: buildMapperUserPayload(input),
    output_json_schema: modelProposedContextCatalogJsonSchema,
    timeout_ms: 1000,
  };
}

function engine(engineId: string, revision: string, providerId: string, modelId: string, credentialReference = "TEST_ACTIVE_KEY"): InternalAiEngineConfigurationMaterial {
  return {
    engineId,
    engineConfigRevision: revision,
    providerId,
    channelId: `${providerId}-chat-v1`,
    modelId,
    endpoint: `https://${providerId}.example.test/v1/chat/completions`,
    credentialReference,
    transportProfileId: "chat_completions_json_object_v1",
    behaviorProfileId: "zai_error_semantics_v1",
    capabilityProfileVersion: "cap-v1",
    timeoutMs: 60000,
  };
}

function qual(target: ReturnType<typeof engine>, scope: InternalAiQualificationScope = "AI_CONTEXT_MAPPING_V1") {
  return {
    qualificationId: `q-${target.engineId}-${target.engineConfigRevision}-${scope}`,
    engineId: target.engineId,
    engineConfigRevision: target.engineConfigRevision,
    engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(target),
    qualificationStatus: "QUALIFIED" as const,
    qualificationScope: scope,
    qualifiedAt: "2026-08-18T00:00:00.000Z",
    qualifiedBy: "SYSTEM_OWNER",
    evidenceReference: "benchmark:evidence",
    capabilityProfileVersion: "cap-v1",
  };
}

function configure(engines: unknown[], quals: unknown[], enabled: string[]) {
  process.env.AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON = JSON.stringify(engines);
  process.env.AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON = JSON.stringify(quals);
  process.env.AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS = enabled.join(",");
  process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID = "standby-engine";
  process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION = "1";
  process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
  process.env.TEST_ACTIVE_KEY = "test-secret";
  process.env.TEST_CANDIDATE_KEY = "candidate-secret";
  process.env.TEST_STANDBY_KEY = "standby-secret";
}

describe("Internal AI governed runtime engine resolution", () => {
  it("switches qualified Model A to Model B by configuration only and sends the selected Model", () => withEnv(async () => {
    const standby = engine("standby-engine", "1", "standby-provider", "standby-model", "TEST_STANDBY_KEY");
    const modelA = engine("engine-a", "1", "compatible-provider", "qualified-model-a");
    configure([modelA, standby], [qual(modelA)], ["engine-a"]);
    expect(readAiContextMapperConfig().active?.modelId).toBe("qualified-model-a");
    const modelB = engine("engine-b", "1", "compatible-provider", "qualified-model-b");
    configure([modelB, standby], [qual(modelB)], ["engine-b"]);
    const config = readAiContextMapperConfig();
    let outboundModel: unknown;
    const adapter = createInternalAiProviderAdapter(config.active!, {
      executionMode: "PRODUCTION",
      expectedQualificationScope: "AI_CONTEXT_MAPPING_V1",
      fetchImpl: async (_url, init) => {
        outboundModel = (JSON.parse(String(init?.body)) as Record<string, unknown>).model;
        return new Response(JSON.stringify({ id: "req-b", model: "qualified-model-b", choices: [{ message: { content: JSON.stringify(validCatalog()) } }] }), { status: 200 });
      },
    });
    await adapter.execute(providerRequest());
    expect(outboundModel).toBe("qualified-model-b");
  }));

  it("switches a compatible Provider identity/endpoint/credential through runtime registry data", () => withEnv(async () => {
    const active = engine("engine-b", "1", "provider-b", "model-b");
    const standby = engine("standby-engine", "1", "standby-provider", "standby-model", "TEST_STANDBY_KEY");
    configure([active, standby], [qual(active)], ["engine-b"]);
    const config = readAiContextMapperConfig();
    let seenUrl = "";
    const adapter = createInternalAiProviderAdapter(config.active!, {
      executionMode: "PRODUCTION",
      expectedQualificationScope: "AI_CONTEXT_MAPPING_V1",
      fetchImpl: async url => {
        seenUrl = String(url);
        return new Response(JSON.stringify({ id: "req", model: "model-b", choices: [{ message: { content: JSON.stringify(validCatalog()) } }] }), { status: 200 });
      },
    });
    await adapter.execute(providerRequest());
    expect(adapter.provider_id).toBe("provider-b");
    expect(seenUrl).toContain("provider-b.example.test");
    expect(JSON.stringify(config.providerConfigurationSnapshot)).not.toContain("test-secret");
  }));

  it("permits Candidate benchmark without qualification but never promotes it to Active", () => withEnv(async () => {
    const active = engine("active-engine", "1", "provider-a", "active-model");
    const candidate = engine("candidate-engine", "1", "provider-c", "candidate-model", "TEST_CANDIDATE_KEY");
    const standby = engine("standby-engine", "1", "provider-s", "standby-model", "TEST_STANDBY_KEY");
    configure([active, candidate, standby], [qual(active)], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID = "candidate-engine";
    process.env.AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_REVISION = "1";
    const config = readAiContextMapperConfig();
    expect(config.candidate?.qualification).toBeUndefined();
    const adapter = createInternalAiProviderAdapter(config.candidate!, {
      executionMode: "CANDIDATE_BENCHMARK",
      expectedQualificationScope: "AI_CONTEXT_MAPPING_V1",
      fetchImpl: async () => new Response(JSON.stringify({ id: "req", model: "candidate-model", choices: [{ message: { content: JSON.stringify(validCatalog()) } }] }), { status: 200 }),
    });
    await adapter.execute(providerRequest());
    expect(config.active?.engineId).toBe("active-engine");
  }));

  describe("Owner Correction 1: Mandatory expectedQualificationScope enforcement", () => {
    it("V1 caller + V1 record = PASS (adapter execution authorized)", () => withEnv(async () => {
      const active = engine("engine-v1", "1", "provider-v1", "model-v1");
      const qV1 = qual(active, "AI_CONTEXT_MAPPING_V1");
      configure([active], [qV1], ["engine-v1"]);
      const config = readAiContextMapperConfig();
      const adapter = createInternalAiProviderAdapter(config.active!, {
        executionMode: "PRODUCTION",
        expectedQualificationScope: "AI_CONTEXT_MAPPING_V1",
        credentialOverride: "test-secret",
        fetchImpl: async () => new Response(JSON.stringify({ id: "req", model: "model-v1", choices: [{ message: { content: JSON.stringify(validCatalog()) } }] }), { status: 200 }),
      });
      const res = await adapter.execute(providerRequest());
      expect(res.provider_request_id).toBe("req");
    }));

    it("V1 caller + V2 record = REJECT (execution not authorized)", () => withEnv(async () => {
      const active = engine("engine-v2", "1", "provider-v2", "model-v2");
      const qV2 = qual(active, "AI_CONTEXT_MAPPING_V2");
      const resolvedConfig = {
        ...active,
        role: "ACTIVE" as const,
        ownerEnabled: true,
        qualification: qV2,
        engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(active),
      };
      expect(() => {
        createInternalAiProviderAdapter(resolvedConfig, {
          executionMode: "PRODUCTION",
          expectedQualificationScope: "AI_CONTEXT_MAPPING_V1",
          credentialOverride: "test-secret",
        });
      }).toThrow("The configured Active Internal AI engine is not governance-qualified.");
    }));

    it("V2 caller + V2 record = PASS (adapter execution authorized)", () => withEnv(async () => {
      const active = engine("engine-v2", "1", "provider-v2", "model-v2");
      const qV2 = qual(active, "AI_CONTEXT_MAPPING_V2");
      const resolvedConfig = {
        ...active,
        role: "ACTIVE" as const,
        ownerEnabled: true,
        qualification: qV2,
        engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(active),
      };
      const adapter = createInternalAiProviderAdapter(resolvedConfig, {
        executionMode: "PRODUCTION",
        expectedQualificationScope: "AI_CONTEXT_MAPPING_V2",
        credentialOverride: "test-secret",
        fetchImpl: async () => new Response(JSON.stringify({ id: "req", model: "model-v2", choices: [{ message: { content: JSON.stringify(validCatalog()) } }] }), { status: 200 }),
      });
      const res = await adapter.execute(providerRequest());
      expect(res.provider_request_id).toBe("req");
    }));

    it("V2 caller + V1 record = REJECT (execution not authorized)", () => withEnv(async () => {
      const active = engine("engine-v1", "1", "provider-v1", "model-v1");
      const qV1 = qual(active, "AI_CONTEXT_MAPPING_V1");
      const resolvedConfig = {
        ...active,
        role: "ACTIVE" as const,
        ownerEnabled: true,
        qualification: qV1,
        engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(active),
      };
      expect(() => {
        createInternalAiProviderAdapter(resolvedConfig, {
          executionMode: "PRODUCTION",
          expectedQualificationScope: "AI_CONTEXT_MAPPING_V2",
          credentialOverride: "test-secret",
        });
      }).toThrow("The configured Active Internal AI engine is not governance-qualified.");
    }));

    it("missing expected scope cannot authorize execution (fails closed)", () => withEnv(async () => {
      const active = engine("engine-v1", "1", "provider-v1", "model-v1");
      const qV1 = qual(active, "AI_CONTEXT_MAPPING_V1");
      const resolvedConfig = {
        ...active,
        role: "ACTIVE" as const,
        ownerEnabled: true,
        qualification: qV1,
        engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(active),
      };
      expect(() => {
        // @ts-expect-error Testing missing expectedQualificationScope
        createInternalAiProviderAdapter(resolvedConfig, { executionMode: "PRODUCTION", credentialOverride: "test-secret" });
      }).toThrow(/Expected qualification scope is mandatory/);
    }));
  });
});
