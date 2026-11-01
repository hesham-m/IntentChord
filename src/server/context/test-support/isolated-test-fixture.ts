import { randomUUID } from "node:crypto";
import { databasePool } from "@/server/db";
import { mapperSha256 } from "@/core/ai-context-mapper/canonical";

export async function createIsolatedTestContextAssembly(params: {
  workspaceRegistrationId: string;
  workspaceRevisionId: string;
  workspaceObservationId: string;
  authoritySequence: number;
  workspaceIndexSnapshotId: string;
  acceptedWorkspaceEvidenceArtifactId: string;
  workspaceIndexSha256: string;
  artifactSemanticSha256: string;
  workspaceRegistrationRevision?: number;
  workspaceRegistrationFingerprint?: string;
}): Promise<{
  testTaskId: string;
  testAssemblyId: string;
  testRevisionId: string;
  cleanup: () => Promise<void>;
}> {
  const testTaskId = randomUUID();
  const testAssemblyId = randomUUID();
  const testRevisionId = randomUUID();

  const pool = databasePool();

  // Look up registration revision and fingerprint from existing context_assembly_sources
  let regRev = params.workspaceRegistrationRevision ?? 1;
  let regFp = params.workspaceRegistrationFingerprint ?? "";
  if (!regFp) {
    const srcRes = await pool.query<{ workspace_registration_revision: number; workspace_registration_fingerprint: string }>(
      `SELECT workspace_registration_revision, workspace_registration_fingerprint 
         FROM intentchord.context_assembly_sources 
        WHERE workspace_registration_id = $1 
        LIMIT 1`,
      [params.workspaceRegistrationId],
    );
    if (srcRes.rows.length > 0) {
      regRev = Number(srcRes.rows[0].workspace_registration_revision);
      regFp = srcRes.rows[0].workspace_registration_fingerprint;
    } else {
      const fallbackRes = await pool.query<{ workspace_registration_revision: number; workspace_registration_fingerprint: string }>(
        `SELECT workspace_registration_revision, workspace_registration_fingerprint 
           FROM intentchord.context_assembly_sources 
          LIMIT 1`,
      );
      if (fallbackRes.rows.length > 0) {
        regRev = Number(fallbackRes.rows[0].workspace_registration_revision);
        regFp = fallbackRes.rows[0].workspace_registration_fingerprint;
      }
    }
  }

  await pool.query(
    `INSERT INTO intentchord.tasks (
      id, title, title_manually_edited, objective, task_mode, draft, created_at, updated_at, revision
    ) VALUES (
      $1, 'Test Task Isolated', false, 'Test Objective', 'CONTROLLED_AUDIT', '{}'::jsonb, clock_timestamp(), clock_timestamp(), 1
    )`,
    [testTaskId],
  );

  await pool.query(
    `INSERT INTO intentchord.context_assemblies (id, task_id, contract_version)
     VALUES ($1, $2, 'intentchord.context-assembly.v1')`,
    [testAssemblyId, testTaskId],
  );

  const assemblySha256 = mapperSha256({ testRevisionId, testAssemblyId });

  await pool.query(
    `INSERT INTO intentchord.context_assembly_revisions (id, context_assembly_id, revision, assembly_schema_version, assembly_sha256)
     VALUES ($1, $2, 1, 'intentchord.context-assembly.v1', $3)`,
    [testRevisionId, testAssemblyId, assemblySha256],
  );

  await pool.query(
    `INSERT INTO intentchord.context_assembly_sources (
      id, context_assembly_revision_id, ordering,
      workspace_registration_id, workspace_registration_revision, workspace_registration_fingerprint,
      workspace_revision_id, workspace_observation_id, workspace_observation_authority_sequence,
      workspace_index_snapshot_id, accepted_workspace_evidence_artifact_id,
      workspace_index_sha256, artifact_semantic_sha256
    ) VALUES (
      $1, $2, 0,
      $3, $4, $5,
      $6, $7, $8,
      $9, $10,
      $11, $12
    )`,
    [
      randomUUID(),
      testRevisionId,
      params.workspaceRegistrationId,
      regRev,
      regFp,
      params.workspaceRevisionId,
      params.workspaceObservationId,
      params.authoritySequence,
      params.workspaceIndexSnapshotId,
      params.acceptedWorkspaceEvidenceArtifactId,
      params.artifactSemanticSha256,
      params.artifactSemanticSha256,
    ],
  );

  const cleanup = async () => {
    await pool.query(
      "DELETE FROM intentchord.context_mapping_traversals WHERE context_assembly_revision_id = $1",
      [testRevisionId],
    );
  };

  return { testTaskId, testAssemblyId, testRevisionId, cleanup };
}
