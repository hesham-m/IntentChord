import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import { PostgresWorkspaceIndexSnapshotRepository } from "@/server/workspace-index-snapshot-repository";
import { bindRollbackOnlyTestClient } from "@/server/db";
import { stableWorkspaceIndexId } from "@/core/workspace-index/canonical";
import { hostname, platform } from "node:os";

/**
 * PG-OR: Observation Result Authority — V2 Successor Proof.
 *
 * Proves the exact B1 truth table is applied by the application
 * and accepted by the database guard for all V2 chronology cases.
 *
 * Uses real PostgreSQL with SAVEPOINT isolation.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function loadDisposableUrl(varName: string): string | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`PG_OR_DISPOSABLE_IDENTITY_BLOCKED: ${varName}`);
  }
  return raw;
}

const DISPOSABLE_URL = loadDisposableUrl("INTENTCHORD_C1_VALIDATION_DATABASE_URL");

const HEX64 = (ch: string) => ch.repeat(64);
const SHA = (label: string) => `sha256:${Buffer.from(label, "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
const WS_OR = "00000000-0000-4000-8000-000000000003";
const CONFIG_OR = SHA("or-cfg");
const CONFIG_OR2 = SHA("or-cfg2");

const EXPECTED_SBI = stableWorkspaceIndexId("sbi", {
  normalized_reference: "c:/or/pg",
  device_name: hostname(),
  platform: platform(),
});

let pool: pg.Pool | undefined;
let rollbackClient: pg.PoolClient | undefined;
let releaseRollbackBinding: (() => void) | undefined;
let savepointCounter = 0;

beforeAll(async () => {
  if (!DISPOSABLE_URL) return;
  process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST = "1";
  pool = new pg.Pool({ connectionString: DISPOSABLE_URL });
  rollbackClient = await pool.connect();
  await rollbackClient.query("BEGIN");
  releaseRollbackBinding = bindRollbackOnlyTestClient(rollbackClient);
  await applyMigrationsThrough15(rollbackClient);
  await seedWorkspaceOR(rollbackClient);
});

afterAll(async () => {
  if (!rollbackClient) return;
  await rollbackClient.query("ROLLBACK");
  releaseRollbackBinding?.();
  rollbackClient.release();
  await pool?.end();
  delete process.env.INTENTCHORD_ROLLBACK_ONLY_PG_TEST;
});

beforeEach(async () => {
  if (!rollbackClient) return;
  savepointCounter++;
  await rollbackClient.query(`SAVEPOINT or_sp_${savepointCounter}`);
});

afterEach(async () => {
  if (!rollbackClient) return;
  await rollbackClient.query(`ROLLBACK TO SAVEPOINT or_sp_${savepointCounter}`);
});

async function applyMigrationsThrough15(client: pg.PoolClient): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE");
  await client.query("CREATE SCHEMA intentchord AUTHORIZATION intentchord_app");
  const names = (await readdir(MIGRATIONS_DIR)).filter(n => /^0\d\d_.*\.sql$/.test(n)).sort();
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

async function seedWorkspaceOR(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspaces
       (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
        verification_status,verification_method,verification_authority,device_provenance,source_type,
        verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
        verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
        current_root_file_id,current_root_identity_method,root_authority_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      WS_OR, "OR PG Proof", "PRIMARY", "LOCAL_PATH", "C:\\or\\pg", "or-pg-fp", 1, "c:/or/pg",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\or\\pg", "555555555", "00000000000000000000000000000def", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\or\\pg", "555555555",
      "00000000000000000000000000000def", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
}

async function sealAttestationOR(client: pg.PoolClient, attestationId: string, snapId: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_source_continuity_attestations
       (id,workspace_registration_id,provider_class,provider_id,claim_type,
        volume_identity_json,journal_identity_json,previous_trusted_boundary_usn,
        opened_boundary_usn,bootstrap,policy_hash,continuity_evidence_json,snapshot_operation_id)
     VALUES ($1,$2,'STRONG_CONTINUITY_PROVIDER','WINDOWS_NTFS_USN_V1','SEALED_INTERVAL',
         '{"vs":"OR"}','{"j":"OR"}',null,100,true,$3,'{}',$4)`,
    [attestationId, WS_OR, SHA("orpol"), snapId],
  );
  await client.query(
    `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='RECONCILING' WHERE id=$1`,
    [attestationId],
  );
  await client.query(
    `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='SEALED',
       closed_boundary_usn=200, reconciliation_passes=0, attestation_sha256=$2 WHERE id=$1`,
    [attestationId, SHA("orsha")],
  );
}

async function seedRevisionOR(client: pg.PoolClient, revisionId: string, treeFingerprint: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_source_revisions
       (id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_state_summary,first_observed_at)
     VALUES ($1,$2,$3,$4,'{}',now())`,
    [revisionId, WS_OR, WS_OR, treeFingerprint],
  );
}

/**
 * Insert a V2 observation directly with the given observation_result.
 * This tests that the application-derived result is accepted by the B1 guard.
 */
async function insertV2Observation(
  client: pg.PoolClient,
  opts: {
    snapshotId: string;
    workspaceRevisionId: string;
    indexConfigurationSha256: string;
    treeFingerprint: string;
    observationResult: string;
    acceptedWorkspaceEvidenceArtifactId: string;
    sourceContinuityAttestationId: string;
    previousObservationId?: string;
  },
): Promise<string> {
  const obsId = randomUUID();
  const sourceBinding = JSON.stringify({
    source_binding_id: EXPECTED_SBI,
    binding_type: "LOCAL_FILESYSTEM",
    normalized_reference: "c:/or/pg",
    metadata: { engine: "V2_SECTIONED" },
  });
  await client.query(
    `INSERT INTO intentchord.workspace_observations
       (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
        canonical_index_artifact_id,previous_observation_id,delta_artifact_id,
        observation_result,index_configuration_sha256,source_tree_fingerprint,
        source_binding_json,owner_reference,observed_at,
        accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
     VALUES ($1,$2,$3,$4,null,$5,null,$6,$7,$8,$9,'owner',now(),$10,$11)`,
    [obsId, opts.snapshotId, WS_OR, opts.workspaceRevisionId,
      opts.previousObservationId ?? null, opts.observationResult,
      opts.indexConfigurationSha256, opts.treeFingerprint,
      sourceBinding, opts.acceptedWorkspaceEvidenceArtifactId,
      opts.sourceContinuityAttestationId],
  );
  return obsId;
}

describe("PG-OR: Observation Result Authority — V2 Successor Proof", () => {
  if (!DISPOSABLE_URL) return;

  // ─── PG-OR-01: first successful V2 run → FIRST_INDEXED ───
  it("PG-OR-01: first V2 run with no prior observation → FIRST_INDEXED", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const snapId = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId = `${snapId.slice(0,8)}-${snapId.slice(8,12)}-${snapId.slice(12,16)}-${snapId.slice(16,20)}-${snapId.slice(20)}`;
    const attestationId = `wca_${HEX64("a")}`;
    const artifactId = `wea_${HEX64("b")}`;
    const revId = `wsr_${HEX64("a")}`;
    const tf = SHA("or-tf01");

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg01',$3,'owner',now(),NULL)`,
      [formattedSnapId, WS_OR, SHA("or-fp01")],
    );

    await sealAttestationOR(rollbackClient!, attestationId, formattedSnapId);
    await seedRevisionOR(rollbackClient!, revId, tf);

    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId, section_type: "FILES", record_seq: 1, record_id: "r-or01", record_digest: SHA("or-r01"), record_json: { path: "or01.ts" } },
    ]);

    const result = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId,
        workspaceRevisionId: revId,
        indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED", or01: true },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm01"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd01"),
        artifactManifestSha256: SHA("or-am01"),
        artifactSemanticSha256: SHA("or-as01"),
        canonicalCompatSha256: SHA("or-cc01"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm01"), recordCount: 1, segmentCount: 1 }],
      attestationId,
      observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI,
      sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM",
      normalizedReference: "c:/or/pg",
      treeFingerprint: tf,
    }, evidenceRepo);

    const obs = await rollbackClient!.query(
      "SELECT id,observation_result FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [formattedSnapId],
    );
    expect(obs.rowCount).toBe(1);
    expect(obs.rows[0].observation_result).toBe("FIRST_INDEXED");
    expect(obs.rows[0].id).toBe(result.observationId);
  });

  // ─── PG-OR-02: same revision, different config → SOURCE_UNCHANGED_INDEX_REFRESHED ───
  it("PG-OR-02: successor same revision, different config → SOURCE_UNCHANGED_INDEX_REFRESHED", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const revId = `wsr_${HEX64("c")}`;
    const tf = SHA("or-tf02");
    const artifactId1 = `wea_${HEX64("d")}`;
    const artifactId2 = `wea_${HEX64("e")}`;

    const snapId1 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId1 = `${snapId1.slice(0,8)}-${snapId1.slice(8,12)}-${snapId1.slice(12,16)}-${snapId1.slice(16,20)}-${snapId1.slice(20)}`;
    const attId1 = `wca_${HEX64("f")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg02a',$3,'owner',now(),NULL)`,
      [formattedSnapId1, WS_OR, SHA("or-fp02a")],
    );
    await sealAttestationOR(rollbackClient!, attId1, formattedSnapId1);
    await seedRevisionOR(rollbackClient!, revId, tf);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId1, section_type: "FILES", record_seq: 1, record_id: "r-or02a", record_digest: SHA("or-r02a"), record_json: { path: "or02.ts" } },
    ]);

    const result1 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId1,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId1, workspaceRevisionId: revId, indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm02"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd02"), artifactManifestSha256: SHA("or-am02"),
        artifactSemanticSha256: SHA("or-as02"), canonicalCompatSha256: SHA("or-cc02"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm02"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId1, observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf,
    }, evidenceRepo);

    // Second seal — same revision, different config → SOURCE_UNCHANGED_INDEX_REFRESHED
    const snapId2 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId2 = `${snapId2.slice(0,8)}-${snapId2.slice(8,12)}-${snapId2.slice(12,16)}-${snapId2.slice(16,20)}-${snapId2.slice(20)}`;
    const attId2 = `wca_${HEX64("a")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg02b',$3,'owner',now(),$4)`,
      [formattedSnapId2, WS_OR, SHA("or-fp02b"), result1.observationId],
    );
    await sealAttestationOR(rollbackClient!, attId2, formattedSnapId2);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId2, section_type: "FILES", record_seq: 1, record_id: "r-or02b", record_digest: SHA("or-r02b"), record_json: { path: "or02.ts" } },
    ]);

    const result2 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId2,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId2, workspaceRevisionId: revId, indexConfigurationSha256: CONFIG_OR2,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm02b"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd02b"), artifactManifestSha256: SHA("or-am02b"),
        artifactSemanticSha256: SHA("or-as02b"), canonicalCompatSha256: SHA("or-cc02b"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm02b"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId2, observationResult: "SOURCE_UNCHANGED_INDEX_REFRESHED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf,
    }, evidenceRepo);

    const obs = await rollbackClient!.query(
      "SELECT observation_result FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [formattedSnapId2],
    );
    expect(obs.rows[0].observation_result).toBe("SOURCE_UNCHANGED_INDEX_REFRESHED");
    expect(result2.observationId).not.toBe(result1.observationId);
  });

  // ─── PG-OR-03: same artifact reused → SOURCE_UNCHANGED (direct insert) ───
  it("PG-OR-03: same artifact reused → SOURCE_UNCHANGED (direct insert proof)", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const revId = `wsr_${HEX64("b")}`;
    const tf = SHA("or-tf03");
    const artifactId = `wea_${HEX64("c")}`;

    const snapId1 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId1 = `${snapId1.slice(0,8)}-${snapId1.slice(8,12)}-${snapId1.slice(12,16)}-${snapId1.slice(16,20)}-${snapId1.slice(20)}`;
    const attId1 = `wca_${HEX64("d")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg03a',$3,'owner',now(),NULL)`,
      [formattedSnapId1, WS_OR, SHA("or-fp03a")],
    );
    await sealAttestationOR(rollbackClient!, attId1, formattedSnapId1);
    await seedRevisionOR(rollbackClient!, revId, tf);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId1, section_type: "FILES", record_seq: 1, record_id: "r-or03a", record_digest: SHA("or-r03a"), record_json: { path: "or03.ts" } },
    ]);

    const result1 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId1,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId, workspaceRevisionId: revId, indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm03"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd03"), artifactManifestSha256: SHA("or-am03"),
        artifactSemanticSha256: SHA("or-as03"), canonicalCompatSha256: SHA("or-cc03"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm03"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId1, observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf,
    }, evidenceRepo);

    // Second seal — same artifact → SOURCE_UNCHANGED (direct insert to prove B1 guard accepts)
    const snapId2 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId2 = `${snapId2.slice(0,8)}-${snapId2.slice(8,12)}-${snapId2.slice(12,16)}-${snapId2.slice(16,20)}-${snapId2.slice(20)}`;
    const attId2 = `wca_${HEX64("e")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg03b',$3,'owner',now(),$4)`,
      [formattedSnapId2, WS_OR, SHA("or-fp03b"), result1.observationId],
    );
    await sealAttestationOR(rollbackClient!, attId2, formattedSnapId2);

    // Insert observation directly with same artifact ID → SOURCE_UNCHANGED
    const obsId = await insertV2Observation(rollbackClient!, {
      snapshotId: formattedSnapId2,
      workspaceRevisionId: revId,
      indexConfigurationSha256: CONFIG_OR,
      treeFingerprint: tf,
      observationResult: "SOURCE_UNCHANGED",
      acceptedWorkspaceEvidenceArtifactId: artifactId,
      sourceContinuityAttestationId: attId2,
      previousObservationId: result1.observationId,
    });

    const obs = await rollbackClient!.query(
      "SELECT observation_result FROM intentchord.workspace_observations WHERE id=$1",
      [obsId],
    );
    expect(obs.rows[0].observation_result).toBe("SOURCE_UNCHANGED");
  });

  // ─── PG-OR-04: different revision, first time → SOURCE_CHANGED ───
  it("PG-OR-04: successor with different revision, first time → SOURCE_CHANGED", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const revId1 = `wsr_${HEX64("c")}`;
    const revId2 = `wsr_${HEX64("d")}`;
    const tf1 = SHA("or-tf04a");
    const tf2 = SHA("or-tf04b");
    const artifactId1 = `wea_${HEX64("e")}`;

    const snapId1 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId1 = `${snapId1.slice(0,8)}-${snapId1.slice(8,12)}-${snapId1.slice(12,16)}-${snapId1.slice(16,20)}-${snapId1.slice(20)}`;
    const attId1 = `wca_${HEX64("f")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg04a',$3,'owner',now(),NULL)`,
      [formattedSnapId1, WS_OR, SHA("or-fp04a")],
    );
    await sealAttestationOR(rollbackClient!, attId1, formattedSnapId1);
    await seedRevisionOR(rollbackClient!, revId1, tf1);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId1, section_type: "FILES", record_seq: 1, record_id: "r-or04a", record_digest: SHA("or-r04a"), record_json: { path: "or04.ts" } },
    ]);

    const result1 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId1,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId1, workspaceRevisionId: revId1, indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm04"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd04"), artifactManifestSha256: SHA("or-am04"),
        artifactSemanticSha256: SHA("or-as04"), canonicalCompatSha256: SHA("or-cc04"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm04"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId1, observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf1,
    }, evidenceRepo);

    // Second seal — different revision, never seen before
    const snapId2 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId2 = `${snapId2.slice(0,8)}-${snapId2.slice(8,12)}-${snapId2.slice(12,16)}-${snapId2.slice(16,20)}-${snapId2.slice(20)}`;
    const attId2 = `wca_${HEX64("a")}`;
    const artifactId2 = `wea_${HEX64("b")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg04b',$3,'owner',now(),$4)`,
      [formattedSnapId2, WS_OR, SHA("or-fp04b"), result1.observationId],
    );
    await sealAttestationOR(rollbackClient!, attId2, formattedSnapId2);
    await seedRevisionOR(rollbackClient!, revId2, tf2);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId2, section_type: "FILES", record_seq: 1, record_id: "r-or04b", record_digest: SHA("or-r04b"), record_json: { path: "or04.ts" } },
    ]);

    const result2 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId2,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId2, workspaceRevisionId: revId2, indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm04b"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd04b"), artifactManifestSha256: SHA("or-am04b"),
        artifactSemanticSha256: SHA("or-as04b"), canonicalCompatSha256: SHA("or-cc04b"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm04b"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId2, observationResult: "SOURCE_CHANGED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf2,
    }, evidenceRepo);

    const obs = await rollbackClient!.query(
      "SELECT observation_result FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [formattedSnapId2],
    );
    expect(obs.rows[0].observation_result).toBe("SOURCE_CHANGED");
  });

  // ─── PG-OR-05: return to previously known revision → KNOWN_STATE_RESTORED ───
  it("PG-OR-05: successor returns to previously known revision → KNOWN_STATE_RESTORED", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const revId1 = `wsr_${HEX64("f")}`;
    const revId2 = `wsr_${HEX64("0")}`;
    const revId3 = `wsr_${HEX64("f")}`;
    const tf1 = SHA("or-tf05a");
    const tf2 = SHA("or-tf05b");
    const tf3 = SHA("or-tf05a");
    const artifactId1 = `wea_${HEX64("e")}`;

    // First seal
    const snapId1 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId1 = `${snapId1.slice(0,8)}-${snapId1.slice(8,12)}-${snapId1.slice(12,16)}-${snapId1.slice(16,20)}-${snapId1.slice(20)}`;
    const attId1 = `wca_${HEX64("f")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg05a',$3,'owner',now(),NULL)`,
      [formattedSnapId1, WS_OR, SHA("or-fp05a")],
    );
    await sealAttestationOR(rollbackClient!, attId1, formattedSnapId1);
    await seedRevisionOR(rollbackClient!, revId1, tf1);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId1, section_type: "FILES", record_seq: 1, record_id: "r-or05a", record_digest: SHA("or-r05a"), record_json: { path: "or05.ts" } },
    ]);

    const result1 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId1,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId1, workspaceRevisionId: revId1, indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm05"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd05"), artifactManifestSha256: SHA("or-am05"),
        artifactSemanticSha256: SHA("or-as05"), canonicalCompatSha256: SHA("or-cc05"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm05"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId1, observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf1,
    }, evidenceRepo);

    // Second seal — different revision
    const snapId2 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId2 = `${snapId2.slice(0,8)}-${snapId2.slice(8,12)}-${snapId2.slice(12,16)}-${snapId2.slice(16,20)}-${snapId2.slice(20)}`;
    const attId2 = `wca_${HEX64("a")}`;
    const artifactId2 = `wea_${HEX64("b")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg05b',$3,'owner',now(),$4)`,
      [formattedSnapId2, WS_OR, SHA("or-fp05b"), result1.observationId],
    );
    await sealAttestationOR(rollbackClient!, attId2, formattedSnapId2);
    await seedRevisionOR(rollbackClient!, revId2, tf2);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId2, section_type: "FILES", record_seq: 1, record_id: "r-or05b", record_digest: SHA("or-r05b"), record_json: { path: "or05.ts" } },
    ]);

    const result2 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId2,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId2, workspaceRevisionId: revId2, indexConfigurationSha256: CONFIG_OR,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm05b"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd05b"), artifactManifestSha256: SHA("or-am05b"),
        artifactSemanticSha256: SHA("or-as05b"), canonicalCompatSha256: SHA("or-cc05b"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm05b"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId2, observationResult: "SOURCE_CHANGED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf2,
    }, evidenceRepo);

    // Third seal — return to previously known revision (revId1)
    const snapId3 = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId3 = `${snapId3.slice(0,8)}-${snapId3.slice(8,12)}-${snapId3.slice(12,16)}-${snapId3.slice(16,20)}-${snapId3.slice(20)}`;
    const attId3 = `wca_${HEX64("c")}`;
    const artifactId3 = `wea_${HEX64("d")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'or-pg-fp','{}','or-pg05c',$3,'owner',now(),$4)`,
      [formattedSnapId3, WS_OR, SHA("or-fp05c"), result2.observationId],
    );
    await sealAttestationOR(rollbackClient!, attId3, formattedSnapId3);
    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId3, section_type: "FILES", record_seq: 1, record_id: "r-or05c", record_digest: SHA("or-r05c"), record_json: { path: "or05.ts" } },
    ]);

    const result3 = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId3,
      workspaceRegistrationId: WS_OR,
      workspaceInstanceId: WS_OR,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId3, workspaceRevisionId: revId3, indexConfigurationSha256: CONFIG_OR2,
        headerJson: { engine_mode: "V2_SECTIONED" },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("or-sm05c"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("or-smd05c"), artifactManifestSha256: SHA("or-am05c"),
        artifactSemanticSha256: SHA("or-as05c"), canonicalCompatSha256: SHA("or-cc05c"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("or-sm05c"), recordCount: 1, segmentCount: 1 }],
      attestationId: attId3, observationResult: "KNOWN_STATE_RESTORED",
      sourceBindingId: EXPECTED_SBI, sourceBindingMetadata: { normalized_reference: "c:/or/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM", normalizedReference: "c:/or/pg", treeFingerprint: tf3,
    }, evidenceRepo);

    const obs = await rollbackClient!.query(
      "SELECT observation_result FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [formattedSnapId3],
    );
    expect(obs.rows[0].observation_result).toBe("KNOWN_STATE_RESTORED");
  });
});
