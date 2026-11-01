import { describe, expect, it } from "vitest";
import { readAiContextMapperConfig } from "@/server/ai-context-mapper-config";
import { createAiContextMappingRun } from "@/server/ai-context-mapping-service";
import { deriveInternalAiEngineConfigurationSha256 } from "@/core/ai-context-mapper/engine-registry";
import type { InternalAiEngineConfigurationMaterial } from "@/core/ai-context-mapper/types";

const names = ["AI_CONTEXT_MAPPER_ENABLED", "AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON", "AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON", "AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS", "AI_CONTEXT_MAPPER_SELECTION_POLICY_ID", "AI_CONTEXT_MAPPER_SELECTION_POLICY_VERSION", "AI_CONTEXT_MAPPER_SELECTION_POLICY_MODE", "AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID", "AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_REVISION", "AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID", "AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION", "AI_CONTEXT_MAPPER_STANDBY_ENABLED", "AI_CONTEXT_MAPPER_LIVE_PROVIDER_TESTS_ENABLED", "TEST_ACTIVE_KEY", "TEST_CANDIDATE_KEY", "TEST_STANDBY_KEY"] as const;

async function withEnvironment<T>(work: () => T | Promise<T>): Promise<T> {
  const snapshot = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    return await work();
  } finally {
    for (const name of names) {
      const value = snapshot.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

function engine(engineId: string, revision: string, providerId: string, modelId: string, credentialReference = "TEST_ACTIVE_KEY"): InternalAiEngineConfigurationMaterial {
  return {
    engineId, engineConfigRevision: revision, providerId, channelId: `${providerId}-chat-v1`, modelId,
    endpoint: `https://${providerId}.example.test/v1/chat/completions`, credentialReference,
    transportProfileId: "chat_completions_json_object_v1", behaviorProfileId: "zai_error_semantics_v1",
    capabilityProfileVersion: "AI_CONTEXT_MAPPING_V1/capability-1", timeoutMs: 60000,
  };
}

function qualification(target: ReturnType<typeof engine>, status: "QUALIFIED" | "REVOKED" | "EXPIRED" = "QUALIFIED", scope: string = "AI_CONTEXT_MAPPING_V1", capabilityProfileVersion = target.capabilityProfileVersion, qualificationId = `qual-${target.engineId}-${target.engineConfigRevision}-${status}`) {
  return {
    qualificationId, engineId: target.engineId, engineConfigRevision: target.engineConfigRevision,
    engineConfigurationSha256: deriveInternalAiEngineConfigurationSha256(target),
    qualificationStatus: status, qualificationScope: scope, qualifiedAt: "2026-08-18T00:00:00.000Z",
    qualifiedBy: "SYSTEM_OWNER", evidenceReference: `benchmark:${target.engineId}:${target.engineConfigRevision}`, capabilityProfileVersion,
  };
}

function configureRegistry(engines: unknown[], qualifications: unknown[] = [], enabledIds: string[] = []): void {
  process.env.AI_CONTEXT_MAPPER_ENGINE_REGISTRY_JSON = JSON.stringify(engines);
  process.env.AI_CONTEXT_MAPPER_QUALIFICATION_REGISTRY_JSON = JSON.stringify(qualifications);
  process.env.AI_CONTEXT_MAPPER_OWNER_ENABLED_ENGINE_IDS = enabledIds.join(",");
  process.env.AI_CONTEXT_MAPPER_SELECTION_POLICY_ID = "context-mapping-single";
  process.env.AI_CONTEXT_MAPPER_SELECTION_POLICY_VERSION = "1";
  process.env.AI_CONTEXT_MAPPER_SELECTION_POLICY_MODE = "SINGLE";
  process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID = "standby-engine";
  process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION = "1";
}

describe("AI Context Mapper governed engine registry + qualification configuration", () => {
  it("does not manufacture qualification from configuration presence or ACTIVE enablement", async () => withEnvironment(() => {
    configureRegistry([engine("active-engine", "1", "provider-a", "model-a"), engine("standby-engine", "1", "provider-s", "model-s", "TEST_STANDBY_KEY")], [], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    let error: unknown;
    try { readAiContextMapperConfig(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "INTERNAL_AI_ACTIVE_ENGINE_NOT_QUALIFIED", status: 503 });
  }));

  it("fails closed when qualification scope is wrong", async () => withEnvironment(() => {
    const active = engine("active-engine", "1", "provider-a", "model-a");
    configureRegistry([active, engine("standby-engine", "1", "provider-s", "model-s", "TEST_STANDBY_KEY")], [qualification(active, "QUALIFIED", "OTHER_SCOPE")], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    expect(() => readAiContextMapperConfig()).toThrow(/scope AI_CONTEXT_MAPPING_V1/i);
  }));

  it("binds qualification to the exact Engine revision", async () => withEnvironment(() => {
    const current = engine("active-engine", "2", "provider-a", "model-a2");
    const oldRevision = engine("active-engine", "1", "provider-a", "model-a");
    configureRegistry([current, engine("standby-engine", "1", "provider-s", "model-s", "TEST_STANDBY_KEY")], [qualification(oldRevision)], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    expect(() => readAiContextMapperConfig()).toThrow(/registered Engine configuration revision|not explicitly qualified|not qualified/i);
  }));

  it("permits exactly qualified + Owner-enabled Active execution and freezes selection/qualification provenance", async () => withEnvironment(() => {
    const active = engine("active-engine", "7", "provider-a", "model-a7");
    configureRegistry([active, engine("standby-engine", "1", "provider-s", "model-s", "TEST_STANDBY_KEY")], [qualification(active)], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    const config = readAiContextMapperConfig();
    expect(config.active).toMatchObject({ role: "ACTIVE", engineId: "active-engine", engineConfigRevision: "7", ownerEnabled: true, modelId: "model-a7" });
    expect(config.active?.qualification?.qualificationScope).toBe("AI_CONTEXT_MAPPING_V1");
    expect(config.providerConfigurationSnapshot).toMatchObject({
      selected_engine_id: "active-engine", selected_engine_config_revision: "7", selected_engine_configuration_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      selection_policy: { selection_mode: "SINGLE", selection_policy_id: "context-mapping-single", selection_policy_version: "1" },
      active: { engine_id: "active-engine", engine_config_revision: "7", engine_configuration_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), qualification: { qualification_scope: "AI_CONTEXT_MAPPING_V1", engine_configuration_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } },
    });
  }));

  it("keeps Candidate configured but non-Active/non-qualified when no qualification record exists", async () => withEnvironment(() => {
    const active = engine("active-engine", "1", "provider-a", "model-a");
    const candidate = engine("candidate-engine", "1", "provider-b", "model-b", "TEST_CANDIDATE_KEY");
    configureRegistry([active, candidate, engine("standby-engine", "1", "provider-s", "model-s", "TEST_STANDBY_KEY")], [qualification(active)], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    process.env.AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_ID = "candidate-engine";
    process.env.AI_CONTEXT_MAPPER_CANDIDATE_ENGINE_REVISION = "1";
    const config = readAiContextMapperConfig();
    expect(config.active?.engineId).toBe("active-engine");
    expect(config.candidate).toMatchObject({ role: "CANDIDATE", engineId: "candidate-engine" });
    expect(config.candidate?.qualification).toBeUndefined();
  }));

  it("production service cannot bypass an unqualified Active Engine", async () => withEnvironment(async () => {
    configureRegistry([engine("active-engine", "1", "provider-a", "model-a"), engine("standby-engine", "1", "provider-s", "model-s", "TEST_STANDBY_KEY")], [], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    process.env.TEST_ACTIVE_KEY = "secret";
    await expect(createAiContextMappingRun({ invalid: true })).rejects.toMatchObject({ status: 503 });
  }));
  it("does not require a Standby Engine when failover is disabled", async () => withEnvironment(() => {
    const active = engine("active-only", "1", "provider-a", "model-a");
    configureRegistry([active], [qualification(active)], ["active-only"]);
    delete process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID;
    delete process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION;
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    const config = readAiContextMapperConfig();
    expect(config.active?.engineId).toBe("active-only");
    expect(config.standby).toBeUndefined();
    expect(config.providerConfigurationSnapshot?.standby).toBeUndefined();
    expect(config.providerConfigurationSnapshot?.failover_policy.enabled).toBe(false);
  }));

  it("ignores stale Standby identity configuration when failover is disabled", async () => withEnvironment(() => {
    const active = engine("active-only", "1", "provider-a", "model-a");
    configureRegistry([active], [qualification(active)], ["active-only"]);
    process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_ID = "stale-unregistered-standby";
    process.env.AI_CONTEXT_MAPPER_STANDBY_ENGINE_REVISION = "99";
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    const config = readAiContextMapperConfig();
    expect(config.active?.engineId).toBe("active-only");
    expect(config.standbyEnabled).toBe(false);
    expect(config.standby).toBeUndefined();
    expect(config.providerConfigurationSnapshot?.standby).toBeUndefined();
    expect(config.providerConfigurationSnapshot?.failover_policy).toMatchObject({ enabled: false, governance_qualified: false });
  }));

  it("fails closed on duplicate Engine revision identities even before execution", async () => withEnvironment(() => {
    const duplicate = engine("duplicate-engine", "1", "provider-a", "model-a");
    configureRegistry([duplicate, { ...duplicate }], [], []);
    expect(() => readAiContextMapperConfig()).toThrow(/configuration revision must be unique/i);
  }));

  it("fails closed when qualification registry contains an orphan Engine revision", async () => withEnvironment(() => {
    const missing = engine("missing-engine", "1", "provider-a", "model-a");
    configureRegistry([engine("registered-engine", "1", "provider-a", "model-a")], [qualification(missing)], []);
    expect(() => readAiContextMapperConfig()).toThrow(/qualification record must bind to a registered Engine/i);
  }));

  it("F changing only the secret credential VALUE does not change/leak the governed Engine fingerprint", async () => withEnvironment(() => {
    const active = engine("active-engine", "1", "provider-a", "model-a");
    configureRegistry([active], [qualification(active)], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    process.env.TEST_ACTIVE_KEY = "first-secret-value";
    const first = readAiContextMapperConfig();
    process.env.TEST_ACTIVE_KEY = "second-secret-value";
    const second = readAiContextMapperConfig();
    expect(second.active?.engineConfigurationSha256).toBe(first.active?.engineConfigurationSha256);
    const provenance = JSON.stringify(second.providerConfigurationSnapshot);
    expect(provenance).not.toContain("first-secret-value");
    expect(provenance).not.toContain("second-secret-value");
    expect(provenance).toContain("TEST_ACTIVE_KEY");
  }));

  it("I/J fails closed when one qualification target has conflicting current states", async () => withEnvironment(() => {
    const active = engine("active-engine", "1", "provider-a", "model-a");
    configureRegistry([active], [qualification(active, "QUALIFIED", "AI_CONTEXT_MAPPING_V1", active.capabilityProfileVersion, "q-qualified"), qualification(active, "REVOKED", "AI_CONTEXT_MAPPING_V1", active.capabilityProfileVersion, "q-revoked")], ["active-engine"]);
    process.env.AI_CONTEXT_MAPPER_ENABLED = "true";
    expect(() => readAiContextMapperConfig()).toThrow(/current-state records/i);

    configureRegistry([active], [qualification(active, "QUALIFIED", "AI_CONTEXT_MAPPING_V1", active.capabilityProfileVersion, "q-qualified"), qualification(active, "EXPIRED", "AI_CONTEXT_MAPPING_V1", active.capabilityProfileVersion, "q-expired")], ["active-engine"]);
    expect(() => readAiContextMapperConfig()).toThrow(/current-state records/i);
  }));

});
