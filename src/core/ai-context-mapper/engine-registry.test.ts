import { describe, expect, it } from "vitest";
import {
  bindInternalAiEngineConfiguration,
  resolveSingleQualifiedInternalAiEngine,
} from "@/core/ai-context-mapper/engine-registry";
import type { InternalAiEngineConfigurationMaterial, InternalAiEngineDefinition, InternalAiQualificationRecord } from "@/core/ai-context-mapper/types";

function engine(engineId: string, revision: string, modelId: string, overrides: Partial<Omit<InternalAiEngineDefinition, "engineConfigurationSha256">> = {}): InternalAiEngineDefinition {
  return bindInternalAiEngineConfiguration({
    engineId,
    engineConfigRevision: revision,
    providerId: `provider-${engineId}`,
    channelId: "chat-v1",
    modelId,
    endpoint: `https://${engineId}.example.test/v1/chat`,
    credentialReference: "ENGINE_KEY",
    transportProfileId: "chat_completions_json_object_v1",
    behaviorProfileId: "zai_error_semantics_v1",
    capabilityProfileVersion: "cap-v1",
    timeoutMs: 60000,
    ...overrides,
  });
}
function qualification(target: InternalAiEngineDefinition, status: InternalAiQualificationRecord["qualificationStatus"] = "QUALIFIED", id = `qual-${target.engineId}-${target.engineConfigRevision}-${status}`): InternalAiQualificationRecord {
  return {
    qualificationId: id,
    engineId: target.engineId,
    engineConfigRevision: target.engineConfigRevision,
    engineConfigurationSha256: target.engineConfigurationSha256,
    qualificationStatus: status,
    qualificationScope: "AI_CONTEXT_MAPPING_V1",
    qualifiedAt: "2026-08-18T00:00:00.000Z",
    qualifiedBy: "SYSTEM_OWNER",
    evidenceReference: "benchmark:evidence",
    capabilityProfileVersion: target.capabilityProfileVersion,
  };
}
const policy = { selectionPolicyId: "single", selectionPolicyVersion: "1", selectionMode: "SINGLE" as const };
function resolve(target: InternalAiEngineDefinition, records: InternalAiQualificationRecord[]) {
  return resolveSingleQualifiedInternalAiEngine({ engines: [target], qualifications: records, ownerEnabledEngineIds: [target.engineId], selectionPolicy: policy });
}

describe("Internal AI Engine Registry exact configuration qualification authority", () => {
  it("A/E exact unchanged Engine configuration + valid Qualification passes", () => {
    const target = engine("engine-a", "1", "model-a");
    const selected = resolve(target, [qualification(target)]);
    expect(selected.engine.engineConfigurationSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(selected.qualification.engineConfigurationSha256).toBe(selected.engine.engineConfigurationSha256);
  });

  it("B same Engine/revision with Model mutation fails closed against the old Qualification", () => {
    const modelA = engine("engine-a", "1", "model-a");
    const modelB = engine("engine-a", "1", "model-b");
    expect(modelB.engineConfigurationSha256).not.toBe(modelA.engineConfigurationSha256);
    expect(() => resolve(modelB, [qualification(modelA)])).toThrow(/exact configuration fingerprint/i);
  });

  it("C same revision label with material Provider change fails closed", () => {
    const original = engine("engine-a", "1", "model-a");
    const changed = engine("engine-a", "1", "model-a", { providerId: "provider-b" });
    expect(() => resolve(changed, [qualification(original)])).toThrow();
  });

  it.each([
    ["endpoint", { endpoint: "https://changed.example.test/v1/chat" }],
    ["behavior/transport", { transportProfileId: "chat_completions_json_schema_v1" as const, behaviorProfileId: "sambanova_error_semantics_v1" as const }],
    ["runtime timeout", { timeoutMs: 61000 }],
  ])("D material %s mutation with unchanged revision fails closed", (_label: string, change: Partial<InternalAiEngineConfigurationMaterial>) => {
    const original = engine("engine-a", "1", "model-a");
    const changed = engine("engine-a", "1", "model-a", change);
    expect(changed.engineConfigurationSha256).not.toBe(original.engineConfigurationSha256);
    expect(() => resolve(changed, [qualification(original)])).toThrow();
  });

  it("binds the credential reference but has no secret credential value input", () => {
    const a = engine("engine-a", "1", "model-a", { credentialReference: "ACCOUNT_A_KEY" });
    const b = engine("engine-a", "1", "model-a", { credentialReference: "ACCOUNT_B_KEY" });
    expect(a.engineConfigurationSha256).not.toBe(b.engineConfigurationSha256);
    expect(JSON.stringify(a)).not.toContain("secret-value");
  });

  it("G qualification target with only REVOKED is not eligible", () => {
    const target = engine("engine-a", "1", "model-a");
    expect(() => resolve(target, [qualification(target, "REVOKED")])).toThrow(/exact configuration fingerprint/i);
  });

  it("H qualification target with only EXPIRED is not eligible", () => {
    const target = engine("engine-a", "1", "model-a");
    expect(() => resolve(target, [qualification(target, "EXPIRED")])).toThrow(/exact configuration fingerprint/i);
  });

  it("I conflicting QUALIFIED + REVOKED current-state records fail closed", () => {
    const target = engine("engine-a", "1", "model-a");
    expect(() => resolve(target, [qualification(target, "QUALIFIED", "q1"), qualification(target, "REVOKED", "q2")])).toThrow(/current-state records/i);
  });

  it("J conflicting QUALIFIED + EXPIRED current-state records fail closed", () => {
    const target = engine("engine-a", "1", "model-a");
    expect(() => resolve(target, [qualification(target, "QUALIFIED", "q1"), qualification(target, "EXPIRED", "q2")])).toThrow(/current-state records/i);
  });

  it("supports multiple Engine definitions and Engine identity remains independent from Model identity", () => {
    const engines = [engine("engine-a", "1", "shared-model"), engine("engine-b", "9", "shared-model")];
    const selected = resolveSingleQualifiedInternalAiEngine({ engines, qualifications: [qualification(engines[0]), qualification(engines[1])], ownerEnabledEngineIds: ["engine-b"], selectionPolicy: policy });
    expect(selected.engine).toMatchObject({ engineId: "engine-b", engineConfigRevision: "9", modelId: "shared-model" });
  });

  it("qualified but Owner-disabled is not eligible", () => {
    const target = engine("engine-a", "1", "m");
    expect(() => resolveSingleQualifiedInternalAiEngine({ engines: [target], qualifications: [qualification(target)], ownerEnabledEngineIds: [], selectionPolicy: policy })).toThrow();
  });

  it("Owner-enabled but unqualified is not eligible", () => {
    const target = engine("engine-a", "1", "m");
    expect(() => resolve(target, [])).toThrow();
  });

  it("SINGLE fails closed instead of silently routing when more than one eligible Engine exists", () => {
    const engines = [engine("engine-a", "1", "m-a"), engine("engine-b", "1", "m-b")];
    expect(() => resolveSingleQualifiedInternalAiEngine({ engines, qualifications: engines.map(item => qualification(item)), ownerEnabledEngineIds: ["engine-a", "engine-b"], selectionPolicy: policy })).toThrow(/exactly one/i);
  });
});
