import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL && fs.existsSync(".env.local")) {
  const envContent = fs.readFileSync(".env.local", "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

import { beginRollbackOnlyOwnerDbTest, type RollbackOnlyOwnerDbHarness } from "@/test/rollback-only-owner-db";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import { setInternalAiSecretResolver } from "@/server/ai-context-mapper-config";
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import { HttpCommandError } from "@/server/errors";
import {
  parseQualificationProbe,
  validateAndQualifyInternalAiEngine,
} from "@/server/internal-ai-qualification-runtime-service";

function successFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({
    id: "req-runtime-validation",
    model: "provider/test-model",
    choices: [{ message: { content: JSON.stringify({ status: "PASS", probe: "INTENTCHORD_RUNTIME_VALIDATION_V1" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

function deniedFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({
    error: { code: "provider_policy_denied", message: "denied" },
  }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
}

describe("Internal AI Qualification Flow V2 runtime validation", () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const vendorId = `test_qual_vendor_${suffix}`;
  const modelId = `test_qual_model_${suffix}`;
  const providerModelId = `provider/test-model-${suffix}`;
  const credentialReference = `TEST_QUAL_KEY_${suffix}`.toUpperCase();
  const enginePass = `test_qual_engine_pass_${suffix}`;
  const engineFail = `test_qual_engine_fail_${suffix}`;
  let harness: RollbackOnlyOwnerDbHarness | undefined;
  let evidenceRoot = "";

  beforeAll(async () => {
    harness = await beginRollbackOnlyOwnerDbTest();
    evidenceRoot = await mkdtemp(join(tmpdir(), "intentchord-qualification-v2-"));
    setInternalAiSecretResolver(createTestSecretResolver({ [credentialReference]: "synthetic-test-secret" }));

    await internalAiVendorService.addVendor({
      vendorId,
      displayName: "Qualification Test Vendor",
      baseUrl: "https://provider.example/v1",
      authType: "bearer_token",
      protocolProfile: "openai_chat_completions_v1",
      credentialReference,
    }, "OWNER_TEST");
    await internalAiVendorService.addModel(vendorId, {
      modelId,
      displayName: "Qualification Test Model",
      providerFacingModelId: providerModelId,
    }, "OWNER_TEST");

    for (const engineId of [enginePass, engineFail]) {
      await internalAiEngineRegistryService.registerEngine({ engineId, displayName: engineId }, "OWNER_TEST");
      await internalAiEngineRegistryService.createEngineRevision({
        engineId,
        engineConfigRevision: "1",
        providerId: vendorId,
        channelId: `${vendorId}_chat_completions`,
        modelId: providerModelId,
        endpoint: "https://provider.example/v1/chat/completions",
        credentialReference,
        transportProfileId: "chat_completions_json_schema_v1",
        behaviorProfileId: "openai_chat_completions_error_semantics_v1",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
        timeoutMs: 10000,
      }, "OWNER_TEST");
    }
  });

  afterAll(async () => {
    if (harness) await harness.close();
    if (evidenceRoot) await rm(evidenceRoot, { recursive: true, force: true });
  });

  it("accepts only the exact governed structured probe", () => {
    expect(parseQualificationProbe('{"status":"PASS","probe":"INTENTCHORD_RUNTIME_VALIDATION_V1"}')).toEqual({
      status: "PASS",
      probe: "INTENTCHORD_RUNTIME_VALIDATION_V1",
    });
    expect(() => parseQualificationProbe("not-json")).toThrow(/not valid JSON/i);
    expect(() => parseQualificationProbe('{"status":"PASS","probe":"wrong"}')).toThrow(/did not satisfy/i);
  });

  it("runs the Candidate revision through the real adapter and qualifies only after PASS evidence is written", async () => {
    const result = await validateAndQualifyInternalAiEngine({
      engineId: enginePass,
      engineConfigRevision: "1",
    }, "OWNER_TEST", { fetchImpl: successFetch(), evidenceRoot });

    expect(result.status).toBe("QUALIFIED");
    expect(result.qualification.qualificationStatus).toBe("QUALIFIED");
    expect(result.qualification.qualificationScope).toBe("AI_CONTEXT_MAPPING_V2");
    expect(result.evidenceReference).toBe(result.qualification.evidenceReference);

    const report = JSON.parse(await readFile(result.evidenceReference, "utf8"));
    expect(report.outcome).toBe("PASS");
    expect(report.engine.engineId).toBe(enginePass);
    expect(report.engine.credentialReference).toBe(credentialReference);
    expect(JSON.stringify(report)).not.toContain("synthetic-test-secret");
  });

  it("fails closed on provider rejection, writes FAIL evidence, and creates no qualification", async () => {
    let thrown: unknown;
    try {
      await validateAndQualifyInternalAiEngine({
        engineId: engineFail,
        engineConfigRevision: "1",
      }, "OWNER_TEST", { fetchImpl: deniedFetch(), evidenceRoot });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpCommandError);
    expect((thrown as HttpCommandError).code).toBe("QUALIFICATION_EXTERNAL_VALIDATION_FAILED");

    const detail = await internalAiEngineRegistryService.getEngine(engineFail);
    expect(detail?.qualifications.some(q => q.qualificationStatus === "QUALIFIED")).toBe(false);
    const files = await readdir(evidenceRoot);
    expect(files.some(name => name.includes(suffix) && name.includes("FAIL"))).toBe(true);
  });
});
