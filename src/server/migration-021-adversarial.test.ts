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

import { databasePool, bindRollbackOnlyTestClient, databaseQuery } from "@/server/db";
import {
  internalAiEngineRegistryService,
  deriveAiExecutionAuthoritySha256,
} from "@/server/internal-ai-engine-registry-service";
import {
  PostgresContextMappingTraversalRepository,
} from "@/server/context-mapping-traversal-repository";
import {
  deriveInternalAiEngineConfigurationSha256,
} from "@/core/ai-context-mapper/engine-registry";
import {
  INTERNAL_AI_QUALIFICATION_SCOPE_V2,
  type FrozenAiExecutionAuthority,
  type InternalAiEngineConfigurationMaterial,
} from "@/core/ai-context-mapper/types";
import { createInternalAiProviderAdapter } from "@/server/internal-ai-engine-runtime";
import type { ResolvedInternalAiEngineConfig } from "@/server/ai-context-mapper-config";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";
import { internalAiVendorService } from "@/server/internal-ai-vendor-service";

describe("Migration 021 Adversarial Specification: Provider Neutrality & Execution Immutability", () => {
  const testPrefix = `test_m021_${Date.now()}`;
  const engineA = `${testPrefix}_a`;
  const engineFuture = `${testPrefix}_future`;

  let realWEA: any;
  let realSnap: any;
  let realObs: any;
  let realSec: any;
  let isolatedFixture: any;
  let baseAuthority: any;
  let traversalId: string;
  let historicalTraversalId: string;
  let fixtureHistorical: any;
  let unbindTestClient: (() => void) | undefined;

  beforeAll(async () => {
    process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
    const pool = databasePool();
    const client = await pool.connect();
    
    await client.query("BEGIN");
    unbindTestClient = bindRollbackOnlyTestClient(client);

    // Defensive cleanup: delete any leftover test_m021_* rows from prior
    // interrupted runs whose afterAll never executed.  Order respects FKs.
    const leftover = await databaseQuery(
      "SELECT engine_id FROM intentchord.internal_ai_engines WHERE engine_id LIKE 'test_m021_%'",
    );
    if (leftover.rows.length > 0) {
      const ids = leftover.rows.map(r => (r as { engine_id: string }).engine_id);
      const placeholders = ids.map((_: string, i: number) => `$${i + 1}`);
      await databaseQuery(`DELETE FROM intentchord.context_mapping_traversals WHERE ai_execution_active_engine_id IN (${placeholders})`, ids);
      await databaseQuery(`DELETE FROM intentchord.internal_ai_admin_selections WHERE active_engine_id IN (${placeholders})`, ids);
      await databaseQuery(`DELETE FROM intentchord.internal_ai_qualifications WHERE engine_id IN (${placeholders})`, ids);
      await databaseQuery(`DELETE FROM intentchord.internal_ai_engine_revisions WHERE engine_id IN (${placeholders})`, ids);
      await databaseQuery(`DELETE FROM intentchord.internal_ai_engines WHERE engine_id IN (${placeholders})`, ids);
    }

    const weaRes = await databaseQuery(
      `SELECT id, workspace_registration_id, workspace_revision_id, index_configuration_sha256, artifact_semantic_sha256
         FROM intentchord.workspace_evidence_artifacts
        LIMIT 1`,
    );
    realWEA = weaRes.rows[0];

    const snapRes = await databaseQuery(
      `SELECT id FROM intentchord.workspace_index_snapshots
       WHERE accepted_workspace_evidence_artifact_id = $1 AND status = 'READY'
       LIMIT 1`,
      [realWEA.id],
    );
    realSnap = snapRes.rows[0];

    const obsRes = await databaseQuery(
      `SELECT id, authority_sequence FROM intentchord.workspace_observations
       WHERE workspace_registration_id = $1
       ORDER BY authority_sequence ASC LIMIT 1`,
      [realWEA.workspace_registration_id],
    );
    realObs = obsRes.rows[0];

    const secRes = await databaseQuery<{ id: number; section_schema_version: string }>(
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

    // Register test engines
    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineA, displayName: "Test Engine Legacy" },
      "OWNER_TEST",
    );
    await internalAiEngineRegistryService.registerEngine(
      { engineId: engineFuture, displayName: "Test Engine Future" },
      "OWNER_TEST",
    );

    // Gate 4: future provider must be a first-class Vendor before Engine Revision binding.
    await internalAiVendorService.addVendor(
      {
        vendorId: "future_provider",
        displayName: "Future Provider",
        baseUrl: "https://api.future.ai",
        authType: "api_key",
        protocolProfile: "openai_chat_completions_v1",
      },
      "OWNER_TEST",
    ).catch(() => {});
    await internalAiVendorService.addModel(
      "future_provider",
      {
        modelId: "future-model-v1",
        displayName: "Future Model V1",
        providerFacingModelId: "future-model-v1",
      },
      "OWNER_TEST",
    ).catch(() => {});
  });

  afterAll(async () => {
    if (isolatedFixture?.cleanup) await isolatedFixture.cleanup();
    if (fixtureHistorical?.cleanup) await fixtureHistorical.cleanup();

    await databaseQuery("DELETE FROM intentchord.context_mapping_traversals WHERE ai_execution_active_engine_id LIKE $1", [`${testPrefix}%`]);
    if (historicalTraversalId) {
      await databaseQuery("DELETE FROM intentchord.context_mapping_traversals WHERE id = $1", [historicalTraversalId]);
    }
    await databaseQuery("DELETE FROM intentchord.internal_ai_qualifications WHERE engine_id LIKE $1", [`${testPrefix}%`]);
    await databaseQuery("DELETE FROM intentchord.internal_ai_engine_revisions WHERE engine_id LIKE $1", [`${testPrefix}%`]);
    await databaseQuery("DELETE FROM intentchord.internal_ai_engines WHERE engine_id LIKE $1", [`${testPrefix}%`]);
    await databaseQuery("DELETE FROM intentchord.internal_ai_models WHERE vendor_id = 'future_provider' AND model_id = 'future-model-v1'").catch(() => {});
    await databaseQuery("DELETE FROM intentchord.internal_ai_vendors WHERE vendor_id = 'future_provider'").catch(() => {});

    if (unbindTestClient) unbindTestClient();
  });

  // ==========================================================================
  // AREA 1: PROVIDER / ADAPTER NEUTRALITY TESTS
  // ==========================================================================

  it("Area 1.1: Legacy ZAI profile remains structurally representable in DB", async () => {
    const mat: InternalAiEngineConfigurationMaterial = {
      engineId: engineA,
      engineConfigRevision: "1",
      providerId: "zai",
      channelId: "zai_chat",
      modelId: "glm-4.7-flash",
      endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
      credentialReference: "ZAI_API_KEY",
      transportProfileId: "chat_completions_json_object_v1",
      behaviorProfileId: "zai_error_semantics_v1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
    };
    const rev = await internalAiEngineRegistryService.createEngineRevision(mat, "OWNER_TEST");
    expect(rev.transportProfileId).toBe("chat_completions_json_object_v1");
    expect(rev.behaviorProfileId).toBe("zai_error_semantics_v1");
  });

  it("Area 1.2: Legacy SambaNova profile remains structurally representable in DB", async () => {
    const mat: InternalAiEngineConfigurationMaterial = {
      engineId: engineA,
      engineConfigRevision: "2",
      providerId: "sambanova",
      channelId: "sambanova_chat",
      modelId: "gpt-oss-120b",
      endpoint: "https://api.sambanova.ai/v1/chat/completions",
      credentialReference: "SAMBANOVA_API_KEY",
      transportProfileId: "chat_completions_json_schema_v1",
      behaviorProfileId: "sambanova_error_semantics_v1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
    };
    const rev = await internalAiEngineRegistryService.createEngineRevision(mat, "OWNER_TEST");
    expect(rev.transportProfileId).toBe("chat_completions_json_schema_v1");
    expect(rev.behaviorProfileId).toBe("sambanova_error_semantics_v1");
  });

  it("Area 1.3: Syntactically valid future profile identifier can be persisted without schema change", async () => {
    const futureMat: InternalAiEngineConfigurationMaterial = {
      engineId: engineFuture,
      engineConfigRevision: "1",
      providerId: "future_provider",
      channelId: "future_channel",
      modelId: "future-model-v1",
      endpoint: "https://api.future.ai/v1/chat",
      credentialReference: "FUTURE_AI_KEY",
      transportProfileId: "future_custom_streaming_transport_v1",
      behaviorProfileId: "future_custom_error_semantics_v1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
    };
    const rev = await internalAiEngineRegistryService.createEngineRevision(futureMat, "OWNER_TEST");
    expect(rev.transportProfileId).toBe("future_custom_streaming_transport_v1");
    expect(rev.behaviorProfileId).toBe("future_custom_error_semantics_v1");

    // Verify row directly in PostgreSQL
    const res = await databaseQuery(
      "SELECT transport_profile_id, behavior_profile_id FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = '1'",
      [engineFuture],
    );
    expect(res.rows[0].transport_profile_id).toBe("future_custom_streaming_transport_v1");
    expect(res.rows[0].behavior_profile_id).toBe("future_custom_error_semantics_v1");
  });

  it("Area 1.4: Unsupported runtime profile cannot become executable (fails closed)", () => {
    const futureEngine: ResolvedInternalAiEngineConfig = {
      engineId: engineFuture,
      engineConfigRevision: "1",
      providerId: "future_provider",
      channelId: "future_channel",
      modelId: "future-model-v1",
      endpoint: "https://api.future.ai/v1/chat",
      credentialReference: "FUTURE_AI_KEY",
      transportProfileId: "future_custom_streaming_transport_v1",
      behaviorProfileId: "future_custom_error_semantics_v1",
      capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      timeoutMs: 60000,
      engineConfigurationSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      role: "ACTIVE",
      ownerEnabled: true,
    };

    expect(() => {
      createInternalAiProviderAdapter(futureEngine, {
        expectedQualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        executionMode: "PRODUCTION",
      });
    }).toThrow(/UNSUPPORTED_TRANSPORT_PROFILE/i);
  });

  it("Area 1.5: Adding a new supported profile requires Adapter Registry source addition, not DB migration", async () => {
    // Proves that when DB allows the profile string, the barrier to execution is strictly source-level adapter capability
    const dbChecks = await databaseQuery(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'intentchord' AND c.conrelid = 'intentchord.internal_ai_engine_revisions'::regclass
         AND conname IN ('internal_ai_engine_revisions_transport_profile_id_check', 'internal_ai_engine_revisions_behavior_profile_id_check')
    `);
    for (const row of dbChecks.rows) {
      expect(row.def).not.toContain("chat_completions_json_object_v1");
      expect(row.def).not.toContain("zai_error_semantics_v1");
      expect(row.def).toContain("length");
    }
  });

  // ==========================================================================
  // AREA 2: FROZEN AI EXECUTION AUTHORITY DB IMMUTABILITY TESTS
  // ==========================================================================

  it("Setup Traversal with Frozen AI Execution Authority", async () => {
    const revA1 = await databaseQuery(
      "SELECT engine_configuration_sha256 FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = '1'",
      [engineA],
    );
    if (!revA1.rows[0]) {
      // Ensure revision exists (Area 1.1 might not have run yet depending on Vitest execution)
      await internalAiEngineRegistryService.createEngineRevision({
        engineId: engineA,
        engineConfigRevision: "1",
        providerId: "zai",
        channelId: "zai_chat",
        modelId: "glm-4.7-flash",
        endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
        credentialReference: "ZAI_API_KEY",
        transportProfileId: "chat_completions_json_object_v1",
        behaviorProfileId: "zai_error_semantics_v1",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
        timeoutMs: 60000,
      }, "OWNER_TEST");
      
      const retryRev = await databaseQuery(
        "SELECT engine_configuration_sha256 FROM intentchord.internal_ai_engine_revisions WHERE engine_id = $1 AND engine_config_revision = '1'",
        [engineA],
      );
      return setupTraversal(retryRev.rows[0].engine_configuration_sha256);
    }
    return setupTraversal(revA1.rows[0].engine_configuration_sha256);

    async function setupTraversal(revA1Sha: string) {
      const qual = await internalAiEngineRegistryService.qualifyEngine({
        engineId: engineA,
        engineConfigRevision: "1",
        engineConfigurationSha256: revA1Sha,
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        evidenceReference: "benchmark:m021-test",
        capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
      }, "OWNER_TEST");

      const authSha = deriveAiExecutionAuthoritySha256({
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        selectionAuthoritySequence: 1,
        active: {
          engineId: engineA,
          engineConfigRevision: "1",
          engineConfigurationSha256: revA1Sha,
          qualificationId: qual.qualificationId,
          capabilityProfileVersion: "AI_CONTEXT_MAPPING_V2/v1",
        },
      });

      const frozenExecutionAuthority: FrozenAiExecutionAuthority = {
        aiExecutionAuthoritySha256: authSha,
        qualificationScope: INTERNAL_AI_QUALIFICATION_SCOPE_V2,
        selectionAuthoritySequence: 1,
        active: {
          engineId: engineA,
          engineConfigRevision: "1",
          engineConfigurationSha256: revA1Sha,
          qualificationId: qual.qualificationId,
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
            channel_id: "zai_chat",
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
      traversalId = traversal.id;
      expect(traversal.ai_execution_authority_sha256).toBe(authSha);
    }
  });

  it("AI_EXECUTION_ACTIVE_ENGINE_UPDATE = DB_REJECT", async () => {
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_active_engine_id = 'hacked_engine' WHERE id = $1",
        [traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("AI_EXECUTION_ACTIVE_REVISION_UPDATE = DB_REJECT", async () => {
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_active_engine_config_revision = '99' WHERE id = $1",
        [traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("AI_EXECUTION_QUALIFICATION_UPDATE = DB_REJECT", async () => {
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_active_qualification_id = 'qual_hacked' WHERE id = $1",
        [traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("AI_EXECUTION_SHA_UPDATE = DB_REJECT", async () => {
    const fakeSha = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_authority_sha256 = $1 WHERE id = $2",
        [fakeSha, traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("AI_EXECUTION_STANDBY_UPDATE = DB_REJECT", async () => {
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_standby_engine_id = 'standby_hacked' WHERE id = $1",
        [traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("AI_EXECUTION_SELECTION_SEQUENCE_UPDATE = DB_REJECT", async () => {
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_selection_authority_sequence = 9999 WHERE id = $1",
        [traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("AI_EXECUTION_PROVIDER_SNAPSHOT_UPDATE = DB_REJECT", async () => {
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_provider_configuration_snapshot = '{\"tampered\": true}'::jsonb WHERE id = $1",
        [traversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });

  it("NULL_HISTORICAL_TRAVERSAL_READABLE = YES (Operational update succeeds, retroactive AI backfill rejected)", async () => {
    fixtureHistorical = await createIsolatedTestContextAssembly({
      workspaceRegistrationId: realWEA.workspace_registration_id,
      workspaceRevisionId: realWEA.workspace_revision_id,
      workspaceObservationId: realObs.id,
      authoritySequence: Number(realObs.authority_sequence),
      workspaceIndexSnapshotId: realSnap.id,
      acceptedWorkspaceEvidenceArtifactId: realWEA.id,
      workspaceIndexSha256: realWEA.artifact_semantic_sha256,
      artifactSemanticSha256: realWEA.artifact_semantic_sha256,
    });
    const histAuth = {
      context_assembly_revision_id: fixtureHistorical.testRevisionId,
      workspace_registration_id: realWEA.workspace_registration_id,
      workspace_revision_id: realWEA.workspace_revision_id,
      workspace_index_snapshot_id: realSnap.id,
      accepted_workspace_evidence_artifact_id: realWEA.id,
      artifact_semantic_sha256: realWEA.artifact_semantic_sha256,
      workspace_observation_id: realObs.id,
      authority_sequence: Number(realObs.authority_sequence),
      index_configuration_sha256: realWEA.index_configuration_sha256,
    };
    const cursor = {
      cursor_artifact_id: realWEA.id,
      cursor_section_id: realSec.id,
      cursor_section_type: "SEMANTIC_PROJECTION" as const,
      cursor_section_schema_version: realSec.section_schema_version,
      cursor_record_seq: 0,
    };

    // Create a traversal WITHOUT frozen AI execution authority (simulating legacy historical row)
    const repo = new PostgresContextMappingTraversalRepository();
    const histTrav = await repo.createTraversal(histAuth, cursor);
    historicalTraversalId = histTrav.id;

    // Verify row is readable and ai_execution_* are null
    const read = await repo.getTraversalById(historicalTraversalId);
    expect(read).toBeDefined();
    expect(read?.ai_execution_authority_sha256 ?? null).toBeNull();

    // Verify operational update (e.g. status) SUCCEEDS without triggering immutability guard
    await databaseQuery(
      "UPDATE intentchord.context_mapping_traversals SET traversal_status = 'CANCELLED' WHERE id = $1",
      [historicalTraversalId],
    );
    const updated = await repo.getTraversalById(historicalTraversalId);
    expect(updated?.traversal_status).toBe("CANCELLED");

    // Verify attempt to retroactively set ai_execution_active_engine_id FAILS CLOSED
    await expect(
      databaseQuery(
        "UPDATE intentchord.context_mapping_traversals SET ai_execution_active_engine_id = 'retroactive_backfill' WHERE id = $1",
        [historicalTraversalId],
      ),
    ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_AI_EXECUTION_AUTHORITY_IMMUTABLE/);
  });
});
