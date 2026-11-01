import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";

if (!process.env.DATABASE_URL && fs.existsSync(".env.local")) {
  const envContent = fs.readFileSync(".env.local", "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

import { databasePool } from "@/server/db";
import { beginRollbackOnlyOwnerDbTest, type RollbackOnlyOwnerDbHarness } from "@/test/rollback-only-owner-db";
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import {
  checkBehaviorTransportCompatibility,
  isSupportedProtocolFamily,
} from "@/core/ai-context-mapper/protocol-family";
import { AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1, buildMapperUserPayload } from "@/core/ai-context-mapper/prompt";
import { modelProposedContextCatalogJsonSchema } from "@/core/ai-context-mapper/schema";
import { sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";
import { deriveInternalAiEngineConfigurationSha256 } from "@/core/ai-context-mapper/engine-registry";
import type { InternalAiEngineConfigurationMaterial } from "@/core/ai-context-mapper/types";

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

describe("Gate 2: Protocol-family indirection + synthetic compatible Vendor", () => {
  const testPrefix = `gate2_${Date.now()}`;
  const syntheticVendorId = `${testPrefix}_acme`;
  const unsupportedFamilyVendorId = `${testPrefix}_bad`;
  const engineId = `${testPrefix}_engine`;
  const modelId = `${testPrefix}_model`;
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
  });

  afterAll(async () => {
    const pool = databasePool();
    await pool
      .query("DELETE FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1", [engineId])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1", [`${engineId}_zai`])
      .catch(() => {});
    await pool.query("DELETE FROM intentchord.internal_ai_engines WHERE engine_id = $1", [engineId]).catch(() => {});
    await pool.query("DELETE FROM intentchord.internal_ai_engines WHERE engine_id = $1", [`${engineId}_zai`]).catch(() => {});
    await pool.query("DELETE FROM intentchord.internal_ai_models WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.end().catch(() => {});
    await rollbackHarness?.close();
  });

  it("1. Supported protocol family accepts compatible Vendor via Admin config only", async () => {
    expect(isSupportedProtocolFamily("openai_chat_completions_v1")).toBe(true);
    const vendor = await internalAiVendorService.addVendor(
      {
        vendorId: syntheticVendorId,
        displayName: "Gate 2 Synthetic OpenAI-Compatible Vendor",
        baseUrl: "https://api.gate2-synthetic.example.com",
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    expect(vendor.vendorId).toBe(syntheticVendorId);
    expect(vendor.protocolProfile).toBe("openai_chat_completions_v1");

    const model = await internalAiVendorService.addModel(
      syntheticVendorId,
      {
        modelId,
        displayName: "Gate 2 Model",
        providerFacingModelId: "gate2-model-v1",
      },
      "OWNER_TEST",
    );
    expect(model.modelId).toBe(modelId);
  });

  it("2. Incompatible/unknown protocol family Vendor is rejected (adapter-required path)", async () => {
    await expect(
      internalAiVendorService.addVendor(
        {
          vendorId: unsupportedFamilyVendorId,
          displayName: "Unsupported Family Vendor",
          baseUrl: "https://api.unsupported-family.example.com",
          authType: "bearer_token",
          protocolProfile: "unsupported_quantum_transport_v1",
        },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/not supported/i);
  });

  it("3. Behavior×transport compatibility is data-driven (not vendor-specific code)", () => {
    expect(checkBehaviorTransportCompatibility("zai_error_semantics_v1", "chat_completions_json_object_v1")).toBe("COMPATIBLE");
    expect(checkBehaviorTransportCompatibility("zai_error_semantics_v1", "chat_completions_json_schema_v1")).toBe("INCOMPATIBLE");
    expect(checkBehaviorTransportCompatibility("sambanova_error_semantics_v1", "chat_completions_json_schema_v1")).toBe("COMPATIBLE");
    expect(
      checkBehaviorTransportCompatibility("openai_chat_completions_error_semantics_v1", "chat_completions_json_schema_v1"),
    ).toBe("COMPATIBLE");
    expect(
      checkBehaviorTransportCompatibility("openai_chat_completions_error_semantics_v1", "chat_completions_json_object_v1"),
    ).toBe("COMPATIBLE");
    expect(checkBehaviorTransportCompatibility("future_custom_error_semantics_v1", "chat_completions_json_object_v1")).toBe(
      "UNKNOWN_BEHAVIOR_PROFILE",
    );
  });

  it("4. Synthetic Vendor engine revision uses family profiles without vendor-specific source guards", async () => {
    await internalAiEngineRegistryService.registerEngine(
      { engineId, displayName: "Gate 2 Synthetic Engine" },
      "OWNER_TEST",
    );
    const material: InternalAiEngineConfigurationMaterial = {
      engineId,
      engineConfigRevision: "1",
      providerId: syntheticVendorId,
      channelId: `${syntheticVendorId}_chat`,
      modelId: "gate2-model-v1",
      endpoint: "https://api.gate2-synthetic.example.com/v1/chat/completions",
      credentialReference: "GATE2_SYNTHETIC_KEY",
      transportProfileId: "chat_completions_json_schema_v1",
      behaviorProfileId: "openai_chat_completions_error_semantics_v1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
    };
    const rev = await internalAiEngineRegistryService.createEngineRevision(material, "OWNER_TEST");
    expect(rev.engineConfigurationSha256).toBe(deriveInternalAiEngineConfigurationSha256(material));
    expect(rev.behaviorProfileId).toBe("openai_chat_completions_error_semantics_v1");
    expect(rev.transportProfileId).toBe("chat_completions_json_schema_v1");
  });

  it("5. Known-incompatible pair still fails closed at revision creation", async () => {
    await internalAiEngineRegistryService.registerEngine(
      { engineId: `${engineId}_zai`, displayName: "Gate 2 ZAI Guard" },
      "OWNER_TEST",
    );
    await expect(
      internalAiEngineRegistryService.createEngineRevision(
        {
          engineId: `${engineId}_zai`,
          engineConfigRevision: "1",
          providerId: "zai",
          channelId: "zai_chat",
          modelId: "glm-4.7-flash",
          endpoint: "https://api.z.ai/v4/chat/completions",
          credentialReference: "ZAI_API_KEY",
          transportProfileId: "chat_completions_json_schema_v1",
          behaviorProfileId: "zai_error_semantics_v1",
          capabilityProfileVersion: "v1",
          timeoutMs: 60000,
        },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/does not support chat_completions_json_schema_v1/i);
  });

  it("6. Runtime adapter executes synthetic Vendor with generic normalizer (config-only path)", async () => {
    const definition = {
      engineId,
      engineConfigRevision: "1",
      providerId: syntheticVendorId,
      channelId: `${syntheticVendorId}_chat`,
      modelId: "gate2-model-v1",
      endpoint: "https://api.gate2-synthetic.example.com/v1/chat/completions",
      credentialReference: "GATE2_SYNTHETIC_KEY",
      transportProfileId: "chat_completions_json_schema_v1" as const,
      behaviorProfileId: "openai_chat_completions_error_semantics_v1" as const,
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
      engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256({
        engineId,
        engineConfigRevision: "1",
        providerId: syntheticVendorId,
        channelId: `${syntheticVendorId}_chat`,
        modelId: "gate2-model-v1",
        endpoint: "https://api.gate2-synthetic.example.com/v1/chat/completions",
        credentialReference: "GATE2_SYNTHETIC_KEY",
        transportProfileId: "chat_completions_json_schema_v1",
        behaviorProfileId: "openai_chat_completions_error_semantics_v1",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
        timeoutMs: 60000,
      }),
      role: "ACTIVE" as const,
      ownerEnabled: true,
      qualification: {
        qualificationId: `q-${engineId}-1-AI_CONTEXT_MAPPING_V2`,
        engineId,
        engineConfigRevision: "1",
        engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256({
          engineId,
          engineConfigRevision: "1",
          providerId: syntheticVendorId,
          channelId: `${syntheticVendorId}_chat`,
          modelId: "gate2-model-v1",
          endpoint: "https://api.gate2-synthetic.example.com/v1/chat/completions",
          credentialReference: "GATE2_SYNTHETIC_KEY",
          transportProfileId: "chat_completions_json_schema_v1",
          behaviorProfileId: "openai_chat_completions_error_semantics_v1",
          capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
          timeoutMs: 60000,
        }),
        qualificationStatus: "QUALIFIED" as const,
        qualificationScope: "AI_CONTEXT_MAPPING_V2" as const,
        qualifiedAt: "2026-09-22T00:00:00.000Z",
        qualifiedBy: "SYSTEM_OWNER",
        evidenceReference: "benchmark:gate2-synthetic",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      },
    };

    let outboundUrl = "";
    let outboundModel: unknown;
    const adapter = createInternalAiProviderAdapter(definition, {
      expectedQualificationScope: "AI_CONTEXT_MAPPING_V2",
      executionMode: "PRODUCTION",
      credentialOverride: "synthetic-test-credential",
      fetchImpl: async (url, init) => {
        outboundUrl = String(url);
        outboundModel = (JSON.parse(String(init?.body)) as Record<string, unknown>).model;
        return new Response(
          JSON.stringify({
            id: "req-gate2",
            model: "gate2-model-v1",
            choices: [{ message: { content: JSON.stringify(validCatalog()) } }],
          }),
          { status: 200 },
        );
      },
    });
    const res = await adapter.execute(providerRequest());
    expect(res.provider_request_id).toBe("req-gate2");
    expect(outboundUrl).toContain("api.gate2-synthetic.example.com");
    expect(outboundModel).toBe("gate2-model-v1");
    expect(adapter.provider_id).toBe(syntheticVendorId);
  });
});
