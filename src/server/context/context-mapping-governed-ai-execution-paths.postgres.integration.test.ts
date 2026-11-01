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
import {
  PostgresContextMappingTraversalRepository,
  computeTraversalAuthoritySha256,
  StaleExecutorLeaseError,
} from "@/server/context-mapping-traversal-repository";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";
import { ContextMappingTraversalExecutor } from "@/server/context/context-mapping-traversal-executor";
import { AiContextMapperV2Orchestrator } from "@/core/ai-context-mapper/orchestrator-v2";
import { PostgresAiContextMappingV2Repository } from "@/server/ai-context-mapping-v2-repository";
import { ReductionSynthesisAdapter } from "@/server/context/reduction-synthesis-adapter";
import {
  chunkSourcesByTokenBudget,
  OversizedReductionChildError,
  type ReductionSourceItem,
} from "@/server/context/hierarchical-context-synthesizer";
import {
  getGovernedReductionWindowTokenBudget,
  getGovernedTokenBudgetDetails,
  GOVERNED_RESPONSE_RESERVE_TOKENS,
  GOVERNED_PROTOCOL_OVERHEAD_TOKENS,
} from "@/server/context/governed-token-budget";
import { mapperSha256, canonicalJson, estimatedTokensForUtf8 } from "@/core/ai-context-mapper/canonical";
import type {
  AiContextMapperProviderAdapterV2,
  InternalAiProviderConfigurationSnapshotV3,
  ProviderAttemptResponse,
} from "@/core/ai-context-mapper/types";
import type { ModelContextAnalysisV2 } from "@/core/ai-context-mapper/v2";
import { ProviderTechnicalError } from "@/core/ai-context-mapper/errors";

function validModelAnalysis(
  compName = "TestComponent",
  workspaceId = "ws_1",
  evidenceEntryId = "entry_1",
): ModelContextAnalysisV2 {
  return {
    schema_version: "intentchord.model-context-analysis.v2",
    analysis_outcome: "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP",
    catalog_summary: `Summary of ${compName}`,
    components: [
      {
        component_id: `ctx_${compName.toLowerCase().replace(/[^a-z0-9_]/g, "")}_unit`,
        display_name: compName,
        context_kind: "module",
        summary: `A valid component summary for ${compName}`,
        responsibilities: ["responsibility 1"],
        workspace_ids: [workspaceId],
        evidence_entry_ids: [evidenceEntryId],
        interfaces: [],
        unknowns: [],
        confidence: "high",
        rationale: "Evidence based rationale",
      },
    ],
    relationships: [],
    missing_evidence_requests: [],
    material_contradictions: [],
    global_unknowns: [],
    warnings: [],
  };
}

import { sampleInternalAiProviderConfiguration } from "@/core/ai-context-mapper/test-fixtures";

function mockProviderSnapshot(standbyEnabled = false): InternalAiProviderConfigurationSnapshotV3 {
  const snapshot = sampleInternalAiProviderConfiguration({
    primaryProviderId: "zai",
    primaryChannelId: "zai_direct_chat_completions_v4",
    primaryModelId: "glm-4.7-flash",
    standbyProviderId: "sambanova",
    standbyChannelId: "sambanova_direct_chat_completions_v1",
    standbyModelId: "gpt-oss-120b",
    standbyEnabled,
    includeStandbySnapshot: standbyEnabled,
    standbyGovernanceQualified: standbyEnabled,
  });

  (snapshot.active.qualification as any).qualification_scope = "AI_CONTEXT_MAPPING_V2";
  if (snapshot.standby) {
    (snapshot.standby.qualification as any).qualification_scope = "AI_CONTEXT_MAPPING_V2";
  }
  return snapshot;
}

function createMockAdapter(
  providerId: "zai" | "sambanova",
  modelId: string,
  behavior?: (req: any) => Promise<ProviderAttemptResponse>,
): AiContextMapperProviderAdapterV2 {
  const channelId =
    providerId === "zai"
      ? "zai_direct_chat_completions_v4"
      : "sambanova_direct_chat_completions_v1";

  return {
    provider_id: providerId as any,
    channel_id: channelId,
    model_id: modelId,
    execute:
      behavior ??
      (async () => {
        const content = JSON.stringify(validModelAnalysis());
        return {
          raw_model_content: content,
          response_model_id: modelId,
          provider_request_id: "req-mock-1",
          usage_metadata: { total_tokens: 150, prompt_tokens: 100, completion_tokens: 50 },
          rate_limit_metadata: {},
          raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
        };
      }),
  };
}

describe("GOVERNED_AI_EXECUTION_PATHS_AND_OVERSIZED_CHILD_VALIDATION", () => {
  const repo = new PostgresContextMappingTraversalRepository();
  const v2Repo = new PostgresAiContextMappingV2Repository();

  let realWEA: any;
  let realSnap: any;
  let realObs: any;
  let realSec: any;
  let realStructuralRecord: any;

  beforeAll(async () => {
    const weaRes = await databasePool().query(
      `SELECT id, workspace_registration_id, workspace_revision_id, index_configuration_sha256, artifact_semantic_sha256
         FROM intentchord.workspace_evidence_artifacts
        LIMIT 1`,
    );
    realWEA = weaRes.rows[0];

    const snapRes = await databasePool().query(
      `SELECT id FROM intentchord.workspace_index_snapshots
        WHERE accepted_workspace_evidence_artifact_id = $1 AND status = 'READY'
        LIMIT 1`,
      [realWEA.id],
    );
    realSnap = snapRes.rows[0];

    const obsRes = await databasePool().query(
      `SELECT id, authority_sequence FROM intentchord.workspace_observations
        WHERE workspace_registration_id = $1
        ORDER BY authority_sequence ASC LIMIT 1`,
      [realWEA.workspace_registration_id],
    );
    realObs = obsRes.rows[0];

    const secRes = await databasePool().query<{ id: number; section_schema_version: string }>(
      `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
        LIMIT 1`,
      [realWEA.id],
    );
    realSec = secRes.rows[0];

    const recRes = await databasePool().query(
      `SELECT source_file_revision_id, (record_json->>'logical_unit_id') as logical_unit_id
         FROM intentchord.workspace_evidence_section_records
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
          AND (record_json->>'logical_unit_id') IS NOT NULL
        LIMIT 1`,
      [realWEA.id],
    );
    realStructuralRecord = recRes.rows[0];
  });

  async function createTestTraversalHelper(workerId = "worker_test") {
    const fixture = await createIsolatedTestContextAssembly({
      workspaceRegistrationId: realWEA.workspace_registration_id,
      workspaceRevisionId: realWEA.workspace_revision_id,
      workspaceObservationId: realObs.id,
      authoritySequence: Number(realObs.authority_sequence),
      workspaceIndexSnapshotId: realSnap.id,
      acceptedWorkspaceEvidenceArtifactId: realWEA.id,
      workspaceIndexSha256: realWEA.artifact_semantic_sha256,
      artifactSemanticSha256: realWEA.artifact_semantic_sha256,
    });

    const auth = {
      context_assembly_revision_id: fixture.testRevisionId,
      workspace_registration_id: realWEA.workspace_registration_id,
      workspace_revision_id: realWEA.workspace_revision_id,
      workspace_index_snapshot_id: realSnap.id,
      accepted_workspace_evidence_artifact_id: realWEA.id,
      artifact_semantic_sha256: realWEA.artifact_semantic_sha256,
      workspace_observation_id: realObs.id,
      authority_sequence: Number(realObs.authority_sequence),
      index_configuration_sha256: realWEA.index_configuration_sha256,
    };

    const traversal = await repo.createTraversal(auth, {
      cursor_artifact_id: realWEA.id,
      cursor_section_id: realSec.id,
      cursor_section_type: "SEMANTIC_PROJECTION",
      cursor_section_schema_version: realSec.section_schema_version,
      cursor_record_seq: 0,
    });

    const lease = await repo.claimOrRenewLease(traversal.id, workerId, 30000);
    const revRes = await databasePool().query<{ assembly_sha256: string }>(
      `SELECT assembly_sha256 FROM intentchord.context_assembly_revisions WHERE id = $1`,
      [fixture.testRevisionId],
    );
    const assemblySha256 = revRes.rows[0]?.assembly_sha256;

    return { fixture, auth, traversal, leaseEpoch: lease.leaseEpoch, assemblySha256 };
  }

  describe("PART 1: ATOMIC OVERSIZED REDUCTION CHILD (BLOCKER 1)", () => {
    it("SINGLE_CHILD_UNDER_BUDGET = PASS", () => {
      const budget = 2000;
      const childAnalysis = validModelAnalysis("UnderBudgetComp");
      const tokens = estimatedTokensForUtf8(canonicalJson(childAnalysis));
      expect(tokens).toBeLessThan(budget);

      const source: ReductionSourceItem = {
        sourceId: "src_under_budget",
        sourceType: "MAPPING_WINDOW",
        sourceOutputSha256: mapperSha256(childAnalysis),
        payload: childAnalysis,
      };

      const chunks = chunkSourcesByTokenBudget([source], budget);
      expect(chunks.length).toBe(1);
      expect(chunks[0].length).toBe(1);
      expect(chunks[0][0].sourceId).toBe("src_under_budget");
    });

    it("SINGLE_CHILD_EXACT_BUDGET = PASS", () => {
      const childAnalysis = validModelAnalysis("ExactBudgetComp");
      const exactTokens = estimatedTokensForUtf8(canonicalJson(childAnalysis));

      const source: ReductionSourceItem = {
        sourceId: "src_exact_budget",
        sourceType: "MAPPING_WINDOW",
        sourceOutputSha256: mapperSha256(childAnalysis),
        payload: childAnalysis,
      };

      const chunks = chunkSourcesByTokenBudget([source], exactTokens);
      expect(chunks.length).toBe(1);
      expect(chunks[0].length).toBe(1);
      expect(chunks[0][0].sourceId).toBe("src_exact_budget");
    });

    it("SINGLE_CHILD_OVER_BUDGET_NEVER_FORWARDED_TO_PROVIDER = PASS", async () => {
      const childAnalysis = validModelAnalysis("OversizedIndivisibleComp");
      const itemTokens = estimatedTokensForUtf8(canonicalJson(childAnalysis));
      const tinyBudget = Math.floor(itemTokens / 2);

      const source: ReductionSourceItem = {
        sourceId: "src_oversized_indivisible",
        sourceType: "MAPPING_WINDOW",
        sourceOutputSha256: mapperSha256(childAnalysis),
        payload: childAnalysis,
      };

      // Fails closed immediately during chunking
      expect(() => chunkSourcesByTokenBudget([source], tinyBudget)).toThrow(
        OversizedReductionChildError,
      );

      // Verify at the ReductionSynthesisAdapter boundary: provider execute is NEVER invoked
      let providerInvocationCount = 0;
      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async () => {
        providerInvocationCount++;
        return {
          raw_model_content: JSON.stringify(validModelAnalysis()),
          response_model_id: "glm-4.7-flash",
          provider_request_id: "req-1",
          usage_metadata: { total_tokens: 100 },
          rate_limit_metadata: {},
          raw_provider_body: "{}",
        };
      });

      const adapter = new ReductionSynthesisAdapter(mockPrimary, undefined, {
        providerConfigurationSnapshot: mockProviderSnapshot(false),
      });

      const massiveComps = Array.from({ length: 3000 }, (_, i) => ({
        component_id: `ctx_huge_${i}`,
        display_name: `HugeComponent_${i}`,
        context_kind: "module" as const,
        summary: "A very long summary repeating words ".repeat(15),
        responsibilities: ["r1", "r2", "r3"],
        workspace_ids: ["ws_1"],
        evidence_entry_ids: ["e1"],
        interfaces: [],
        unknowns: [],
        confidence: "high" as const,
        rationale: "Long rationale ".repeat(10),
      }));

      const hugeAnalysis: ModelContextAnalysisV2 = {
        ...validModelAnalysis(),
        components: massiveComps,
      };

      const { fixture, traversal, leaseEpoch } = await createTestTraversalHelper("worker_adapter_test");

      await expect(
        adapter.synthesizeReductionWindow(
          {
            traversalId: traversal.id,
            traversalAuthoritySha256: traversal.traversal_authority_sha256,
            reductionLevel: 1,
            reductionOrdinal: 1,
            childItems: [
              {
                sourceId: "huge_child",
                sourceType: "MAPPING_WINDOW",
                sourceOutputSha256: mapperSha256(hugeAnalysis),
                payload: hugeAnalysis,
              },
            ],
          },
          repo,
          "worker_adapter_test",
          leaseEpoch,
        ),
      ).rejects.toThrow(/SINGLE_CHILD_OVER_BUDGET_NEVER_FORWARDED_TO_PROVIDER/);

      expect(providerInvocationCount).toBe(0);
      await fixture.cleanup();
    });

    it("EVERY_REDUCTION_AI_INPUT_BOUNDED = YES (decomposes divisible multi-component oversized children)", () => {
      const comps = [
        { ...validModelAnalysis("C1").components[0], component_id: "ctx_c1_unit" },
        { ...validModelAnalysis("C2").components[0], component_id: "ctx_c2_unit" },
        { ...validModelAnalysis("C3").components[0], component_id: "ctx_c3_unit" },
        { ...validModelAnalysis("C4").components[0], component_id: "ctx_c4_unit" },
      ];
      const multiCompAnalysis: ModelContextAnalysisV2 = {
        ...validModelAnalysis("Multi"),
        components: comps,
      };
      const totalTokens = estimatedTokensForUtf8(canonicalJson(multiCompAnalysis));
      const subBudget = Math.floor(totalTokens * 0.6);

      const source: ReductionSourceItem = {
        sourceId: "src_multi_comp",
        sourceType: "MAPPING_WINDOW",
        sourceOutputSha256: mapperSha256(multiCompAnalysis),
        payload: multiCompAnalysis,
      };

      const chunks = chunkSourcesByTokenBudget([source], subBudget);
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      const seenCompIds = new Set<string>();
      for (const chunk of chunks) {
        let chunkTotal = 0;
        for (const item of chunk) {
          chunkTotal += estimatedTokensForUtf8(canonicalJson(item.payload));
          for (const c of (item.payload.components ?? [])) {
            seenCompIds.add(c.component_id);
          }
        }
        // Strict boundary assertion
        expect(chunkTotal).toBeLessThanOrEqual(subBudget);
      }

      expect(seenCompIds.size).toBe(4);
    });
  });

  describe("PART 2: AI EXECUTION PATHS AT CONTROLLED BOUNDARY (BLOCKER 3)", () => {
    it("1. Topology invokes the governed V2 orchestrator once per window attempt", async () => {
      const { fixture, traversal, leaseEpoch, assemblySha256 } = await createTestTraversalHelper("worker_topo_test");

      let executionCount = 0;
      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async (req) => {
        executionCount++;
        const wsId = req.mapping_input?.source_bindings?.[0]?.workspace_id ?? "ws_1";
        const entryId = req.mapping_input?.entries?.[0]?.entry_id ?? "entry_1";
        const content = JSON.stringify(validModelAnalysis("TopologyComponent", wsId, entryId));
        return {
          raw_model_content: content,
          response_model_id: "glm-4.7-flash",
          provider_request_id: "req-topo-1",
          usage_metadata: { total_tokens: 120 },
          rate_limit_metadata: {},
          raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
        };
      });

      const orchestrator = new AiContextMapperV2Orchestrator(
        v2Repo,
        mockPrimary,
        undefined,
        {
          providerConfigurationSnapshot: mockProviderSnapshot(false),
          standbyEnabled: false,
          standbyGovernanceQualified: false,
          assemblySha256,
          idempotencyKey: `test:topo:${randomUUID()}`,
          requestFingerprintSha256: mapperSha256({ test: "topo" }),
          primaryRequestTimeoutMs: 30000,
        },
      );

      const executor = new ContextMappingTraversalExecutor({
        workerId: "worker_topo_test",
        traversalRepo: repo,
        orchestrator,
      });
      (executor as any).currentEpoch = leaseEpoch;

      const traversalRow = await repo.getTraversalById(traversal.id);
      expect(traversalRow).not.toBeNull();

      // Execute topology phase using properly fetched row
      await (executor as any).executeTopologyPhase(traversalRow!);

      expect(executionCount).toBe(1);
      await fixture.cleanup();
    });

    it("2. Drilldown invokes the governed V2 orchestrator once per window attempt", async () => {
      const { fixture, traversal, leaseEpoch, assemblySha256 } = await createTestTraversalHelper("worker_drill_test");

      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET traversal_status = 'DRILLDOWN_IN_PROGRESS',
                current_phase = 'DRILLDOWN',
                active_window_ordinal = 2
          WHERE id = $1`,
        [traversal.id],
      );

      const batchId = randomUUID();
      await repo.insertCandidateBatch({
        id: batchId,
        traversalId: traversal.id,
        traversalAuthoritySha256: traversal.traversal_authority_sha256,
        batchOrdinal: 1,
        candidateCount: 1,
        tokenCount: 100,
        workerId: "worker_drill_test",
        leaseEpoch,
      });

      await repo.insertCandidateUnits(
        [
          {
            id: randomUUID(),
            batchId,
            traversalId: traversal.id,
            candidateOrdinal: 1,
            workspaceRegistrationId: realWEA.workspace_registration_id,
            workspaceRevisionId: realWEA.workspace_revision_id,
            acceptedWorkspaceEvidenceArtifactId: realWEA.id,
            sourceFileRevisionId: realStructuralRecord.source_file_revision_id,
            logicalUnitId: realStructuralRecord.logical_unit_id,
            status: "SELECTED",
          },
        ],
        "worker_drill_test",
        leaseEpoch,
      );

      let drilldownExecutionCount = 0;
      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async (req) => {
        drilldownExecutionCount++;
        const wsId = req.mapping_input?.source_bindings?.[0]?.workspace_id ?? "ws_1";
        const entryId = req.mapping_input?.entries?.[0]?.entry_id ?? "entry_1";
        const content = JSON.stringify(validModelAnalysis("DrilldownComponent", wsId, entryId));
        return {
          raw_model_content: content,
          response_model_id: "glm-4.7-flash",
          provider_request_id: "req-drill-1",
          usage_metadata: { total_tokens: 150 },
          rate_limit_metadata: {},
          raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
        };
      });

      const orchestrator = new AiContextMapperV2Orchestrator(
        v2Repo,
        mockPrimary,
        undefined,
        {
          providerConfigurationSnapshot: mockProviderSnapshot(false),
          standbyEnabled: false,
          standbyGovernanceQualified: false,
          assemblySha256,
          idempotencyKey: `test:drill:${randomUUID()}`,
          requestFingerprintSha256: mapperSha256({ test: "drill" }),
          primaryRequestTimeoutMs: 30000,
        },
      );

      const executor = new ContextMappingTraversalExecutor({
        workerId: "worker_drill_test",
        traversalRepo: repo,
        orchestrator,
      });
      (executor as any).currentEpoch = leaseEpoch;

      const traversalRow = await repo.getTraversalById(traversal.id);
      await (executor as any).executeDrilldownPhase(traversalRow!);

      expect(drilldownExecutionCount).toBe(1);
      await fixture.cleanup();
    });

    it("3. Reduction uses ReductionSynthesisAdapter/provider path", async () => {
      const { fixture, traversal, leaseEpoch } = await createTestTraversalHelper("worker_reduction_test");

      let reductionProviderInvoked = false;
      let receivedSystemPrompt = "";

      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async req => {
        reductionProviderInvoked = true;
        receivedSystemPrompt = req.system_prompt;
        const content = JSON.stringify(validModelAnalysis("ReducedRootComponent"));
        return {
          raw_model_content: content,
          response_model_id: "glm-4.7-flash",
          provider_request_id: "req-reduction-1",
          usage_metadata: { total_tokens: 200 },
          rate_limit_metadata: {},
          raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
        };
      });

      const adapter = new ReductionSynthesisAdapter(mockPrimary, undefined, {
        providerConfigurationSnapshot: mockProviderSnapshot(false),
      });

      const childAnalysis = validModelAnalysis("ChildForReduction");
      const result = await adapter.synthesizeReductionWindow(
        {
          traversalId: traversal.id,
          traversalAuthoritySha256: traversal.traversal_authority_sha256,
          reductionLevel: 1,
          reductionOrdinal: 1,
          childItems: [
            {
              sourceId: "win_child_1",
              sourceType: "MAPPING_WINDOW",
              sourceOutputSha256: mapperSha256(childAnalysis),
              payload: childAnalysis,
            },
          ],
        },
        repo,
        "worker_reduction_test",
        leaseEpoch,
      );

      expect(reductionProviderInvoked).toBe(true);
      expect(receivedSystemPrompt).toContain("Hierarchical Reduction Synthesis");
      expect(result.parentAnalysis.components[0].display_name).toBe("ReducedRootComponent");
      await fixture.cleanup();
    });

    it("4. Invalid provider output fails schema validation", async () => {
      const { fixture, traversal, leaseEpoch } = await createTestTraversalHelper("worker_schema_test");

      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async () => {
        const invalidContent = JSON.stringify({
          corrupted_field: "not_a_valid_model_context_analysis_v2",
        });
        return {
          raw_model_content: invalidContent,
          response_model_id: "glm-4.7-flash",
          provider_request_id: "req-invalid",
          usage_metadata: { total_tokens: 50 },
          rate_limit_metadata: {},
          raw_provider_body: "{}",
        };
      });

      const adapter = new ReductionSynthesisAdapter(mockPrimary, undefined, {
        providerConfigurationSnapshot: mockProviderSnapshot(false),
      });

      const childAnalysis = validModelAnalysis("Child");
      await expect(
        adapter.synthesizeReductionWindow(
          {
            traversalId: traversal.id,
            traversalAuthoritySha256: traversal.traversal_authority_sha256,
            reductionLevel: 1,
            reductionOrdinal: 1,
            childItems: [
              {
                sourceId: "win_1",
                sourceType: "MAPPING_WINDOW",
                sourceOutputSha256: mapperSha256(childAnalysis),
                payload: childAnalysis,
              },
            ],
          },
          repo,
          "worker_schema_test",
          leaseEpoch,
        ),
      ).rejects.toThrow(/REDUCTION_SCHEMA_INVALID/);

      await fixture.cleanup();
    });

    it("5. Provider failure follows governed failure/failover behavior", async () => {
      const { fixture, traversal, leaseEpoch } = await createTestTraversalHelper("worker_failover_test");

      let primaryAttempted = false;
      let standbyAttempted = false;

      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async () => {
        primaryAttempted = true;
        throw new ProviderTechnicalError(
          "PRIMARY_PROVIDER_UNAVAILABLE",
          "Simulated primary 503 gateway timeout",
          false,
          true,
          503,
        );
      });

      const mockStandby = createMockAdapter("sambanova", "gpt-oss-120b", async () => {
        standbyAttempted = true;
        const content = JSON.stringify(validModelAnalysis("FailoverComponent"));
        return {
          raw_model_content: content,
          response_model_id: "gpt-oss-120b",
          provider_request_id: "req-standby-1",
          usage_metadata: { total_tokens: 180 },
          rate_limit_metadata: {},
          raw_provider_body: JSON.stringify({ choices: [{ message: { content } }] }),
        };
      });

      const adapter = new ReductionSynthesisAdapter(mockPrimary, mockStandby, {
        providerConfigurationSnapshot: mockProviderSnapshot(true),
        standbyEnabled: true,
        standbyGovernanceQualified: true,
      });

      const childAnalysis = validModelAnalysis("Child");
      const result = await adapter.synthesizeReductionWindow(
        {
          traversalId: traversal.id,
          traversalAuthoritySha256: traversal.traversal_authority_sha256,
          reductionLevel: 1,
          reductionOrdinal: 1,
          childItems: [
            {
              sourceId: "win_1",
              sourceType: "MAPPING_WINDOW",
              sourceOutputSha256: mapperSha256(childAnalysis),
              payload: childAnalysis,
            },
          ],
        },
        repo,
        "worker_failover_test",
        leaseEpoch,
      );

      expect(primaryAttempted).toBe(true);
      expect(standbyAttempted).toBe(true);
      expect(result.parentAnalysis.components[0].display_name).toBe("FailoverComponent");
      await fixture.cleanup();
    });

    it("6. Source authority drift prevents a new AI call", async () => {
      const { fixture, traversal, leaseEpoch } = await createTestTraversalHelper("worker_drift_test");

      let providerCalled = false;
      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash", async () => {
        providerCalled = true;
        return {
          raw_model_content: JSON.stringify(validModelAnalysis()),
          response_model_id: "glm-4.7-flash",
          provider_request_id: "req-drift",
          usage_metadata: { total_tokens: 100 },
          rate_limit_metadata: {},
          raw_provider_body: "{}",
        };
      });

      const adapter = new ReductionSynthesisAdapter(mockPrimary, undefined, {
        providerConfigurationSnapshot: mockProviderSnapshot(false),
      });

      const childAnalysis = validModelAnalysis("Child");

      await expect(
        adapter.synthesizeReductionWindow(
          {
            traversalId: traversal.id,
            traversalAuthoritySha256: "sha256:drifted_bogus_sha_000000000000000000000000000000000000000000000000",
            reductionLevel: 1,
            reductionOrdinal: 1,
            childItems: [
              {
                sourceId: "win_1",
                sourceType: "MAPPING_WINDOW",
                sourceOutputSha256: mapperSha256(childAnalysis),
                payload: childAnalysis,
              },
            ],
          },
          repo,
          "worker_drift_test",
          leaseEpoch,
        ),
      ).rejects.toThrow(/AUTHORITY_VIOLATION/);

      expect(providerCalled).toBe(false);
      await fixture.cleanup();
    });

    it("7. Worker A provider result cannot commit after lease loss/reclaim", async () => {
      const { fixture, traversal } = await createTestTraversalHelper("worker_lease_base");

      const workerA = "worker_A";
      const workerB = "worker_B";

      // Expire previous lease and let Worker A claim
      await databasePool().query(
        "UPDATE intentchord.context_mapping_traversals SET executor_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [traversal.id],
      );
      const leaseA = await repo.claimOrRenewLease(traversal.id, workerA, 30000);
      expect(leaseA.acquired).toBe(true);

      // Force lease expiration in DB to simulate reclaim by Worker B
      await databasePool().query(
        "UPDATE intentchord.context_mapping_traversals SET executor_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [traversal.id],
      );
      const leaseB = await repo.claimOrRenewLease(traversal.id, workerB, 30000);
      expect(leaseB.acquired).toBe(true);
      expect(leaseB.leaseEpoch).toBeGreaterThan(leaseA.leaseEpoch);

      // Worker A attempts to commit with stale epoch
      const batchId = randomUUID();
      await expect(
        repo.insertCandidateBatch({
          id: batchId,
          traversalId: traversal.id,
          traversalAuthoritySha256: traversal.traversal_authority_sha256,
          batchOrdinal: 99,
          candidateCount: 1,
          tokenCount: 100,
          workerId: workerA,
          leaseEpoch: leaseA.leaseEpoch,
        }),
      ).rejects.toThrow(StaleExecutorLeaseError);

      await fixture.cleanup();
    });

    it("8. Non-empty AI execution produces non-zero provider-neutral token accounting", async () => {
      const { fixture, traversal, leaseEpoch } = await createTestTraversalHelper("worker_token_acc_test");

      const mockPrimary = createMockAdapter("zai", "glm-4.7-flash");
      const adapter = new ReductionSynthesisAdapter(mockPrimary, undefined, {
        providerConfigurationSnapshot: mockProviderSnapshot(false),
      });

      const childAnalysis = validModelAnalysis("TokenAccTest");
      const result = await adapter.synthesizeReductionWindow(
        {
          traversalId: traversal.id,
          traversalAuthoritySha256: traversal.traversal_authority_sha256,
          reductionLevel: 1,
          reductionOrdinal: 1,
          childItems: [
            {
              sourceId: "win_tok_1",
              sourceType: "MAPPING_WINDOW",
              sourceOutputSha256: mapperSha256(childAnalysis),
              payload: childAnalysis,
            },
          ],
        },
        repo,
        "worker_token_acc_test",
        leaseEpoch,
      );

      expect(result.inputEstimatedTokens).toBeGreaterThan(0);
      expect(result.outputEstimatedTokens).toBeGreaterThan(0);
      expect(result.inputEstimatedTokens).toBeGreaterThan(result.outputEstimatedTokens);

      await fixture.cleanup();
    });
  });

  describe("PART 3: FROZEN TOKEN BUDGET EQUATION VALIDATION (BLOCKER 2)", () => {
    it("proves exact mathematical derivation conforming to frozen contract", () => {
      const details = getGovernedTokenBudgetDetails();

      // Total budget
      expect(details.governedTotalBudget).toBeGreaterThan(0);
      // Reserves
      expect(details.responseReserve).toBe(GOVERNED_RESPONSE_RESERVE_TOKENS);
      expect(details.protocolOverhead).toBe(GOVERNED_PROTOCOL_OVERHEAD_TOKENS);
      expect(details.systemPromptReserve).toBeGreaterThan(500);

      // Usable budget = total - (systemPrompt + response + protocol)
      const expectedUsable =
        details.governedTotalBudget -
        (details.systemPromptReserve + details.responseReserve + details.protocolOverhead);

      expect(details.effectiveTopologyInputBudget).toBe(expectedUsable);
      expect(details.effectiveDrilldownInputBudget).toBe(expectedUsable);
      expect(details.effectiveReductionInputBudget).toBe(expectedUsable);
      expect(details.windowBudgetDerivationConformsToFrozenContract).toBe(true);
    });
  });
});
