import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

vi.mock("@/server/owner-account", () => ({
  findOwnerById: vi.fn().mockResolvedValue({
    owner_id: "00000000-0000-0000-0000-000000000001",
    login_name: "test-owner",
    display_name: "Test Owner",
    account_state: "ACTIVE",
    session_version: 1,
  }),
}));

import { databasePool } from "@/server/db";
import { beginRollbackOnlyOwnerDbTest, type RollbackOnlyOwnerDbHarness } from "@/test/rollback-only-owner-db";
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";
import { internalAiEngineRegistryService } from "@/server/internal-ai-engine-registry-service";
import type { InternalAiEngineConfigurationMaterial } from "@/core/ai-context-mapper/types";
import { INTERNAL_AI_QUALIFICATION_SCOPE_V2 } from "@/core/ai-context-mapper/types";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import { setInternalAiSecretResolver } from "@/server/ai-context-mapper-config";
import { DELETE as deleteVendorRoute } from "@/app/api/admin/ai-vendors/[vendorId]/route";
import { DELETE as deleteModelRoute } from "@/app/api/admin/ai-vendors/[vendorId]/models/[modelId]/route";
import { DELETE as deleteEngineRoute } from "@/app/api/admin/ai-engines/[engineId]/route";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";

ensureTestSessionSecret();

function makeUnauthRequest(url: string) {
  return new Request(url, { method: "DELETE", headers: { "content-type": "application/json", host: "127.0.0.1:3000" } });
}

function makeValidAuthRequest(url: string) {
  const cookie = createTestSessionCookie();
  return new Request(url, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      cookie: `${cookie.name}=${cookie.value}`,
    },
  });
}

describe("Gate 6: Governed Delete / Retire Semantics", () => {
  const testPrefix = `gate6_${Date.now()}`;
  const vendorFresh = `${testPrefix}_vf`;
  const vendorBound = `${testPrefix}_vb`;
  const vendorNever = `${testPrefix}_vn`;
  const modelFresh = `${testPrefix}_mf`;
  const modelBound = `${testPrefix}_mb`;
  const modelNever = `${testPrefix}_mn`;
  const engineNever = `${testPrefix}_en`;
  const engineBound = `${testPrefix}_eb`;
  const scope = INTERNAL_AI_QUALIFICATION_SCOPE_V2;
  const BASE = "http://127.0.0.1:3000";

  let boundRevSha = "";
  let boundQualId = "";
  let selectionSeq = 0;
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  function material(overrides: Partial<InternalAiEngineConfigurationMaterial> = {}): InternalAiEngineConfigurationMaterial {
    return {
      engineId: engineBound,
      engineConfigRevision: "1",
      providerId: vendorBound,
      channelId: `${testPrefix}_bound_chat`,
      modelId: modelBound,
      endpoint: `https://api.${vendorBound}.example.com/v1/chat/completions`,
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
    setInternalAiSecretResolver(createTestSecretResolver({ [`${testPrefix}_KEY`]: "gate6-secret" }));

    await internalAiVendorService.addVendor(
      {
        vendorId: vendorFresh,
        displayName: "Gate 6 Fresh",
        baseUrl: `https://api.${vendorFresh}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(vendorFresh, {
      modelId: modelFresh,
      displayName: "Gate 6 Fresh Model",
      providerFacingModelId: `${modelFresh}_provider`,
    }, "OWNER_TEST");

    await internalAiVendorService.addVendor(
      {
        vendorId: vendorNever,
        displayName: "Gate 6 Never Used",
        baseUrl: `https://api.${vendorNever}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(vendorNever, {
      modelId: modelNever,
      displayName: "Gate 6 Never Model",
      providerFacingModelId: `${modelNever}_provider`,
    }, "OWNER_TEST");

    await internalAiVendorService.addVendor(
      {
        vendorId: vendorBound,
        displayName: "Gate 6 Bound",
        baseUrl: `https://api.${vendorBound}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
        credentialReference: `${testPrefix}_KEY`,
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(vendorBound, {
      modelId: modelBound,
      displayName: "Gate 6 Bound Model",
      providerFacingModelId: `${modelBound}_provider`,
    }, "OWNER_TEST");

    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineNever, displayName: "Gate 6 Never Engine" },
      "OWNER_TEST",
    );
    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineBound, displayName: "Gate 6 Bound Engine" },
      "OWNER_TEST",
    );

    const rev = await internalAiEngineRegistryService.createEngineRevision(material(), "OWNER_TEST");
    boundRevSha = rev.engineConfigurationSha256;
    const qual = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineBound,
      engineConfigRevision: "1",
      engineConfigurationSha256: boundRevSha,
      qualificationScope: scope,
      evidenceReference: "benchmark:gate6",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    boundQualId = qual.qualificationId;

    const selection = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: scope,
      engineId: engineBound,
      engineConfigRevision: "1",
      engineConfigurationSha256: boundRevSha,
      qualificationId: boundQualId,
      expectedSequence: selectionSeq,
    }, "OWNER_TEST");
    selectionSeq = selection.selectionAuthoritySequence;
  });

  afterAll(async () => {
    setInternalAiSecretResolver(null as never);
    const pool = databasePool();
    await pool
      .query("DELETE FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1", [scope])
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
      .query("DELETE FROM intentchord.internal_ai_credentials WHERE vendor_id LIKE $1", [`${testPrefix}%`])
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

  it("1. Unauthenticated DELETE vendor/model/engine = REJECT (401)", async () => {
    const v = await deleteVendorRoute(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorNever}`),
      { params: Promise.resolve({ vendorId: vendorNever }) },
    );
    expect(v.status).toBe(401);
    expect((await v.json()).code).toBe("OWNER_SESSION_REQUIRED");

    const m = await deleteModelRoute(
      makeUnauthRequest(`${BASE}/api/admin/ai-vendors/${vendorNever}/models/${modelNever}`),
      { params: Promise.resolve({ vendorId: vendorNever, modelId: modelNever }) },
    );
    expect(m.status).toBe(401);
    expect((await m.json()).code).toBe("OWNER_SESSION_REQUIRED");

    const e = await deleteEngineRoute(
      makeUnauthRequest(`${BASE}/api/admin/ai-engines/${engineNever}`),
      { params: Promise.resolve({ engineId: engineNever }) },
    );
    expect(e.status).toBe(401);
    expect((await e.json()).code).toBe("OWNER_SESSION_REQUIRED");
  });

  it("2. Vendor with models blocks hard delete (DELETE_NOT_ALLOWED_CHILDREN_EXIST)", async () => {
    await expect(internalAiVendorService.deleteVendor(vendorNever, "OWNER_TEST"))
      .rejects.toThrow(/DELETE_NOT_ALLOWED_CHILDREN_EXIST|still has/i);
    const still = await databasePool().query(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorNever],
    );
    expect(still.rowCount).toBe(1);
  });

  it("3. Model with historical Engine Revision blocks hard delete → Retire required", async () => {
    await expect(internalAiVendorService.deleteModel(vendorBound, modelBound, "OWNER_TEST"))
      .rejects.toThrow(/DELETE_NOT_ALLOWED_RETIRE_REQUIRED|historical Engine Revision/i);

    const disabled = await internalAiVendorService.setModelState(vendorBound, modelBound, "DISABLED", "OWNER_TEST");
    expect(disabled.state).toBe("DISABLED");
    const row = await databasePool().query(
      `SELECT model_state FROM intentchord.internal_ai_models WHERE vendor_id = $1 AND model_id = $2`,
      [vendorBound, modelBound],
    );
    expect(row.rows[0].model_state).toBe("DISABLED");

    await internalAiVendorService.setModelState(vendorBound, modelBound, "ENABLED", "OWNER_TEST");
  });

  it("4. Active/Standby engine blocks hard delete (ACTIVE_STANDBY_PROTECTION)", async () => {
    await expect(internalAiEngineRegistryService.deleteEngine(engineBound, "OWNER_TEST"))
      .rejects.toThrow(/ACTIVE_STANDBY_PROTECTION|Active or Standby/i);

    const still = await databasePool().query(
      `SELECT engine_id FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
      [engineBound],
    );
    expect(still.rowCount).toBe(1);
  });

  it("5. Vendor with Engine Revision provenance blocks hard delete → Retire required", async () => {
    await expect(internalAiVendorService.deleteVendor(vendorBound, "OWNER_TEST"))
      .rejects.toThrow(/DELETE_NOT_ALLOWED_RETIRE_REQUIRED|historical Engine Revision/i);
    const still = await databasePool().query(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorBound],
    );
    expect(still.rowCount).toBe(1);
  });

  it("6. Removing Active selection still blocks delete while qualification history remains", async () => {
    const removeRes = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: scope,
      engineId: engineNever,
      engineConfigRevision: "1",
      engineConfigurationSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }, "OWNER_TEST").catch(() => null);
    expect(removeRes).toBeNull();

    const current = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    expect(current).not.toBeNull();
    expect(current!.active.engineId).toBe(engineBound);

    await expect(internalAiEngineRegistryService.deleteEngine(engineBound, "OWNER_TEST"))
      .rejects.toThrow(/ACTIVE_STANDBY_PROTECTION|Active or Standby|Retire/i);
  });

  it("7. Engine with only unused registration (no revisions) can be hard-deleted", async () => {
    const res = await internalAiEngineRegistryService.deleteEngine(engineNever, "OWNER_TEST");
    expect(res.deleted).toBe(true);
    const gone = await databasePool().query(
      `SELECT engine_id FROM intentchord.internal_ai_engines WHERE engine_id = $1`,
      [engineNever],
    );
    expect(gone.rowCount).toBe(0);
  });

  it("8. Vendor after deleting its only never-used model can be hard-deleted", async () => {
    const modelDel = await internalAiVendorService.deleteModel(vendorNever, modelNever, "OWNER_TEST");
    expect(modelDel.deleted).toBe(true);

    const vendorDel = await internalAiVendorService.deleteVendor(vendorNever, "OWNER_TEST");
    expect(vendorDel.deleted).toBe(true);

    const gone = await databasePool().query(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorNever],
    );
    expect(gone.rowCount).toBe(0);
  });

  it("9. Vendor with models still present (fresh) still blocks delete", async () => {
    await expect(internalAiVendorService.deleteVendor(vendorFresh, "OWNER_TEST"))
      .rejects.toThrow(/DELETE_NOT_ALLOWED_CHILDREN_EXIST|still has/i);
  });

  it("10. Admin API authenticated DELETE never-used vendor succeeds; model still present first", async () => {
    const modelList = await databasePool().query(
      `SELECT model_id FROM intentchord.internal_ai_models WHERE vendor_id = $1`,
      [vendorFresh],
    );
    expect(modelList.rowCount).toBe(1);

    const delModel = await deleteModelRoute(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorFresh}/models/${modelFresh}`),
      { params: Promise.resolve({ vendorId: vendorFresh, modelId: modelFresh }) },
    );
    expect(delModel.status).toBe(200);
    expect((await delModel.json()).deleted).toBe(true);

    const delVendor = await deleteVendorRoute(
      makeValidAuthRequest(`${BASE}/api/admin/ai-vendors/${vendorFresh}`),
      { params: Promise.resolve({ vendorId: vendorFresh }) },
    );
    expect(delVendor.status).toBe(200);
    expect((await delVendor.json()).deleted).toBe(true);

    const gone = await databasePool().query(
      `SELECT vendor_id FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [vendorFresh],
    );
    expect(gone.rowCount).toBe(0);
  });

  it("11. Retired Vendor cannot return to ENABLED (terminal retire)", async () => {
    const retiredVendor = `${testPrefix}_retired`;
    await internalAiVendorService.addVendor(
      {
        vendorId: retiredVendor,
        displayName: "Gate 6 Retired",
        baseUrl: `https://api.${retiredVendor}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.setVendorState(retiredVendor, "RETIRED", "OWNER_TEST", "gate6");
    await expect(internalAiVendorService.setVendorState(retiredVendor, "ENABLED", "OWNER_TEST"))
      .rejects.toThrow(/VENDOR_RETIRED|retired/i);

    await databasePool().query(
      `DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id = $1`,
      [retiredVendor],
    );
  });

  it("12. Audit events record VENDOR_DELETED / MODEL_DELETED / ENGINE_DELETED without secrets", async () => {
    const events = await databasePool().query(
      `SELECT event_type, metadata FROM intentchord.audit_events
        WHERE event_type IN ('VENDOR_DELETED', 'MODEL_DELETED', 'ENGINE_DELETED')
          AND (metadata::text LIKE $1 OR event_type = 'ENGINE_DELETED')
        ORDER BY created_at DESC LIMIT 20`,
      [`%${testPrefix}%`],
    );
    const types = new Set(events.rows.map((r: { event_type: string }) => r.event_type));
    expect(types.has("ENGINE_DELETED")).toBe(true);
    for (const row of events.rows as Array<{ event_type: string; metadata: Record<string, unknown> }>) {
      const blob = JSON.stringify(row.metadata);
      expect(blob).not.toMatch(/apiKey|secret|password|token/i);
    }
  });
});
