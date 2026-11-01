import { beforeAll, afterAll, describe, expect, it } from "vitest";
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
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import {
  PostgresContextMappingTraversalRepository,
  computeTraversalAuthoritySha256,
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import {
  buildNextTopologyWindow,
  DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET,
} from "@/server/context/topology-window-builder";
import {
  buildNextDrilldownWindow,
  type DrilldownCandidateUnit,
} from "@/server/context/selective-drilldown-builder";
import {
  executeHierarchicalReduction,
  mergeAnalysisPayloads,
  type ReductionSourceItem,
} from "@/server/context/hierarchical-context-synthesizer";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import { readTaskContextClosure } from "@/server/context-closure-service";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";

describe("INTENTCHORD_MULTI_WINDOW_AND_NO_TRUNCATION_TESTS", () => {
  const traversalRepo = new PostgresContextMappingTraversalRepository();
  const evidenceRepo = new PostgresWorkspaceEvidenceRepository();
  let baseAuthority: FrozenAuthorityTuple;
  let traversalId: string;
  let taskId: string;
  let fixtureCleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const weaRes = await databasePool().query<{
      id: string;
      workspace_registration_id: string;
      workspace_revision_id: string;
      index_configuration_sha256: string;
      artifact_semantic_sha256: string;
    }>(
      `SELECT id, workspace_registration_id, workspace_revision_id, index_configuration_sha256, artifact_semantic_sha256
         FROM intentchord.workspace_evidence_artifacts
        LIMIT 1`,
    );
    const wea = weaRes.rows[0];

    const snapRes = await databasePool().query<{ id: string }>(
      `SELECT id FROM intentchord.workspace_index_snapshots
        WHERE accepted_workspace_evidence_artifact_id = $1 AND status = 'READY'
        LIMIT 1`,
      [wea.id],
    );
    const snap = snapRes.rows[0];

    const obsRes = await databasePool().query<{ id: string; authority_sequence: string }>(
      `SELECT id, authority_sequence FROM intentchord.workspace_observations
        WHERE workspace_registration_id = $1
        ORDER BY authority_sequence ASC LIMIT 1`,
      [wea.workspace_registration_id],
    );
    const obs = obsRes.rows[0];

    const fixture = await createIsolatedTestContextAssembly({
      workspaceRegistrationId: wea.workspace_registration_id,
      workspaceRevisionId: wea.workspace_revision_id,
      workspaceObservationId: obs.id,
      authoritySequence: Number(obs.authority_sequence),
      workspaceIndexSnapshotId: snap.id,
      acceptedWorkspaceEvidenceArtifactId: wea.id,
      workspaceIndexSha256: wea.index_configuration_sha256,
      artifactSemanticSha256: wea.artifact_semantic_sha256,
    });
    taskId = fixture.testTaskId;
    fixtureCleanup = fixture.cleanup;

    baseAuthority = {
      context_assembly_revision_id: fixture.testRevisionId,
      workspace_registration_id: wea.workspace_registration_id,
      workspace_revision_id: wea.workspace_revision_id,
      workspace_index_snapshot_id: snap.id,
      accepted_workspace_evidence_artifact_id: wea.id,
      artifact_semantic_sha256: wea.artifact_semantic_sha256,
      workspace_observation_id: obs.id,
      authority_sequence: Number(obs.authority_sequence),
      index_configuration_sha256: wea.index_configuration_sha256,
    };

    const secRes = await databasePool().query<{ id: string; section_schema_version: string }>(
      `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
        LIMIT 1`,
      [wea.id],
    );
    expect(secRes.rows.length).toBeGreaterThan(0);
    const semanticSectionId = Number(secRes.rows[0].id);
    const semanticSchemaVersion = secRes.rows[0].section_schema_version;

    // Clean prior test traversals for this isolated test revision only
    await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE context_assembly_revision_id = $1", [baseAuthority.context_assembly_revision_id]);

    const created = await traversalRepo.createTraversal(baseAuthority, {
      cursor_artifact_id: baseAuthority.accepted_workspace_evidence_artifact_id,
      cursor_section_id: semanticSectionId,
      cursor_section_type: "SEMANTIC_PROJECTION",
      cursor_section_schema_version: semanticSchemaVersion,
      cursor_record_seq: 0,
    });
    traversalId = created.id;
  });

  afterAll(async () => {
    if (traversalId) {
      await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE id = $1", [traversalId]);
    }
    if (fixtureCleanup) {
      await fixtureCleanup();
    }
  });

  describe("A. BACKEND AUTHORITY & OBSERVATIONAL READS", () => {
    it("repeated readTaskContextClosure 20 times performs ZERO traversal advancement", async () => {
      const initial = await readTaskContextClosure(taskId);
      const initialSeq = initial.traversal?.activeWindowOrdinal ?? 1;

      for (let i = 0; i < 20; i++) {
        const view = await readTaskContextClosure(taskId);
        expect(view.traversal?.activeWindowOrdinal ?? 1).toBe(initialSeq);
      }

      const post20 = await readTaskContextClosure(taskId);
      expect(post20.traversal?.activeWindowOrdinal ?? 1).toBe(initialSeq);
    }, 60000);
  });

  describe("B. MULTI-WINDOW TOPOLOGY & NO TRUNCATION", () => {
    it("splits evidence across multiple bounded windows without terminal aggregate 413", async () => {
      // Use small token budget to force window creation
      const window1 = await buildNextTopologyWindow({
        evidenceRepo,
        artifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        traversalId,
        traversalAuthoritySha256: computeTraversalAuthoritySha256(baseAuthority),
        windowOrdinal: 1,
        startCursorRecordSeq: 0,
        tokenBudget: 3_000,
      });

      expect(window1).not.toBeNull();
      expect(window1!.entries.length).toBeGreaterThan(0);
      expect(window1!.tokenCount).toBeLessThanOrEqual(DEFAULT_TOPOLOGY_WINDOW_TOKEN_BUDGET);

      if (window1!.hasMore) {
        const window2 = await buildNextTopologyWindow({
          evidenceRepo,
          artifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
          traversalId,
          traversalAuthoritySha256: computeTraversalAuthoritySha256(baseAuthority),
          windowOrdinal: 2,
          startCursorRecordSeq: window1!.endCursorRecordSeq,
          tokenBudget: 3_000,
        });

        expect(window2).not.toBeNull();
        expect(window2!.windowOrdinal).toBe(2);
        // Verify no overlapping or duplicate records across window boundary
        expect(window2!.startCursorRecordSeq).toBe(window1!.endCursorRecordSeq);
        const win1Ids = new Set(window1!.entries.map(e => e.entry_id));
        const win2Ids = new Set(window2!.entries.map(e => e.entry_id));
        for (const id of win2Ids) {
          expect(win1Ids.has(id)).toBe(false);
        }
      }
    });

    it("processes candidates in bounded drilldown windows without arbitrary truncation (>256 candidates)", async () => {
      const candidates: DrilldownCandidateUnit[] = Array.from({ length: 300 }, (_, i) => ({
        id: `cand_${i}`,
        logical_unit_id: `unit_${i}`,
        source_file_revision_id: `rev_${i}`,
        candidate_ordinal: i + 1,
      }));

      const window1 = await buildNextDrilldownWindow({
        evidenceRepo,
        artifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        traversalId,
        traversalAuthoritySha256: computeTraversalAuthoritySha256(baseAuthority),
        windowOrdinal: 1,
        candidates,
        tokenBudget: 1_000, // Small budget to trigger multi-window
      });

      expect(window1).not.toBeNull();
      // Verify all candidates remain accounted for
      const totalProcessedAndRemaining = window1!.processedCandidateIds.length + window1!.remainingCandidates.length;
      expect(totalProcessedAndRemaining).toBe(300);
    });

    it("retains all components (>50) and relations (>100) across hierarchical reduction", async () => {
      // Synthesize 60 components and 120 relations across 3 mock mapping windows
      const mockItems: Array<ReductionSourceItem["payload"]> = [
        {
          catalog_summary: "Window 1",
          components: Array.from({ length: 25 }, (_, i) => ({
            component_id: `comp_${i}`,
            display_name: `Component ${i}`,
            context_kind: "module",
            summary: `Summary ${i}`,
            responsibilities: [`Resp ${i}`],
            workspace_ids: ["ws_1"],
            evidence_entry_ids: [`ev_${i}`],
            interfaces: [],
            unknowns: [],
            confidence: "high",
            rationale: "r",
          })),
          relationships: Array.from({ length: 45 }, (_, i) => ({
            relationship_id: `rel_${i}`,
            from_component_id: `comp_${i % 25}`,
            to_component_id: `comp_${(i + 1) % 25}`,
            relationship_type: i < 25 ? "calls" : "contains",
            evidence_entry_ids: [`ev_${i}`],
            confidence: "high",
            rationale: "r",
          })),
        },
        {
          catalog_summary: "Window 2",
          components: Array.from({ length: 35 }, (_, i) => ({
            component_id: `comp_${i + 25}`,
            display_name: `Component ${i + 25}`,
            context_kind: "service",
            summary: `Summary ${i + 25}`,
            responsibilities: [`Resp ${i + 25}`],
            workspace_ids: ["ws_1"],
            evidence_entry_ids: [`ev_${i + 25}`],
            interfaces: [],
            unknowns: [],
            confidence: "high",
            rationale: "r",
          })),
          relationships: Array.from({ length: 75 }, (_, i) => ({
            relationship_id: `rel_${i + 45}`,
            from_component_id: `comp_${(i + 25) % 60}`,
            to_component_id: `comp_${(i + 26) % 60}`,
            relationship_type: i < 60 ? "depends_on" : "implements",
            evidence_entry_ids: [`ev_${i + 45}`],
            confidence: "high",
            rationale: "r",
          })),
        },
      ];

      const merged = mergeAnalysisPayloads(mockItems);
      // Verify no arbitrary caps: 60 components (>50) and 120 relations (>100) are fully preserved
      expect(merged.components.length).toBe(60);
      expect(merged.relationships.length).toBe(120);
    });
  });
});
