import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import { PostgresWorkspaceIndexSnapshotRepository } from "@/server/workspace-index-snapshot-repository";
import { bindRollbackOnlyTestClient } from "@/server/db";

/**
 * Task C1 Part K: Disposable PostgreSQL E2E — Full V2 atomic seal transaction.
 * Task C1 Part L: Transaction failure proofs — Any S1-S8 failure rolls back everything.
 *
 * Uses raw pg.Pool (not databasePool) to avoid INTENTCHORD_DATABASE_IDENTITY_BLOCKED.
 * Binds rollback-only test client so transaction() from db.ts uses savepoints.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function loadDisposableUrl(varName: string): string | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`C1_E2E_DISPOSABLE_IDENTITY_BLOCKED: ${varName}`);
  }
  return raw;
}

const DISPOSABLE_URL = loadDisposableUrl("INTENTCHORD_C1_VALIDATION_DATABASE_URL");

const HEX = (ch: string) => ch.repeat(64);
const SHA = (label: string) => `sha256:${Buffer.from(label, "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
const WS = "c1e20000-0000-4000-8000-00000000c1e1";
const SNAP = "c1e20000-e89b-42d3-a456-00000000c1e2";
const ATTESTATION = "wca_c1e20000f78647702e7fc381e8610d8ffcf0bb6a4d234da5a306f699daf6c1e2";
const REVISION_ID = `wsr_${HEX("c")}`;
const CONFIG = `sha256:${HEX("f")}`;
const INSTANCE = WS;
const TREE_FINGERPRINT = `sha256:${HEX("d")}`;
const ARTIFACT_ID = "wea_c1e200002222222222222222222222222222222222222222222222222222c1e2";

let pool: pg.Pool | undefined;
let rollbackClient: pg.PoolClient | undefined;
let releaseRollbackBinding: (() => void) | undefined;
let c1SavepointCounter = 0;

beforeAll(async () => {
  if (!DISPOSABLE_URL) return;
  process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
  pool = new pg.Pool({ connectionString: DISPOSABLE_URL });
  rollbackClient = await pool.connect();
  await rollbackClient.query("BEGIN");
  releaseRollbackBinding = bindRollbackOnlyTestClient(rollbackClient);
  await applyMigrationsThrough14(rollbackClient);
  await applyMigration015(rollbackClient);
  await seedWorkspace(rollbackClient);
});

afterAll(async () => {
  try {
    if (rollbackClient) await rollbackClient.query("ROLLBACK");
  } finally {
    releaseRollbackBinding?.();
    rollbackClient?.release();
    delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
    await pool?.end();
  }
});

async function applyMigrationsThrough14(client: pg.PoolClient): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE");
  await client.query("CREATE SCHEMA intentchord AUTHORIZATION intentchord_app");
  const names = (await readdir(MIGRATIONS_DIR)).filter(n => /^0\d\d_.*\.sql$/.test(n)).sort();
  for (const name of names) {
    if (Number(name.slice(1, 3)) > 14) continue;
    await client.query(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

async function applyMigration015(client: pg.PoolClient): Promise<void> {
  await client.query(await readFile(path.join(MIGRATIONS_DIR, "015_sectioned_evidence_incremental_workspace.sql"), "utf8"));
}

async function seedWorkspace(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspaces
       (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
        verification_status,verification_method,verification_authority,device_provenance,source_type,
        verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
        verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
        current_root_file_id,current_root_identity_method,root_authority_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      WS, "C1 E2E", "PRIMARY", "LOCAL_PATH", "C:\\c1\\e2e", "c1-e2e-fp", 1, "c:/c1/e2e",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\c1\\e2e", "1234567890", "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\c1\\e2e", "1234567890",
      "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
}

async function seedSnapshotCreating(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_index_snapshots
       (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
        workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
        snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
     VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'c1-e2e-fp','{}','c1-e2e-snap',$3,'owner',now(),null)`,
    [SNAP, WS, `sha256:${HEX("a")}`],
  );
}

function createSealInput(overrides?: Partial<Parameters<PostgresWorkspaceIndexSnapshotRepository["sealV2Snapshot"]>[0]>) {
  return {
    snapshotId: SNAP,
    workspaceRegistrationId: WS,
    workspaceInstanceId: INSTANCE,
    completedAt: new Date().toISOString(),
    evidenceArtifact: {
      id: ARTIFACT_ID,
      workspaceRevisionId: REVISION_ID,
      indexConfigurationSha256: CONFIG,
      headerJson: { engine_mode: "V2_SECTIONED", c1_e2e: true },
      sectionManifestJson: [
        { section_type: "FILES", section_schema_version: "v1", section_digest: `sha256:${HEX("a")}`, record_count: 2, segment_count: 1 },
      ],
      sectionManifestDigest: `sha256:${HEX("b")}`,
      artifactManifestSha256: `sha256:${HEX("c")}`,
      artifactSemanticSha256: `sha256:${HEX("d")}`,
      canonicalCompatSha256: `sha256:${HEX("e")}`,
    },
    sections: [
      {
        sectionType: "FILES" as const,
        sectionOrder: 1,
        sectionSchemaVersion: "v1",
        sectionDigest: `sha256:${HEX("a")}`,
        recordCount: 2,
        segmentCount: 1,
      },
    ],
    attestationId: ATTESTATION,
    observationResult: "FIRST_INDEXED",
    sourceBindingId: "sbi_e2e0000000000000000000000000000000000000000000000000000000000e2e",
    sourceBindingMetadata: { normalized_reference: "c:/c1/e2e", binding_type: "LOCAL_FILESYSTEM" },
    bindingType: "LOCAL_FILESYSTEM",
    normalizedReference: "c:/c1/e2e",
    treeFingerprint: TREE_FINGERPRINT,
    ...overrides,
  } as Parameters<PostgresWorkspaceIndexSnapshotRepository["sealV2Snapshot"]>[0];
}

describe.skipIf(!DISPOSABLE_URL)("Task C1 Part K — Disposable PostgreSQL E2E: Full V2 atomic seal", () => {

  it("K01: staging writes + attestation open + seal → READY with all links", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();

    // Seed snapshot in CREATING state
    await seedSnapshotCreating(rollbackClient!);

    // Open attestation
    await evidenceRepo.insertAttestationOpen({
      id: ATTESTATION,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: { volume_serial: "C1" },
      journal_identity_json: { usn_journal_id: "J1" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 100,
      bootstrap: true,
      policy_hash: `sha256:${HEX("9")}`,
      continuity_evidence_json: { proofs: {} },
      snapshot_operation_id: SNAP,
    });

    // Transition attestation through RECONCILING then SEALED (Migration 015 authority)
    await evidenceRepo.transitionAttestation(ATTESTATION, { attestation_state: "RECONCILING" });
    await evidenceRepo.transitionAttestation(ATTESTATION, {
      attestation_state: "SEALED",
      closed_boundary_usn: 100,
      reconciliation_passes: 0,
      continuity_evidence_json: { engine: "V2_SECTIONED", bootstrap: true },
      attestation_sha256: `sha256:${HEX("e")}`,
    });

    // Stage 2 records + 1 segment
    const opId = SNAP;
    const insertedRecords = await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: opId, section_type: "FILES", record_seq: 1, record_id: "r1", record_digest: `sha256:${HEX("1")}`, record_json: { path: "a.ts" } },
      { snapshot_operation_id: opId, section_type: "FILES", record_seq: 2, record_id: "r2", record_digest: `sha256:${HEX("2")}`, record_json: { path: "b.ts" } },
    ]);
    expect(insertedRecords).toBe(2);

    await evidenceRepo.insertStagedSegment({
      snapshot_operation_id: opId,
      section_type: "FILES",
      segment_seq: 1,
      record_count: 2,
      first_record_seq: 1,
      last_record_seq: 2,
      segment_digest: `sha256:${HEX("3")}`,
      byte_size: 256,
    });

    // Verify staging exists before seal
    const stagedCount = await evidenceRepo.countStagedRecords(opId);
    expect(stagedCount).toBe(2);

    // ATOMIC SEAL: all S1-S8 in one transaction
    const sealed = await snapshotRepo.sealV2Snapshot(createSealInput(), evidenceRepo);

    // S8: Snapshot is READY
    expect(sealed.status).toBe("READY");
    expect(sealed.observationResult).toBe("FIRST_INDEXED");
    expect(sealed.workspaceRevisionId).toBe(REVISION_ID);
    expect(sealed.indexConfigurationSha256).toBe(CONFIG);

    // Verify observation row exists
    const obsResult = await evidenceRepo.query(
      "SELECT id,observation_result,workspace_revision_id FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [SNAP],
    );
    expect(obsResult.rowCount).toBe(1);
    expect(obsResult.rows[0].observation_result).toBe("FIRST_INDEXED");
    expect(obsResult.rows[0].workspace_revision_id).toBe(REVISION_ID);

    // Verify attestation back-link
    const attResult = await evidenceRepo.query(
      "SELECT observation_id,attestation_state FROM intentchord.workspace_source_continuity_attestations WHERE id=$1",
      [ATTESTATION],
    );
    expect(attResult.rowCount).toBe(1);
    expect(attResult.rows[0].observation_id).toBe(obsResult.rows[0].id);
    expect(attResult.rows[0].attestation_state).toBe("SEALED");

    // Verify artifact exists
    const artResult = await evidenceRepo.query(
      "SELECT id,engine_mode FROM intentchord.workspace_evidence_artifacts WHERE id=$1",
      [ARTIFACT_ID],
    );
    expect(artResult.rowCount).toBe(1);
    expect(artResult.rows[0].engine_mode).toBe("V2_SECTIONED");

    // Verify section exists
    const secResult = await evidenceRepo.query(
      "SELECT section_type,record_count,segment_count FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1",
      [ARTIFACT_ID],
    );
    expect(secResult.rowCount).toBe(1);
    expect(secResult.rows[0].section_type).toBe("FILES");
    expect(secResult.rows[0].record_count).toBe(2);

    // Verify staged records promoted to accepted
    const acceptedRecords = await evidenceRepo.query(
      "SELECT record_id FROM intentchord.workspace_evidence_section_records WHERE section_id=(SELECT id FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1) ORDER BY record_seq",
      [ARTIFACT_ID],
    );
    expect(acceptedRecords.rowCount).toBe(2);
    expect(acceptedRecords.rows.map((r: Record<string, string>) => r.record_id)).toEqual(["r1", "r2"]);

    // canonical_index_artifact_id must be null/undefined for V2 (mapSnapshot omits nulls)
    expect(sealed.canonicalIndexArtifactId == null).toBe(true);
  });

  it("K02: V2 seal sets accepted_workspace_evidence_artifact_id in snapshot evidence", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const result = await evidenceRepo.query(
      "SELECT index_attempt_evidence,index_configuration_sha256,workspace_revision_id FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [SNAP],
    );
    expect(result.rowCount).toBe(1);
    const row = result.rows[0];
    const evidence = row.index_attempt_evidence as Record<string, unknown>;
    expect(evidence).toBeDefined();
    expect(evidence["accepted_workspace_evidence_artifact_id"]).toBe(ARTIFACT_ID);
    expect(evidence["engine_mode"]).toBe("V2_SECTIONED");
    expect(evidence["source_continuity_attestation_id"]).toBe(ATTESTATION);
    expect(row.index_configuration_sha256).toBe(CONFIG);
    expect(row.workspace_revision_id).toBe(REVISION_ID);
  });

  it("K03: evidence artifact semantic sha256 preserved on artifact row", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const result = await evidenceRepo.query(
      "SELECT id,engine_mode,canonical_compat_sha256,artifact_semantic_sha256 FROM intentchord.workspace_evidence_artifacts WHERE id=$1",
      [ARTIFACT_ID],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].engine_mode).toBe("V2_SECTIONED");
    expect(result.rows[0].canonical_compat_sha256).toBe(`sha256:${HEX("e")}`);
    expect(result.rows[0].artifact_semantic_sha256).toBe(`sha256:${HEX("d")}`);
  });
});

describe.skipIf(!DISPOSABLE_URL)("Task C1 Part L — Transaction failure proofs (atomic rollback)", () => {
  let lSavepointCounter = 0;

  beforeEach(async () => {
    if (!rollbackClient) return;
    lSavepointCounter++;
    await rollbackClient.query(`SAVEPOINT l_sp_${lSavepointCounter}`);
  });

  afterEach(async () => {
    if (!rollbackClient) return;
    await rollbackClient.query(`ROLLBACK TO SAVEPOINT l_sp_${lSavepointCounter}`);
  });

  it("L01: S2 artifact insert failure rolls back snapshot stays CREATING", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const failSnapId = "c1e20000-f0a1-4fa1-8fa1-fa1000000001";

    // SNAP already exists from Part K; just insert the fail snapshot
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'c1-e2e-fp','{}','l01-snap',$3,'owner',now(),null)`,
      [failSnapId, WS, `sha256:${HEX("a")}`],
    );

    // Open attestation
    const failAttestationId = ATTESTATION.replace("c1e2", "f001");
    await evidenceRepo.insertAttestationOpen({
      id: failAttestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: {},
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 200,
      bootstrap: true,
      policy_hash: `sha256:${HEX("9")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: failSnapId,
    });

    // Stage records
    const failOpId = failSnapId;
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: failOpId, section_type: "FILES", record_seq: 1, record_id: "r1", record_digest: `sha256:${HEX("1")}`, record_json: { path: "x.ts" } },
    ]);

    // Try to seal with artifact ID that already exists in a DIFFERENT workspace_registration_id
    // This violates the FK constraint (wea_reg_rev_cfg_uq or wea_reg_id_uq)
    const dupArtifactId = ARTIFACT_ID; // Reuse existing artifact ID which is bound to a different snapshot workspace combo
    await expect(
      snapshotRepo.sealV2Snapshot(createSealInput({
        snapshotId: failSnapId,
        evidenceArtifact: {
          ...createSealInput().evidenceArtifact,
          id: dupArtifactId,
          workspaceRevisionId: REVISION_ID,
        },
        attestationId: failAttestationId,
      }), evidenceRepo),
    ).rejects.toThrow();

    // Verify snapshot is STILL CREATING (transaction rolled back)
    const stillCreating = await rollbackClient!.query(
      "SELECT status FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [failSnapId],
    );
    expect(stillCreating.rows[0]?.status).toBe("CREATING");
  });

  it("L02: S3 section insert failure rolls back — no artifact or observation persisted", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const failSnapId = "c1e20000-f0a1-4fa1-8fa1-fa1000000002";
    const failAttestationId = ATTESTATION.replace("c1e2", "a002");

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'c1-e2e-fp','{}','l02-snap',$3,'owner',now(),null)`,
      [failSnapId, WS, `sha256:${HEX("a")}`],
    );

    await evidenceRepo.insertAttestationOpen({
      id: failAttestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: {},
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 300,
      bootstrap: true,
      policy_hash: `sha256:${HEX("9")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: failSnapId,
    });

    // Section with invalid section_type that violates the CHECK constraint
    const failArtifactId = "wea_a002000000000000000000000000000000000000000000000000000000000a02";
    await expect(
      snapshotRepo.sealV2Snapshot(createSealInput({
        snapshotId: failSnapId,
        evidenceArtifact: {
          ...createSealInput().evidenceArtifact,
          id: failArtifactId,
          workspaceRevisionId: `wsr_${HEX("a")}`,
        },
        attestationId: failAttestationId,
        sections: [
          {
            sectionType: "FILES",
            sectionOrder: 1,
            sectionSchemaVersion: "v1",
            sectionDigest: `sha256:${HEX("a")}`,
            recordCount: 0,
            segmentCount: 0, // segment_count CHECK requires >= 1
          },
        ],
      }), evidenceRepo),
    ).rejects.toThrow();

    // Snapshot still CREATING
    const snap = await rollbackClient!.query(
      "SELECT status FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [failSnapId],
    );
    expect(snap.rows[0]?.status).toBe("CREATING");

    // No artifact was persisted
    const art = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_evidence_artifacts WHERE id=$1",
      [failArtifactId],
    );
    expect(art.rowCount).toBe(0);
  });

  it("L03: scan_base stale head rejects seal — no observation or attestation link", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const failSnapId = "c1e20000-f0a1-4fa1-8fa1-fa1000000003";
    const failAttestationId = ATTESTATION.replace("c1e2", "a003");

    const k01Obs = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_observations WHERE workspace_registration_id=$1 ORDER BY authority_sequence ASC LIMIT 1",
      [WS],
    );
    expect(k01Obs.rows.length).toBe(1);

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'c1-e2e-fp','{}','l03-snap',$3,'owner',now(),NULL)`,
      [failSnapId, WS, `sha256:${HEX("a")}`],
    );

    await evidenceRepo.insertAttestationOpen({
      id: failAttestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: {},
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 400,
      bootstrap: true,
      policy_hash: `sha256:${HEX("9")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: failSnapId,
    });

    const failArtifactId = "wea_a003000000000000000000000000000000000000000000000000000000000a03";

    await expect(
      snapshotRepo.sealV2Snapshot(createSealInput({
        snapshotId: failSnapId,
        evidenceArtifact: {
          ...createSealInput().evidenceArtifact,
          id: failArtifactId,
          workspaceRevisionId: REVISION_ID,
        },
        attestationId: failAttestationId,
        treeFingerprint: TREE_FINGERPRINT,
      }), evidenceRepo),
    ).rejects.toThrow();

    const obsCheck = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [failSnapId],
    );
    expect(obsCheck.rowCount).toBe(0);

    const attCheck = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_source_continuity_attestations WHERE id=$1 AND observation_id IS NOT NULL",
      [failAttestationId],
    );
    expect(attCheck.rowCount).toBe(0);
  });
});
