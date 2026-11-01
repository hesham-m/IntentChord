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
  StaleExecutorLeaseError,
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import { runTraversalRecoveryCycle } from "@/server/context/context-mapping-traversal-recovery-loop";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";

describe("INTENTCHORD_TRAVERSAL_LEASE_FENCING_AND_CONCURRENCY", () => {
  const repo = new PostgresContextMappingTraversalRepository();
  let baseAuthority: FrozenAuthorityTuple;
  let traversalId: string;
  let traversalAuthoritySha256: string;
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
    fixtureCleanup = fixture.cleanup;

    const secRes = await databasePool().query<{ id: string; section_schema_version: string }>(
      `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
        WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
        LIMIT 1`,
      [wea.id],
    );
    const semanticSectionId = Number(secRes.rows[0].id);
    const semanticSchemaVersion = secRes.rows[0].section_schema_version;

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

    // Clean prior test traversals for this isolated test revision only
    await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE context_assembly_revision_id = $1", [baseAuthority.context_assembly_revision_id]);

    const created = await repo.createTraversal(baseAuthority, {
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

  describe("E. LEASE CONCURRENCY & FENCING", () => {
    it("two workers race -> exactly one claims the lease", async () => {
      const workerA = "worker_alpha";
      const workerB = "worker_beta";

      const [resA, resB] = await Promise.all([
        repo.claimOrRenewLease(traversalId, workerA, 30_000),
        repo.claimOrRenewLease(traversalId, workerB, 30_000),
      ]);

      const successCount = (resA.acquired ? 1 : 0) + (resB.acquired ? 1 : 0);
      expect(successCount).toBe(1);
    });

    it("worker A pauses; lease expires; worker B reclaims with higher monotonic epoch", async () => {
      const workerA = "worker_alpha";
      const workerB = "worker_beta";

      // Explicitly set lease to expired for workerA
      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_owner = $2,
                executor_lease_epoch = 1,
                executor_lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [traversalId, workerA],
      );

      // Worker B reclaims
      const claimB = await repo.claimOrRenewLease(traversalId, workerB, 30_000);
      expect(claimB.acquired).toBe(true);
      expect(claimB.leaseEpoch).toBeGreaterThan(1);

      // Query section details
      const secRes = await databasePool().query<{ id: string; section_schema_version: string }>(
        `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
          WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
          LIMIT 1`,
        [baseAuthority.accepted_workspace_evidence_artifact_id],
      );
      const semanticSectionId = Number(secRes.rows[0].id);
      const semanticSchemaVersion = secRes.rows[0].section_schema_version;

      // Query real logical unit for candidate unit insertion test
      const recRes = await databasePool().query<{ logical_unit_id: string; source_file_revision_id: string }>(
        `SELECT record_json->>'logical_unit_id' as logical_unit_id, source_file_revision_id
           FROM intentchord.workspace_evidence_section_records
          WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
          LIMIT 1`,
        [baseAuthority.accepted_workspace_evidence_artifact_id],
      );
      const realLogicalUnitId = recRes.rows[0]?.logical_unit_id ?? "unit_fallback";
      const realSourceFileRevId = recRes.rows[0]?.source_file_revision_id ?? "rev_fallback";

      // 1. Worker A attempts parent write -> REJECTED
      await expect(
        repo.updateProgressAndCursor({
          traversalId,
          cursorRecordSeq: 99,
          topologyWindowCount: 1,
          drilldownWindowCount: 0,
          reductionLevelCount: 0,
          activeWindowOrdinal: 2,
          workerId: workerA,
          leaseEpoch: 1,
        }),
      ).rejects.toThrow(StaleExecutorLeaseError);

      // 2. Worker A attempts child Window write -> REJECTED
      await expect(
        repo.insertEvidenceWindow({
          id: randomUUID(),
          traversalId,
          traversalAuthoritySha256,
          phase: "TOPOLOGY",
          windowOrdinal: 1,
          cursorArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
          cursorSectionId: semanticSectionId,
          cursorSectionType: "SEMANTIC_PROJECTION",
          cursorSectionSchemaVersion: semanticSchemaVersion,
          startCursorRecordSeq: 0,
          endCursorRecordSeq: 10,
          tokenCount: 100,
          windowInputSha256: mapperSha256({ win: 1 }),
          workerId: workerA,
          leaseEpoch: 1,
        }),
      ).rejects.toThrow(StaleExecutorLeaseError);

      // 3. Worker A attempts Candidate Batch write -> REJECTED
      const staleBatchId = randomUUID();
      await expect(
        repo.insertCandidateBatch({
          id: staleBatchId,
          traversalId,
          traversalAuthoritySha256,
          batchOrdinal: 1,
          candidateCount: 1,
          tokenCount: 50,
          workerId: workerA,
          leaseEpoch: 1,
        }),
      ).rejects.toThrow(StaleExecutorLeaseError);

      // 4. Worker A attempts Candidate Units write -> REJECTED
      await expect(
        repo.insertCandidateUnits(
          [
            {
              id: randomUUID(),
              batchId: staleBatchId,
              traversalId,
              candidateOrdinal: 1,
              workspaceRegistrationId: baseAuthority.workspace_registration_id,
              workspaceRevisionId: baseAuthority.workspace_revision_id,
              acceptedWorkspaceEvidenceArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
              sourceFileRevisionId: realSourceFileRevId,
              logicalUnitId: realLogicalUnitId,
              status: "SELECTED",
            },
          ],
          workerA,
          1,
        ),
      ).rejects.toThrow(StaleExecutorLeaseError);

      // 5. Worker A attempts Reduction Window write -> REJECTED
      const staleRedWindowId = randomUUID();
      await expect(
        repo.insertReductionWindow({
          id: staleRedWindowId,
          traversalId,
          traversalAuthoritySha256,
          reductionLevel: 1,
          reductionOrdinal: 1,
          inputSetSha256: mapperSha256({ s: 1 }),
          inputItemCount: 1,
          tokenCount: 100,
          status: "READY",
          workerId: workerA,
          leaseEpoch: 1,
        }),
      ).rejects.toThrow(StaleExecutorLeaseError);

      // 6. Worker A attempts Reduction Input write -> REJECTED
      await expect(
        repo.insertReductionInput({
          id: randomUUID(),
          reductionWindowId: staleRedWindowId,
          traversalId,
          inputOrdinal: 1,
          sourceMappingWindowId: randomUUID(),
          sourceOutputSha256: mapperSha256({ out: 1 }),
          workerId: workerA,
          leaseEpoch: 1,
        }),
      ).rejects.toThrow(StaleExecutorLeaseError);
    });

    it("prevents duplicate window ordinal execution for the same phase", async () => {
      const workerB = "worker_beta";
      const claim = await repo.claimOrRenewLease(traversalId, workerB);
      expect(claim.acquired).toBe(true);
      const epoch = claim.leaseEpoch;

      const secRes = await databasePool().query<{ id: string; section_schema_version: string }>(
        `SELECT id, section_schema_version FROM intentchord.workspace_evidence_sections
          WHERE artifact_id = $1 AND section_type = 'SEMANTIC_PROJECTION'
          LIMIT 1`,
        [baseAuthority.accepted_workspace_evidence_artifact_id],
      );
      const semanticSectionId = Number(secRes.rows[0].id);
      const semanticSchemaVersion = secRes.rows[0].section_schema_version;

      const windowId1 = randomUUID();
      await repo.insertEvidenceWindow({
        id: windowId1,
        traversalId,
        traversalAuthoritySha256,
        phase: "TOPOLOGY",
        windowOrdinal: 1,
        cursorArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
        cursorSectionId: semanticSectionId,
        cursorSectionType: "SEMANTIC_PROJECTION",
        cursorSectionSchemaVersion: semanticSchemaVersion,
        startCursorRecordSeq: 0,
        endCursorRecordSeq: 10,
        tokenCount: 100,
        windowInputSha256: mapperSha256({ w: 1 }),
        workerId: workerB,
        leaseEpoch: epoch,
      });

      // Attempt inserting second window with same ordinal 1 for phase TOPOLOGY -> REJECTED by unique constraint
      await expect(
        repo.insertEvidenceWindow({
          id: randomUUID(),
          traversalId,
          traversalAuthoritySha256,
          phase: "TOPOLOGY",
          windowOrdinal: 1, // duplicate ordinal
          cursorArtifactId: baseAuthority.accepted_workspace_evidence_artifact_id,
          cursorSectionId: semanticSectionId,
          cursorSectionType: "SEMANTIC_PROJECTION",
          cursorSectionSchemaVersion: semanticSchemaVersion,
          startCursorRecordSeq: 11,
          endCursorRecordSeq: 20,
          tokenCount: 100,
          windowInputSha256: mapperSha256({ w: "dup" }),
          workerId: workerB,
          leaseEpoch: epoch,
        }),
      ).rejects.toThrow();
    });
  });

  describe("F. BACKEND RECOVERY SCANNER", () => {
    it("discovers expired/abandoned traversals and reclaims them atomically without frontend requests", async () => {
      // Set lease to expired
      await databasePool().query(
        `UPDATE intentchord.context_mapping_traversals
            SET executor_lease_expires_at = clock_timestamp() - interval '10 seconds'
          WHERE id = $1`,
        [traversalId],
      );

      const initial = await repo.getTraversalById(traversalId);
      const initialEpoch = initial!.executor_lease_epoch;

      const recoverable = await repo.findRecoverableTraversals();
      const found = recoverable.some(r => r.id === traversalId);
      expect(found).toBe(true);

      const recoveredCount = await runTraversalRecoveryCycle(repo);
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // Verify the lease epoch was incremented by the atomic recovery (wait up to 2s for background worker)
      let updated = await repo.getTraversalById(traversalId);
      for (let i = 0; i < 20; i++) {
        if (updated && updated.executor_lease_epoch > initialEpoch) {
          break;
        }
        await new Promise(r => setTimeout(r, 100));
        updated = await repo.getTraversalById(traversalId);
      }
      expect(Number(updated!.executor_lease_epoch)).toBeGreaterThan(Number(initialEpoch));
    });
  });
});
