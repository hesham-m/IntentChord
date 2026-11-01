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
import { beginRollbackOnlyOwnerDbTest, type RollbackOnlyOwnerDbHarness } from "@/test/rollback-only-owner-db";
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import { deriveInternalAiEngineConfigurationSha256 } from "@/core/ai-context-mapper/engine-registry";
import type { InternalAiEngineConfigurationMaterial } from "@/core/ai-context-mapper/types";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import { setInternalAiSecretResolver } from "@/server/ai-context-mapper-config";

describe("Gate 4: Engine Binding Vendor/Model + Immutable Revision", () => {
  const testPrefix = `gate4_${Date.now()}`;
  const vendorId = `${testPrefix}_vendor`;
  const retiredVendorId = `${testPrefix}_retired`;
  const modelId = `${testPrefix}_model`;
  const engineId = `${testPrefix}_engine`;
  const unknownVendorEngine = `${testPrefix}_unknown_vendor_engine`;
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  function baseMaterial(overrides: Partial<InternalAiEngineConfigurationMaterial> = {}): InternalAiEngineConfigurationMaterial {
    return {
      engineId,
      engineConfigRevision: "1",
      providerId: vendorId,
      channelId: `${testPrefix}_chat`,
      modelId,
      endpoint: `https://api.${testPrefix}.example.com/v1/chat/completions`,
      credentialReference: `${testPrefix}_KEY`,
      transportProfileId: "chat_completions_json_schema_v1",
      behaviorProfileId: "openai_chat_completions_error_semantics_v1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
      ...overrides,
    };
  }

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
    setInternalAiSecretResolver(createTestSecretResolver({
      [`${testPrefix}_KEY`]: "gate4-test-secret",
    }));
    await internalAiVendorService.addVendor(
      {
        vendorId,
        displayName: "Gate 4 Vendor",
        baseUrl: `https://api.${testPrefix}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(
      vendorId,
      {
        modelId,
        displayName: "Gate 4 Model",
        providerFacingModelId: `${modelId}-provider`,
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addVendor(
      {
        vendorId: retiredVendorId,
        displayName: "Gate 4 Retired Vendor",
        baseUrl: `https://api.${retiredVendorId}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(
      retiredVendorId,
      {
        modelId,
        displayName: "Gate 4 Retired Vendor Model",
        providerFacingModelId: modelId,
      },
      "OWNER_TEST",
    );
    await internalAiEngineRegistryService.registerEngine(
      { engineId, displayName: "Gate 4 Binding Engine" },
      "OWNER_TEST",
    );
    await internalAiEngineRegistryService.registerEngine(
      { engineId: unknownVendorEngine, displayName: "Gate 4 Unknown Vendor Engine" },
      "OWNER_TEST",
    );
  });

  afterAll(async () => {
    setInternalAiSecretResolver(null as never);
    const pool = databasePool();
    await pool
      .query("DELETE FROM intentchord.context_mapping_traversals WHERE ai_execution_active_engine_id LIKE $1 OR ai_execution_standby_engine_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_admin_selections WHERE active_engine_id LIKE $1 OR standby_engine_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_qualifications WHERE engine_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_engine_revisions WHERE engine_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_engines WHERE engine_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_models WHERE vendor_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool.end().catch(() => {});
    await rollbackHarness?.close();
  });

  it("1. Migration 025 objects exist: vendor_id column + immutability trigger", async () => {
    const col = await databasePool().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='intentchord' AND table_name='internal_ai_engine_revisions' AND column_name='vendor_id'`,
    );
    expect(col.rowCount).toBe(1);

    const trg = await databasePool().query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'intentchord.internal_ai_engine_revisions'::regclass
          AND tgname = 'trg_internal_ai_engine_revision_immutable_guard'
          AND NOT tgisinternal`,
    );
    expect(trg.rowCount).toBe(1);
  });

  it("2. Production vendor/model seeds exist (zai + sambanova)", async () => {
    const vendors = await databasePool().query(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = ANY($1::text[])`,
      [["zai", "sambanova"]],
    );
    expect(vendors.rowCount).toBe(2);
    const models = await databasePool().query(
      `SELECT vendor_id, model_id FROM intentchord.internal_ai_models
        WHERE (vendor_id, model_id) IN (('zai','glm-4.7-flash'), ('sambanova','gpt-oss-120b'))`,
    );
    expect(models.rowCount).toBe(2);
  });

  it("3. Engine revision binds first-class Vendor and Model (vendor_id persisted)", async () => {
    const material = baseMaterial({ engineConfigRevision: "1" });
    const expectedSha = deriveInternalAiEngineConfigurationSha256(material);
    const rev = await internalAiEngineRegistryService.createEngineRevision(material, "OWNER_TEST");
    expect(rev.engineConfigurationSha256).toBe(expectedSha);
    expect(rev.vendorId).toBe(vendorId);

    const row = await databasePool().query(
      `SELECT vendor_id, provider_id, model_id FROM intentchord.internal_ai_engine_revisions
        WHERE engine_id = $1 AND engine_config_revision = '1'`,
      [engineId],
    );
    expect(row.rows[0].vendor_id).toBe(vendorId);
    expect(row.rows[0].provider_id).toBe(vendorId);
    expect(row.rows[0].model_id).toBe(modelId);
  });

  it("4. Provider-facing model id also satisfies Model binding", async () => {
    const material = baseMaterial({
      engineConfigRevision: "2",
      modelId: `${modelId}-provider`,
    });
    const rev = await internalAiEngineRegistryService.createEngineRevision(material, "OWNER_TEST");
    expect(rev.modelId).toBe(`${modelId}-provider`);
    expect(rev.vendorId).toBe(vendorId);
  });

  it("5. Revision with unregistered Vendor fails closed (404 VENDOR_NOT_FOUND)", async () => {
    await expect(
      internalAiEngineRegistryService.createEngineRevision(
        baseMaterial({
          engineId: unknownVendorEngine,
          engineConfigRevision: "1",
          providerId: `${testPrefix}_missing_vendor`,
          modelId,
        }),
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/VENDOR_NOT_FOUND|not registered/i);
  });

  it("6. Revision with Model not under Vendor fails closed (404 MODEL_NOT_FOUND)", async () => {
    await expect(
      internalAiEngineRegistryService.createEngineRevision(
        baseMaterial({
          engineConfigRevision: "3",
          modelId: `${testPrefix}_unregistered_model`,
        }),
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/MODEL_NOT_FOUND|not registered under vendor/i);
  });

  it("7. RETIRED Vendor blocks new Engine Revisions (409 VENDOR_RETIRED)", async () => {
    const pool = databasePool();
    await pool.query(
      `UPDATE intentchord.internal_ai_vendors
        SET vendor_state = 'RETIRED', retired_at = clock_timestamp()
        WHERE vendor_id = $1`,
      [retiredVendorId],
    );

    const engineIdRetired = `${testPrefix}_retired_engine`;
    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineIdRetired, displayName: "Gate 4 Retired Vendor Engine" },
      "OWNER_TEST",
    );

    await expect(
      internalAiEngineRegistryService.createEngineRevision(
        baseMaterial({
          engineId: engineIdRetired,
          engineConfigRevision: "1",
          providerId: retiredVendorId,
          modelId,
          endpoint: `https://api.${retiredVendorId}.example.com/v1/chat/completions`,
          channelId: `${retiredVendorId}_chat`,
        }),
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/VENDOR_RETIRED|RETIRED/i);

    await pool.query(
      `DELETE FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
      [engineIdRetired],
    );
  });

  it("8. credentialReference mismatch against Vendor binding fails closed (409)", async () => {
    const pool = databasePool();
    await pool.query(
      `UPDATE intentchord.internal_ai_vendors SET credential_reference = $2 WHERE vendor_id = $1`,
      [vendorId, `${testPrefix}_BOUND_KEY`],
    );

    await expect(
      internalAiEngineRegistryService.createEngineRevision(
        baseMaterial({
          engineConfigRevision: "90",
          credentialReference: `${testPrefix}_WRONG_KEY`,
        }),
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/CREDENTIAL_VENDOR_MISMATCH|must match vendor/i);

    await pool.query(
      `UPDATE intentchord.internal_ai_vendors SET credential_reference = NULL WHERE vendor_id = $1`,
      [vendorId],
    );
  });

  it("9. Config change creates a NEW FUTURE revision; historical revision remains untouched", async () => {
    const before = await databasePool().query(
      `SELECT endpoint, engine_configuration_sha256 FROM intentchord.internal_ai_engine_revisions
        WHERE engine_id = $1 AND engine_config_revision = '1'`,
      [engineId],
    );
    const beforeEndpoint = before.rows[0].endpoint;
    const beforeSha = before.rows[0].engine_configuration_sha256;

    const nextMaterial = baseMaterial({
      engineConfigRevision: "10",
      endpoint: `https://api.${testPrefix}.example.com/v2/chat/completions`,
      credentialReference: `${testPrefix}_KEY`,
    });
    const next = await internalAiEngineRegistryService.createEngineRevision(nextMaterial, "OWNER_TEST");
    expect(next.engineConfigRevision).toBe("10");
    expect(next.engineConfigurationSha256).not.toBe(beforeSha);

    const after = await databasePool().query(
      `SELECT endpoint, engine_configuration_sha256 FROM intentchord.internal_ai_engine_revisions
        WHERE engine_id = $1 AND engine_config_revision = '1'`,
      [engineId],
    );
    expect(after.rows[0].endpoint).toBe(beforeEndpoint);
    expect(after.rows[0].engine_configuration_sha256).toBe(beforeSha);
  });

  it("10. HISTORICAL_ENGINE_REVISION_REWRITE = FORBIDDEN (DB rejects UPDATE)", async () => {
    await expect(
      databasePool().query(
        `UPDATE intentchord.internal_ai_engine_revisions
          SET endpoint = 'https://evil.example.com/hijack'
          WHERE engine_id = $1 AND engine_config_revision = '1'`,
        [engineId],
      ),
    ).rejects.toThrow(/HISTORICAL_ENGINE_REVISION_REWRITE_FORBIDDEN/i);

    await expect(
      databasePool().query(
        `UPDATE intentchord.internal_ai_engine_revisions
          SET credential_reference = 'HIJACKED_KEY'
          WHERE engine_id = $1 AND engine_config_revision = '1'`,
        [engineId],
      ),
    ).rejects.toThrow(/HISTORICAL_ENGINE_REVISION_REWRITE_FORBIDDEN/i);

    await expect(
      databasePool().query(
        `UPDATE intentchord.internal_ai_engine_revisions
          SET vendor_id = NULL
          WHERE engine_id = $1 AND engine_config_revision = '1'`,
        [engineId],
      ),
    ).rejects.toThrow(/HISTORICAL_ENGINE_REVISION_REWRITE_FORBIDDEN/i);
  });

  it("11. Duplicate revision key still rejected (409 ENGINE_REVISION_EXISTS)", async () => {
    await expect(
      internalAiEngineRegistryService.createEngineRevision(
        baseMaterial({ engineConfigRevision: "1" }),
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/already exists|ENGINE_REVISION_EXISTS/i);
  });

  it("12. Engine detail exposes revisions with vendor binding and no secret fields", async () => {
    const detail = await internalAiEngineRegistryService.getEngine(engineId);
    expect(detail).not.toBeNull();
    expect(detail!.revisions.length).toBeGreaterThanOrEqual(2);
    for (const rev of detail!.revisions) {
      expect(rev.vendorId).toBe(vendorId);
      expect((rev as any).secret).toBeUndefined();
      expect((rev as any).apiKey).toBeUndefined();
    }
  });
});
