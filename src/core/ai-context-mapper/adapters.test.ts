import { describe, expect, it } from "vitest";
import { ChatCompletionsProviderAdapter } from "@/core/ai-context-mapper/adapters/chat-completions";
import { normalizeSambaNovaProviderError } from "@/core/ai-context-mapper/adapters/sambanova";
import { normalizeZaiProviderError } from "@/core/ai-context-mapper/adapters/zai";
import { AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1, buildMapperUserPayload } from "@/core/ai-context-mapper/prompt";
import { modelProposedContextCatalogJsonSchema } from "@/core/ai-context-mapper/schema";
import { sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";

function request() {
  const input = sampleMappingInput();
  return { mapping_input: input, system_prompt: AI_CONTEXT_MAPPER_SYSTEM_PROMPT_V1, user_payload: buildMapperUserPayload(input), output_json_schema: modelProposedContextCatalogJsonSchema, timeout_ms: 1000 };
}

function primaryAdapter(fetchImpl: typeof fetch, modelId = "model-a", providerId = "provider-a") {
  return new ChatCompletionsProviderAdapter({
    providerId,
    channelId: "chat-json-object-v1",
    modelId,
    endpoint: "https://provider-a.example.test/v1/chat/completions",
    credential: "test-key",
    transportProfileId: "chat_completions_json_object_v1",
    errorNormalizer: normalizeZaiProviderError,
    enabled: true,
    executionAuthorized: true,
    operationalRole: "PRIMARY",
  }, fetchImpl);
}

function standbyAdapter(fetchImpl: typeof fetch) {
  return new ChatCompletionsProviderAdapter({
    providerId: "provider-standby",
    channelId: "chat-json-schema-v1",
    modelId: "standby-model",
    endpoint: "https://provider-standby.example.test/v1/chat/completions",
    credential: "test-key",
    transportProfileId: "chat_completions_json_schema_v1",
    errorNormalizer: normalizeSambaNovaProviderError,
    enabled: true,
    executionAuthorized: true,
    operationalRole: "STANDBY",
  }, fetchImpl);
}

describe("AI Context Mapper configured Chat-Completions transport", () => {
  it("uses the runtime-configured Provider endpoint and Model with JSON-object structured output", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = primaryAdapter(async (url, init) => {
      expect(String(url)).toBe("https://provider-a.example.test/v1/chat/completions");
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "req-a", model: "model-b-response", choices: [{ message: { content: JSON.stringify(validCatalog()) } }], usage: { total_tokens: 10 } }), { status: 200 });
    }, "configured-model-b");
    const response = await adapter.execute(request());
    expect(captured.model).toBe("configured-model-b");
    expect(captured.response_format).toEqual({ type: "json_object" });
    expect(captured).not.toHaveProperty("tools");
    expect(response.response_model_id).toBe("model-b-response");
    expect(response.provider_request_id).toBe("req-a");
  });

  it("uses strict JSON-schema structured output for the supported schema profile", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = standbyAdapter(async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "req-standby", model: "standby-model", choices: [{ message: { content: JSON.stringify(validCatalog()) } }] }), { status: 200 });
    });
    await adapter.execute(request());
    expect(captured.model).toBe("standby-model");
    expect(captured.response_format).toMatchObject({ type: "json_schema" });
    expect(captured).not.toHaveProperty("tools");
  });

  it("keeps behavior-specific error normalization without coupling Provider identity to the adapter", async () => {
    const adapter = primaryAdapter(async () => new Response(JSON.stringify({ code: 1302 }), { status: 429 }), "model-x", "different-compatible-provider");
    await expect(adapter.execute(request())).rejects.toMatchObject({ normalizedCode: "PRIMARY_RATE_LIMITED", failoverEligible: true });
  });

  it("maps behavior-profile errors to the resolved operational role rather than the old vendor role", async () => {
    const adapter = new ChatCompletionsProviderAdapter({
      providerId: "compatible-active-provider",
      channelId: "chat-json-schema-v1",
      modelId: "active-schema-model",
      endpoint: "https://compatible-active.example.test/v1/chat/completions",
      credential: "test-key",
      transportProfileId: "chat_completions_json_schema_v1",
      errorNormalizer: normalizeSambaNovaProviderError,
      enabled: true,
      executionAuthorized: true,
      operationalRole: "PRIMARY",
    }, async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }));
    await expect(adapter.execute(request())).rejects.toMatchObject({ normalizedCode: "PRIMARY_DAILY_LIMIT_REACHED", failoverEligible: true });
  });

  it("returns an empty model body for deterministic validation when a successful envelope has no content", async () => {
    const adapter = primaryAdapter(async () => new Response(JSON.stringify({ id: "req-empty", model: "model-a", choices: [] }), { status: 200 }));
    await expect(adapter.execute(request())).resolves.toMatchObject({ raw_model_content: "" });
  });

  it("persists content-safe provider diagnostics for empty-content reasoning responses", async () => {
    const adapter = primaryAdapter(async () => new Response(JSON.stringify({
      id: "req-reasoning-only",
      model: "model-a",
      choices: [{
        finish_reason: "length",
        native_finish_reason: "length",
        message: {
          role: "assistant",
          content: "",
          reasoning: "private model reasoning must not be persisted verbatim",
          reasoning_details: [{ type: "reasoning.summary" }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200 }));

    const response = await adapter.execute(request());
    expect(response.raw_model_content).toBe("");
    expect(response.usage_metadata).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      diagnostic_choice_count: 1,
      diagnostic_finish_reason: "length",
      diagnostic_native_finish_reason: "length",
      diagnostic_content_chars: 0,
      diagnostic_reasoning_chars: 54,
      diagnostic_reasoning_details_count: 1,
      diagnostic_refusal_chars: 0,
    });
    expect(JSON.stringify(response.usage_metadata)).not.toContain("private model reasoning");
  });

  it("captures safe structure for HTTP-200 provider error envelopes without copying model content", async () => {
    const adapter = primaryAdapter(async () => new Response(JSON.stringify({
      id: "gen-200-error-envelope",
      error: { code: 503, type: "provider_error", message: "Upstream provider returned no choices." },
    }), { status: 200 }));
    const response = await adapter.execute(request());
    expect(response.raw_model_content).toBe("");
    expect(response.usage_metadata).toMatchObject({
      diagnostic_choice_count: 0,
      diagnostic_error_present: true,
      diagnostic_error_code: "503",
      diagnostic_error_type: "provider_error",
      diagnostic_error_message: "Upstream provider returned no choices.",
    });
    expect(response.usage_metadata.diagnostic_top_level_keys).toEqual(["error", "id"]);
  });

  it("bounds diagnostic provider key names and never accepts arbitrary usage arrays", async () => {
    const longKey = "probe_" + "x".repeat(400);
    const adapter = primaryAdapter(async () => new Response(JSON.stringify({
      id: "bounded",
      [longKey]: "untrusted raw value must not be stored as diagnostic metadata",
      choices: [],
      usage: { safe_scalar: 1, unsafe_array: ["private", "should_not_escape"] },
    }), { status: 200 }));
    const response = await adapter.execute(request());
    const keys = response.usage_metadata.diagnostic_top_level_keys;
    expect(Array.isArray(keys)).toBe(true);
    expect((keys as string[]).length).toBeLessThanOrEqual(24);
    expect((keys as string[]).every(key => key.length <= 64)).toBe(true);
    expect(response.usage_metadata).not.toHaveProperty("unsafe_array");
    expect(JSON.stringify(response.usage_metadata)).not.toContain("should_not_escape");
  });
});
