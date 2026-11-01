import { describe, expect, it } from "vitest";
import { AiContextMapperOrchestrator } from "@/core/ai-context-mapper/orchestrator";
import { InMemoryAiContextMappingRepository } from "@/server/ai-context-mapping-repository";
import { ProviderTechnicalError } from "@/core/ai-context-mapper/errors";
import {
  type AiContextMapperProviderAdapter,
  type InternalAiProviderConfigurationSnapshotV3,
  type MappingProviderRequest,
  type ProviderAttemptResponse,
} from "@/core/ai-context-mapper/types";
import { sampleInternalAiProviderConfiguration, sampleMappingInput, validCatalog } from "@/core/ai-context-mapper/test-fixtures";

const PRIMARY = { provider: "provider-primary", channel: "primary-chat-v1", model: "model-primary" } as const;
const STANDBY = { provider: "provider-standby", channel: "standby-chat-v1", model: "model-standby" } as const;

function providerConfigurationSnapshot(standbyEnabled: boolean, standbyGovernanceQualified: boolean): InternalAiProviderConfigurationSnapshotV3 {
  return sampleInternalAiProviderConfiguration({
    primaryProviderId: PRIMARY.provider, primaryChannelId: PRIMARY.channel, primaryModelId: PRIMARY.model,
    standbyProviderId: STANDBY.provider, standbyChannelId: STANDBY.channel, standbyModelId: STANDBY.model,
    standbyEnabled, standbyGovernanceQualified, includeStandbySnapshot: true,
  });
}

function orchestratorConfig(standbyEnabled: boolean, standbyGovernanceQualified: boolean) {
  return { standbyEnabled, standbyGovernanceQualified, providerConfigurationSnapshot: providerConfigurationSnapshot(standbyEnabled, standbyGovernanceQualified) };
}

function successResponse(provider: "primary" | "standby", input = sampleMappingInput()): ProviderAttemptResponse {
  const content = JSON.stringify(validCatalog(input));
  return {
    raw_model_content: content,
    response_model_id: provider === "primary" ? PRIMARY.model : STANDBY.model,
    provider_request_id: provider === "primary" ? "req-primary" : "req-standby",
    usage_metadata: { total_tokens: provider === "primary" ? 100 : 120 },
    rate_limit_metadata: {},
    raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

function adapter(
  provider: "primary" | "standby",
  behavior: (request: MappingProviderRequest) => Promise<ProviderAttemptResponse>,
): AiContextMapperProviderAdapter {
  return {
    provider_id: provider === "primary" ? PRIMARY.provider : STANDBY.provider,
    channel_id: provider === "primary" ? PRIMARY.channel : STANDBY.channel,
    model_id: provider === "primary" ? PRIMARY.model : STANDBY.model,
    execute: behavior,
  };
}

function primarySuccess(input = sampleMappingInput()): AiContextMapperProviderAdapter {
  return adapter("primary", async () => successResponse("primary", input));
}

function standbySuccess(input = sampleMappingInput()): AiContextMapperProviderAdapter {
  return adapter("standby", async () => successResponse("standby", input));
}

describe("AI Context Mapper governed orchestrator", () => {
  it("records primary success without standby and binds the exact final producer", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    const input = sampleMappingInput();
    let standbyCalls = 0;
    const orchestrator = new AiContextMapperOrchestrator(
      repo,
      primarySuccess(input),
      adapter("standby", async () => { standbyCalls += 1; return successResponse("standby", input); }),
      orchestratorConfig(false, false),
    );
    const run = await orchestrator.run(input);
    const attempts = await repo.listAttempts(run.id);
    expect(run.status).toBe("AWAITING_OWNER_REVIEW");
    expect(run.proposal?.resultEnvelope.provider_id).toBe(PRIMARY.provider);
    expect(run.proposal?.resultEnvelope.requested_model_id).toBe(PRIMARY.model);
    expect(run.proposal?.resultEnvelope.attempt_id).toBe(attempts[0].id);
    expect(run.finalAttemptId).toBe(attempts[0].id);
    expect(standbyCalls).toBe(0);
    expect(attempts).toHaveLength(1);
  });

  for (const scenario of [
    { name: "invalid JSON", raw: "{" },
    { name: "schema invalid", raw: JSON.stringify({ schema_version: "intentchord.model-proposed-context-catalog.v1" }) },
  ]) {
    it(`does not fail over when Primary output is ${scenario.name}`, async () => {
      const repo = new InMemoryAiContextMappingRepository();
      let standbyCalls = 0;
      const orchestrator = new AiContextMapperOrchestrator(
        repo,
        adapter("primary", async () => ({ ...successResponse("primary"), raw_model_content: scenario.raw })),
        adapter("standby", async () => { standbyCalls += 1; return successResponse("standby"); }),
        orchestratorConfig(true, true),
      );
      const run = await orchestrator.run(sampleMappingInput());
      expect(run.status).toBe("REJECTED_VALIDATION");
      expect(standbyCalls).toBe(0);
      expect(await repo.listAttempts(run.id)).toHaveLength(1);
    });
  }

  it("records the governance block after a technical failover trigger and one bounded retry", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    let calls = 0;
    const primary = adapter("primary", async () => {
      calls += 1;
      throw new ProviderTechnicalError("PRIMARY_PROVIDER_UNAVAILABLE", "unavailable", true, true);
    });
    const run = await new AiContextMapperOrchestrator(
      repo,
      primary,
      standbySuccess(),
      orchestratorConfig(false, false),
    ).run(sampleMappingInput());
    expect(calls).toBe(2);
    expect(run.status).toBe("STANDBY_BLOCKED_GOVERNANCE");
    expect((await repo.listAttempts(run.id))[0]).toMatchObject({ retryCount: 1, status: "FAILED_TECHNICAL" });
  });

  it("fails over from a Primary 429 without retry and records one run with two attempts", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    const input = sampleMappingInput();
    let primaryCalls = 0;
    const run = await new AiContextMapperOrchestrator(
      repo,
      adapter("primary", async () => {
        primaryCalls += 1;
        throw new ProviderTechnicalError("PRIMARY_RATE_LIMITED", "rate limited", false, true);
      }),
      standbySuccess(input),
      orchestratorConfig(true, true),
    ).run(input);
    const attempts = await repo.listAttempts(run.id);
    expect(primaryCalls).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(item => item.ordinal)).toEqual([1, 2]);
    expect(run.status).toBe("AWAITING_OWNER_REVIEW");
    expect(run.finalAttemptId).toBe(attempts[1].id);
    expect(run.proposal?.resultEnvelope.provider_id).toBe(STANDBY.provider);
  });

  for (const scenario of [
    { name: "503", code: "PRIMARY_PROVIDER_UNAVAILABLE" as const },
    { name: "timeout", code: "PRIMARY_NETWORK_TIMEOUT" as const },
  ]) {
    it(`retries one transient Primary ${scenario.name} failure then uses governed standby`, async () => {
      const repo = new InMemoryAiContextMappingRepository();
      const input = sampleMappingInput();
      let primaryCalls = 0;
      const run = await new AiContextMapperOrchestrator(
        repo,
        adapter("primary", async () => {
          primaryCalls += 1;
          throw new ProviderTechnicalError(scenario.code, "transient", true, true);
        }),
        standbySuccess(input),
        orchestratorConfig(true, true),
      ).run(input);
      const attempts = await repo.listAttempts(run.id);
      expect(primaryCalls).toBe(2);
      expect(attempts[0].retryCount).toBe(1);
      expect(attempts[1].providerId).toBe(STANDBY.provider);
      expect(run.status).toBe("AWAITING_OWNER_REVIEW");
    });
  }

  it("prioritizes JSON parse classification even when an invalid response also exceeds the output bound", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    const oversizedInvalidJson = `{${"x".repeat(80_000)}`;
    const run = await new AiContextMapperOrchestrator(
      repo,
      adapter("primary", async () => ({ ...successResponse("primary"), raw_model_content: oversizedInvalidJson })),
      standbySuccess(),
      orchestratorConfig(true, true),
    ).run(sampleMappingInput());
    const attempts = await repo.listAttempts(run.id);
    expect(run.status).toBe("REJECTED_VALIDATION");
    expect(attempts[0].normalizedErrorCode).toBe("PRIMARY_RESPONSE_NOT_JSON");
    expect(attempts).toHaveLength(1);
  });

  it("does not silently fail over on an unnormalized adapter or application error", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    let standbyCalls = 0;
    const run = await new AiContextMapperOrchestrator(
      repo,
      adapter("primary", async () => { throw new Error("unexpected adapter bug"); }),
      adapter("standby", async () => { standbyCalls += 1; return successResponse("standby"); }),
      orchestratorConfig(true, true),
    ).run(sampleMappingInput());
    const attempts = await repo.listAttempts(run.id);
    expect(run.status).toBe("FAILED");
    expect(standbyCalls).toBe(0);
    expect(attempts[0].normalizedErrorCode).toBe("UNKNOWN_PROVIDER_ERROR");
  });

  it("does not fail over when Primary authentication is invalid", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    let standbyCalls = 0;
    const run = await new AiContextMapperOrchestrator(
      repo,
      adapter("primary", async () => { throw new ProviderTechnicalError("PRIMARY_AUTH_MISSING_OR_INVALID", "missing", false, false); }),
      adapter("standby", async () => { standbyCalls += 1; return successResponse("standby"); }),
      orchestratorConfig(true, true),
    ).run(sampleMappingInput());
    expect(run.status).toBe("FAILED");
    expect(standbyCalls).toBe(0);
    expect(await repo.listAttempts(run.id)).toHaveLength(1);
  });

  it("records standby failure after a governed Primary failure without a third provider", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    let standbyCalls = 0;
    const run = await new AiContextMapperOrchestrator(
      repo,
      adapter("primary", async () => { throw new ProviderTechnicalError("PRIMARY_RATE_LIMITED", "rate", false, true); }),
      adapter("standby", async () => {
        standbyCalls += 1;
        throw new ProviderTechnicalError("STANDBY_PROVIDER_UNAVAILABLE", "maintenance", false, false);
      }),
      orchestratorConfig(true, true),
    ).run(sampleMappingInput());
    const attempts = await repo.listAttempts(run.id);
    expect(standbyCalls).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ status: "FAILED_TECHNICAL", normalizedErrorCode: "STANDBY_PROVIDER_UNAVAILABLE" });
    expect(run.status).toBe("FAILED");
    expect(run.finalAttemptId).toBe(attempts[1].id);
    expect(run.proposal).toBeUndefined();
  });

  it("uses the exact same Mapping Input identity and hash across Primary and Standby", async () => {
    const repo = new InMemoryAiContextMappingRepository();
    const input = sampleMappingInput();
    const seen: Array<{ snapshot: string; payload: string; workspace: string }> = [];
    const primary = adapter("primary", async request => {
      seen.push({ snapshot: request.mapping_input.mapping_input_snapshot_id, payload: request.mapping_input.serialized_payload_sha256, workspace: request.mapping_input.workspace_index_sha256 });
      throw new ProviderTechnicalError("PRIMARY_RATE_LIMITED", "rate limited", false, true);
    });
    const standby = adapter("standby", async request => {
      seen.push({ snapshot: request.mapping_input.mapping_input_snapshot_id, payload: request.mapping_input.serialized_payload_sha256, workspace: request.mapping_input.workspace_index_sha256 });
      return successResponse("standby", input);
    });
    const run = await new AiContextMapperOrchestrator(repo, primary, standby, orchestratorConfig(true, true)).run(input);
    expect(seen).toEqual([seen[0], seen[0]]);
    expect(run.mappingInputSnapshotId).toBe(input.mapping_input_snapshot_id);
    expect(run.proposal?.resultEnvelope.mapping_input_snapshot_id).toBe(input.mapping_input_snapshot_id);
    expect(run.proposal?.resultEnvelope.mapping_input_sha256).toBe(run.mappingInputSha256);
  });
});
