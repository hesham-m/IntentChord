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
import {
  PostgresContextMappingTraversalRepository,
  type FrozenAuthorityTuple,
} from "@/server/context-mapping-traversal-repository";
import {
  startTraversalRecoveryLoop,
  stopTraversalRecoveryLoop,
  runTraversalRecoveryCycle,
} from "@/server/context/context-mapping-traversal-recovery-loop";
import { createIsolatedTestContextAssembly } from "@/server/context/test-support/isolated-test-fixture";

describe("INTENTCHORD_BACKEND_RECOVERY_TESTS", () => {
  const repo = new PostgresContextMappingTraversalRepository();
  let baseAuthority: FrozenAuthorityTuple;
  let traversalId: string;
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
    stopTraversalRecoveryLoop();
    if (traversalId) {
      await databasePool().query("DELETE FROM intentchord.context_mapping_traversals WHERE id = $1", [traversalId]);
    }
    if (fixtureCleanup) {
      await fixtureCleanup();
    }
  });

  it("identifies expired or abandoned lease as recoverable", async () => {
    // Set lease as expired in the past
    await databasePool().query(
      `UPDATE intentchord.context_mapping_traversals
          SET executor_lease_owner = 'abandoned_worker',
              executor_lease_expires_at = clock_timestamp() - interval '10 seconds',
              traversal_status = 'TOPOLOGY_IN_PROGRESS'
        WHERE id = $1`,
      [traversalId],
    );

    const recoverable = await repo.findRecoverableTraversals();
    const match = recoverable.find(t => t.id === traversalId);
    expect(match).toBeDefined();
    expect(match!.traversal_status).toBe("TOPOLOGY_IN_PROGRESS");
  });

  it("prevents duplicate recovery loops under hot-reload or multiple imports", () => {
    stopTraversalRecoveryLoop();
    expect(globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__).toBeFalsy();

    startTraversalRecoveryLoop(60_000, repo);
    expect(globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__).toBe(true);
    const firstTimer = globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__;

    // Call startTraversalRecoveryLoop again - must be a no-op
    startTraversalRecoveryLoop(60_000, repo);
    expect(globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__).toBe(firstTimer);

    stopTraversalRecoveryLoop();
    expect(globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_ACTIVE__).toBe(false);
    expect(globalThis.__INTENTCHORD_TRAVERSAL_RECOVERY_TIMER__).toBeUndefined();
  });

  it("runs a recovery cycle and finds the recoverable traversal", async () => {
    // Ensure traversal is in recoverable state
    await databasePool().query(
      `UPDATE intentchord.context_mapping_traversals
          SET executor_lease_owner = 'dead_worker',
              executor_lease_expires_at = clock_timestamp() - interval '5 seconds',
              traversal_status = 'TOPOLOGY_IN_PROGRESS'
        WHERE id = $1`,
      [traversalId],
    );

    const count = await runTraversalRecoveryCycle(repo);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
