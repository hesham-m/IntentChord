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

import { databasePool, transaction } from "@/server/db";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";
import {
  PostgresContextMappingTraversalRepository,
  computeTraversalAuthoritySha256,
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";

describe("INTENTCHORD_TRAVERSAL_AUTHORITY_AND_LINEAGE_INTEGRITY", () => {
  const repo = new PostgresContextMappingTraversalRepository();
  let baseAuthority: FrozenAuthorityTuple;
  let traversalId: string;
  let traversalAuthoritySha256: string;
  let semanticSectionId: number;
  let semanticSchemaVersion: string;
  let fixtureCleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    // Query actual coherent authority records from intentchord_dev
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
    expect(weaRes.rows.length).toBeGreaterThan(0);
    const wea = weaRes.rows[0];

    const snapRes = await databasePool().query<{ id: string }>(
      `SELECT id FROM intentchord.workspace_index_snapshots
        WHERE accepted_workspace_evidence_artifact_id = $1 AND status = 'READY'
        LIMIT 1`,
      [wea.id],
    );
    expect(snapRes.rows.length).toBeGreaterThan(0);
    const snap = snapRes.rows[0];

    const obsRes = await databasePool().query<{ id: string; authority_sequence: string }>(
      `SELECT id, authority_sequence FROM intentchord.workspace_observations
        WHERE workspace_registration_id = $1
        ORDER BY authority_sequence ASC LIMIT 1`,
      [wea.workspace_registration_id],
    );
    expect(obsRes.rows.length).toBeGreaterThan(0);
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
    fixtureCleanup = fixture.cleanup;

    const secRes = await databasePool().query<{ id: string; section_schema_version: string }>(
      `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
        LIMIT 1`,
      [wea.id],
    );
    expect(secRes.rows.length).toBeGreaterThan(0);
    semanticSectionId = Number(secRes.rows[0].id);
    semanticSchemaVersion = secRes.rows[0].section_schema_version;

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

    traversalAuthoritySha256 = computeTraversalAuthoritySha256(baseAuthority);
  });

  afterAll(async () => {
    if (traversalId) {
      await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE id = $1", [traversalId]);
    }
    if (fixtureCleanup) {
      await fixtureCleanup();
    }
  });

  describe("D. FROZEN AUTHORITY GUARD & IMMUTABILITY", () => {
    it("rejects traversal creation with mixed/mismatched authority tuple", async () => {
      const invalidAuthority: FrozenAuthorityTuple = {
        ...baseAuthority,
        workspace_revision_id: "wsr_mismatched_revision",
      };

      await expect(
        repo.createTraversal(invalidAuthority, {
          cursor_artifact_id: baseAuthority.accepted_workspace_evidence_artifact_id,
          cursor_section_id: semanticSectionId,
          cursor_section_type: "SEMANTIC_PROJECTION",
          cursor_section_schema_version: semanticSchemaVersion,
          cursor_record_seq: 0,
        }),
      ).rejects.toThrow();
    });

    it("rejects traversal creation with wrong semantic hash", async () => {
      const invalidAuthority: FrozenAuthorityTuple = {
        ...baseAuthority,
        artifact_semantic_sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      };

      await expect(
        repo.createTraversal(invalidAuthority, {
          cursor_artifact_id: baseAuthority.accepted_workspace_evidence_artifact_id,
          cursor_section_id: semanticSectionId,
          cursor_section_type: "SEMANTIC_PROJECTION",
          cursor_section_schema_version: semanticSchemaVersion,
          cursor_record_seq: 0,
        }),
      ).rejects.toThrow();
    });

    it("rejects traversal with cross-WEA cursor_artifact_id", async () => {
      await expect(
        repo.createTraversal(baseAuthority, {
          cursor_artifact_id: "wea_cross_poisoning_attempt",
          cursor_section_id: semanticSectionId,
          cursor_section_type: "SEMANTIC_PROJECTION",
          cursor_section_schema_version: semanticSchemaVersion,
          cursor_record_seq: 0,
        }),
      ).rejects.toThrow();
    });

    it("rejects traversal with invalid cursor_section_id or wrong schema", async () => {
      await expect(
        repo.createTraversal(baseAuthority, {
          cursor_artifact_id: baseAuthority.accepted_workspace_evidence_artifact_id,
          cursor_section_id: 9999999,
          cursor_section_type: "SEMANTIC_PROJECTION",
          cursor_section_schema_version: semanticSchemaVersion,
          cursor_record_seq: 0,
        }),
      ).rejects.toThrow();
    });

    it("creates traversal when full authority tuple matches exactly", async () => {
      // Clean any existing traversal for this revision first
      await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE context_assembly_revision_id = $1", [baseAuthority.context_assembly_revision_id]);

      const traversal = await repo.createTraversal(baseAuthority, {
        cursor_artifact_id: baseAuthority.accepted_workspace_evidence_artifact_id,
        cursor_section_id: semanticSectionId,
        cursor_section_type: "SEMANTIC_PROJECTION",
        cursor_section_schema_version: semanticSchemaVersion,
        cursor_record_seq: 0,
      });

      expect(traversal.id).toBeDefined();
      expect(traversal.traversal_authority_sha256).toBe(traversalAuthoritySha256);
      expect(traversal.traversal_status).toBe("TOPOLOGY_IN_PROGRESS");
      traversalId = traversal.id;
    });

    it("rejects UPDATE of any frozen authority field on existing traversal (TRAVERSAL_FROZEN_AUTHORITY_IMMUTABLE)", async () => {
      expect(traversalId).toBeDefined();

      // 1. Attempt updating workspace_revision_id
      await expect(
        databasePool().query(
          "UPDATE intentchord.context_mapping_traversals SET workspace_revision_id = 'tampered' WHERE id = $1",
          [traversalId],
        ),
      ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_FROZEN_AUTHORITY_IMMUTABLE/);

      // 2. Attempt updating artifact_semantic_sha256
      await expect(
        databasePool().query(
          "UPDATE intentchord.context_mapping_traversals SET artifact_semantic_sha256 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111' WHERE id = $1",
          [traversalId],
        ),
      ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_FROZEN_AUTHORITY_IMMUTABLE/);

      // 3. Attempt updating traversal_authority_sha256
      await expect(
        databasePool().query(
          "UPDATE intentchord.context_mapping_traversals SET traversal_authority_sha256 = 'sha256:2222222222222222222222222222222222222222222222222222222222222222' WHERE id = $1",
          [traversalId],
        ),
      ).rejects.toThrow(/INTENTCHORD_TRAVERSAL_FROZEN_AUTHORITY_IMMUTABLE/);
    });

    it("allows operational updates (status, counts, cursor, lease) without triggering immutability guard", async () => {
      const res = await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET topology_window_count = 1,
                cursor_record_seq = 42,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING topology_window_count, cursor_record_seq`,
        [traversalId],
      );
      expect(res.rows[0].topology_window_count).toBe(1);
      expect(Number(res.rows[0].cursor_record_seq)).toBe(42);
    });
  });

  describe("H. CANDIDATE NORMALIZATION", () => {
    it("persists candidates as normalized relational rows without JSONB authority array", async () => {
      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_owner = NULL, executor_lease_expires_at = NULL
          WHERE id = $1`,
        [traversalId],
      );
      const workerId = `worker_${randomUUID()}`;
      const lease = await repo.claimOrRenewLease(traversalId, workerId);
      expect(lease.acquired).toBe(true);

      const batchId = randomUUID();
      await repo.insertCandidateBatch({
        id: batchId,
        traversalId,
        traversalAuthoritySha256,
        batchOrdinal: 1,
        candidateCount: 505,
        tokenCount: 12000,
        workerId,
        leaseEpoch: lease.leaseEpoch,
      });

      // Query 505 real records from the accepted WEA SEMANTIC_PROJECTION section
      const realRecordsRes = await databasePool().query<{
        logical_unit_id: string;
        source_file_revision_id: string;
      }>(
        `SELECT (record_json->>'logical_unit_id') as logical_unit_id,
                source_file_revision_id
           FROM intentchord.workspace_evidence_section_records
          WHERE artifact_id = $1
            AND section_type = 'SEMANTIC_PROJECTION'
          LIMIT 505`,
        [baseAuthority.accepted_workspace_evidence_artifact_id],
      );
      expect(realRecordsRes.rows.length).toBe(505);

      // Insert 505 normalized candidate unit rows using real WEA-grounded identities
      const units = realRecordsRes.rows.map((row, i) => ({
        id: randomUUID(),
        batchId,
        traversalId,
        candidateOrdinal: i + 1,
        workspaceRegistrationId: baseAuthority.workspace_registration_id,
        workspaceRevisionId: baseAuthority.workspace_revision_id,
        acceptedWorkspaceEvidenceArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        sourceFileRevisionId: row.source_file_revision_id,
        logicalUnitId: row.logical_unit_id,
        status: "SELECTED" as const,
      }));

      await repo.insertCandidateUnits(units, workerId, lease.leaseEpoch);

      const persistedUnits = await repo.findSelectedCandidateUnits(traversalId);
      expect(persistedUnits.length).toBe(505);

      // Unique constraint on (traversal_id, logical_unit_id) rejects duplicate logical units
      await expect(
        repo.insertCandidateUnits(
          [
            {
              id: randomUUID(),
              batchId,
              traversalId,
              candidateOrdinal: 506,
              workspaceRegistrationId: baseAuthority.workspace_registration_id,
              workspaceRevisionId: baseAuthority.workspace_revision_id,
              acceptedWorkspaceEvidenceArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
              sourceFileRevisionId: realRecordsRes.rows[0].source_file_revision_id,
              logicalUnitId: realRecordsRes.rows[0].logical_unit_id, // duplicate
              status: "SELECTED",
            },
          ],
          workerId,
          lease.leaseEpoch,
        ),
      ).resolves.not.toThrow(); // ON CONFLICT DO NOTHING preserves uniqueness

      const countRes = await databasePool().query<{ count: string }>(
        "SELECT count(*)::text as count FROM intentchord.context_mapping_candidate_units WHERE traversal_id = $1",
        [traversalId],
      );
      expect(Number(countRes.rows[0].count)).toBe(505);
    });

    it("enforces Defect 3: rejects candidate unit with ungrounded source identity", async () => {
      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_owner = NULL, executor_lease_expires_at = NULL
          WHERE id = $1`,
        [traversalId],
      );
      const workerId = `worker_${randomUUID()}`;
      const lease = await repo.claimOrRenewLease(traversalId, workerId);
      expect(lease.acquired).toBe(true);
      const batchId = randomUUID();
      await repo.insertCandidateBatch({
        id: batchId,
        traversalId,
        traversalAuthoritySha256,
        batchOrdinal: 2,
        candidateCount: 1,
        tokenCount: 100,
        workerId,
        leaseEpoch: lease.leaseEpoch,
      });

      // Completely ungrounded logical unit and source file revision
      await expect(
        repo.insertCandidateUnits(
          [
            {
              id: randomUUID(),
              batchId,
              traversalId,
              candidateOrdinal: 1,
              workspaceRegistrationId: baseAuthority.workspace_registration_id,
              workspaceRevisionId: baseAuthority.workspace_revision_id,
              acceptedWorkspaceEvidenceArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
              sourceFileRevisionId: "rev_completely_fake_9999",
              logicalUnitId: "luid_completely_fake_9999",
              status: "SELECTED",
            },
          ],
          workerId,
          lease.leaseEpoch,
        ),
      ).rejects.toThrow(/INTENTCHORD_CANDIDATE_SOURCE_IDENTITY_NOT_FOUND_IN_WEA/);
    });

    it("enforces Defect 3: rejects candidate unit with mismatched traversal authority tuple", async () => {
      const batchRes = await databasePool().query(
        "SELECT id FROM intentchord.context_mapping_candidate_batches WHERE traversal_id = $1 LIMIT 1",
        [traversalId],
      );
      const batchId = batchRes.rows[0].id;

      // Tampered workspace_revision_id violating fk_candidate_unit_traversal_authority
      await expect(
        databasePool().query(
          `INSERT INTO intentchord.context_mapping_candidate_units (
            id, batch_id, traversal_id, candidate_ordinal,
            workspace_registration_id, workspace_revision_id,
            accepted_workspace_evidence_artifact_id,
            source_file_revision_id, logical_unit_id, status
          ) VALUES ($1, $2, $3, 999, $4, 'tampered_workspace_rev', $5, 'fake', 'fake', 'SELECTED')`,
          [
            randomUUID(),
            batchId,
            traversalId,
            baseAuthority.workspace_registration_id,
            baseAuthority.accepted_workspace_evidence_artifact_id,
          ],
        ),
      ).rejects.toThrow();
    });

    it("enforces Defect 2: rejects candidate unit processed in non-DRILLDOWN window or another traversal", async () => {
      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_owner = NULL, executor_lease_expires_at = NULL
          WHERE id = $1`,
        [traversalId],
      );
      const workerId = `worker_${randomUUID()}`;
      const lease = await repo.claimOrRenewLease(traversalId, workerId);
      expect(lease.acquired).toBe(true);

      // Create a TOPOLOGY window for this traversal
      const topWinId = randomUUID();
      await repo.insertEvidenceWindow({
        id: topWinId,
        traversalId,
        traversalAuthoritySha256,
        phase: "TOPOLOGY",
        windowOrdinal: 999,
        cursorArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        cursorSectionId: semanticSectionId,
        cursorSectionType: "SEMANTIC_PROJECTION",
        cursorSectionSchemaVersion: semanticSchemaVersion,
        startCursorRecordSeq: 0,
        endCursorRecordSeq: 10,
        tokenCount: 100,
        windowInputSha256: mapperSha256({ dummy: "top" }),
        workerId,
        leaseEpoch: lease.leaseEpoch,
      });

      const unitRes = await databasePool().query<{ id: string }>(
        "SELECT id FROM intentchord.context_mapping_candidate_units WHERE traversal_id = $1 LIMIT 1",
        [traversalId],
      );
      const unitId = unitRes.rows[0].id;

      // 1. Pointing to a TOPOLOGY window -> rejects with phase guard
      await expect(
        databasePool().query(
          "UPDATE intentchord.context_mapping_candidate_units SET status = 'PROCESSED', processed_in_window_id = $1 WHERE id = $2",
          [topWinId, unitId],
        ),
      ).rejects.toThrow(/INTENTCHORD_CANDIDATE_PROCESSED_ONLY_BY_DRILLDOWN_WINDOW/);

      // 2. Pointing to a window from a non-existent or foreign traversal -> rejects with FK violation
      await expect(
        databasePool().query(
          "UPDATE intentchord.context_mapping_candidate_units SET status = 'PROCESSED', processed_in_window_id = $1 WHERE id = $2",
          [randomUUID(), unitId],
        ),
      ).rejects.toThrow();
    });
  });

  describe("G. REDUCTION LINEAGE INTEGRITY & DAG BY CONSTRUCTION", () => {
    let window1Id: string;
    let window1Sha: string;
    let window2Id: string;
    let window2Sha: string;
    let workerId: string;
    let leaseEpoch: number;

    beforeAll(async () => {
      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_owner = NULL, executor_lease_expires_at = NULL
          WHERE id = $1`,
        [traversalId],
      );
      workerId = `worker_${randomUUID()}`;
      const lease = await repo.claimOrRenewLease(traversalId, workerId);
      expect(lease.acquired).toBe(true);
      leaseEpoch = lease.leaseEpoch;

      window1Id = randomUUID();
      window1Sha = mapperSha256({ result: "window1_content" });
      await repo.insertEvidenceWindow({
        id: window1Id,
        traversalId,
        traversalAuthoritySha256,
        phase: "TOPOLOGY",
        windowOrdinal: 1,
        cursorArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        cursorSectionId: semanticSectionId,
        cursorSectionType: "SEMANTIC_PROJECTION",
        cursorSectionSchemaVersion: semanticSchemaVersion,
        startCursorRecordSeq: 0,
        endCursorRecordSeq: 20,
        tokenCount: 500,
        windowInputSha256: mapperSha256({ input: "win1" }),
        workerId,
        leaseEpoch,
      });
      await repo.completeWindow({
        windowId: window1Id,
        traversalId,
        windowResultJson: { result: "window1_content" },
        windowResultSha256: window1Sha,
        workerId,
        leaseEpoch,
      });

      window2Id = randomUUID();
      window2Sha = mapperSha256({ result: "window2_content" });
      await repo.insertEvidenceWindow({
        id: window2Id,
        traversalId,
        traversalAuthoritySha256,
        phase: "TOPOLOGY",
        windowOrdinal: 2,
        cursorArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        cursorSectionId: semanticSectionId,
        cursorSectionType: "SEMANTIC_PROJECTION",
        cursorSectionSchemaVersion: semanticSchemaVersion,
        startCursorRecordSeq: 21,
        endCursorRecordSeq: 40,
        tokenCount: 500,
        windowInputSha256: mapperSha256({ input: "win2" }),
        workerId,
        leaseEpoch,
      });
      await repo.completeWindow({
        windowId: window2Id,
        traversalId,
        windowResultJson: { result: "window2_content" },
        windowResultSha256: window2Sha,
        workerId,
        leaseEpoch,
      });
    });

    it("rejects reduction input violating XOR source condition", async () => {
      const redWinId = randomUUID();
      await repo.insertReductionWindow({
        id: redWinId,
        traversalId,
        traversalAuthoritySha256,
        reductionLevel: 1,
        reductionOrdinal: 1,
        inputSetSha256: mapperSha256({ set: 1 }),
        inputItemCount: 1,
        tokenCount: 100,
        status: "READY",
        workerId,
        leaseEpoch,
      });

      // Both source_mapping_window_id and source_reduction_window_id provided
      await expect(
        databasePool().query(
          `INSERT INTO intentchord.context_mapping_reduction_inputs (
            id, reduction_window_id, traversal_id, input_ordinal,
            source_mapping_window_id, source_reduction_window_id, source_output_sha256
          ) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
          [randomUUID(), redWinId, traversalId, window1Id, redWinId, window1Sha],
        ),
      ).rejects.toThrow();

      // Neither source provided
      await expect(
        databasePool().query(
          `INSERT INTO intentchord.context_mapping_reduction_inputs (
            id, reduction_window_id, traversal_id, input_ordinal,
            source_mapping_window_id, source_reduction_window_id, source_output_sha256
          ) VALUES ($1, $2, $3, 1, NULL, NULL, $4)`,
          [randomUUID(), redWinId, traversalId, window1Sha],
        ),
      ).rejects.toThrow();
    });

    it("rejects reduction input if source output hash does not match actual output hash", async () => {
      const redWinId = randomUUID();
      await repo.insertReductionWindow({
        id: redWinId,
        traversalId,
        traversalAuthoritySha256,
        reductionLevel: 1,
        reductionOrdinal: 2,
        inputSetSha256: mapperSha256({ set: 2 }),
        inputItemCount: 1,
        tokenCount: 100,
        status: "READY",
        workerId,
        leaseEpoch,
      });

      // Tampered source output SHA
      await expect(
        repo.insertReductionInputs(
          [
            {
              id: randomUUID(),
              reductionWindowId: redWinId,
              traversalId,
              inputOrdinal: 1,
              sourceMappingWindowId: window1Id,
              sourceOutputSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
          workerId,
          leaseEpoch,
        ),
      ).rejects.toThrow(/INTENTCHORD_REDUCTION_INPUT_HASH_MISMATCH/);
    });

    it("rejects higher-level source into lower-level reduction window (cycle prevention)", async () => {
      // Create level 2 reduction window
      const redWinLevel2Id = randomUUID();
      const level2OutputSha = mapperSha256({ out: "level2" });
      await repo.insertReductionWindow({
        id: redWinLevel2Id,
        traversalId,
        traversalAuthoritySha256,
        reductionLevel: 2,
        reductionOrdinal: 1,
        inputSetSha256: mapperSha256({ set: "l2" }),
        inputItemCount: 1,
        tokenCount: 200,
        status: "SUCCEEDED",
        outputSha256: level2OutputSha,
        outputSummary: { out: "level2" },
        workerId,
        leaseEpoch,
      });

      // Attempt inserting level 2 window as source into level 1 reduction window
      const redWinLevel1Id = randomUUID();
      await repo.insertReductionWindow({
        id: redWinLevel1Id,
        traversalId,
        traversalAuthoritySha256,
        reductionLevel: 1,
        reductionOrdinal: 3,
        inputSetSha256: mapperSha256({ set: "l1_invalid" }),
        inputItemCount: 1,
        tokenCount: 100,
        status: "READY",
        workerId,
        leaseEpoch,
      });

      await expect(
        repo.insertReductionInputs(
          [
            {
              id: randomUUID(),
              reductionWindowId: redWinLevel1Id,
              traversalId,
              inputOrdinal: 1,
              sourceReductionWindowId: redWinLevel2Id,
              sourceOutputSha256: level2OutputSha,
            },
          ],
          workerId,
          leaseEpoch,
        ),
      ).rejects.toThrow(/INTENTCHORD_REDUCTION_INPUT_LEVEL_DIRECTION_VIOLATION/);
    });

    it("accepts valid cryptographically verified DAG lineage", async () => {
      const redWinId = randomUUID();
      const outputSha = mapperSha256({ out: "combined" });
      await repo.insertReductionWindow({
        id: redWinId,
        traversalId,
        traversalAuthoritySha256,
        reductionLevel: 1,
        reductionOrdinal: 4,
        inputSetSha256: mapperSha256({ set: "valid_l1" }),
        inputItemCount: 2,
        tokenCount: 300,
        status: "SUCCEEDED",
        outputSha256: outputSha,
        outputSummary: { out: "combined" },
        workerId,
        leaseEpoch,
      });

      await repo.insertReductionInputs(
        [
          {
            id: randomUUID(),
            reductionWindowId: redWinId,
            traversalId,
            inputOrdinal: 1,
            sourceMappingWindowId: window1Id,
            sourceOutputSha256: window1Sha,
          },
          {
            id: randomUUID(),
            reductionWindowId: redWinId,
            traversalId,
            inputOrdinal: 2,
            sourceMappingWindowId: window2Id,
            sourceOutputSha256: window2Sha,
          },
        ],
        workerId,
        leaseEpoch,
      );

      const inputsRes = await databasePool().query(
        "SELECT * FROM intentchord.context_mapping_reduction_inputs WHERE reduction_window_id = $1 ORDER BY input_ordinal ASC",
        [redWinId],
      );
      expect(inputsRes.rows.length).toBe(2);
      expect(inputsRes.rows[0].source_output_sha256).toBe(window1Sha);
      expect(inputsRes.rows[1].source_output_sha256).toBe(window2Sha);
    });
  });
});
