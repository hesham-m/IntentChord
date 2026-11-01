import { describe, it, expect, afterAll } from "vitest";
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
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import { setInternalAiSecretResolver } from "@/server/ai-context-mapper-config";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";

const ZAI_ENGINE_ID = "zai-context-mapper-v1";
const SAMBANOVA_ENGINE_ID = "sambanova-context-mapper-v1";

describe("Register real proven engine bindings", () => {
  setInternalAiSecretResolver(createTestSecretResolver({}));

  afterAll(async () => {
    setInternalAiSecretResolver(createTestSecretResolver({}));
    await databasePool().end().catch(() => {});
  });

  it("Register ZAI engine with proven binding", async () => {
    const existing = await internalAiEngineRegistryService.getEngine(ZAI_ENGINE_ID);
    if (!existing) {
      await internalAiEngineRegistryService.registerEngine(
        { engineId: ZAI_ENGINE_ID, displayName: "ZAI Context Mapper" },
        "OWNER_ADMIN_SEED",
      );
    }
    const engine = await internalAiEngineRegistryService.getEngine(ZAI_ENGINE_ID);
    expect(engine).not.toBeNull();
    expect(engine!.engineId).toBe(ZAI_ENGINE_ID);
  });

  it("Create ZAI revision with proven binding material", async () => {
    const detail = await internalAiEngineRegistryService.getEngine(ZAI_ENGINE_ID);
    if (detail && detail.revisions.length === 0) {
      const rev = await internalAiEngineRegistryService.createEngineRevision(
        {
          engineId: ZAI_ENGINE_ID,
          engineConfigRevision: "1",
          providerId: "zai",
          channelId: "zai_direct_chat_completions_v4",
          modelId: "glm-4.7-flash",
          endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
          credentialReference: "ZAI_API_KEY",
          transportProfileId: "chat_completions_json_object_v1",
          behaviorProfileId: "zai_error_semantics_v1",
          capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
          timeoutMs: 60000,
        },
        "OWNER_ADMIN_SEED",
      );
      expect(rev.engineConfigurationSha256).toBeTruthy();
    }
    const check = await internalAiEngineRegistryService.getEngine(ZAI_ENGINE_ID);
    expect(check!.revisions.length).toBe(1);
    expect(check!.revisions[0].providerId).toBe("zai");
    expect(check!.revisions[0].credentialReference).toBe("ZAI_API_KEY");
  });

  it("Register SambaNova engine with proven binding", async () => {
    const existing = await internalAiEngineRegistryService.getEngine(SAMBANOVA_ENGINE_ID);
    if (!existing) {
      await internalAiEngineRegistryService.registerEngine(
        { engineId: SAMBANOVA_ENGINE_ID, displayName: "SambaNova Context Mapper" },
        "OWNER_ADMIN_SEED",
      );
    }
    const engine = await internalAiEngineRegistryService.getEngine(SAMBANOVA_ENGINE_ID);
    expect(engine).not.toBeNull();
    expect(engine!.engineId).toBe(SAMBANOVA_ENGINE_ID);
  });

  it("Create SambaNova revision with proven binding material", async () => {
    const detail = await internalAiEngineRegistryService.getEngine(SAMBANOVA_ENGINE_ID);
    if (detail && detail.revisions.length === 0) {
      const rev = await internalAiEngineRegistryService.createEngineRevision(
        {
          engineId: SAMBANOVA_ENGINE_ID,
          engineConfigRevision: "1",
          providerId: "sambanova",
          channelId: "sambanova_direct_chat_completions_v1",
          modelId: "gpt-oss-120b",
          endpoint: "https://api.sambanova.ai/v1/chat/completions",
          credentialReference: "SAMBANOVA_API_KEY",
          transportProfileId: "chat_completions_json_schema_v1",
          behaviorProfileId: "sambanova_error_semantics_v1",
          capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
          timeoutMs: 60000,
        },
        "OWNER_ADMIN_SEED",
      );
      expect(rev.engineConfigurationSha256).toBeTruthy();
    }
    const check = await internalAiEngineRegistryService.getEngine(SAMBANOVA_ENGINE_ID);
    expect(check!.revisions.length).toBe(1);
    expect(check!.revisions[0].providerId).toBe("sambanova");
    expect(check!.revisions[0].credentialReference).toBe("SAMBANOVA_API_KEY");
  });

  it("Both engines listed and visible", async () => {
    const list = await internalAiEngineRegistryService.listEngines();
    expect(list.find(e => e.engineId === ZAI_ENGINE_ID)).toBeDefined();
    expect(list.find(e => e.engineId === SAMBANOVA_ENGINE_ID)).toBeDefined();
  });

  it("Qualification is NOT fabricated — left unresolved pending external provider validation", async () => {
    const zaiDetail = await internalAiEngineRegistryService.getEngine(ZAI_ENGINE_ID);
    expect(zaiDetail!.qualifications.length).toBe(0);
    const samDetail = await internalAiEngineRegistryService.getEngine(SAMBANOVA_ENGINE_ID);
    expect(samDetail!.qualifications.length).toBe(0);
  });

  it("MiMo and Nemotron remain unregistered (NOT_YET_BINDABLE)", async () => {
    const list = await internalAiEngineRegistryService.listEngines();
    expect(list.find(e => e.engineId.toLowerCase().includes("mimo"))).toBeUndefined();
    expect(list.find(e => e.engineId.toLowerCase().includes("nemotron"))).toBeUndefined();
  });
});
