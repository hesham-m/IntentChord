import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";

describe("Owner retry preserves failed traversal provenance", () => {
  const repo = new PostgresContextMappingTraversalRepository();
  let traversalId = "";
  let failedWindowId = "";
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
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const wea = weaRes.rows[0];

    const snapRes = await databasePool().query<{ id: string }>(
      `SELECT id FROM intentchord.workspace_index_snapshots
        WHERE accepted_workspace_evidence_artifact_id = $1 AND status = 'READY'
        ORDER BY created_at DESC LIMIT 1`,
      [wea.id],
    );
    const snap = snapRes.rows[0];

    const obsRes = await databasePool().query<{ id: string; authority_sequence: string }>(
      `SELECT id, authority_sequence FROM intentchord.workspace_observations
        WHERE workspace_registration_id = $1
        ORDER BY authority_sequence DESC LIMIT 1`,
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

    const authority: FrozenAuthorityTuple = {
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

    const created = await repo.createTraversal(authority, {
      cursor_artifact_id: wea.id,
      cursor_section_id: Number(secRes.rows[0].id),
      cursor_section_type: "SEMANTIC_PROJECTION",
      cursor_section_schema_version: secRes.rows[0].section_schema_version,
      cursor_record_seq: 0,
    });
    traversalId = created.id;

    const workerId = "owner_retry_test_worker";
    const lease = await repo.acquireOrReclaimLease(traversalId, workerId);
    expect(lease.acquired).toBe(true);

    failedWindowId = randomUUID();
    await repo.insertEvidenceWindow({
      id: failedWindowId,
      traversalId,
      traversalAuthoritySha256: created.traversal_authority_sha256,
      phase: "TOPOLOGY",
      windowOrdinal: 1,
      cursorArtifactId: wea.id,
      cursorSectionId: Number(secRes.rows[0].id),
      cursorSectionType: "SEMANTIC_PROJECTION",
      cursorSectionSchemaVersion: secRes.rows[0].section_schema_version,
      startCursorRecordSeq: 0,
      endCursorRecordSeq: 10,
      tokenCount: 100,
      windowInputSha256: "sha256:" + "1".repeat(64),
      workerId,
      leaseEpoch: lease.epoch,
    });
    await repo.markWindowRunning({
      windowId: failedWindowId,
      traversalId,
      workerId,
      leaseEpoch: lease.epoch,
    });
    await repo.failWindow({
      windowId: failedWindowId,
      traversalId,
      workerId,
      leaseEpoch: lease.epoch,
      errorMessage: "synthetic validation failure",
    });
    await repo.failTraversal(
      traversalId,
      workerId,
      lease.epoch,
      "EXECUTOR_FAILURE",
      "synthetic validation failure",
    );
  });

  afterAll(async () => {
    if (traversalId) {
      await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE id = $1", [traversalId]);
    }
    if (fixtureCleanup) await fixtureCleanup();
  });

  it("re-opens the same frozen traversal at a fresh window ordinal without overwriting the failed window", async () => {
    const before = await repo.getTraversalById(traversalId);
    expect(before?.traversal_status).toBe("FAILED");
    expect(before?.active_window_ordinal).toBe(1);

    const reopened = await repo.reopenFailedTraversalForRetry(traversalId);
    expect(reopened.id).toBe(traversalId);
    expect(reopened.traversal_authority_sha256).toBe(before?.traversal_authority_sha256);
    expect(reopened.traversal_status).toBe("TOPOLOGY_IN_PROGRESS");
    expect(reopened.active_window_ordinal).toBe(2);
    expect(Number(reopened.cursor_record_seq)).toBe(0);
    expect(reopened.failure_code).toBeNull();
    expect(reopened.failure_reason).toBeNull();

    const failedWindow = await databasePool().query<{
      status: string;
      window_ordinal: number;
      attempt_count: number;
      window_input_sha256: string;
      error_message: string | null;
    }>(
      `SELECT status, window_ordinal, attempt_count, window_input_sha256, error_message
         FROM intentchord.context_mapping_windows
        WHERE id = $1`,
      [failedWindowId],
    );
    expect(failedWindow.rows[0]).toMatchObject({
      status: "FAILED",
      window_ordinal: 1,
      attempt_count: 1,
      window_input_sha256: "sha256:" + "1".repeat(64),
      error_message: "synthetic validation failure",
    });
  });
});
