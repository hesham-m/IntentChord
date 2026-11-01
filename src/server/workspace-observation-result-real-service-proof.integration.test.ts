import { randomUUID } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import { PostgresWorkspaceIndexSnapshotRepository } from "@/server/workspace-index-snapshot-repository";
import { bindRollbackOnlyTestClient } from "@/server/db";
import { indexWorkspaceV2 } from "@/core/workspace-index/ingestion/engine-v2-adapter";

/**
 * Real Service Proof Closure — SOURCE_UNCHANGED and KNOWN_STATE_RESTORED
 *
 * Exercises the actual production chain:
 *   WorkspaceIndexSnapshotService path → real V2 adapter → was_revision_previously_observed callback
 *   → classifyWorkspaceObservation → actual artifact candidate → repository seal → PostgreSQL B1 guard
 *
 * No manual observationResult injection. No direct INSERT as substitute.
 */

const DISPOSABLE_URL = (() => {
  const raw = process.env.INTENTCHORD_C1_VALIDATION_DATABASE_URL;
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`DISPOSABLE_IDENTITY_BLOCKED: INTENTCHORD_C1_VALIDATION_DATABASE_URL`);
  }
  return raw;
})();

const WS = "00000000-0000-4000-8000-000000000009";
const CONFIG = `sha256:${"a".repeat(64)}`;

let pool: pg.Pool | undefined;
let rollbackClient: pg.PoolClient | undefined;
let releaseRollbackBinding: (() => void) | undefined;
let tempDir: string | undefined;

beforeAll(async () => {
  if (!DISPOSABLE_URL) return;
  process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
  pool = new pg.Pool({ connectionString: DISPOSABLE_URL });
  rollbackClient = await pool.connect();
  await rollbackClient.query("BEGIN");
  releaseRollbackBinding = bindRollbackOnlyTestClient(rollbackClient);
  await applyMigrationsThrough15(rollbackClient);
  await seedWorkspace(rollbackClient);
  tempDir = path.join(os.tmpdir(), `rsp-proof-${randomUUID().slice(0, 8)}`);
  await mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
  if (releaseRollbackBinding) releaseRollbackBinding();
  if (rollbackClient) { await rollbackClient.query("ROLLBACK"); rollbackClient.release(); }
  if (pool) await pool.end();
  if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

async function applyMigrationsThrough15(client: pg.PoolClient) {
  const fs = await import("node:fs/promises");
  await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE");
  await client.query("CREATE SCHEMA intentchord AUTHORIZATION intentchord_app");
  const migrationsDir = path.resolve(process.cwd(), "migrations");
  const files = (await fs.readdir(migrationsDir)).filter(f => /^0\d\d_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf-8");
    await client.query(sql);
  }
}

async function seedWorkspace(client: pg.PoolClient) {
  await client.query(
    `INSERT INTO intentchord.workspaces
       (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
        verification_status,verification_method,verification_authority,device_provenance,source_type,
        verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
        verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
        current_root_file_id,current_root_identity_method,root_authority_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      WS, "RSP Proof", "PRIMARY", "LOCAL_PATH", "C:\\rsp\\proof", "rsp-fp", 1, "c:/rsp/proof",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\rsp\\proof", "666666666", "00000000000000000000000000000009", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\rsp\\proof", "666666666",
      "00000000000000000000000000000009", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
}

function makeRepo() {
  return new PostgresWorkspaceIndexSnapshotRepository();
}

function makeEvidenceRepo() {
  return new PostgresWorkspaceEvidenceRepository(rollbackClient!);
}

/**
 * Run the real V2 adapter with controlled file content.
 * Returns the V2Outcome from the adapter.
 */
async function runV2Adapter(opts: {
  workspaceInstanceId: string;
  rootPath: string;
  files: Array<{ relativePath: string; content: string }>;
  previousObservation: { workspace_revision_id: string; accepted_workspace_evidence_artifact_id: string } | null;
  wasRevisionPreviouslyObserved: (revisionId: string) => Promise<boolean>;
}) {
  const snapshotOpId = `rsp-${randomUUID().slice(0, 8)}`;

  // Write files to temp directory
  for (const file of opts.files) {
    const filePath = path.join(opts.rootPath, file.relativePath);
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, file.content, "utf-8");
  }

  const request = {
    workspace_instance_id: opts.workspaceInstanceId,
    root_path: opts.rootPath,
    authorized_root_identity: { real_path: opts.rootPath, identity: { grade: "GENERIC_METADATA_V1" as const, proof: "test", device_id: "666666666", file_id: "00000000000000000000000000000009", proof_method: "WINDOWS_FILE_ID_128_V1" as const } },
    predecessor_attestation: null,
    previous_observation: opts.previousObservation,
    was_revision_previously_observed: opts.wasRevisionPreviouslyObserved,
    binding_type: "LOCAL_FILESYSTEM" as const,
    owner_restricted_paths: [],
    budgets: { maxDiscoveredFiles: 1000, maxDiscoveredBytes: 10_000_000 },
    attempt_started_at_ms: Date.now(),
    indexing_session_id: snapshotOpId,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };

  const outcome = await indexWorkspaceV2(request);
  return { outcome, snapshotOpId };
}

/**
 * Seal a V2 snapshot using the repository.
 * Handles attestation lifecycle (OPEN → RECONCILING → SEALED) and staging.
 */
async function sealSnapshot(opts: {
  snapshotId: string;
  workspaceRegistrationId: string;
  workspaceInstanceId: string;
  v2Outcome: Awaited<ReturnType<typeof indexWorkspaceV2>> & { outcome: "SEALED" };
  previousObservationId: string | null;
}) {
  const repo = makeRepo();
  const evidenceRepo = makeEvidenceRepo();
  const { snapshotId, workspaceRegistrationId, workspaceInstanceId, v2Outcome, previousObservationId } = opts;

  // Reserve snapshot
  const reserved = await repo.reserve({
    sourceMode: "REGISTERED_WORKSPACE",
    workspaceRegistrationId,
    workspaceRegistrationRevision: 1,
    workspaceRegistrationFingerprint: "rsp-fp",
    governedScope: {},
    idempotencyKey: snapshotId,
    requestFingerprintSha256: `sha256:${randomUUID().replace(/-/g, "")}`,
    ownerReference: "rsp-owner",
    startedAt: new Date().toISOString(),
    ...(previousObservationId ? { scanBaseObservationId: previousObservationId } : {}),
  });

  // Insert staged records and segments
  for (const section of v2Outcome.sealPlan.sections) {
    if (section.records.length > 0) {
      await evidenceRepo.insertStagedRecords(section.records.map(r => ({
        snapshot_operation_id: snapshotId,
        section_type: section.section_type as "FILES",
        record_seq: r.record_seq,
        record_id: r.record_id,
        record_digest: r.record_digest,
        record_json: r.record_json,
      })));
    }
    for (const seg of section.segments) {
      await evidenceRepo.insertStagedSegment({
        snapshot_operation_id: snapshotId,
        section_type: section.section_type as "FILES",
        segment_seq: seg.segment_seq,
        record_count: seg.record_count,
        first_record_seq: seg.first_record_seq,
        last_record_seq: seg.last_record_seq,
        segment_digest: seg.segment_digest,
        byte_size: seg.byte_size,
      });
    }
  }

  // Open attestation
  const attestationId = v2Outcome.continuityAttestation.attestationId;
  await evidenceRepo.insertAttestationOpen({
    id: attestationId,
    workspace_registration_id: workspaceRegistrationId,
    provider_class: "GENERIC_METADATA_V1",
    provider_id: "test",
    claim_type: "BOUNDARY_OPEN_CLOSE",
    volume_identity_json: {},
    journal_identity_json: null,
    previous_trusted_boundary_usn: null,
    opened_boundary_usn: "0",
    bootstrap: true,
    policy_hash: "test",
    continuity_evidence_json: v2Outcome.continuityEvidence,
    snapshot_operation_id: snapshotId,
  });
  await evidenceRepo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
  await evidenceRepo.transitionAttestation(attestationId, {
    attestation_state: "SEALED",
    closed_boundary_usn: "0",
    reconciliation_passes: 0,
    continuity_evidence_json: v2Outcome.continuityEvidence,
    attestation_sha256: `sha256:${randomUUID().replace(/-/g, "")}`,
  });

  // Seal
  const sealed = await repo.sealV2Snapshot({
    snapshotId,
    workspaceRegistrationId,
    workspaceInstanceId,
    completedAt: new Date().toISOString(),
    evidenceArtifact: {
      id: v2Outcome.artifactCandidate.artifactId,
      workspaceRevisionId: v2Outcome.artifactCandidate.workspaceRevisionId,
      indexConfigurationSha256: CONFIG,
      headerJson: v2Outcome.sealPlan.header_json,
      sectionManifestJson: v2Outcome.sealPlan.section_manifest_json,
      sectionManifestDigest: v2Outcome.artifactCandidate.sectionManifestDigest,
      artifactManifestSha256: v2Outcome.artifactCandidate.artifactManifestSha256,
      artifactSemanticSha256: v2Outcome.artifactCandidate.artifactSemanticSha256,
      canonicalCompatSha256: v2Outcome.sealPlan.canonical_compat_sha256,
    },
    sections: v2Outcome.sealPlan.sections.map(s => ({
      sectionType: s.section_type as "FILES",
      sectionOrder: s.section_order,
      sectionSchemaVersion: s.section_schema_version,
      sectionDigest: s.section_digest,
      recordCount: s.record_count,
      segmentCount: s.segment_count,
    })),
    attestationId,
    observationResult: v2Outcome.observationResult,
    sourceBindingId: `sbi_${randomUUID().replace(/-/g, "").slice(0, 64)}`,
    sourceBindingMetadata: { engine: "V2_SECTIONED" },
    bindingType: "LOCAL_FILESYSTEM",
    normalizedReference: "c:/rsp/proof",
    treeFingerprint: v2Outcome.artifactCandidate.sectionManifestDigest,
  }, evidenceRepo);

  return { sealed, snapshotOpId: reserved.snapshot.id };
}

/**
 * Read the latest observation head for a workspace.
 */
async function readObservationHead(workspaceRegistrationId: string) {
  const result = await rollbackClient!.query(
    `SELECT o.id, o.observation_result, o.workspace_revision_id, o.accepted_workspace_evidence_artifact_id
     FROM intentchord.workspace_observations o
     WHERE o.workspace_registration_id = $1
     ORDER BY o.authority_sequence DESC LIMIT 1`,
    [workspaceRegistrationId],
  );
  return result.rowCount ? result.rows[0] : undefined;
}

// ============================================================
// TEST 1: SOURCE_UNCHANGED REAL SERVICE PATH
// ============================================================
describe("Real Service Proof — SOURCE_UNCHANGED", () => {
  it("PG-OR-SU: two runs with same revision/artifact → SOURCE_UNCHANGED via real adapter", async () => {
    if (!DISPOSABLE_URL || !rollbackClient || !tempDir) return;

    const regId = WS;
    const instanceId = WS;
    const testDir = path.join(tempDir, `su-${randomUUID().slice(0, 6)}`);
    await mkdir(testDir, { recursive: true });

    const files = [{ relativePath: "hello.ts", content: "export const x = 1;" }];
    const repo = makeRepo();

    // ── RUN 1: FIRST_INDEXED ──
    const result1 = await runV2Adapter({
      workspaceInstanceId: instanceId,
      rootPath: testDir,
      files,
      previousObservation: null,
      wasRevisionPreviouslyObserved: async () => false,
    });
    // Log failure details for debugging
    if (result1.outcome.outcome !== "SEALED") {
      console.log("V2 FAILED:", JSON.stringify(result1.outcome, null, 2));
    }
    expect(result1.outcome.outcome).toBe("SEALED");
    if (result1.outcome.outcome !== "SEALED") return;
    expect(result1.outcome.observationResult).toBe("FIRST_INDEXED");

    const snapId1 = `rsp-su-${randomUUID().slice(0, 8)}`;
    const { snapshotOpId: opId1 } = await sealSnapshot({
      snapshotId: snapId1,
      workspaceRegistrationId: regId,
      workspaceInstanceId: instanceId,
      v2Outcome: result1.outcome,
      previousObservationId: null,
    });

    // Verify RUN 1 persisted result
    const head1 = await readObservationHead(regId);
    expect(head1).toBeDefined();
    expect(head1!.observation_result).toBe("FIRST_INDEXED");
    const revA = head1!.workspace_revision_id;
    const artifactA = head1!.accepted_workspace_evidence_artifact_id;

    // ── RUN 2: SOURCE_UNCHANGED ──
    // Same files → same revision → same artifact
    // previous_observation points to RUN 1 head
    const result2 = await runV2Adapter({
      workspaceInstanceId: instanceId,
      rootPath: testDir,
      files,
      previousObservation: { workspace_revision_id: revA, accepted_workspace_evidence_artifact_id: artifactA },
      wasRevisionPreviouslyObserved: async () => false,
    });
    expect(result2.outcome.outcome).toBe("SEALED");
    if (result2.outcome.outcome !== "SEALED") return;

    // THE CRITICAL ASSERTION: adapter classified as SOURCE_UNCHANGED
    expect(result2.outcome.observationResult).toBe("SOURCE_UNCHANGED");

    const snapId2 = `rsp-su-${randomUUID().slice(0, 8)}`;
    await sealSnapshot({
      snapshotId: snapId2,
      workspaceRegistrationId: regId,
      workspaceInstanceId: instanceId,
      v2Outcome: result2.outcome,
      previousObservationId: head1!.id,
    });

    // Verify RUN 2 persisted result in workspace_observations
    const head2 = await readObservationHead(regId);
    expect(head2).toBeDefined();
    expect(head2!.observation_result).toBe("SOURCE_UNCHANGED");
    expect(head2!.workspace_revision_id).toBe(revA);

    // Verify workspace_index_snapshots also has SOURCE_UNCHANGED
    const snapResult = await rollbackClient!.query(
      "SELECT observation_result FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [snapId2],
    );
    expect(snapResult.rows[0].observation_result).toBe("SOURCE_UNCHANGED");

    // Cleanup temp dir
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// TEST 2: KNOWN_STATE_RESTORED REAL SERVICE PATH
// ============================================================
describe("Real Service Proof — KNOWN_STATE_RESTORED", () => {
  it("PG-OR-KSR: A → B → A chronology produces KNOWN_STATE_RESTORED via real adapter", async () => {
    if (!DISPOSABLE_URL || !rollbackClient || !tempDir) return;

    const regId = WS;
    const instanceId = WS;
    const testDir = path.join(tempDir, `ksr-${randomUUID().slice(0, 6)}`);
    await mkdir(testDir, { recursive: true });

    const filesA = [{ relativePath: "main.ts", content: "export const a = 1;" }];
    const filesB = [{ relativePath: "main.ts", content: "export const b = 2;export const c = 3;" }];
    const repo = makeRepo();

    // ── RUN 1: Revision A → FIRST_INDEXED ──
    const result1 = await runV2Adapter({
      workspaceInstanceId: instanceId,
      rootPath: testDir,
      files: filesA,
      previousObservation: null,
      wasRevisionPreviouslyObserved: async () => false,
    });
    expect(result1.outcome.outcome).toBe("SEALED");
    if (result1.outcome.outcome !== "SEALED") return;
    expect(result1.outcome.observationResult).toBe("FIRST_INDEXED");

    const snapId1 = `rsp-ksr-${randomUUID().slice(0, 8)}`;
    await sealSnapshot({
      snapshotId: snapId1,
      workspaceRegistrationId: regId,
      workspaceInstanceId: instanceId,
      v2Outcome: result1.outcome,
      previousObservationId: null,
    });

    const head1 = await readObservationHead(regId);
    expect(head1).toBeDefined();
    const revA = head1!.workspace_revision_id;
    expect(head1!.observation_result).toBe("FIRST_INDEXED");

    // ── RUN 2: Revision B → SOURCE_CHANGED ──
    const result2 = await runV2Adapter({
      workspaceInstanceId: instanceId,
      rootPath: testDir,
      files: filesB,
      previousObservation: { workspace_revision_id: revA, accepted_workspace_evidence_artifact_id: head1!.accepted_workspace_evidence_artifact_id },
      wasRevisionPreviouslyObserved: async () => false,
    });
    expect(result2.outcome.outcome).toBe("SEALED");
    if (result2.outcome.outcome !== "SEALED") return;
    expect(result2.outcome.observationResult).toBe("SOURCE_CHANGED");

    const snapId2 = `rsp-ksr-${randomUUID().slice(0, 8)}`;
    await sealSnapshot({
      snapshotId: snapId2,
      workspaceRegistrationId: regId,
      workspaceInstanceId: instanceId,
      v2Outcome: result2.outcome,
      previousObservationId: head1!.id,
    });

    const head2 = await readObservationHead(regId);
    expect(head2).toBeDefined();
    const revB = head2!.workspace_revision_id;
    expect(head2!.observation_result).toBe("SOURCE_CHANGED");
    expect(revB).not.toBe(revA);

    // ── RUN 3: Revision A again → KNOWN_STATE_RESTORED ──
    // The real adapter calls was_revision_previously_observed(A)
    // Repository queries workspace_observations and finds Revision A from RUN 1
    let callbackResult: boolean | undefined;
    const result3 = await runV2Adapter({
      workspaceInstanceId: instanceId,
      rootPath: testDir,
      files: filesA,
      previousObservation: { workspace_revision_id: revB, accepted_workspace_evidence_artifact_id: head2!.accepted_workspace_evidence_artifact_id },
      wasRevisionPreviouslyObserved: async (revisionId: string) => {
        // Use the REAL repository method to query persisted observation history
        const repoInstance = makeRepo();
        const result = await repoInstance.wasRevisionPreviouslyObserved(regId, revisionId);
        callbackResult = result;
        return result;
      },
    });
    expect(result3.outcome.outcome).toBe("SEALED");
    if (result3.outcome.outcome !== "SEALED") return;

    // THE CRITICAL ASSERTIONS:
    // 1. The callback returned TRUE (Revision A exists in historical observations)
    expect(callbackResult).toBe(true);

    // 2. The adapter classified as KNOWN_STATE_RESTORED
    expect(result3.outcome.observationResult).toBe("KNOWN_STATE_RESTORED");

    // 3. The revision is A (same as RUN 1)
    expect(result3.outcome.sealPlan.workspace_revision_id).toBe(revA);

    const snapId3 = `rsp-ksr-${randomUUID().slice(0, 8)}`;
    await sealSnapshot({
      snapshotId: snapId3,
      workspaceRegistrationId: regId,
      workspaceInstanceId: instanceId,
      v2Outcome: result3.outcome,
      previousObservationId: head2!.id,
    });

    // Verify RUN 3 persisted result in workspace_observations
    const head3 = await readObservationHead(regId);
    expect(head3).toBeDefined();
    expect(head3!.observation_result).toBe("KNOWN_STATE_RESTORED");
    expect(head3!.workspace_revision_id).toBe(revA);

    // Verify workspace_index_snapshots also has KNOWN_STATE_RESTORED
    const snapResult = await rollbackClient!.query(
      "SELECT observation_result FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [snapId3],
    );
    expect(snapResult.rows[0].observation_result).toBe("KNOWN_STATE_RESTORED");

    // ── WRONG RESULT DEFENSE: Attempt SOURCE_CHANGED for same A → B → A chronology ──
    // This should be rejected by the B1 guard in Migration 015
    try {
      const evidenceRepo = makeEvidenceRepo();
      const wrongSnapId = `rsp-ksr-wrong-${randomUUID().slice(0, 8)}`;
      await rollbackClient!.query(
        `INSERT INTO intentchord.workspace_index_snapshots
           (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
            workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
            snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
         VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'rsp-fp','{}',$3,$4,'rsp-owner',now(),$5)`,
        [wrongSnapId, regId, `rsp-wrong-${randomUUID().slice(0, 8)}`, `sha256:${randomUUID().replace(/-/g, "")}`, head2!.id],
      );

      // Attempt to insert observation with WRONG result (SOURCE_CHANGED instead of KNOWN_STATE_RESTORED)
      const wrongAttId = `wca_${randomUUID().replace(/-/g, "").slice(0, 64)}`;
      await evidenceRepo.insertAttestationOpen({
        id: wrongAttId,
        workspace_registration_id: regId,
        provider_class: "GENERIC_METADATA_V1",
        provider_id: "test",
        claim_type: "BOUNDARY_OPEN_CLOSE",
        volume_identity_json: {},
        journal_identity_json: null,
        previous_trusted_boundary_usn: null,
        opened_boundary_usn: "0",
        bootstrap: true,
        policy_hash: "test",
        continuity_evidence_json: { engine: "V2_SECTIONED", bootstrap: true },
        snapshot_operation_id: wrongSnapId,
      });
      await evidenceRepo.transitionAttestation(wrongAttId, { attestation_state: "RECONCILING" });
      await evidenceRepo.transitionAttestation(wrongAttId, {
        attestation_state: "SEALED",
        closed_boundary_usn: "0",
        reconciliation_passes: 0,
        continuity_evidence_json: { engine: "V2_SECTIONED", bootstrap: true },
        attestation_sha256: `sha256:${randomUUID().replace(/-/g, "")}`,
      });

      // Try to insert observation with SOURCE_CHANGED for Revision A
      // B1 guard should reject this because Revision A was seen before → should be KNOWN_STATE_RESTORED
      await rollbackClient!.query(
        `INSERT INTO intentchord.workspace_observations
           (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
            canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
            observation_result,index_configuration_sha256,source_tree_fingerprint,
            source_binding_json,owner_reference,observed_at,
            accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
         VALUES ($1,$2,$3,$4,null,$5,null,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          randomUUID(), wrongSnapId, regId, revA,
          head2!.id, "SOURCE_CHANGED", CONFIG,
          `sha256:${"b".repeat(64)}`,
          JSON.stringify({ source_binding_id: "sbi_wrong", binding_type: "LOCAL_FILESYSTEM" }),
          "rsp-owner", new Date().toISOString(),
          result3.outcome.artifactCandidate.artifactId, wrongAttId,
        ],
      );

      // If we reach here, the B1 guard did NOT reject — this is a failure
      expect.fail("B1 guard should have rejected SOURCE_CHANGED for previously known Revision A");
    } catch (error: unknown) {
      // Expected: B1 guard rejects SOURCE_CHANGED for previously known revision
      const msg = error instanceof Error ? error.message : String(error);
      const isB1Rejection = msg.includes("B1_OBSERVATION_RESULT_MISMATCH") || msg.includes("INTENTCHORD_WORKSPACE_B1");
      expect(isB1Rejection).toBe(true);
    }

    // Cleanup temp dir
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });
});
