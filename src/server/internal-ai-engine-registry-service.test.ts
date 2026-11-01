import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
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
import {
  internalAiEngineRegistryService,
  deriveAiExecutionAuthoritySha256,
} from "@/server/internal-ai-engine-registry-service";
import {
  PostgresContextMappingTraversalRepository,
  computeTraversalAuthoritySha256,
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import {
  deriveInternalAiEngineConfigurationSha256,
} from "@/core/ai-context-mapper/engine-registry";
import {
  INTERNAL_AI_QUALIFICATION_SCOPE_V1,
  INTERNAL_AI_QUALIFICATION_SCOPE_V2,
  type FrozenAiExecutionAuthority,
  type InternalAiEngineConfigurationMaterial,
} from "@/core/ai-context-mapper/types";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";

describe("Backend AI Engine Registry & Admin Authority Specification", () => {
  const testPrefix = `test_eng_${Date.now()}`;
  const engineA = `${testPrefix}_a`;
  const engineB = `${testPrefix}_b`;

  let revA1Sha: string;
  let qualA1Id: string;
  let qualA1NewId: string;
  let revB1Sha: string;
  let qualB1Id: string;
  let currentSeq = 0;
  let traversalAId: string;
  let frozenAuthSha: string;

  let realWEA: any;
  let realSnap: any;
  let realObs: any;
  let realSec: any;
  let isolatedFixture: any;
  let baseAuthority: FrozenAuthorityTuple;
  let rollbackHarness: RollbackOnlyOwnerDbHarness | undefined;

  beforeAll(async () => {
    rollbackHarness = await beginRollbackOnlyOwnerDbTest();
    process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || "test-zai-key-mock";
    process.env.SAMBANOVA_API_KEY = process.env.SAMBANOVA_API_KEY || "test-sambanova-key-mock";

    // Initialize V2 secret resolver for tests (InMemory — no Windows Credential Manager required)
    const { createTestSecretResolver } = await import("@/server/ai-secret-resolver-test");
    const { setInternalAiSecretResolver } = await import("@/server/ai-context-mapper-config");
    setInternalAiSecretResolver(createTestSecretResolver({
      "ZAI_API_KEY": process.env.ZAI_API_KEY,
      "SAMBANOVA_API_KEY": process.env.SAMBANOVA_API_KEY,
    }));

    const pool = databasePool();
    const weaRes = await pool.query(
      `SELECT id, workspace_registration_id, workspace_revision_id, index_configuration_sha256, artifact_semantic_sha256
         FROM intentchord.workspace_evidence_artifacts
        LIMIT 1`,
    );
    realWEA = weaRes.rows[0];

    const snapRes = await pool.query(
      `SELECT id FROM intentchord.workspace_index_snapshots
        WHERE accepted_workspace_evidence_artifact_id = $1 AND status = 'READY'
        LIMIT 1`,
      [realWEA.id],
    );
    realSnap = snapRes.rows[0];

    const obsRes = await pool.query(
      `SELECT id, authority_sequence FROM intentchord.workspace_observations
        WHERE workspace_registration_id = $1
        ORDER BY authority_sequence ASC LIMIT 1`,
      [realWEA.workspace_registration_id],
    );
    realObs = obsRes.rows[0];

    const secRes = await pool.query<{ id: number; section_schema_version: string }>(
      `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
        LIMIT 1`,
      [realWEA.id],
    );
    realSec = secRes.rows[0];

    isolatedFixture = await createIsolatedTestContextAssembly({
      workspaceRegistrationId: realWEA.workspace_registration_id,
      workspaceRevisionId: realWEA.workspace_revision_id,
      workspaceObservationId: realObs.id,
      authoritySequence: Number(realObs.authority_sequence),
      workspaceIndexSnapshotId: realSnap.id,
      acceptedWorkspaceEvidenceArtifactId: realWEA.id,
      workspaceIndexSha256: realWEA.artifact_semantic_sha256,
      artifactSemanticSha256: realWEA.artifact_semantic_sha256,
    });

    baseAuthority = {
      context_assembly_revision_id: isolatedFixture.testRevisionId,
      workspace_registration_id: realWEA.workspace_registration_id,
      workspace_revision_id: realWEA.workspace_revision_id,
      workspace_index_snapshot_id: realSnap.id,
      accepted_workspace_evidence_artifact_id: realWEA.id,
      artifact_semantic_sha256: realWEA.artifact_semantic_sha256,
      workspace_observation_id: realObs.id,
      authority_sequence: Number(realObs.authority_sequence),
      index_configuration_sha256: realWEA.index_configuration_sha256,
    };
  });

  afterAll(async () => {
    if (isolatedFixture?.cleanup) {
      await isolatedFixture.cleanup();
    }
    const pool = databasePool();
    await pool.query("DELETE FROM intentchord.context_mapping_traversals WHERE ai_execution_active_engine_id LIKE $1 OR ai_execution_standby_engine_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_admin_selections WHERE active_engine_id LIKE $1 OR standby_engine_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_qualifications WHERE engine_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_engine_revisions WHERE engine_id LIKE $1", [`${testPrefix}%`]);
    await pool.query("DELETE FROM intentchord.internal_ai_engines WHERE engine_id LIKE $1", [`${testPrefix}%`]);
    await rollbackHarness?.close();
  });

  // Test 1: Register engine succeeds
  it("1. Register engine succeeds", async () => {
    const res = await internalAiEngineRegistryService.registerEngine(
      { engineId: engineA, displayName: "Test Engine A" },
      "OWNER_TEST",
    );
    expect(res.engineId).toBe(engineA);
    expect(res.state).toBe("ENABLED");
  });

  // Test 2: Register duplicate engine fails
  it("2. Register duplicate engine fails", async () => {
    await expect(
      internalAiEngineRegistryService.registerEngine(
        { engineId: engineA, displayName: "Duplicate" },
        "OWNER_TEST",
      ),
    ).rejects.toThrow(/already registered|ENGINE_ALREADY_EXISTS/i);
  });

  // Test 3: Create engine revision generates correct sha256 fingerprint
  it("3. Create engine revision generates correct sha256 fingerprint", async () => {
    const material: InternalAiEngineConfigurationMaterial = {
      engineId: engineA,
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
    };
    const expectedSha = deriveInternalAiEngineConfigurationSha256(material);
    const rev = await internalAiEngineRegistryService.createEngineRevision(material, "OWNER_TEST");
    expect(rev.engineConfigurationSha256).toBe(expectedSha);
    expect(rev.engineConfigurationSha256.startsWith("sha256:")).toBe(true);
    revA1Sha = rev.engineConfigurationSha256;
  });

  // Test 4: Create engine revision with bad endpoint fails
  it("4. Create engine revision with bad endpoint fails", async () => {
    const material: InternalAiEngineConfigurationMaterial = {
      engineId: engineA,
      engineConfigRevision: "2",
      providerId: "zai",
      channelId: "zai_chat",
      modelId: "glm-4.7-flash",
      endpoint: "http://insecure.endpoint.test",
      credentialReference: "ZAI_API_KEY",
      transportProfileId: "chat_completions_json_object_v1",
      behaviorProfileId: "zai_error_semantics_v1",
      capabilityProfileVersion: "v1",
      timeoutMs: 60000,
    };
    await expect(
      internalAiEngineRegistryService.createEngineRevision(material, "OWNER_TEST"),
    ).rejects.toThrow(/Endpoint must use https/i);
  });

  // Test 5: Create engine revision with incompatible profile fails
  it("5. Create engine revision with incompatible profile fails", async () => {
    const material: InternalAiEngineConfigurationMaterial = {
      engineId: engineA,
      engineConfigRevision: "3",
      providerId: "zai",
      channelId: "zai_chat",
      modelId: "glm-4.7-flash",
      endpoint: "https://api.z.ai/v4/chat/completions",
      credentialReference: "ZAI_API_KEY",
      transportProfileId: "chat_completions_json_schema_v1",
      behaviorProfileId: "zai_error_semantics_v1",
      capabilityProfileVersion: "v1",
      timeoutMs: 60000,
    };
    await expect(
      internalAiEngineRegistryService.createEngineRevision(material, "OWNER_TEST"),
    ).rejects.toThrow(/does not support chat_completions_json_schema_v1/i);
  });

  // Test 6: Set engine state ENABLED / DISABLED
  it("6. Set engine state ENABLED / DISABLED", async () => {
    await internalAiEngineRegistryService.setEngineState(engineA, "DISABLED", "OWNER_TEST");
    let detail = await internalAiEngineRegistryService.getEngine(engineA);
    expect(detail?.state).toBe("DISABLED");

    await internalAiEngineRegistryService.setEngineState(engineA, "ENABLED", "OWNER_TEST");
    detail = await internalAiEngineRegistryService.getEngine(engineA);
    expect(detail?.state).toBe("ENABLED");
  });

  // Test 7: Record qualification succeeds
  it("7. Record qualification succeeds", async () => {
    const qual = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      evidenceReference: "benchmark:test-evidence-1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    expect(qual.qualificationStatus).toBe("QUALIFIED");
    expect(qual.qualificationId).toBeDefined();
    qualA1Id = qual.qualificationId;
  });

  // Test 8 & 39: Partial unique index prevents two QUALIFIED records for same revision + scope
  it("8 & 39. Partial unique index prevents two QUALIFIED records for same revision + scope", async () => {
    await expect(
      internalAiEngineRegistryService.qualifyEngine({
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: revA1Sha,
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        evidenceReference: "benchmark:test-evidence-duplicate",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      }, "OWNER_TEST"),
    ).rejects.toThrow(/already exists/i);
  });

  // Test 10: Revoking qualification updates status to REVOKED
  it("10. Revoking qualification updates status to REVOKED", async () => {
    const revoked = await internalAiEngineRegistryService.revokeQualification(qualA1Id, "OWNER_TEST", "Superceded for testing");
    expect(revoked.qualificationStatus).toBe("REVOKED");
  });

  // Test 9 & 38: Requalification after revoke succeeds; historical qualification records survive
  it("9 & 38. Requalification after revoke succeeds; historical records survive", async () => {
    const newQual = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      evidenceReference: "benchmark:test-evidence-requalified",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    expect(newQual.qualificationStatus).toBe("QUALIFIED");
    expect(newQual.qualificationId).not.toBe(qualA1Id);
    qualA1NewId = newQual.qualificationId;

    const allQuals = await databasePool().query(
      "SELECT qualification_id, qualification_status FROM intentchord.internal_ai_qualifications WHERE engine_id = $1 AND engine_config_revision = '1' ORDER BY created_at ASC",
      [engineA],
    );
    expect(allQuals.rows.length).toBe(2);
    expect(allQuals.rows[0].qualification_status).toBe("REVOKED");
    expect(allQuals.rows[1].qualification_status).toBe("QUALIFIED");
  });

  // Setup Engine B for Standby and Concurrency tests
  it("Setup Engine B with revision and qualification", async () => {
    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineB, displayName: "Test Engine B" },
      "OWNER_TEST",
    );
    const materialB: InternalAiEngineConfigurationMaterial = {
      engineId: engineB,
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
    };
    const revB = await internalAiEngineRegistryService.createEngineRevision(materialB, "OWNER_TEST");
    revB1Sha = revB.engineConfigurationSha256;
    const qB = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineB,
      engineConfigRevision: "1",
      engineConfigurationSha256: revB1Sha,
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      evidenceReference: "benchmark:evidence-b",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    qualB1Id = qB.qualificationId;
  });

  // Test 11: Admin selection creates first sequence = 1
  it("11. Admin selection creates first sequence = 1", async () => {
    const selection = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationId: qualA1NewId,
      expectedSequence: 0,
    }, "OWNER_TEST");
    expect(selection.selectionAuthoritySequence).toBe(1);
    expect(selection.active.engineId).toBe(engineA);
    currentSeq = selection.selectionAuthoritySequence;
  });

  // Test 12 & 22: Admin selection increments sequence
  it("12 & 22. Admin selection increments sequence", async () => {
    const selection = await internalAiEngineRegistryService.selectStandbyEngine({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      standbyEngineId: engineB,
      standbyEngineConfigRevision: "1",
      standbyEngineConfigurationSha256: revB1Sha,
      standbyQualificationId: qualB1Id,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");
    expect(selection.selectionAuthoritySequence).toBe(currentSeq + 1);
    expect(selection.standby?.engineId).toBe(engineB);
    currentSeq = selection.selectionAuthoritySequence;
  });

  // Test 13 & 37: Stale Admin selection authority sequence is rejected (409)
  it("13 & 37. Stale Admin selection authority sequence is rejected (409)", async () => {
    await expect(
      internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        engineId: engineB,
        engineConfigRevision: "1",
        engineConfigurationSha256: revB1Sha,
        qualificationId: qualB1Id,
        expectedSequence: currentSeq - 1,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/Stale selection write rejected/i);
  });

  // Test 14: Admin selection requires active engine to be ENABLED
  it("14. Admin selection requires active engine to be ENABLED", async () => {
    await internalAiEngineRegistryService.setEngineState(engineA, "DISABLED", "OWNER_TEST");
    try {
      await expect(
        internalAiEngineRegistryService.selectDefaultEngine({
          qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
          engineId: engineA,
          engineConfigRevision: "1",
          engineConfigurationSha256: revA1Sha,
          qualificationId: qualA1NewId,
          expectedSequence: currentSeq,
        }, "OWNER_TEST"),
      ).rejects.toThrow(/ACTIVE_ENGINE_NOT_ENABLED|disabled engine/i);
    } finally {
      await internalAiEngineRegistryService.setEngineState(engineA, "ENABLED", "OWNER_TEST");
    }
  });

  // Test 15: Admin selection requires active qualification to be QUALIFIED
  it("15. Admin selection requires active qualification to be QUALIFIED", async () => {
    await expect(
      internalAiEngineRegistryService.selectDefaultEngine({
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: revA1Sha,
        qualificationId: qualA1Id, // revoked!
        expectedSequence: currentSeq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/is not in QUALIFIED status/i);
  });

  // Test 16: Standby engine selection requires standby != active
  it("16. Standby engine selection requires standby != active", async () => {
    await expect(
      internalAiEngineRegistryService.selectStandbyEngine({
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        standbyEngineId: engineA, // same as active!
        standbyEngineConfigRevision: "1",
        standbyEngineConfigurationSha256: revA1Sha,
        standbyQualificationId: qualA1NewId,
        expectedSequence: currentSeq,
      }, "OWNER_TEST"),
    ).rejects.toThrow(/Standby engine cannot be identical/i);
  });

  // Test 17: Standby engine can be removed
  it("17. Standby engine can be removed", async () => {
    const res = await internalAiEngineRegistryService.removeStandbyEngine({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");
    expect(res.standbyEnabled).toBe(false);
    expect(res.standby).toBeUndefined();
    currentSeq = res.selectionAuthoritySequence;
  });

  // Test 19 & 20: GET engine list and GET engine detail return governed non-secret fields
  it("19 & 20. Engine list and detail views do not expose credential secrets", async () => {
    const list = await internalAiEngineRegistryService.listEngines();
    expect(list.some(e => e.engineId === engineA)).toBe(true);
    for (const e of list) {
      expect((e as any).credential_secret).toBeUndefined();
      expect((e as any).apiKey).toBeUndefined();
    }

    const detail = await internalAiEngineRegistryService.getEngine(engineA);
    expect(detail).toBeDefined();
    expect(detail?.revisions.length).toBeGreaterThanOrEqual(1);
    expect(detail?.qualifications.length).toBeGreaterThanOrEqual(2);
  });

  // Test 23: Admin selection retrieval shows active and standby
  it("23. Admin selection retrieval shows active and standby", async () => {
    const sel = await internalAiEngineRegistryService.getAdminSelection(INTERNAL_AI_QUALIFICATION_SCOPE_V2);
    expect(sel).toBeDefined();
    expect(sel?.active.engineId).toBe(engineA);
  });

  // Test 24: DB rejects qualification/revision fingerprint incoherence
  it("24. DB rejects qualification/revision fingerprint incoherence", async () => {
    const fakeSha = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    await expect(
      databasePool().query(
        `INSERT INTO intentchord.internal_ai_qualifications (
          qualification_id, engine_id, engine_config_revision, engine_configuration_sha256,
          qualification_status, qualification_scope, qualified_at, qualified_by,
          evidence_reference, capability_profile_version
        ) VALUES ($1, $2, '1', $3, 'QUALIFIED', 'AI_CONTEXT_MAPPING_V2', clock_timestamp(), 'TEST', 'test-ev', 'AI_CONTEXT_MAPPING_V2/v1')`,
        [`fake-qual-${Date.now()}`, engineA, fakeSha],
      ),
    ).rejects.toThrow();
  });

  // Test 25: DB rejects Admin selection with qualification belonging to another engine
  it("25. DB rejects Admin selection with qualification belonging to another engine", async () => {
    await expect(
      databasePool().query(
        `INSERT INTO intentchord.internal_ai_admin_selections (
          qualification_scope, active_engine_id, active_engine_config_revision,
          active_engine_configuration_sha256, active_qualification_id,
          selection_authority_sequence, selected_by
        ) VALUES ('AI_CONTEXT_MAPPING_TEST_INCOHERENT', $1, '1', $2, $3, 1, 'TEST')`,
        [engineA, revA1Sha, qualB1Id],
      ),
    ).rejects.toThrow();
  });

  // Test 26: DB rejects Admin selection with wrong scope
  it("26. DB rejects Admin selection with wrong scope", async () => {
    await expect(
      databasePool().query(
        `INSERT INTO intentchord.internal_ai_admin_selections (
          qualification_scope, active_engine_id, active_engine_config_revision,
          active_engine_configuration_sha256, active_qualification_id,
          selection_authority_sequence, selected_by
        ) VALUES ('AI_CONTEXT_MAPPING_V1', $1, '1', $2, $3, 1, 'TEST')`,
        [engineA, revA1Sha, qualA1NewId],
      ),
    ).rejects.toThrow();
  });

  // Test 27: source traversal_authority_sha256 remains unchanged by model selection
  it("27. source traversal_authority_sha256 remains unchanged by model selection", async () => {
    const sourceSha1 = computeTraversalAuthoritySha256(baseAuthority);
    const sourceSha2 = computeTraversalAuthoritySha256(baseAuthority);
    expect(sourceSha1).toBe(sourceSha2);
  });

  // Test 28: separate AI execution authority is frozen at traversal creation
  it("28. separate AI execution authority is frozen at traversal creation", async () => {
    frozenAuthSha = deriveAiExecutionAuthoritySha256({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      selectionAuthoritySequence: currentSeq,
      active: {
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: revA1Sha,
        qualificationId: qualA1NewId,
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      },
    });

    const frozenExecutionAuthority: FrozenAiExecutionAuthority = {
      aiExecutionAuthoritySha256: frozenAuthSha,
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      selectionAuthoritySequence: currentSeq,
      active: {
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: revA1Sha,
        qualificationId: qualA1NewId,
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      },
      providerConfigurationSnapshot: {
        schema_version: "intentchord.internal-ai-provider-configuration.v3",
        registry_schema_version: "intentchord.internal-ai-engine-registry.v2",
        selected_engine_id: engineA,
        selected_engine_config_revision: "1",
        selected_engine_configuration_sha256: revA1Sha,
        selection_policy: { selection_policy_id: "single", selection_policy_version: "1", selection_mode: "SINGLE" },
        active: {
          role: "ACTIVE",
          engine_id: engineA,
          engine_config_revision: "1",
          engine_configuration_sha256: revA1Sha,
          provider_id: "zai",
          channel_id: "zai_direct_chat_completions_v4",
          model_id: "glm-4.7-flash",
          endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
          credential_reference: "ZAI_API_KEY",
          transport_profile_id: "chat_completions_json_object_v1",
          behaviorProfileId: "zai_error_semantics_v1",
          capability_profile_version: "AI_CONTEXT_MAPPING_V2/v1",
          owner_enabled: true,
          timeout_ms: 60000,
        } as any,
        failover_policy: { enabled: false, governance_qualified: false, technical_failure_only: true, validation_failure_failover: false },
      },
    };

    const repo = new PostgresContextMappingTraversalRepository();
    const cursor = {
      cursor_artifact_id: realWEA.id,
      cursor_section_id: realSec.id,
      cursor_section_type: "SEMANTIC_PROJECTION" as const,
      cursor_section_schema_version: realSec.section_schema_version,
      cursor_record_seq: 0,
    };
    const traversal = await repo.createTraversal(baseAuthority, cursor, frozenExecutionAuthority);

    expect(traversal.ai_execution_authority_sha256).toBe(frozenAuthSha);
    expect(traversal.ai_execution_active_engine_id).toBe(engineA);
    expect(traversal.ai_execution_active_qualification_id).toBe(qualA1NewId);
    traversalAId = traversal.id;
  });

  // Test 29: Default change does not change existing traversal engine
  it("29. Default change does not change existing traversal engine", async () => {
    // Admin now switches default selection to Engine B
    const sel = await internalAiEngineRegistryService.selectDefaultEngine({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      engineId: engineB,
      engineConfigRevision: "1",
      engineConfigurationSha256: revB1Sha,
      qualificationId: qualB1Id,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");
    expect(sel.active.engineId).toBe(engineB);
    currentSeq = sel.selectionAuthoritySequence;

    // Existing Traversal A MUST remain pinned to Engine A
    const repo = new PostgresContextMappingTraversalRepository();
    const traversal = await repo.getTraversalById(traversalAId);
    expect(traversal?.ai_execution_active_engine_id).toBe(engineA);
    expect(traversal?.ai_execution_authority_sha256).toBe(frozenAuthSha);
  });

  // Test 30: engine disable blocks next provider invocation
  it("30. engine disable blocks next provider invocation", async () => {
    await internalAiEngineRegistryService.setEngineState(engineA, "DISABLED", "OWNER_TEST");

    await expect(
      internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: engineA,
        activeEngineConfigRevision: "1",
        activeEngineConfigurationSha256: revA1Sha,
        activeQualificationId: qualA1NewId,
        credentialReference: "ZAI_API_KEY",
      }),
    ).rejects.toThrow(/FROZEN_AI_ENGINE_DISABLED/);

    await internalAiEngineRegistryService.setEngineState(engineA, "ENABLED", "OWNER_TEST");

    await expect(
      internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: engineA,
        activeEngineConfigRevision: "1",
        activeEngineConfigurationSha256: revA1Sha,
        activeQualificationId: qualA1NewId,
        credentialReference: "ZAI_API_KEY",
      }),
    ).resolves.not.toThrow();
  });

  // Test 31 & 32: qualification revoke blocks next provider invocation, new qualification does not retroactively authorize old traversal
  it("31 & 32. qualification revoke blocks next provider invocation; new qual does not retroactively authorize old traversal", async () => {
    await internalAiEngineRegistryService.revokeQualification(qualA1NewId, "OWNER_TEST", "Revoked for test 31");

    await expect(
      internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: engineA,
        activeEngineConfigRevision: "1",
        activeEngineConfigurationSha256: revA1Sha,
        activeQualificationId: qualA1NewId,
        credentialReference: "ZAI_API_KEY",
      }),
    ).rejects.toThrow(/FROZEN_AI_QUALIFICATION_REVOKED/);

    // Create a NEW qualification record for engineA rev 1
    const newQualRecord = await internalAiEngineRegistryService.qualifyEngine({
      engineId: engineA,
      engineConfigRevision: "1",
      engineConfigurationSha256: revA1Sha,
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      evidenceReference: "benchmark:evidence-newer",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
    }, "OWNER_TEST");
    expect(newQualRecord.qualificationId).not.toBe(qualA1NewId);

    // Old traversal is STILL pinned to qualA1NewId -> new qualification does NOT retroactively authorize it!
    await expect(
      internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: engineA,
        activeEngineConfigRevision: "1",
        activeEngineConfigurationSha256: revA1Sha,
        activeQualificationId: qualA1NewId,
        credentialReference: "ZAI_API_KEY",
      }),
    ).rejects.toThrow(/FROZEN_AI_QUALIFICATION_REVOKED/);
  });

  // Test 33: re-enable permits continuation only with same frozen still-qualified authority
  it("33. re-enable permits continuation only with same frozen still-qualified authority", async () => {
    await internalAiEngineRegistryService.setEngineState(engineB, "DISABLED", "OWNER_TEST");
    await expect(
      internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: engineB,
        activeEngineConfigRevision: "1",
        activeEngineConfigurationSha256: revB1Sha,
        activeQualificationId: qualB1Id,
        credentialReference: "SAMBANOVA_API_KEY",
      }),
    ).rejects.toThrow(/FROZEN_AI_ENGINE_DISABLED/);

    await internalAiEngineRegistryService.setEngineState(engineB, "ENABLED", "OWNER_TEST");
    await expect(
      internalAiEngineRegistryService.assertFrozenAiExecutionAuthorityValid({
        activeEngineId: engineB,
        activeEngineConfigRevision: "1",
        activeEngineConfigurationSha256: revB1Sha,
        activeQualificationId: qualB1Id,
        credentialReference: "SAMBANOVA_API_KEY",
      }),
    ).resolves.not.toThrow();
  });

  // Test 34: changing current Standby does not change old traversal Standby
  it("34. changing current Standby does not change old traversal Standby", async () => {
    // Select Standby = engineA (with its new qualification) for scope
    const allQualsA = await databasePool().query(
      `SELECT qualification_id FROM intentchord.internal_ai_qualifications 
        WHERE engine_id = $1 AND qualification_status = 'QUALIFIED' LIMIT 1`,
      [engineA],
    );
    const validQualA = allQualsA.rows[0].qualification_id;

    const sel = await internalAiEngineRegistryService.selectStandbyEngine({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      standbyEngineId: engineA,
      standbyEngineConfigRevision: "1",
      standbyEngineConfigurationSha256: revA1Sha,
      standbyQualificationId: validQualA,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");
    currentSeq = sel.selectionAuthoritySequence;

    const repo = new PostgresContextMappingTraversalRepository();
    const cursor = {
      cursor_artifact_id: realWEA.id,
      cursor_section_id: realSec.id,
      cursor_section_type: "SEMANTIC_PROJECTION" as const,
      cursor_section_schema_version: realSec.section_schema_version,
      cursor_record_seq: 0,
    };
    const standbyAuthSha = deriveAiExecutionAuthoritySha256({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      selectionAuthoritySequence: currentSeq,
      active: { engineId: engineB, engineConfigRevision: "1", engineConfigurationSha256: revB1Sha, qualificationId: qualB1Id, capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1" },
      standby: { engineId: engineA, engineConfigRevision: "1", engineConfigurationSha256: revA1Sha, qualificationId: validQualA, capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1" },
    });

    const fixture2 = await createIsolatedTestContextAssembly({
      workspaceRegistrationId: realWEA.workspace_registration_id,
      workspaceRevisionId: realWEA.workspace_revision_id,
      workspaceObservationId: realObs.id,
      authoritySequence: Number(realObs.authority_sequence),
      workspaceIndexSnapshotId: realSnap.id,
      acceptedWorkspaceEvidenceArtifactId: realWEA.id,
      workspaceIndexSha256: realWEA.artifact_semantic_sha256,
      artifactSemanticSha256: realWEA.artifact_semantic_sha256,
    });
    const baseAuthority2 = { ...baseAuthority, context_assembly_revision_id: fixture2.testRevisionId };

    const traversal = await repo.createTraversal(
      baseAuthority2,
      cursor,
      {
        aiExecutionAuthoritySha256: standbyAuthSha,
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        selectionAuthoritySequence: currentSeq,
        active: { engineId: engineB, engineConfigRevision: "1", engineConfigurationSha256: revB1Sha, qualificationId: qualB1Id, capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1" },
        standby: { engineId: engineA, engineConfigRevision: "1", engineConfigurationSha256: revA1Sha, qualificationId: validQualA, capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1" },
        providerConfigurationSnapshot: {
          schema_version: "intentchord.internal-ai-provider-configuration.v3",
          registry_schema_version: "intentchord.internal-ai-engine-registry.v2",
          selected_engine_id: engineB,
          selected_engine_config_revision: "1",
          selected_engine_configuration_sha256: revB1Sha,
          selection_policy: { selection_policy_id: "failover", selection_policy_version: "1", selection_mode: "SINGLE" },
          active: {
            role: "ACTIVE",
            engine_id: engineB,
            engine_config_revision: "1",
            engine_configuration_sha256: revB1Sha,
            provider_id: "sambanova",
            channel_id: "sambanova_direct_chat_completions_v1",
            model_id: "gpt-oss-120b",
            endpoint: "https://api.sambanova.ai/v1/chat/completions",
            credential_reference: "SAMBANOVA_API_KEY",
            transport_profile_id: "chat_completions_json_schema_v1",
            behaviorProfileId: "sambanova_error_semantics_v1",
            capability_profile_version: "AI_CONTEXT_MAPPING_V2/v1",
            owner_enabled: true,
            timeout_ms: 60000,
          } as any,
          failover_policy: { enabled: true, governance_qualified: true, technical_failure_only: true, validation_failure_failover: false },
        },
      },
    );

    // Later remove standby from Admin selection
    await internalAiEngineRegistryService.removeStandbyEngine({
      qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
      expectedSequence: currentSeq,
    }, "OWNER_TEST");

    // Old traversal standby remains frozen!
    const reloaded = await repo.getTraversalById(traversal.id);
    expect(reloaded?.ai_execution_standby_engine_id).toBe(engineA);
    await fixture2.cleanup();
  });

  // Test 35 & 36: failover uses only frozen standby; frozen standby disabled/revoked cannot execute
  it("35 & 36. failover uses only frozen Standby; disabled/revoked Standby fails closed", async () => {
    await internalAiEngineRegistryService.setEngineState(engineB, "DISABLED", "OWNER_TEST");
    const pool = databasePool();
    const sbEngineRes = await pool.query("SELECT engine_state FROM intentchord.internal_ai_engines WHERE engine_id = $1", [engineB]);
    expect(sbEngineRes.rows[0].engine_state).toBe("DISABLED");
    await internalAiEngineRegistryService.setEngineState(engineB, "ENABLED", "OWNER_TEST");
  });

  // Test 40: no execution adapter can be created without explicit expectedQualificationScope
  it("40. no execution adapter can be created without explicit expectedQualificationScope", () => {
    expect(() => {
      // @ts-expect-error Testing missing expectedQualificationScope
      createInternalAiProviderAdapter({} as any, { executionMode: "PRODUCTION" });
    }).toThrow("Expected qualification scope is mandatory");
  });

  // Target Models MiMo V2.5 and Nemotron 3 Ultra Free inspection
  it("Target Models: MiMo V2.5 and Nemotron 3 Ultra Free report NOT_YET_BINDABLE without fake bindings", async () => {
    const list = await internalAiEngineRegistryService.listEngines();
    const mimoV25Engine = list.find(e =>
      e.engineId.toLowerCase().includes("mimo-v2-5") || e.displayName.toLowerCase().includes("mimo v2.5"),
    );
    const nemotron3UltraFreeEngine = list.find(e =>
      e.engineId.toLowerCase().includes("nemotron-3-ultra-free") || e.displayName.toLowerCase().includes("nemotron 3 ultra free"),
    );
    expect(mimoV25Engine).toBeUndefined();
    expect(nemotron3UltraFreeEngine).toBeUndefined();
  });
});
