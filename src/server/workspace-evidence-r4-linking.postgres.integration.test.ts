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
 * R4 Targeted PostgreSQL Proof — Observation/Attestation Linking + Source Binding Authority.
 *
 * Each test uses SAVEPOINTs for isolation within the shared rollback transaction.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function loadDisposableUrl(varName: string): string | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`R4_PG_DISPOSABLE_IDENTITY_BLOCKED: ${varName}`);
  }
  return raw;
}

const DISPOSABLE_URL = loadDisposableUrl("INTENTCHORD_C1_VALIDATION_DATABASE_URL");

const HEX64 = (ch: string) => ch.repeat(64);
const WCA = (label: string) => `wca_${Buffer.from(label, "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
const SHA = (label: string) => `sha256:${Buffer.from(label, "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
const WS_R4 = "00000000-0000-4000-8000-000000000002";
const REVISION_ID_R4 = `wsr_${HEX64("a")}`;
const CONFIG_R4 = SHA("r4cfg");

const EXPECTED_SBI = stableWorkspaceIndexId("sbi", {
  normalized_reference: "c:/r4/pg",
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
  await applyMigrationsThrough14(rollbackClient);
  await applyMigration015(rollbackClient);
  await seedWorkspaceR4(rollbackClient);
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

beforeEach(async () => {
  if (!rollbackClient) return;
  savepointCounter++;
  await rollbackClient.query(`SAVEPOINT test_sp_${savepointCounter}`);
});

afterEach(async () => {
  if (!rollbackClient) return;
  await rollbackClient.query(`ROLLBACK TO SAVEPOINT test_sp_${savepointCounter}`);
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

async function seedWorkspaceR4(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspaces
       (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
        verification_status,verification_method,verification_authority,device_provenance,source_type,
        verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
        verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
        current_root_file_id,current_root_identity_method,root_authority_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      WS_R4, "R4 PG Proof", "PRIMARY", "LOCAL_PATH", "C:\\r4\\pg", "r4-pg-fp", 1, "c:/r4/pg",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\r4\\pg", "444444444", "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\r4\\pg", "444444444",
      "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
}

async function seedSnapshotR4(client: pg.PoolClient, snapId: string, idempotencyKey: string, scanBaseObservationId?: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_index_snapshots
       (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
        workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
        snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
     VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'r4-pg-fp','{}',$3,$4,'owner',now(),$5)`,
    [snapId, WS_R4, idempotencyKey, `sha256:${HEX64("a")}`, scanBaseObservationId ?? null],
  );
}

async function stageRecordsR4(client: pg.PoolClient, snapId: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_evidence_staging_records
       (snapshot_operation_id, section_type, record_seq, record_id, record_digest, source_file_revision_id, record_json)
     VALUES ($1,'FILES',1,'r4r1',$2,null,$3)`,
    [snapId, SHA("r4r1"), JSON.stringify({ path: "r4.ts" })],
  );
  await client.query(
    `INSERT INTO intentchord.workspace_evidence_staging_segments
       (snapshot_operation_id, section_type, segment_seq, record_count, first_record_seq, last_record_seq, segment_digest, byte_size)
     VALUES ($1,'FILES',1,1,1,1,$2,128)`,
    [snapId, SHA("r4s1")],
  );
}

async function sealAttestationR4(client: pg.PoolClient, attestationId: string, snapId: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_source_continuity_attestations
       (id,workspace_registration_id,provider_class,provider_id,claim_type,
        volume_identity_json,journal_identity_json,previous_trusted_boundary_usn,
        opened_boundary_usn,bootstrap,policy_hash,continuity_evidence_json,snapshot_operation_id)
     VALUES ($1,$2,'STRONG_CONTINUITY_PROVIDER','WINDOWS_NTFS_USN_V1','SEALED_INTERVAL',
         '{"vs":"R4"}','{"j":"R4"}',null,100,true,$3,'{}',$4)`,
    [attestationId, WS_R4, SHA("r4pol"), snapId],
  );
  await client.query(
    `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='RECONCILING' WHERE id=$1`,
    [attestationId],
  );
  await client.query(
    `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='SEALED',
       closed_boundary_usn=200, reconciliation_passes=0, attestation_sha256=$2 WHERE id=$1`,
    [attestationId, SHA("r4sha")],
  );
}

async function seedRevisionR4(client: pg.PoolClient, revisionId: string, treeFingerprint: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_source_revisions
       (id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,source_state_summary,first_observed_at)
     VALUES ($1,$2,$3,$4,'{}',now())`,
    [revisionId, WS_R4, WS_R4, treeFingerprint],
  );
}

// V2 authority-aligned artifact fixture; retired canonical artifact tables are not recreated.
async function seedCiaR4(client: pg.PoolClient, artifactId: string, revisionId: string, configSha: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_evidence_artifacts
       (id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,
        header_json,section_manifest_json,section_manifest_digest,
        artifact_manifest_sha256,artifact_semantic_sha256,canonical_compat_sha256)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,'[]'::jsonb,$5,$6,$7,$8)`,
    [artifactId, WS_R4, revisionId, configSha, SHA('r4sec'), SHA('r4manifest'), SHA('r4semantic'), SHA('r4compat')],
  );
}

describe.skipIf(!DISPOSABLE_URL)("R4 Targeted PostgreSQL Proof", () => {

  it("PG-R4-01: valid SEALED-unlinked attestation → Observation → set-once back-link", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapId = randomUUID();
    const attestationId = WCA("r401");
    const tf = SHA("r4tf01");
    const revId = `wsr_${Buffer.from("r401rev", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const ciaId = `wea_${Buffer.from("r401art", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg01-snap");
    await seedRevisionR4(rollbackClient!, revId, tf);
    await seedCiaR4(rollbackClient!, ciaId, revId, CONFIG_R4);
    await sealAttestationR4(rollbackClient!, attestationId, snapId);

    const obsId = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8,$9)`,
      [obsId, snapId, WS_R4, revId, CONFIG_R4, tf,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
        ciaId, attestationId],
    );

    await evidenceRepo.transitionAttestation(attestationId, { observation_id: obsId });

    const att = await evidenceRepo.getAttestation(attestationId);
    expect(att).not.toBeNull();
    expect(att!.attestation_state).toBe("SEALED");
    expect(att!.observation_id).toBe(obsId);
  });

  it("PG-R4-02: Observation source_binding_json contains real sbi_ identity", async () => {
    const snapId = randomUUID();
    const tf = SHA("r4tf02");
    const revId = `wsr_${Buffer.from("r402rev", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const ciaId = `wea_${Buffer.from("r402art", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg02-snap");
    await seedRevisionR4(rollbackClient!, revId, tf);
    await seedCiaR4(rollbackClient!, ciaId, revId, CONFIG_R4);
    const attestationId = WCA("r402");
    await sealAttestationR4(rollbackClient!, attestationId, snapId);
    const obsId = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8,$9)`,
      [obsId, snapId, WS_R4, revId, CONFIG_R4, tf,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: { engine: "V2_SECTIONED" } }),
        ciaId, attestationId],
    );

    const result = await rollbackClient!.query(
      "SELECT source_binding_json FROM intentchord.workspace_observations WHERE id=$1",
      [obsId],
    );
    const sb = result.rows[0].source_binding_json;
    expect(sb.source_binding_id).toBe(EXPECTED_SBI);
    expect(sb.source_binding_id).toMatch(/^sbi_[0-9a-f]{64}$/);
    expect(sb.binding_type).toBe("LOCAL_FILESYSTEM");
    expect(sb.normalized_reference).toBe("c:/r4/pg");
    expect(sb.metadata).toEqual({ engine: "V2_SECTIONED" });
  });

  it("PG-R4-03: Observation referencing non-SEALED attestation fails closed", async () => {
    const snapId = randomUUID();
    const attestationId = WCA("r403");
    const tf = SHA("r4tf03");
    const revId = `wsr_${Buffer.from("r403rev", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg03-snap");
    await seedRevisionR4(rollbackClient!, revId, tf);
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_source_continuity_attestations
         (id,workspace_registration_id,provider_class,provider_id,claim_type,
          volume_identity_json,journal_identity_json,previous_trusted_boundary_usn,
          opened_boundary_usn,bootstrap,policy_hash,continuity_evidence_json,snapshot_operation_id)
       VALUES ($1,$2,'STRONG_CONTINUITY_PROVIDER','WINDOWS_NTFS_USN_V1','SEALED_INTERVAL',
          '{}','{}',null,100,true,$3,'{}',$4)`,
      [attestationId, WS_R4, SHA("r4pol"), snapId],
    );

    const obsId = randomUUID();
    await expect(
      rollbackClient!.query(
        `INSERT INTO intentchord.workspace_observations
           (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
            observation_result,index_configuration_sha256,source_tree_fingerprint,
            source_binding_json,owner_reference,observed_at,source_continuity_attestation_id)
         VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8)`,
        [obsId, snapId, WS_R4, revId, CONFIG_R4, tf,
          JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
          attestationId],
      ),
    ).rejects.toThrow(/INTENTCHORD_WO_V2_ATTESTATION_NOT_SEALED_UNLINKED/);
  });

  it("PG-R4-04: second distinct Observation cannot retarget already-linked attestation", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapId1 = randomUUID();
    const snapId2 = randomUUID();
    const attestationId = WCA("r404");
    const tf1 = SHA("r4tf04a");
    const revId1 = `wsr_${Buffer.from("r404r1", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const ciaId1 = `wea_${Buffer.from("r404a1", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId1, "r4pg04-snap1");
    await seedRevisionR4(rollbackClient!, revId1, tf1);
    await seedCiaR4(rollbackClient!, ciaId1, revId1, CONFIG_R4);
    await sealAttestationR4(rollbackClient!, attestationId, snapId1);

    const obsId1 = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8,$9)`,
      [obsId1, snapId1, WS_R4, revId1, CONFIG_R4, tf1,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
        ciaId1, attestationId],
    );
    await evidenceRepo.transitionAttestation(attestationId, { observation_id: obsId1 });

    await seedSnapshotR4(rollbackClient!, snapId2, "r4pg04-snap2");
    const secondAttestationId = WCA("r404second");
    await sealAttestationR4(rollbackClient!, secondAttestationId, snapId2);
    await rollbackClient!.query(
      `UPDATE intentchord.workspace_index_snapshots SET scan_base_observation_id=$1 WHERE id=$2`,
      [obsId1, snapId2],
    );
    const obsId2 = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,previous_observation_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'SOURCE_UNCHANGED',$5,$6,$7,'owner',now(),$8,$9,$10)`,
      [obsId2, snapId2, WS_R4, revId1, CONFIG_R4, tf1,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
        ciaId1, obsId1, secondAttestationId],
    );

    await rollbackClient!.query(`SAVEPOINT r404_retarg`);
    await expect(
      evidenceRepo.transitionAttestation(attestationId, { observation_id: obsId2 }),
    ).rejects.toThrow();
    await rollbackClient!.query(`ROLLBACK TO SAVEPOINT r404_retarg`);

    const att = await evidenceRepo.getAttestation(attestationId);
    expect(att!.observation_id).toBe(obsId1);
  });

  it("PG-R4-05: failure after Observation insert before backlink causes full Step-B rollback", async () => {
    const snapId = randomUUID();
    const attestationId = WCA("r405");
    const tf = SHA("r4tf05");
    const revId = `wsr_${Buffer.from("r405rev", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const ciaId = `wea_${Buffer.from("r405art", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg05-snap");
    await seedRevisionR4(rollbackClient!, revId, tf);
    await seedCiaR4(rollbackClient!, ciaId, revId, CONFIG_R4);
    await sealAttestationR4(rollbackClient!, attestationId, snapId);

    await rollbackClient!.query(`SAVEPOINT r405_inner`);
    const obsId = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8,$9)`,
      [obsId, snapId, WS_R4, revId, CONFIG_R4, tf,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
        ciaId, attestationId],
    );

    await rollbackClient!.query(`ROLLBACK TO SAVEPOINT r405_inner`);

    const obs = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [snapId],
    );
    expect(obs.rowCount).toBe(0);

    const att = await rollbackClient!.query(
      "SELECT observation_id FROM intentchord.workspace_source_continuity_attestations WHERE id=$1",
      [attestationId],
    );
    expect(att.rows[0].observation_id).toBeNull();
  });

  it("PG-R4-06: failure after backlink before Step-B commit causes full rollback", async () => {
    const snapId = randomUUID();
    const attestationId = WCA("r406");
    const tf = SHA("r4tf06");
    const revId = `wsr_${Buffer.from("r406rev", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const ciaId = `wea_${Buffer.from("r406art", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg06-snap");
    await seedRevisionR4(rollbackClient!, revId, tf);
    await seedCiaR4(rollbackClient!, ciaId, revId, CONFIG_R4);
    await sealAttestationR4(rollbackClient!, attestationId, snapId);

    await rollbackClient!.query(`SAVEPOINT r406_inner`);
    const obsId = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8,$9)`,
      [obsId, snapId, WS_R4, revId, CONFIG_R4, tf,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
        ciaId, attestationId],
    );

    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET observation_id=$2 WHERE id=$1`,
      [attestationId, obsId],
    );

    await rollbackClient!.query(`ROLLBACK TO SAVEPOINT r406_inner`);

    const obs = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [snapId],
    );
    expect(obs.rowCount).toBe(0);

    const att = await rollbackClient!.query(
      "SELECT observation_id FROM intentchord.workspace_source_continuity_attestations WHERE id=$1",
      [attestationId],
    );
    expect(att.rows[0].observation_id).toBeNull();
  });

  it("PG-R4-07: unlinked SEALED attestation cannot be selected as valid predecessor", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapId = randomUUID();
    const attestationId = WCA("r407");
    const tf = SHA("r4tf07");
    const revId = `wsr_${Buffer.from("r407rev", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const ciaId = `wea_${Buffer.from("r407art", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg07-snap");
    await seedRevisionR4(rollbackClient!, revId, tf);
    await seedCiaR4(rollbackClient!, ciaId, revId, CONFIG_R4);
    await sealAttestationR4(rollbackClient!, attestationId, snapId);

    const obsId = randomUUID();
    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_observations
         (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
          observation_result,index_configuration_sha256,source_tree_fingerprint,
          source_binding_json,owner_reference,observed_at,accepted_workspace_evidence_artifact_id,source_continuity_attestation_id)
       VALUES ($1,$2,$3,$4,'FIRST_INDEXED',$5,$6,$7,'owner',now(),$8,$9)`,
      [obsId, snapId, WS_R4, revId, CONFIG_R4, tf,
        JSON.stringify({ source_binding_id: EXPECTED_SBI, binding_type: "LOCAL_FILESYSTEM", normalized_reference: "c:/r4/pg", metadata: {} }),
        ciaId, attestationId],
    );

    const predecessor = await evidenceRepo.getSealedAttestationForObservation(WS_R4, obsId);
    expect(predecessor).toBeNull();
  });

  it("PG-R4-08: Snapshot cannot satisfy V2 READY binding without committed Observation + backlink", async () => {
    const snapId = randomUUID();
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg08-snap");

    await expect(
      rollbackClient!.query(
        `UPDATE intentchord.workspace_index_snapshots SET
           status='READY', completed_at=now(), progress_phase='READY', heartbeat_at=now(),
           workspace_observation_id=$2, workspace_revision_id=$3,
           index_configuration_sha256=$4, observation_result='FIRST_INDEXED',
           index_attempt_status='SUCCEEDED', index_attempt_evidence='{}'::jsonb,
           accepted_workspace_evidence_artifact_id='wea_nonexistent',
           source_continuity_attestation_id='wca_nonexistent'
         WHERE id=$1 AND status='CREATING'`,
        [snapId, randomUUID(), REVISION_ID_R4, CONFIG_R4],
      ),
    ).rejects.toThrow();
  });

  it("PG-R4-09: successful bounded link sequence produces coherent IDs", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapId = randomUUID();
    const attestationId = WCA("r409");
    const artifactId = `wea_${Buffer.from("r409art", "utf-8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
    await seedSnapshotR4(rollbackClient!, snapId, "r4pg09-snap");
    await stageRecordsR4(rollbackClient!, snapId);
    await sealAttestationR4(rollbackClient!, attestationId, snapId);

    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const sealed = await snapshotRepo.sealV2Snapshot({
      snapshotId: snapId,
      workspaceRegistrationId: WS_R4,
      workspaceInstanceId: WS_R4,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId,
        workspaceRevisionId: REVISION_ID_R4,
        indexConfigurationSha256: CONFIG_R4,
        headerJson: { engine_mode: "V2_SECTIONED", r4: true },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: SHA("r4s"), record_count: 1, segment_count: 1 }],
        sectionManifestDigest: SHA("r4sm"),
        artifactManifestSha256: SHA("r4am"),
        artifactSemanticSha256: SHA("r4as"),
        canonicalCompatSha256: SHA("r4cc"),
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: SHA("r4s"), recordCount: 1, segmentCount: 1 }],
      attestationId,
      observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI,
      sourceBindingMetadata: { engine: "V2_SECTIONED" },
      bindingType: "LOCAL_FILESYSTEM",
      normalizedReference: "c:/r4/pg",
      treeFingerprint: SHA("r4tf09"),
    }, evidenceRepo);

    expect(sealed.status).toBe("READY");

    const obs = await rollbackClient!.query(
      "SELECT id,source_binding_json FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [snapId],
    );
    expect(obs.rowCount).toBe(1);
    const sb = obs.rows[0].source_binding_json;
    expect(sb.source_binding_id).toBe(EXPECTED_SBI);
    expect(sb.source_binding_id).toMatch(/^sbi_[0-9a-f]{64}$/);
    expect(sb.binding_type).toBe("LOCAL_FILESYSTEM");

    const att = await evidenceRepo.getAttestation(attestationId);
    expect(att!.attestation_state).toBe("SEALED");
    expect(att!.observation_id).toBe(obs.rows[0].id);

    const art = await rollbackClient!.query(
      "SELECT id,engine_mode FROM intentchord.workspace_evidence_artifacts WHERE id=$1",
      [artifactId],
    );
    expect(art.rowCount).toBe(1);
    expect(art.rows[0].engine_mode).toBe("V2_SECTIONED");
  });

  // ─── PG-R4-10: Step-B commit succeeds, READY intentionally fails ───
  it("PG-R4-10: Step-B committed evidence survives intentional READY failure, snapshot stays non-READY", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const snapId = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId = `${snapId.slice(0,8)}-${snapId.slice(8,12)}-${snapId.slice(12,16)}-${snapId.slice(16,20)}-${snapId.slice(20)}`;
    const attestationId = `wca_${HEX64("a")}`;
    const artifactId = `wea_${HEX64("b")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'r4-pg-fp','{}','r4-pgr10',$3,'owner',now(),NULL)`,
      [formattedSnapId, WS_R4, `sha256:${HEX64("c")}`],
    );

    await evidenceRepo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS_R4,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: {},
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 1000,
      bootstrap: true,
      policy_hash: `sha256:${HEX64("d")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: formattedSnapId,
    });

    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='RECONCILING' WHERE id=$1`,
      [attestationId],
    );
    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='SEALED',
         closed_boundary_usn=200, reconciliation_passes=0, attestation_sha256=$2 WHERE id=$1`,
      [attestationId, SHA("r4sha10")],
    );

    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId, section_type: "FILES", record_seq: 1, record_id: "r-pgr10", record_digest: `sha256:${HEX64("e")}`, record_json: { path: "pgr10.ts" } },
    ]);

    const stepBResult = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId,
      workspaceRegistrationId: WS_R4,
      workspaceInstanceId: WS_R4,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId,
        workspaceRevisionId: REVISION_ID_R4,
        indexConfigurationSha256: CONFIG_R4,
        headerJson: { engine_mode: "V2_SECTIONED", pgr10: true },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: `sha256:${HEX64("f")}`, record_count: 1, segment_count: 1 }],
        sectionManifestDigest: `sha256:${HEX64("a")}`,
        artifactManifestSha256: `sha256:${HEX64("b")}`,
        artifactSemanticSha256: `sha256:${HEX64("c")}`,
        canonicalCompatSha256: `sha256:${HEX64("d")}`,
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: `sha256:${HEX64("f")}`, recordCount: 1, segmentCount: 1 }],
      attestationId,
      observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI,
      sourceBindingMetadata: { normalized_reference: "c:/r4/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM",
      normalizedReference: "c:/r4/pg",
      treeFingerprint: SHA("r4tfr10"),
    }, evidenceRepo);

    expect(stepBResult.observationId).toBeTruthy();
    expect(stepBResult.revisionId).toBe(REVISION_ID_R4);

    const obsAfterStepB = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [formattedSnapId],
    );
    expect(obsAfterStepB.rowCount).toBe(1);

    const attAfterStepB = await evidenceRepo.getAttestation(attestationId);
    expect(attAfterStepB!.attestation_state).toBe("SEALED");
    expect(attAfterStepB!.observation_id).toBe(stepBResult.observationId);

    const snapAfterStepB = await rollbackClient!.query(
      "SELECT status FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [formattedSnapId],
    );
    expect(snapAfterStepB.rows[0].status).toBe("CREATING");

    try {
      await snapshotRepo.transitionToReady(
        { snapshotId: formattedSnapId, completedAt: new Date().toISOString(), evidenceArtifact: { id: artifactId, indexConfigurationSha256: CONFIG_R4 }, attestationId, observationResult: "FIRST_INDEXED" },
        "nonexistent-observation-id",
        "nonexistent-revision-id",
      );
    } catch {
      // Expected: READY update may fail because observation_id FK or status check
    }

    const snapAfterReadyFailure = await rollbackClient!.query(
      "SELECT status FROM intentchord.workspace_index_snapshots WHERE id=$1",
      [formattedSnapId],
    );
    expect(snapAfterReadyFailure.rows[0].status).toBe("CREATING");

    const obsAfterReadyFailure = await rollbackClient!.query(
      "SELECT id FROM intentchord.workspace_observations WHERE snapshot_operation_id=$1",
      [formattedSnapId],
    );
    expect(obsAfterReadyFailure.rowCount).toBe(1);

    const attAfterReadyFailure = await evidenceRepo.getAttestation(attestationId);
    expect(attAfterReadyFailure!.observation_id).toBe(stepBResult.observationId);
  });

  // ─── PG-R4-11: retry/recovery does not create duplicate authority ───
  it("PG-R4-11: retry after Step-C failure does not create duplicate observation or retarget attestation", async () => {
    const evidenceRepo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const snapshotRepo = new PostgresWorkspaceIndexSnapshotRepository();
    const snapId = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnapId = `${snapId.slice(0,8)}-${snapId.slice(8,12)}-${snapId.slice(12,16)}-${snapId.slice(16,20)}-${snapId.slice(20)}`;
    const attestationId = `wca_${HEX64("c")}`;
    const artifactId = `wea_${HEX64("d")}`;

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'r4-pg-fp','{}','r4-pgr11',$3,'owner',now(),NULL)`,
      [formattedSnapId, WS_R4,
`sha256:${HEX64("e")}`],
    );

    await evidenceRepo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS_R4,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: {},
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 1100,
      bootstrap: true,
      policy_hash: `sha256:${HEX64("f")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: formattedSnapId,
    });

    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='RECONCILING' WHERE id=$1`,
      [attestationId],
    );
    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='SEALED',
         closed_boundary_usn=200, reconciliation_passes=0, attestation_sha256=$2 WHERE id=$1`,
      [attestationId, SHA("r4sha11")],
    );

    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnapId, section_type: "FILES", record_seq: 1, record_id: "r-pgr11", record_digest: `sha256:${HEX64("a")}`, record_json: { path: "pgr11.ts" } },
    ]);

    const stepBResult = await snapshotRepo.commitStepB({
      snapshotId: formattedSnapId,
      workspaceRegistrationId: WS_R4,
      workspaceInstanceId: WS_R4,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId,
        workspaceRevisionId: REVISION_ID_R4,
        indexConfigurationSha256: CONFIG_R4,
        headerJson: { engine_mode: "V2_SECTIONED", pgr11: true },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: `sha256:${HEX64("b")}`, record_count: 1, segment_count: 1 }],
        sectionManifestDigest: `sha256:${HEX64("c")}`,
        artifactManifestSha256: `sha256:${HEX64("d")}`,
        artifactSemanticSha256: `sha256:${HEX64("e")}`,
        canonicalCompatSha256: `sha256:${HEX64("f")}`,
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: `sha256:${HEX64("b")}`, recordCount: 1, segmentCount: 1 }],
      attestationId,
      observationResult: "FIRST_INDEXED",
      sourceBindingId: EXPECTED_SBI,
      sourceBindingMetadata: { normalized_reference: "c:/r4/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM",
      normalizedReference: "c:/r4/pg",
      treeFingerprint: SHA("r4tfr11"),
    }, evidenceRepo);

    const obsCount = await rollbackClient!.query(
      "SELECT COUNT(*) as cnt FROM intentchord.workspace_observations WHERE workspace_registration_id=$1 AND source_tree_fingerprint=$2",
      [WS_R4, SHA("r4tfr11")],
    );
    expect(Number(obsCount.rows[0].cnt)).toBe(1);

    const attLinked = await evidenceRepo.getAttestation(attestationId);
    expect(attLinked!.observation_id).toBe(stepBResult.observationId);

    const snap2Id = randomUUID().replace(/-/g, "").slice(0, 32);
    const formattedSnap2Id = `${snap2Id.slice(0,8)}-${snap2Id.slice(8,12)}-${snap2Id.slice(12,16)}-${snap2Id.slice(16,20)}-${snap2Id.slice(20)}`;
    const attestationId2 = `wca_${HEX64("e")}`;
    const artifactId2 = `wea_${HEX64("f")}`;
    const retryConfig = SHA("r4cfg-r2");

    await rollbackClient!.query(
      `INSERT INTO intentchord.workspace_index_snapshots
         (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
          workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
          snapshot_request_fingerprint_sha256,owner_reference,started_at,scan_base_observation_id)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'r4-pg-fp','{}','r4-pgr11-r2',$3,'owner',now(),$4)`,
      [formattedSnap2Id, WS_R4,
`sha256:${HEX64("c")}`, stepBResult.observationId],
    );

    await evidenceRepo.insertAttestationOpen({
      id: attestationId2,
      workspace_registration_id: WS_R4,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: {},
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 1200,
      bootstrap: false,
      policy_hash: `sha256:${HEX64("d")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: formattedSnap2Id,
    });

    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='RECONCILING' WHERE id=$1`,
      [attestationId2],
    );
    await rollbackClient!.query(
      `UPDATE intentchord.workspace_source_continuity_attestations SET attestation_state='SEALED',
         closed_boundary_usn=200, reconciliation_passes=0, attestation_sha256=$2 WHERE id=$1`,
      [attestationId2, SHA("r4sha11r2")],
    );

    await evidenceRepo.insertStagedRecords([
      { snapshot_operation_id: formattedSnap2Id, section_type: "FILES", record_seq: 1, record_id: "r-pgr11-r2", record_digest: `sha256:${HEX64("e")}`, record_json: { path: "pgr11-r2.ts" } },
    ]);

    const retryResult = await snapshotRepo.commitStepB({
      snapshotId: formattedSnap2Id,
      workspaceRegistrationId: WS_R4,
      workspaceInstanceId: WS_R4,
      completedAt: new Date().toISOString(),
      evidenceArtifact: {
        id: artifactId2,
        workspaceRevisionId: REVISION_ID_R4,
        indexConfigurationSha256: retryConfig,
        headerJson: { engine_mode: "V2_SECTIONED", pgr11r2: true },
        sectionManifestJson: [{ section_type: "FILES", section_schema_version: "v1", section_digest: `sha256:${HEX64("f")}`, record_count: 1, segment_count: 1 }],
        sectionManifestDigest: `sha256:${HEX64("a")}`,
        artifactManifestSha256: `sha256:${HEX64("b")}`,
        artifactSemanticSha256: `sha256:${HEX64("c")}`,
        canonicalCompatSha256: `sha256:${HEX64("d")}`,
      },
      sections: [{ sectionType: "FILES", sectionOrder: 1, sectionSchemaVersion: "v1", sectionDigest: `sha256:${HEX64("f")}`, recordCount: 1, segmentCount: 1 }],
      attestationId: attestationId2,
      observationResult: "SOURCE_UNCHANGED_INDEX_REFRESHED",
      sourceBindingId: EXPECTED_SBI,
      sourceBindingMetadata: { normalized_reference: "c:/r4/pg", binding_type: "LOCAL_FILESYSTEM" },
      bindingType: "LOCAL_FILESYSTEM",
      normalizedReference: "c:/r4/pg",
      treeFingerprint: SHA("r4tfr11"),
    }, evidenceRepo);

    const attOriginal = await evidenceRepo.getAttestation(attestationId);
    expect(attOriginal!.observation_id).toBe(stepBResult.observationId);

    const attRetry = await evidenceRepo.getAttestation(attestationId2);
    expect(attRetry!.observation_id).toBe(retryResult.observationId);
    expect(attRetry!.observation_id).not.toBe(stepBResult.observationId);

    const obsCountFinal = await rollbackClient!.query(
      "SELECT COUNT(*) as cnt FROM intentchord.workspace_observations WHERE workspace_registration_id=$1 AND source_tree_fingerprint=$2",
      [WS_R4, SHA("r4tfr11")],
    );
    expect(Number(obsCountFinal.rows[0].cnt)).toBe(2);
  });
});
