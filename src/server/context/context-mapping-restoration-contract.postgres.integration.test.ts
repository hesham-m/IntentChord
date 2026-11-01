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
  getGovernedTokenBudgetDetails,
  getGovernedTopologyWindowTokenBudget,
  getGovernedDrilldownWindowTokenBudget,
  getGovernedReductionWindowTokenBudget,
  getGovernedSystemPromptEstimatedTokens,
  getGovernedUsableInputBudget,
} from "@/server/context/governed-token-budget";
import {
  MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS,
  MAX_MODEL_OUTPUT_ESTIMATED_TOKENS,
} from "@/core/ai-context-mapper/types";
import { structuralPartToTopologyInputEntry } from "@/server/v2-semantic-projection-reader";
import {
  chunkSourcesByTokenBudget,
  type ReductionSourceItem,
} from "@/server/context/hierarchical-context-synthesizer";
import {
  PostgresContextMappingTraversalRepository,
  computeTraversalAuthoritySha256,
} from "@/server/context-mapping-traversal-repository";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";
import type { ModelContextAnalysisV2 } from "@/core/ai-context-mapper/v2";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";

describe("INTENTCHORD_MULTI_WINDOW_CONTRACT_RESTORATION_SUITE", () => {
  const repo = new PostgresContextMappingTraversalRepository();
  let realWEA: any;
  let realSnap: any;
  let realObs: any;
  let realStructuralRecord: any;
  let realSec: any;

  beforeAll(async () => {
    // Query real coherent WEA, snapshot, observation, and structural record from DB
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

    const recRes = await databasePool().query(
      `SELECT source_file_revision_id, (record_json->>'logical_unit_id') as logical_unit_id
         FROM intentchord.workspace_evidence_section_records
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
          AND (record_json->>'logical_unit_id') IS NOT NULL
        LIMIT 1`,
      [realWEA.id],
    );
    realStructuralRecord = recRes.rows[0];

    const secRes = await databasePool().query<{ id: number; section_schema_version: string }>(
      `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
        LIMIT 1`,
      [realWEA.id],
    );
    realSec = secRes.rows[0];
  });

  describe("1. GOVERNED TOKEN BUDGET DERIVATION (DEFECT 2)", () => {
    it("derives all window token budgets from canonical MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS", () => {
      const details = getGovernedTokenBudgetDetails();
      expect(details.maxIndexPayloadTokens).toBe(MAX_INDEX_PAYLOAD_ESTIMATED_TOKENS);
      expect(details.maxModelOutputTokens).toBe(MAX_MODEL_OUTPUT_ESTIMATED_TOKENS);
      expect(details.systemPromptEstimatedTokens).toBeGreaterThan(500);
      const usable = getGovernedUsableInputBudget();
      expect(getGovernedTopologyWindowTokenBudget()).toBe(usable);
      expect(getGovernedDrilldownWindowTokenBudget()).toBe(usable);
      expect(getGovernedReductionWindowTokenBudget()).toBe(usable);
    });

    it("correctly estimates system prompt tokens dynamically", () => {
      const promptTokens = getGovernedSystemPromptEstimatedTokens();
      expect(promptTokens).toBeGreaterThan(500);
      expect(promptTokens).toBeLessThan(5000);
    });
  });

  describe("2. TOPOLOGY LIGHTWEIGHT PROJECTION (DEFECT 3)", () => {
    it("emits compact unit descriptors instead of full symbol/relation expansions", () => {
      const fakeHeader = {
        record_kind: "FILE_PROJECTION_HEADER" as const,
        record_id: "rec_header_1",
        workspace_id: "ws_1",
        source_file_revision_id: "rev_file_1",
        normalized_path: "src/example/module.ts",
        language_or_format: "typescript",
        size_bytes: 4096,
        content_or_metadata_fingerprint: "fp_example",
        file_kind: "SOURCE_CODE" as const,
        parse_status: "SUPPORTED" as const,
        coverage_state: "FULL" as const,
      };

      const fakeEntry = {
        record_id: "rec_1",
        workspace_id: "ws_1",
        logical_unit_id: "unit_101",
        unit_kind: "class",
        unit_label: "ExampleClass",
        parent_file_revision_id: "rev_file_1",
        projection_signals: {
          symbols: [
            { local_name: "sym1", kind: "method", fact_ref: "ref1" },
            { local_name: "sym2", kind: "method", fact_ref: "ref2" },
            { local_name: "sym3", kind: "method", fact_ref: "ref3" },
          ],
          relations: [
            { relation_type: "CALLS", direction: "DIRECTED", target_entity_id: "target1" },
            { relation_type: "IMPLEMENTS", direction: "DIRECTED", target_entity_id: "target2" },
          ],
        },
      };

      const topologyEntry = structuralPartToTopologyInputEntry(fakeHeader, fakeEntry as any);

      // Must NOT expand symbols into separate fact signals
      expect(topologyEntry.index_supported_signals.fact_signals.length).toBe(1);
      const fact = topologyEntry.index_supported_signals.fact_signals[0];
      expect(fact.fact_type).toBe("LOGICAL_UNIT_DESCRIPTOR");
      expect(fact.attributes.symbol_count).toBe(3);
      expect(fact.attributes.relation_count).toBe(2);
      expect(fact.attributes.logical_unit_id).toBe("unit_101");

      // Must NOT expand relations into relation signals in topology mode
      expect(topologyEntry.index_supported_signals.relation_signals.length).toBe(0);
    });
  });

  describe("3. TOKEN-BOUNDED REDUCTION CHUNKING (DEFECT 4)", () => {
    it("chunks reduction inputs by token budget rather than fixed count", () => {
      const samplePayload: ModelContextAnalysisV2 = {
        schema_version: "intentchord.model-context-analysis.v2",
        analysis_outcome: "ANALYSIS_FINDINGS_NO_KNOWN_BLOCKING_GAP",
        catalog_summary: "Test summary",
        components: [{
          component_id: "c1",
          display_name: "Comp 1",
          context_kind: "module",
          summary: "Summary of component 1",
          responsibilities: ["Does task A"],
          workspace_ids: ["ws1"],
          evidence_entry_ids: ["e1"],
          interfaces: [],
          unknowns: [],
          confidence: "high",
          rationale: "Rationale 1",
        }],
        relationships: [],
        missing_evidence_requests: [],
        material_contradictions: [],
        global_unknowns: [],
        warnings: [],
      };

      const sources: ReductionSourceItem[] = Array.from({ length: 25 }, (_, i) => ({
        sourceType: "MAPPING_WINDOW",
        sourceId: `win_${i}`,
        sourceOutputSha256: `sha256:source_${i}`,
        payload: {
          ...samplePayload,
          catalog_summary: `Summary for window ${i} with extra text to consume tokens ${"x".repeat(200)}`,
        },
      }));

      // Set a small token budget that forces multiple chunks
      const smallBudget = 500;
      const chunks = chunkSourcesByTokenBudget(sources, smallBudget);

      // Should produce more chunks than 10-count fixed division would
      expect(chunks.length).toBeGreaterThan(2);
      // All sources accounted for
      const totalItems = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalItems).toBe(25);
    });
  });

  describe("4. CANDIDATE COHERENCE GUARD TRIGGER ENFORCEMENT (DEFECT 5)", () => {
    let fixtureCleanup: (() => Promise<void>) | null = null;
    let testTraversalId: string;
    let testAuthority: any;
    let testLeaseEpoch: number;

    beforeAll(async () => {
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
      fixtureCleanup = fixture.cleanup;

      testAuthority = {
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

      const traversal = await repo.createTraversal(testAuthority, {
        cursor_artifact_id: realWEA.id,
        cursor_section_id: realSec.id,
        cursor_section_type: "SEMANTIC_PROJECTION",
        cursor_section_schema_version: realSec.section_schema_version,
        cursor_record_seq: 0,
      });
      testTraversalId = traversal.id;

      const lease = await repo.claimOrRenewLease(testTraversalId, "test_worker", 30000);
      expect(lease.acquired).toBe(true);
      testLeaseEpoch = lease.leaseEpoch;
    });

    afterAll(async () => {
      if (fixtureCleanup) await fixtureCleanup();
    });

    it("rejects candidate unit when logical_unit_id exists but source_file_revision_id is bogus", async () => {
      const batchId = randomUUID();
      await repo.insertCandidateBatch({
        id: batchId,
        traversalId: testTraversalId,
        traversalAuthoritySha256: computeTraversalAuthoritySha256(testAuthority),
        batchOrdinal: 1,
        candidateCount: 1,
        tokenCount: 100,
        workerId: "test_worker",
        leaseEpoch: testLeaseEpoch,
      });

      // Valid logical unit, but mismatched bogus source file revision
      const candidateUnits = [{
        id: randomUUID(),
        batchId,
        traversalId: testTraversalId,
        candidateOrdinal: 1,
        workspaceRegistrationId: testAuthority.workspace_registration_id,
        workspaceRevisionId: testAuthority.workspace_revision_id,
        acceptedWorkspaceEvidenceArtifactId: realWEA.id,
        sourceFileRevisionId: "rev_bogus_mismatched_file_12345",
        logicalUnitId: realStructuralRecord.logical_unit_id,
        status: "SELECTED" as const,
      }];

      await expect(
        repo.insertCandidateUnits(candidateUnits, "test_worker", testLeaseEpoch),
      ).rejects.toThrow(/INTENTCHORD_CANDIDATE_SOURCE_IDENTITY_NOT_FOUND_IN_WEA/);
    });

    it("rejects candidate unit when source_file_revision_id exists but logical_unit_id is bogus", async () => {
      const batchId = randomUUID();
      await repo.insertCandidateBatch({
        id: batchId,
        traversalId: testTraversalId,
        traversalAuthoritySha256: computeTraversalAuthoritySha256(testAuthority),
        batchOrdinal: 2,
        candidateCount: 1,
        tokenCount: 100,
        workerId: "test_worker",
        leaseEpoch: testLeaseEpoch,
      });

      // Valid source file, but mismatched bogus logical unit
      const candidateUnits = [{
        id: randomUUID(),
        batchId,
        traversalId: testTraversalId,
        candidateOrdinal: 1,
        workspaceRegistrationId: testAuthority.workspace_registration_id,
        workspaceRevisionId: testAuthority.workspace_revision_id,
        acceptedWorkspaceEvidenceArtifactId: realWEA.id,
        sourceFileRevisionId: realStructuralRecord.source_file_revision_id,
        logicalUnitId: "luid_bogus_fabricated_99999",
        status: "SELECTED" as const,
      }];

      await expect(
        repo.insertCandidateUnits(candidateUnits, "test_worker", testLeaseEpoch),
      ).rejects.toThrow(/INTENTCHORD_CANDIDATE_SOURCE_IDENTITY_NOT_FOUND_IN_WEA/);
    });

    it("accepts candidate unit when logical_unit_id and source_file_revision_id cohere on the same record", async () => {
      const batchId = randomUUID();
      await repo.insertCandidateBatch({
        id: batchId,
        traversalId: testTraversalId,
        traversalAuthoritySha256: computeTraversalAuthoritySha256(testAuthority),
        batchOrdinal: 3,
        candidateCount: 1,
        tokenCount: 100,
        workerId: "test_worker",
        leaseEpoch: testLeaseEpoch,
      });

      // Coherent pair from the exact same record
      const candidateUnits = [{
        id: randomUUID(),
        batchId,
        traversalId: testTraversalId,
        candidateOrdinal: 1,
        workspaceRegistrationId: testAuthority.workspace_registration_id,
        workspaceRevisionId: testAuthority.workspace_revision_id,
        acceptedWorkspaceEvidenceArtifactId: realWEA.id,
        sourceFileRevisionId: realStructuralRecord.source_file_revision_id,
        logicalUnitId: realStructuralRecord.logical_unit_id,
        status: "SELECTED" as const,
      }];

      await expect(
        repo.insertCandidateUnits(candidateUnits, "test_worker", testLeaseEpoch),
      ).resolves.not.toThrow();
    });
  });

  describe("5. TEST ISOLATION & ROW PRESERVATION REGRESSION (DEFECT 6)", () => {
    it("proves that test fixture lifecycle does NOT delete pre-existing traversal rows", async () => {
      // Create pre-existing sentinel traversal row under dedicated assembly
      const sentinelFixture = await createIsolatedTestContextAssembly({
        workspaceRegistrationId: realWEA.workspace_registration_id,
        workspaceRevisionId: realWEA.workspace_revision_id,
        workspaceObservationId: realObs.id,
        authoritySequence: Number(realObs.authority_sequence),
        workspaceIndexSnapshotId: realSnap.id,
        acceptedWorkspaceEvidenceArtifactId: realWEA.id,
        workspaceIndexSha256: realWEA.artifact_semantic_sha256,
        artifactSemanticSha256: realWEA.artifact_semantic_sha256,
      });

      const sentinelAuthority = {
        context_assembly_revision_id: sentinelFixture.testRevisionId,
        workspace_registration_id: realWEA.workspace_registration_id,
        workspace_revision_id: realWEA.workspace_revision_id,
        workspace_index_snapshot_id: realSnap.id,
        accepted_workspace_evidence_artifact_id: realWEA.id,
        artifact_semantic_sha256: realWEA.artifact_semantic_sha256,
        workspace_observation_id: realObs.id,
        authority_sequence: Number(realObs.authority_sequence),
        index_configuration_sha256: realWEA.index_configuration_sha256,
      };

      const sentinelTraversal = await repo.createTraversal(sentinelAuthority, {
        cursor_artifact_id: realWEA.id,
        cursor_section_id: realSec.id,
        cursor_section_type: "SEMANTIC_PROJECTION",
        cursor_section_schema_version: realSec.section_schema_version,
        cursor_record_seq: 0,
      });

      // Now run another test fixture lifecycle (create + teardown)
      const testFixture = await createIsolatedTestContextAssembly({
        workspaceRegistrationId: realWEA.workspace_registration_id,
        workspaceRevisionId: realWEA.workspace_revision_id,
        workspaceObservationId: realObs.id,
        authoritySequence: Number(realObs.authority_sequence),
        workspaceIndexSnapshotId: realSnap.id,
        acceptedWorkspaceEvidenceArtifactId: realWEA.id,
        workspaceIndexSha256: realWEA.artifact_semantic_sha256,
        artifactSemanticSha256: realWEA.artifact_semantic_sha256,
      });

      const testAuth = {
        context_assembly_revision_id: testFixture.testRevisionId,
        workspace_registration_id: realWEA.workspace_registration_id,
        workspace_revision_id: realWEA.workspace_revision_id,
        workspace_index_snapshot_id: realSnap.id,
        accepted_workspace_evidence_artifact_id: realWEA.id,
        artifact_semantic_sha256: realWEA.artifact_semantic_sha256,
        workspace_observation_id: realObs.id,
        authority_sequence: Number(realObs.authority_sequence),
        index_configuration_sha256: realWEA.index_configuration_sha256,
      };

      await repo.createTraversal(testAuth, {
        cursor_artifact_id: realWEA.id,
        cursor_section_id: realSec.id,
        cursor_section_type: "SEMANTIC_PROJECTION",
        cursor_section_schema_version: realSec.section_schema_version,
        cursor_record_seq: 0,
      });

      // Teardown the test fixture
      await testFixture.cleanup();

      // Sentinel traversal row MUST still exist!
      const foundSentinel = await repo.getTraversalById(sentinelTraversal.id);
      expect(foundSentinel).not.toBeNull();
      expect(foundSentinel?.id).toBe(sentinelTraversal.id);

      // Clean sentinel
      await sentinelFixture.cleanup();
    });
  });

  describe("6. REDUCTION WINDOW INPUT/OUTPUT TOKEN SEPARATION (DEFECT 7)", () => {
    let fixtureCleanup: (() => Promise<void>) | null = null;
    let testTraversalId: string;
    let testAuthSha: string;
    let testLeaseEpoch: number;

    beforeAll(async () => {
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
      fixtureCleanup = fixture.cleanup;

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
      testAuthSha = computeTraversalAuthoritySha256(auth);

      const traversal = await repo.createTraversal(auth, {
        cursor_artifact_id: realWEA.id,
        cursor_section_id: realSec.id,
        cursor_section_type: "SEMANTIC_PROJECTION",
        cursor_section_schema_version: realSec.section_schema_version,
        cursor_record_seq: 0,
      });
      testTraversalId = traversal.id;

      const lease = await repo.claimOrRenewLease(testTraversalId, "test_worker", 30000);
      expect(lease.acquired).toBe(true);
      testLeaseEpoch = lease.leaseEpoch;
    });

    afterAll(async () => {
      if (fixtureCleanup) await fixtureCleanup();
    });

    it("inserts reduction window with distinct input_estimated_tokens and output_estimated_tokens", async () => {
      const redWinId = randomUUID();
      await repo.insertReductionWindow({
        id: redWinId,
        traversalId: testTraversalId,
        traversalAuthoritySha256: testAuthSha,
        reductionLevel: 1,
        reductionOrdinal: 1,
        inputSetSha256: mapperSha256({ input: "test" }),
        inputItemCount: 3,
        inputEstimatedTokens: 4500,
        outputEstimatedTokens: 1200,
        status: "SUCCEEDED",
        outputSha256: mapperSha256({ output: "test" }),
        outputSummary: { test: "summary" },
        workerId: "test_worker",
        leaseEpoch: testLeaseEpoch,
      });

      const res = await databasePool().query<{
        input_estimated_tokens: number;
        output_estimated_tokens: number;
        token_count: number;
      }>(
        "SELECT input_estimated_tokens, output_estimated_tokens, token_count FROM intentchord.context_mapping_reduction_windows WHERE id = $1",
        [redWinId],
      );

      expect(res.rows.length).toBe(1);
      expect(res.rows[0].input_estimated_tokens).toBe(4500);
      expect(res.rows[0].output_estimated_tokens).toBe(1200);
      expect(res.rows[0].token_count).toBe(1200); // backwards compatible
    });
  });
});
