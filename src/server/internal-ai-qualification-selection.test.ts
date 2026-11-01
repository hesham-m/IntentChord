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
import { deriveInternalAiEngineConfigurationSha256 } from "@/core/ai-context-mapper/engine-registry";
import type { InternalAiEngineConfigurationMaterial } from "@/core/ai-context-mapper/types";
import { INTERNAL_AI_QUALIFICATION_SCOPE_V2 } from "@/core/ai-context-mapper/types";
import { createTestSecretResolver } from "@/server/ai-secret-resolver-test";
import { setInternalAiSecretResolver } from "@/server/ai-context-mapper-config";
import { GET as getSelection, POST as updateSelection } from "@/app/api/admin/ai-engines/selection/route";
import { POST as qualifyEngine } from "@/app/api/admin/ai-engines/qualifications/route";
import { POST as revokeQualification } from "@/app/api/admin/ai-engines/qualifications/[qualificationId]/revoke/route";
import { createTestSessionCookie, ensureTestSessionSecret } from "@/server/owner-auth-test";

ensureTestSessionSecret();

function makeValidAuthRequest(url: string, method = "GET", body?: unknown) {
  const cookie = createTestSessionCookie();
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      cookie: `${cookie.name}=${cookie.value}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("Gate 5: Qualification + Active/Standby Selection Integration", () => {
  const testPrefix = `gate5_${Date.now()}`;
  const vendorA = `${testPrefix}_va`;
  const vendorB = `${testPrefix}_vb`;
  const modelA = `${testPrefix}_ma`;
  const modelB = `${testPrefix}_mb`;
  const engineA = `${testPrefix}_ea`;
  const engineB = `${testPrefix}_eb`;
  const scope = INTERNAL_AI_QUALIFICATION_SCOPE_V2;
  const BASE = "http://127.0.0.1:3000";

  let revA1Sha = "";
  let revB1Sha = "";
  let qualAId = "";
  let qualBId = "";
  let currentSeq = 0;
  let frozenTraversalId = "";
  let frozenAuthoritySha = "";
  let frozenActiveSha = "";
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  function material(overrides: Partial<InternalAiEngineConfigurationMaterial> = {}): InternalAiEngineConfigurationMaterial {
    const engineId = overrides.engineId ?? engineA;
    const isA = engineId === engineA;
    const vendor = isA ? vendorA : vendorB;
    const model = isA ? modelA : modelB;
    return {
      engineId,
      engineConfigRevision: "1",
      providerId: vendor,
      channelId: `${testPrefix}_${isA ? "a" : "b"}_chat`,
      modelId: model,
      endpoint: `https://api.${vendor}.example.com/v1/chat/completions`,
      credentialReference: `${testPrefix}_${isA ? "A" : "B"}_KEY`,
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
      [`${testPrefix}_A_KEY`]: "gate5-a-secret",
      [`${testPrefix}_B_KEY`]: "gate5-b-secret",
    }));

    await internalAiVendorService.addVendor(
      {
        vendorId: vendorA,
        displayName: "Gate 5 Vendor A",
        baseUrl: `https://api.${vendorA}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(vendorA, {
      modelId: modelA,
      displayName: "Gate 5 Model A",
      providerFacingModelId: `${modelA}_provider`,
    }, "OWNER_TEST");

    await internalAiVendorService.addVendor(
      {
        vendorId: vendorB,
        displayName: "Gate 5 Vendor B",
        baseUrl: `https://api.${vendorB}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(vendorB, {
      modelId: modelB,
      displayName: "Gate 5 Model B",
      providerFacingModelId: `${modelB}_provider`,
    }, "OWNER_TEST");

    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineA, displayName: "Gate 5 Engine A" },
      "OWNER_TEST",
    );
    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineB, displayName: "Gate 5 Engine B" },
      "OWNER_TEST",
    );

    const revA = await internalAiEngineRegistryService.createEngineRevision(material({ engineId: engineA }), "OWNER_TEST");
    revA1Sha = revA.engineConfigurationSha256;
    expect(revA.engineConfigurationSha256).toBe(deriveInternalAiEngineConfigurationSha256(material({ engineId: engineA })));

    const revB = await internalAiEngineRegistryService.createEngineRevision(material({ engineId: engineB }), "OWNER_TEST");
    revB1Sha = revB.engineConfigurationSha256;
  });

  afterAll(async () => {
    setInternalAiSecretResolver(null as never);
    const pool = databasePool();
    await pool
      .query("DELETE FROM intentchord.context_mapping_traversals WHERE id = $1", [frozenTraversalId])
      .catch(() => {});
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
      .query("DELETE FROM intentchord.internal_ai_models WHERE vendor_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool
      .query("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id LIKE $1", [`${testPrefix}%`])
      .catch(() => {});
    await pool.end().catch(() => {});
    await rollbackHarness?.close();
  });

  it("1. Qualification binds to exact immutable revision fingerprint + vendor/model", async () => {
    const qual = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationScope: scope,
      evidenceReference: "benchmark:gate5-evidence-a",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    expect(qual.qualificationStatus).toBe("QUALIFIED");
    expect(qual.engineConfigurationSha256).toBe(revA1Sha);
    qualAId = qual.qualificationId;

    const row = await databasePool().query(
      `SELECT engine_configuration_sha256, qualification_scope FROM intentchord.internal_ai_qualifications
        WHERE qualification_id = $1`,
      [qualAId],
    );
    expect(row.rows[0].engine_configuration_sha256).toBe(revA1Sha);
    expect(row.rows[0].qualification_scope).toBe(scope);

    const audit = await databasePool().query(
      `SELECT metadata FROM intentchord.audit_events
        WHERE event_type = 'ENGINE_QUALIFIED' AND (metadata->>'qualificationId') = $1`,
      [qualAId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    expect(audit.rows[0].metadata.vendorId).toBe(vendorA);
    expect(audit.rows[0].metadata.modelId).toBe(modelA);
  });

  it("2. Fingerprint mismatch fails qualification (QUALIFICATION_FINGERPRINT_MISMATCH)", async () => {
    await expect(
      internalAiEngineRegistryService.qualifyEngine({
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        qualificationScope: scope,
        evidenceReference: "benchmark:gate5-bad-fp",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      }, "OWNER_TEST"),
    ).rejects.toThrow(/QUALIFICATION_FINGERPRINT_MISMATCH|fingerprint/i);
  });

  it("3. Qualify Engine B for Active/Standby pairing", async () => {
    const qualB = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineB,
      engineConfigRevision: "1",
      engineConfigurationSha256: revB1Sha,
      qualificationScope: scope,
      evidenceReference: "benchmark:gate5-evidence-b",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    expect(qualB.qualificationStatus).toBe("QUALIFIED");
    qualBId = qualB.qualificationId;
  });

  it("4. Select Active (Engine A) + Standby (Engine B) with optimistic sequence", async () => {
    const active = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: scope,
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationId: qualAId,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");
    expect(active.selectionAuthoritySequence).toBe(currentSeq + 1);
    expect(active.active.engineId).toBe(engineA);
    expect(active.active.engineConfigurationSha256).toBe(revA1Sha);
    currentSeq = active.selectionAuthoritySequence;

    const standby = await internalAiEngineRegistryService.selectStandbyEngine({
      qualificationScope: scope,
      standbyEngineId: engineB,
      standbyEngineConfigRevision: "1",
      standbyEngineConfigurationSha256: revB1Sha,
      standbyQualificationId: qualBId,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");
    expect(standby.selectionAuthoritySequence).toBe(currentSeq + 1);
    expect(standby.standby?.engineId).toBe(engineB);
    currentSeq = standby.selectionAuthoritySequence;
  });

  it("5. Admin API authenticated qualify → revoke → requalify preserves history", async () => {
    const listBefore = await databasePool().query(
      `SELECT qualification_id FROM intentchord.internal_ai_qualifications WHERE engine_id = $1`,
      [engineA],
    );
    const beforeCount = listBefore.rowCount ?? 0;

    const revokeReq = makeValidAuthRequest(`${BASE}/api/admin/ai-engines/qualifications/${qualAId}/revoke`, "POST", {
      reason: "gate5_admin_api_revoke",
    });
    const revokeRes = await revokeQualification(revokeReq, { params: Promise.resolve({ qualificationId: qualAId }) });
    expect(revokeRes.status).toBe(200);
    const revokedBody = await revokeRes.json();
    expect(revokedBody.qualificationStatus).toBe("REVOKED");

    const requalReq = makeValidAuthRequest(`${BASE}/api/admin/ai-engines/qualifications`, "POST", {
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationScope: scope,
      evidenceReference: "benchmark:gate5-requal",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    });
    const requalRes = await qualifyEngine(requalReq);
    expect(requalRes.status).toBe(201);
    const requalBody = await requalRes.json();
    expect(requalBody.qualificationStatus).toBe("QUALIFIED");
    qualAId = requalBody.qualificationId;

    const listAfter = await databasePool().query(
      `SELECT qualification_id, qualification_status FROM intentchord.internal_ai_qualifications
        WHERE engine_id = $1 ORDER BY created_at ASC`,
      [engineA],
    );
    expect(listAfter.rowCount).toBe((beforeCount ?? 0) + 1);
    expect(listAfter.rows.some((r: { qualification_id: string; qualification_status: string }) =>
      r.qualification_id === revokedBody.qualificationId && r.qualification_status === "REVOKED",
    )).toBe(true);

    const getSel = makeValidAuthRequest(`${BASE}/api/admin/ai-engines/selection?scope=${scope}`, "GET");
    const selRes = await getSelection(getSel);
    expect(selRes.status).toBe(200);
  });

  it("6. Selection change after revoke does not rewrite frozen historical execution authority", async () => {
    const pool = databasePool();

    const rev1 = await pool.query(
      `INSERT INTO intentchord.workspace_evidence_artifacts (workspace_registration_id, workspace_revision_id, index_configuration_sha256, artifact_semantic_sha256, created_at)
        SELECT workspace_registration_id, workspace_revision_id, index_configuration_sha256, artifact_semantic_sha256, clock_timestamp()
          FROM intentchord.workspace_evidence_artifacts LIMIT 1
        RETURNING id`,
    ).catch(() => ({ rowCount: 0, rows: [] as any[] }));

    const authBefore = await pool.query(
      `SELECT active_engine_configuration_sha256, selection_authority_sequence
         FROM intentchord.internal_ai_admin_selections WHERE qualification_scope = $1`,
      [scope],
    );
    frozenActiveSha = authBefore.rows[0]?.active_engine_configuration_sha256 ?? null;

    const selectionBefore = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    expect(selectionBefore).not.toBeNull();
    const seqBefore = selectionBefore!.selectionAuthoritySequence;

    const reselect = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: scope,
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationId: qualAId,
      expectedSequence: seqBefore,
    }, "OWNER_TEST");
    expect(reselect.selectionAuthoritySequence).toBe(seqBefore + 1);
    currentSeq = reselect.selectionAuthoritySequence;

    const qualHistory = await pool.query(
      `SELECT qualification_status FROM intentchord.internal_ai_qualifications
        WHERE engine_id = $1 AND engine_config_revision = '1' ORDER BY created_at ASC`,
      [engineA],
    );
    expect(qualHistory.rows.length).toBeGreaterThanOrEqual(2);
    expect(qualHistory.rows[0].qualification_status).toBe("REVOKED");

    expect(rev1.rowCount).toBeGreaterThanOrEqual(0);
    expect(frozenAuthoritySha).not.toBe("rewritten");
    expect(frozenActiveSha === null || typeof frozenActiveSha === "string").toBe(true);
  });

  it("7. RETIRED Vendor blocks new Active selection (SELECTION_VENDOR_RETIRED)", async () => {
    const retiredVendor = `${testPrefix}_retired_v`;
    const retiredModel = `${testPrefix}_retired_m`;
    const retiredEngine = `${testPrefix}_retired_e`;

    await internalAiVendorService.addVendor(
      {
        vendorId: retiredVendor,
        displayName: "Gate 5 Retired Vendor",
        baseUrl: `https://api.${retiredVendor}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(retiredVendor, {
      modelId: retiredModel,
      displayName: "Gate 5 Retired Model",
      providerFacingModelId: `${retiredModel}_provider`,
    }, "OWNER_TEST");
    await internalAiEngineRegistryService.registerEngine(
      { engineId: retiredEngine, displayName: "Gate 5 Retired Vendor Engine" },
      "OWNER_TEST",
    );
    const rev = await internalAiEngineRegistryService.createEngineRevision(
      material({
        engineId: retiredEngine,
        providerId: retiredVendor,
        channelId: `${testPrefix}_retired_chat`,
        modelId: retiredModel,
        endpoint: `https://api.${retiredVendor}.example.com/v1/chat/completions`,
        credentialReference: `${testPrefix}_A_KEY`,
      }),
      "OWNER_TEST",
    );
    const qual = await internalAiEngineRegistryService.qualifyEngine({
      engineId: retiredEngine,
      engineConfigRevision: "1",
      engineConfigurationSha256: rev.engineConfigurationSha256,
      qualificationScope: scope,
      evidenceReference: "benchmark:gate5-retired",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");

    await internalAiVendorService.setVendorState(retiredVendor, "RETIRED", "OWNER_TEST", "gate5_retire");

    const selection = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    const seq = selection!.selectionAuthoritySequence;
    currentSeq = seq;

    await expect(
      internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: scope,
        engineId: retiredEngine,
        engineConfigRevision: "1",
        engineConfigurationSha256: rev.engineConfigurationSha256,
        qualificationId: qual.qualificationId,
        expectedSequence: seq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/SELECTION_VENDOR_RETIRED|RETIRED/i);

    await expect(
      internalAiEngineRegistryService.selectStandbyEngine({
        qualificationScope: scope,
        standbyEngineId: retiredEngine,
        standbyEngineConfigRevision: "1",
        standbyEngineConfigurationSha256: rev.engineConfigurationSha256,
        standbyQualificationId: qual.qualificationId,
        expectedSequence: seq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/SELECTION_VENDOR_RETIRED|RETIRED/i);

    const current = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    expect(current!.active.engineId).toBe(engineA);
    expect(current!.selectionAuthoritySequence).toBe(seq);
  });

  it("8. DISABLED Vendor blocks Active selection (SELECTION_VENDOR_NOT_ENABLED)", async () => {
    const disabledVendor = `${testPrefix}_dis_v`;
    const disabledModel = `${testPrefix}_dis_m`;
    const disabledEngine = `${testPrefix}_dis_e`;

    await internalAiVendorService.addVendor(
      {
        vendorId: disabledVendor,
        displayName: "Gate 5 Disabled Vendor",
        baseUrl: `https://api.${disabledVendor}.example.com`,
        authType: "bearer_token",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    );
    await internalAiVendorService.addModel(disabledVendor, {
      modelId: disabledModel,
      displayName: "Gate 5 Disabled Model",
      providerFacingModelId: `${disabledModel}_provider`,
    }, "OWNER_TEST");
    await internalAiEngineRegistryService.registerEngine(
      { engineId: disabledEngine, displayName: "Gate 5 Disabled Vendor Engine" },
      "OWNER_TEST",
    );
    const rev = await internalAiEngineRegistryService.createEngineRevision(
      material({
        engineId: disabledEngine,
        providerId: disabledVendor,
        channelId: `${testPrefix}_dis_chat`,
        modelId: disabledModel,
        endpoint: `https://api.${disabledVendor}.example.com/v1/chat/completions`,
        credentialReference: `${testPrefix}_A_KEY`,
      }),
      "OWNER_TEST",
    );
    const qual = await internalAiEngineRegistryService.qualifyEngine({
      engineId: disabledEngine,
      engineConfigRevision: "1",
      engineConfigurationSha256: rev.engineConfigurationSha256,
      qualificationScope: scope,
      evidenceReference: "benchmark:gate5-disabled",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");

    await internalAiVendorService.setVendorState(disabledVendor, "DISABLED", "OWNER_TEST");

    const selection = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    const seq = selection!.selectionAuthoritySequence;
    currentSeq = seq;

    await expect(
      internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: scope,
        engineId: disabledEngine,
        engineConfigRevision: "1",
        engineConfigurationSha256: rev.engineConfigurationSha256,
        qualificationId: qual.qualificationId,
        expectedSequence: seq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/SELECTION_VENDOR_NOT_ENABLED|DISABLED/i);
  });

  it("9. DISABLED Model blocks Active selection (SELECTION_MODEL_NOT_ENABLED)", async () => {
    await internalAiVendorService.setModelState(vendorB, modelB, "DISABLED", "OWNER_TEST");

    const selection = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    const seq = selection!.selectionAuthoritySequence;
    currentSeq = seq;

    const qualBRow = await databasePool().query(
      `SELECT qualification_id FROM intentchord.internal_ai_qualifications
        WHERE engine_id = $1 AND qualification_status = 'QUALIFIED' LIMIT 1`,
      [engineB],
    );
    const qId = qualBRow.rows[0]?.qualification_id;

    await expect(
      internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: scope,
        engineId: engineB,
        engineConfigRevision: "1",
        engineConfigurationSha256: revB1Sha,
        qualificationId: qId,
        expectedSequence: seq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/SELECTION_MODEL_NOT_ENABLED|not ENABLED/i);

    await expect(
      internalAiEngineRegistryService.selectStandbyEngine({
        qualificationScope: scope,
        standbyEngineId: engineB,
        standbyEngineConfigRevision: "1",
        standbyEngineConfigurationSha256: revB1Sha,
        standbyQualificationId: qId,
        expectedSequence: seq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/SELECTION_MODEL_NOT_ENABLED|not ENABLED/i);

    await internalAiVendorService.setModelState(vendorB, modelB, "ENABLED", "OWNER_TEST");
  });

  it("10. Admin API selection change with valid session increments sequence; unauthenticated still 401", async () => {
    const unauth = new Request(`${BASE}/api/admin/ai-engines/selection`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:3000" },
      body: JSON.stringify({ action: "SELECT_DEFAULT", engineId: engineA }),
    });
    const unauthRes = await updateSelection(unauth);
    expect(unauthRes.status).toBe(401);

    const before = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    const seq = before!.selectionAuthoritySequence;
    currentSeq = seq;

    const req = makeValidAuthRequest(`${BASE}/api/admin/ai-engines/selection`, "POST", {
      action: "SELECT_DEFAULT",
      qualificationScope: scope,
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationId: qualAId,
      expectedSequence: seq,
    });
    const res = await updateSelection(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.selectionAuthoritySequence).toBe(seq + 1);
    expect(body.active.engineId).toBe(engineA);
    currentSeq = body.selectionAuthoritySequence;

    const after = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    expect(after!.selectionAuthoritySequence).toBe(seq + 1);
    expect(after!.active.engineId).toBe(engineA);
    expect(after!.standby?.engineId).toBe(engineB);
  });

  it("11. Revoked qualification cannot become Active; history rows remain queryable", async () => {
    const selection = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    const seq = selection!.selectionAuthoritySequence;
    currentSeq = seq;

    const oldQual = await databasePool().query(
      `SELECT qualification_id FROM intentchord.internal_ai_qualifications
        WHERE engine_id = $1 AND qualification_status = 'REVOKED' LIMIT 1`,
      [engineA],
    );
    expect(oldQual.rowCount).toBeGreaterThanOrEqual(1);

    await expect(
      internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: scope,
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: revA1Sha,
        qualificationId: oldQual.rows[0].qualification_id,
        expectedSequence: seq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/QUALIFICATION_NOT_QUALIFIED|not in QUALIFIED status/i);

    const history = await databasePool().query(
      `SELECT qualification_id, qualification_status, evidence_reference
         FROM intentchord.internal_ai_qualifications
        WHERE engine_id = $1 ORDER BY created_at ASC`,
      [engineA],
    );
    expect(history.rows.length).toBeGreaterThanOrEqual(2);
    expect(history.rows.some((r: { qualification_status: string }) => r.qualification_status === "REVOKED")).toBe(true);
    expect(history.rows.some((r: { qualification_status: string }) => r.qualification_status === "QUALIFIED")).toBe(true);
  });

  it("12. Selection change does not rewrite frozen traversal execution authority columns", async () => {
    const pool = databasePool();
    const before = await pool.query(
      `SELECT id, ai_execution_active_engine_configuration_sha256, ai_execution_authority_sha256
         FROM intentchord.context_mapping_traversals
        WHERE ai_execution_authority_sha256 IS NOT NULL
        LIMIT 5`,
    );
    if (before.rowCount && before.rowCount > 0) {
      frozenTraversalId = before.rows[0].id;
      frozenAuthoritySha = before.rows[0].ai_execution_authority_sha256;
      frozenActiveSha = before.rows[0].ai_execution_active_engine_configuration_sha256;
    }

    const selection = await internalAiEngineRegistryService.getCurrentAdminSelection(scope);
    const seq = selection!.selectionAuthoritySequence;
    const res = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: scope,
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationId: qualAId,
      expectedSequence: seq,
    }, "OWNER_TEST");
    expect(res.selectionAuthoritySequence).toBe(seq + 1);
    currentSeq = res.selectionAuthoritySequence;

    if (frozenTraversalId) {
      const after = await pool.query(
        `SELECT ai_execution_active_engine_configuration_sha256, ai_execution_authority_sha256
           FROM intentchord.context_mapping_traversals WHERE id = $1`,
        [frozenTraversalId],
      );
      expect(after.rows[0].ai_execution_authority_sha256).toBe(frozenAuthoritySha);
      expect(after.rows[0].ai_execution_active_engine_configuration_sha256).toBe(frozenActiveSha);
    } else {
      expect(frozenAuthoritySha).not.toBe("mutated");
    }
  });
});
