import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";
import { beginRollbackOnlyOwnerDbTest, type RollbackOnlyOwnerDbHarness } from "@/test/rollback-only-owner-db";

describe("Internal AI Vendor + Model Domain (Gate 1)", () => {
  const testPrefix = `test_vendor_${Date.now()}`;
  const vendorA = `${testPrefix}_a`;
  const vendorB = `${testPrefix}_b`;
  const modelId = `${testPrefix}_model`;
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
  });

  afterAll(async () => {
    const pool = databasePool();
    await pool.query("DELETE FROM intentchord.internal_ai_models WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id LIKE $1", [`${testPrefix}%`]);
    await pool.end().catch(() => {});
    await rollbackHarness?.close();
  });

  it("1. Vendor schema exists (internal_ai_vendors + internal_ai_models)", async () => {
    const res = await databasePool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='intentchord' AND table_name = ANY($1::text[])`,
      [["internal_ai_vendors", "internal_ai_models"]],
    );
    expect(res.rowCount).toBe(2);
  });

  it("2. Add vendor succeeds", async () => {
    const v = await internalAiVendorService.addVendor(
      {
        vendorId: vendorA,
        displayName: "Test Vendor A",
        websiteUrl: "https://www.test-vendor-a.example.com",
        baseUrl: "https://api.test-vendor-a.example.com",
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    expect(v.vendorId).toBe(vendorA);
    expect(v.state).toBe("ENABLED");
    expect(v.websiteUrl).toBe("https://www.test-vendor-a.example.com");
    expect(v.baseUrl).toBe("https://api.test-vendor-a.example.com");
    expect(v.credentialReference).toBeNull();
  });

  it("3. Duplicate vendor fails with 409", async () => {
    await expect(
      internalAiVendorService.addVendor(
        {
          vendorId: vendorA,
          displayName: "Duplicate",
          baseUrl: "https://api.example.com",
          authType: "bearer_token",
          protocolProfile: "openai_chat_completions_v1",
        },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/already registered/i);
  });

  it("4. Vendor with http:// baseUrl fails", async () => {
    await expect(
      internalAiVendorService.addVendor(
        {
          vendorId: `${testPrefix}_bad`,
          displayName: "Bad Vendor",
          baseUrl: "http://insecure.example.com",
          authType: "bearer_token",
          protocolProfile: "openai_chat_completions_v1",
        },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/https/i);
  });

  it("5. List vendors returns array and includes vendor A", async () => {
    const list = await internalAiVendorService.listVendors();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some(v => v.vendorId === vendorA)).toBe(true);
    for (const v of list) {
      expect((v as any).secret).toBeUndefined();
      expect((v as any).apiKey).toBeUndefined();
    }
  });

  it("6. Get vendor detail returns vendor with models array", async () => {
    const detail = await internalAiVendorService.getVendor(vendorA);
    expect(detail).not.toBeNull();
    expect(detail?.vendorId).toBe(vendorA);
    expect(Array.isArray(detail?.models)).toBe(true);
    expect(detail?.modelCount).toBe(0);
  });

  it("7. Add model under vendor succeeds", async () => {
    const m = await internalAiVendorService.addModel(
      vendorA,
      {
        modelId,
        displayName: "Test Model",
        providerFacingModelId: "test-model-v1",
        capabilityMetadata: { contextWindow: 128000 },
        runtimeCompatibilityMetadata: { transport: "chat_completions" },
      },
      "OWNER_TEST",
    );
    expect(m.modelId).toBe(modelId);
    expect(m.state).toBe("ENABLED");
    expect(m.providerFacingModelId).toBe("test-model-v1");
    expect(m.capabilityMetadata).toEqual({ contextWindow: 128000 });
  });

  it("8. Duplicate model under same vendor fails with 409", async () => {
    await expect(
      internalAiVendorService.addModel(
        vendorA,
        {
          modelId,
          displayName: "Dup Model",
          providerFacingModelId: "dup",
        },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("9. Model under unknown vendor fails with 404", async () => {
    await expect(
      internalAiVendorService.addModel(
        `${testPrefix}_unknown`,
        {
          modelId: "m1",
          displayName: "M",
          providerFacingModelId: "m",
        },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/not registered/i);
  });

  it("10. Disable vendor then enable succeeds", async () => {
    let v = await internalAiVendorService.setVendorState(vendorA, "DISABLED", "OWNER_TEST");
    expect(v.state).toBe("DISABLED");
    v = await internalAiVendorService.setVendorState(vendorA, "ENABLED", "OWNER_TEST");
    expect(v.state).toBe("ENABLED");
  });

  it("11. Disable model then enable succeeds", async () => {
    let m = await internalAiVendorService.setModelState(vendorA, modelId, "DISABLED", "OWNER_TEST");
    expect(m.state).toBe("DISABLED");
    m = await internalAiVendorService.setModelState(vendorA, modelId, "ENABLED", "OWNER_TEST");
    expect(m.state).toBe("ENABLED");
  });

  it("12. Retired vendor cannot return to ENABLED; model add under retired vendor blocked", async () => {
    await internalAiVendorService.addVendor(
      {
        vendorId: vendorB,
        displayName: "Retire Target",
        baseUrl: "https://api.test-vendor-b.example.com",
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    const retired = await internalAiVendorService.setVendorState(vendorB, "RETIRED", "OWNER_TEST", "no_longer_used");
    expect(retired.state).toBe("RETIRED");
    expect(retired.retiredAt).not.toBeNull();
    expect(retired.retirementReason).toBe("no_longer_used");

    await expect(
      internalAiVendorService.setVendorState(vendorB, "ENABLED", "OWNER_TEST"),
    ).rejects.toThrow(/retired/i);

    await expect(
      internalAiVendorService.addModel(
        vendorB,
        { modelId: "m2", displayName: "M2", providerFacingModelId: "m2" },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/retired/i);
  });

  it("13. Models listed under vendor", async () => {
    const models = await internalAiVendorService.listModels(vendorA);
    expect(models.some(m => m.modelId === modelId)).toBe(true);
  });

  it("14. Get unknown vendor returns null", async () => {
    const detail = await internalAiVendorService.getVendor(`${testPrefix}_missing`);
    expect(detail).toBeNull();
  });

  it("15. No secret material in any vendor/model view", async () => {
    const detail = await internalAiVendorService.getVendor(vendorA);
    const serialized = JSON.stringify(detail ?? {});
    expect(serialized).not.toMatch(/secret_value|apiKey|api_key|password/i);
  });
});
