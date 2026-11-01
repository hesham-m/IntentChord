import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresWorkspaceEvidenceRepository,
  type StagedRecordInsert,
} from "@/server/workspace-evidence-repository";

/**
 * Phase 2 PostgreSQL integration validation (SPEC V3 Section 17 P2).
 *
 * DISPOSABLE-ONLY discipline: inert unless pointed at a disposable validation
 * database (name must start with `intentchord_validation_`). The suite bootstraps
 * the schema itself from migrations/ and destroys it on exit. intentchord_dev is
 * never touched.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const MIGRATION_015 = "015_sectioned_evidence_incremental_workspace.sql";

function loadDisposableUrl(varName: string): string | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`PHASE2_DISPOSABLE_IDENTITY_BLOCKED: ${varName}`);
  }
  return raw;
}

const PATH_A_URL = loadDisposableUrl("INTENTCHORD_PHASE2_VALIDATION_DATABASE_URL");
const PATH_B_URL = loadDisposableUrl("INTENTCHORD_PHASE2_PATH_B_DATABASE_URL");

const HEX = (ch: string) => ch.repeat(64);
const WS = "aaaa1111-0000-4000-8000-00000000e2e1";
const SNAP = "123e4567-e89b-42d3-a456-426614174000";
const ATTESTATION = "wca_63d1c408f78647702e7fc381e8610d8ffcf0bb6a4d234da5a306f699daf6d2a6";
const ARTIFACT = "wea_2222222222222222222222222222222222222222222222222222222222222222";
const REVISION = `wsr_${HEX("d")}`;
const CONFIG = `sha256:${HEX("f")}`;
const OBS1 = "00000000-0000-4000-8000-c00000000001";

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function applyMigrationsThrough14(client: pg.Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE");
  await client.query("CREATE SCHEMA intentchord AUTHORIZATION intentchord_app");
  const names = (await readdir(MIGRATIONS_DIR)).filter(n => /^0\d\d_.*\.sql$/.test(n)).sort();
  for (const name of names) {
    if (Number(name.slice(1, 3)) > 14) continue;
    await client.query(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

async function applyMigration015(client: pg.Client): Promise<void> {
  await client.query(await readFile(path.join(MIGRATIONS_DIR, MIGRATION_015), "utf8"));
}

let pathAClient: pg.Client | undefined;
let observerClient: pg.Client | undefined;
const T13TRACE: Array<Record<string, unknown>> = [];
function t13push(o: Record<string, unknown>) { T13TRACE.push({ ts: new Date().toISOString(), ...o }); }

beforeAll(async () => {
  if (!PATH_A_URL) return;
  pathAClient = await connect(PATH_A_URL);
  await applyMigrationsThrough14(pathAClient);
  // Migration 015 applied TWICE: first application + idempotency proof.
  await applyMigration015(pathAClient);
  await applyMigration015(pathAClient);
  const obsUrl = PATH_A_URL;
  observerClient = new pg.Client({ connectionString: obsUrl });
  await observerClient.connect();
  t13push({ marker: 'observer_connected', db: obsUrl.split('/').pop() });
});

afterAll(async () => {
  if (pathAClient) {
    try {
      const dump = await pathAClient.query(`SELECT id,attestation_state,policy_hash,xmin::text xmin,ctid::text ctid FROM intentchord.workspace_source_continuity_attestations WHERE id=$1`, [ATTESTATION]);
      console.log("T7PRETEARDOWN", JSON.stringify({ trace: T13TRACE, row: dump.rows[0] ?? null }));
    } catch { /* best-effort diagnostic */ }
    if (process.env.INTENTCHORD_KEEP_SCHEMA !== "1") {
      await pathAClient.query("DROP SCHEMA IF EXISTS intentchord CASCADE").catch(() => undefined);
    }
    if (observerClient) { await observerClient.end().catch(() => undefined); observerClient = undefined; }
    await pathAClient.end();
  }
});

async function seedSealFixtures(repo: PostgresWorkspaceEvidenceRepository): Promise<void> {
  await repo.query(
    `INSERT INTO intentchord.workspaces
       (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
        verification_status,verification_method,verification_authority,device_provenance,source_type,
        verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
        verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
        current_root_file_id,current_root_identity_method,root_authority_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      WS, "PF E2E", "PRIMARY", "LOCAL_PATH", "C:\\pf\\e2e", "e2e-fp", 1, "c:/pf/e2e",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\pf\\e2e", "1234567890", "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\pf\\e2e", "1234567890",
      "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
  await repo.query(
    `INSERT INTO intentchord.workspace_index_snapshots
       (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
        workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
        snapshot_request_fingerprint_sha256,owner_reference,started_at)
     VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'e2e-fp','{}','pf2-e2e-snap',$3,'owner',now())`,
    [SNAP, WS, `sha256:${HEX("a")}`],
  );
  await repo.insertAttestationOpen({
    id: ATTESTATION,
    workspace_registration_id: WS,
    provider_class: "STRONG_CONTINUITY_PROVIDER",
    provider_id: "WINDOWS_NTFS_USN_V1",
    claim_type: "SEALED_INTERVAL",
    volume_identity_json: { volume_serial: "PF" },
    journal_identity_json: { usn_journal_id: "J1" },
    previous_trusted_boundary_usn: null,
    opened_boundary_usn: 100,
    bootstrap: true,
    policy_hash: `sha256:${HEX("9")}`,
    continuity_evidence_json: { proofs: {} },
    snapshot_operation_id: SNAP,
  });
  await repo.query(
    `INSERT INTO intentchord.workspace_source_revisions
       (id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,
        source_state_summary,first_observed_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,now())`,
    [REVISION, WS, WS, `sha256:${HEX("d")}`],
  );
  await repo.query(
    `INSERT INTO intentchord.workspace_evidence_artifacts
       (id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,
        header_json,section_manifest_json,section_manifest_digest,artifact_manifest_sha256,
        artifact_semantic_sha256,canonical_compat_sha256)
     SELECT $1,$2,$3,$4,'{"engine_mode":"V2_SECTIONED"}'::jsonb,
            jsonb_build_array(jsonb_build_object('section_type','FILES','section_schema_version','v1',
              'section_digest','sha256:'||repeat('0',64),'record_count',1,'segment_count',1)),
            'sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'sha256:'||repeat('3',64),
            'sha256:'||repeat('4',64)
       WHERE NOT EXISTS (SELECT 1 FROM intentchord.workspace_evidence_artifacts WHERE id=$1)`,
    [ARTIFACT, WS, REVISION, CONFIG],
  );
}

async function insertObservationAndLink(repo: PostgresWorkspaceEvidenceRepository): Promise<void> {
  await repo.query(
    `INSERT INTO intentchord.workspace_observations
      (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
       index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,
       observed_at,observation_result,accepted_workspace_evidence_artifact_id,
       source_continuity_attestation_id,observation_protocol_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'owner',now(),'FIRST_INDEXED',$8,$9,'{}'::jsonb)`,
    [
      OBS1, SNAP, WS, REVISION, CONFIG, `sha256:${HEX("d")}`,
      JSON.stringify({ normalized_reference: "c:/pf/e2e", binding_type: "LOCAL_FILESYSTEM" }),
      ARTIFACT, ATTESTATION,
    ],
  );
  await repo.transitionAttestation(ATTESTATION, { observation_id: OBS1 });
}

describe.skipIf(!PATH_A_URL)("Phase 2 PostgreSQL integration — PATH A (clean)", () => {
  it("bootstraps fixtures", async () => {
    await seedSealFixtures(new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient));
  });

  it("01 staging batch insert + ordered read", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    const batch: StagedRecordInsert[] = [
      { snapshot_operation_id: SNAP, section_type: "FILES", record_seq: 2, record_id: "r_b", record_digest: `sha256:${HEX("5")}`, record_json: { n: 2 } },
      { snapshot_operation_id: SNAP, section_type: "FILES", record_seq: 1, record_id: "r_a", record_digest: `sha256:${HEX("5")}`, record_json: { n: 1 } },
      { snapshot_operation_id: SNAP, section_type: "FACTS", record_seq: 1, record_id: "f_a", record_digest: `sha256:${HEX("5")}`, source_file_revision_id: "fir_x", record_json: { s: true } },
    ];
    expect(await repo.insertStagedRecords(batch)).toBe(3);
    const seen: number[] = [];
    for await (const row of repo.streamStagedRecords(SNAP, "FILES")) seen.push(row.record_seq);
    expect(seen).toEqual([1, 2]);
  });

  it("02 staging segment insert/read", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await repo.insertStagedSegment({
      snapshot_operation_id: SNAP, section_type: "FILES", segment_seq: 1,
      record_count: 2, first_record_seq: 1, last_record_seq: 2,
      segment_digest: `sha256:${HEX("7")}`, byte_size: 256,
    });
    const result = await (repo as unknown as { query(s: string, v: unknown[]): Promise<{ rowCount: number | null }> }).query(
      `SELECT 1 FROM intentchord.workspace_evidence_staging_segments WHERE snapshot_operation_id=$1 AND section_type='FILES'`,
      [SNAP],
    );
    expect(result.rowCount ?? 0).toBe(1);
  });

  it("03/04 server-side promotion preserves order and lands accepted rows atomically-counted", async () => {
    const client = pathAClient!;
    const repo = new PostgresWorkspaceEvidenceRepository(client as unknown as PoolClient);
    await repo.insertSection({
      workspace_registration_id: WS, artifact_id: ARTIFACT, section_type: "FILES",
      section_order: 1, section_schema_version: "v1",
      section_digest: `sha256:${HEX("0")}`, record_count: 2, segment_count: 1,
    });
    await client.query("BEGIN");
    try {
      const promoted = await repo.promoteStagedSectionWithinTransaction(client as unknown as PoolClient, {
        snapshot_operation_id: SNAP, workspace_registration_id: WS, artifact_id: ARTIFACT,
        section_type: "FILES", expected_record_count: 2,
      });
      expect(promoted).toBe(2);
      const ordered = await client.query(
        `SELECT r.record_seq FROM intentchord.workspace_evidence_section_records r
          JOIN intentchord.workspace_evidence_sections s ON s.id=r.section_id
         WHERE s.artifact_id=$1 ORDER BY r.record_seq`, [ARTIFACT]);
      expect(ordered.rows.map(r => r.record_seq)).toEqual([1, 2]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  it("05 promotion atomicity: mismatch aborts leaving staging untouched", async () => {
    const client = pathAClient!;
    const repo = new PostgresWorkspaceEvidenceRepository(client as unknown as PoolClient);
    // Standalone attempt/artifact/section so earlier promotions cannot interfere.
    const snapId = "123e4567-e89b-42d3-a456-426614174008";
    const artId = "wea_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await client.query(
      `INSERT INTO intentchord.workspace_index_snapshots
        (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
         workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
         snapshot_request_fingerprint_sha256,owner_reference,started_at)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'e2e-fp','{}','pf2-atomic-snap',
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','owner',now())`,
      [snapId, WS],
    );
    await client.query(
      `INSERT INTO intentchord.workspace_evidence_artifacts
        (id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,
         header_json,section_manifest_json,section_manifest_digest,artifact_manifest_sha256,
         artifact_semantic_sha256,canonical_compat_sha256)
       VALUES ($1,$2,$3,'sha256:'||repeat('b',64),'{}'::jsonb,'[]'::jsonb,'sha256:'||repeat('1',64),
        'sha256:'||repeat('2',64),'sha256:'||repeat('3',64),'sha256:'||repeat('4',64))`,
       [artId, WS, REVISION],
    );
    await repo.insertSection({
      workspace_registration_id: WS, artifact_id: artId, section_type: "FILES",
      section_order: 1, section_schema_version: "v1",
      section_digest: `sha256:${HEX("0")}`, record_count: 3, segment_count: 1,
    });
    await repo.insertStagedRecords([
      { snapshot_operation_id: snapId, section_type: "FILES", record_seq: 1, record_id: "at_1", record_digest: `sha256:${HEX("5")}`, record_json: {} },
      { snapshot_operation_id: snapId, section_type: "FILES", record_seq: 2, record_id: "at_2", record_digest: `sha256:${HEX("5")}`, record_json: {} },
      { snapshot_operation_id: snapId, section_type: "FILES", record_seq: 3, record_id: "at_3", record_digest: `sha256:${HEX("5")}`, record_json: {} },
    ]);
    await client.query("BEGIN");
    try {
      try {
        await repo.promoteStagedSectionWithinTransaction(client as unknown as PoolClient, {
          snapshot_operation_id: snapId, workspace_registration_id: WS, artifact_id: artId,
          section_type: "FILES", expected_record_count: 999,
        });
        throw new Error("PROMOTION_RESOLVED_UNEXPECTEDLY");
      } catch (error) {
        expect(String((error as Error).message)).toMatch(/MANIFEST_MISMATCH/);
      }
    } finally {
      await client.query("ROLLBACK");
    }
    const left = await client.query(
      `SELECT
         (SELECT count(*)::int FROM intentchord.workspace_evidence_staging_records
           WHERE snapshot_operation_id=$1) AS staged,
         (SELECT count(*)::int FROM intentchord.workspace_evidence_section_records r
           JOIN intentchord.workspace_evidence_sections s ON s.id=r.section_id
          WHERE s.artifact_id=$2) AS accepted`,
      [snapId, artId],
    );
    expect(left.rows[0]).toMatchObject({ staged: 3, accepted: 0 });
  });

  it("06-09 append-only guards on artifact/section/record/segment", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await expect(repo.query(
      `UPDATE intentchord.workspace_evidence_artifacts SET header_json='{}'::jsonb WHERE id=$1`, [ARTIFACT]),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(repo.query(
      `DELETE FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1`, [ARTIFACT]),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(repo.query(
      `DELETE FROM intentchord.workspace_evidence_section_records WHERE record_id='r_a'`),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(repo.query(
      `DELETE FROM intentchord.workspace_evidence_segments g USING intentchord.workspace_evidence_sections s
        WHERE g.section_id=s.id AND s.artifact_id=$1`, [ARTIFACT]),
    ).rejects.toThrow(/APPEND_ONLY/);
  });

  it("10 composite coherence rejects wrong type/artifact/registration", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await expect(repo.query(
      `INSERT INTO intentchord.workspace_evidence_section_records
         (workspace_registration_id,artifact_id,section_id,section_type,record_seq,record_id,record_digest,source_file_revision_id,record_json)
       SELECT 'aaaa1111-0000-4000-8000-00000000e2e1',$1,id,'FACTS',50,'neg_t',$2,'fir_e2e_r1','{}'::jsonb
         FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1 AND section_type='FILES'`,
      [ARTIFACT, `sha256:${HEX("6")}`]),
    ).rejects.toThrow(/wer_section_coherence_fk/);
    await expect(repo.query(
      `INSERT INTO intentchord.workspace_evidence_section_records
         (workspace_registration_id,artifact_id,section_id,section_type,record_seq,record_id,record_digest,record_json)
       SELECT 'aaaa1111-0000-4000-8000-00000000e2e1','wea_'||repeat('9',64),id,'FILES',51,'neg_a',$2,'{}'::jsonb
         FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1 AND section_type='FILES'`,
      [ARTIFACT, `sha256:${HEX("6")}`]),
    ).rejects.toThrow(/wer_section_coherence_fk/);
    await expect(repo.query(
      `INSERT INTO intentchord.workspace_evidence_section_records
         (workspace_registration_id,artifact_id,section_id,section_type,record_seq,record_id,record_digest,record_json)
       SELECT '11111111-1111-4111-8111-111111111111',$1,id,'FILES',52,'neg_r',$2,'{}'::jsonb
         FROM intentchord.workspace_evidence_sections WHERE artifact_id=$1 AND section_type='FILES'`,
      [ARTIFACT, `sha256:${HEX("6")}`]),
    ).rejects.toThrow(/wer_section_coherence_fk/);
  });

  it("11 object-identity lookups: path / identity tuple / batched", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await repo.query(
      `INSERT INTO intentchord.workspace_file_object_identity_index
        (workspace_registration_id,workspace_revision_id,workspace_file_id,relative_path,prior_relative_path,
         device_id,volume_identity,object_file_id,object_sequence,proof_method,provider_class,lineage_state,move_proof)
       VALUES ($1,$2,'wfi_p','src/p.ts',NULL,'1234567890','{"volume_serial":"PF"}',
               '00000000000000000000000000000abd',43,'WINDOWS_FILE_ID_128_V1',
               'STRONG_CONTINUITY_PROVIDER','RENAMED_OR_MOVED','USN_RENAME_PAIR_PROVEN')`,
      [WS, REVISION],
    );
    const byPath = await repo.findPreviousFileByPath(WS, REVISION, "src/p.ts");
    expect(byPath?.move_proof).toBe("USN_RENAME_PAIR_PROVEN");
    const batched = await repo.findPreviousFilesByObjectIdentity(WS, REVISION, [
      { device_id: "1234567890", object_file_id: "00000000000000000000000000000abd", object_sequence: 43 },
      { device_id: "1234567890", object_file_id: `f${"f".repeat(31)}`, object_sequence: 7 },
    ]);
    expect(batched.size).toBe(1);
  });

  it("12 delete/recreate distinction via sequence component", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await repo.query(
      `INSERT INTO intentchord.workspace_file_object_identity_index
        (workspace_registration_id,workspace_revision_id,workspace_file_id,relative_path,device_id,
         volume_identity,object_file_id,object_sequence,proof_method,provider_class,lineage_state)
       VALUES ($1,$2,'wfi_new2','src/q.ts','1234567890','{"volume_serial":"PF"}',
               '00000000000000000000000000000abd',44,'WINDOWS_FILE_ID_128_V1',
               'STRONG_CONTINUITY_PROVIDER','NEW')`,
      [WS, REVISION],
    );
    const prior = await repo.findPreviousFileByPath(WS, REVISION, "src/q.ts");
    // same path, NEW identity row at seq 44 vs earlier p.ts at 43: sequence decides recreation.
    expect(String(prior?.object_sequence)).toBe('44');
  });

  it("13 attestation lifecycle guards", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await repo.transitionAttestation(ATTESTATION, { attestation_state: "RECONCILING" });
    await expect(repo.transitionAttestation(ATTESTATION, { attestation_state: "SEALED" }))
      .rejects.toThrow(/WCA_TRANSITION_BLOCKED|wca_sealed_shape_ck/);
    await repo.transitionAttestation(ATTESTATION, {
      attestation_state: "SEALED", closed_boundary_usn: 900,
      reconciliation_passes: 1,
      continuity_evidence_json: { engine: "V2_SECTIONED", bootstrap: true },
      attestation_sha256: `sha256:${HEX("e")}`,
    });
try {
      const meta = await repo.query(`SELECT pg_backend_pid() pid, current_database() db, current_setting('search_path') sp, 'intentchord.workspace_source_continuity_attestations'::regclass::oid table_oid, (SELECT array_agg(tgname||':'||tgenabled::text) FROM pg_trigger WHERE tgrelid='intentchord.workspace_source_continuity_attestations'::regclass AND NOT tgisinternal) triggers, (SELECT md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgrelid='intentchord.workspace_source_continuity_attestations'::regclass AND tgname='wca_z_guard_update') guard_def_md5, (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_trigger t ON t.tgfoid=p.oid WHERE t.tgrelid='intentchord.workspace_source_continuity_attestations'::regclass AND t.tgname='wca_z_guard_update') guard_fn_md5`, []);
      let returned: unknown = null;
      try {
        const r = await repo.query(`UPDATE intentchord.workspace_source_continuity_attestations SET policy_hash=$2 WHERE id=$1 RETURNING policy_hash`, [ATTESTATION, `sha256:${HEX("0")}`]);
        returned = r.rows[0] ?? null;
      } catch (rawErr) {
        t13push({ marker: 'RAW_REJECTED', error: String((rawErr as Error).message).slice(0, 120) });
        throw rawErr;
      }
      const rowMain = await repo.query(`SELECT attestation_state,(observation_id IS NOT NULL) linked,policy_hash,xmin::text xmin,ctid::text ctid,tableoid::text tableoid FROM intentchord.workspace_source_continuity_attestations WHERE id=$1`, [ATTESTATION]);
      let rowObs: unknown = null;
      if (observerClient) { const r2 = await observerClient.query(`SELECT policy_hash,xmin::text xmin,ctid::text ctid FROM intentchord.workspace_source_continuity_attestations WHERE id=$1`, [ATTESTATION]); rowObs = r2.rows[0] ?? null; }
      const capture = { marker: 'POLICY_RESOLVED', meta: meta.rows[0], returning: returned, rowMain: rowMain.rows[0], observerSecondSession: rowObs };
      T13TRACE.push(capture);
      console.log('T13CAPTURE', JSON.stringify(capture));
      throw new Error("POLICY_MUTATION_RESOLVED_UNEXPECTEDLY");
    } catch (error) {
      if ((error as Error).message !== "POLICY_MUTATION_RESOLVED_UNEXPECTEDLY") {
        t13push({ marker: 'RAW_PATH', error: String((error as Error).message).slice(0, 140) });
      }
      expect(String((error as Error).message)).toMatch(/IMMUTABLE_BINDING|TRANSITION_BLOCKED/);
    }
  });

  it("14 SEALED unlinked maintenance voids exactly unlinked rows; linked chain intact", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await insertObservationAndLink(repo);
    await repo.query(
      `INSERT INTO intentchord.workspace_index_snapshots
        (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
         workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
         snapshot_request_fingerprint_sha256,owner_reference,started_at)
       VALUES ('123e4567-e89b-42d3-a456-426614174009','REGISTERED_WORKSPACE','CREATING',$1,1,
        'e2e-fp','{}','pf2-unlinked-snap',$2,'owner',now())`,
      [WS, `sha256:${HEX("d")}`],
    );
    await repo.insertAttestationOpen({
      id: `wca_${"8".repeat(64)}`,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: { volume_serial: "PF" },
      journal_identity_json: { j: "J9" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: 130,
      bootstrap: true,
      policy_hash: `sha256:${HEX("9")}`,
      continuity_evidence_json: {},
      snapshot_operation_id: "123e4567-e89b-42d3-a456-426614174009",
    });
    await repo.transitionAttestation(`wca_${"8".repeat(64)}`, { attestation_state: "RECONCILING" });
    await repo.transitionAttestation(`wca_${"8".repeat(64)}`, {
      attestation_state: "SEALED", closed_boundary_usn: 700,
      reconciliation_passes: 0,
      continuity_evidence_json: { engine: "V2_SECTIONED", bootstrap: true },
      attestation_sha256: `sha256:${HEX("e")}`,
    });
    const voided = await repo.voidUnlinkedSealedAttestations(WS);
    expect(voided).toBeGreaterThanOrEqual(1);
    const linked = await repo.getAttestation(ATTESTATION);
    expect(linked.attestation_state).toBe("SEALED");
    expect(String(linked.observation_id)).toBe(OBS1);
  });

  it("15 linked attestation protection: VOID forbidden forever; delete blocked", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await expect(repo.transitionAttestation(ATTESTATION, {
      attestation_state: "VOID", void_reason: "UNLINKED",
    })).rejects.toThrow(/TRANSITION_BLOCKED:SEALED->VOID/);
    await expect(repo.query(
      `DELETE FROM intentchord.workspace_source_continuity_attestations WHERE id=$1`, [ATTESTATION]),
    ).rejects.toThrow(/WCA_APPEND_ONLY/);
  });

  it("16 snapshot READY-V2 terminal binding + reaper purge", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await repo.query(
      `UPDATE intentchord.workspace_index_snapshots SET status='READY',completed_at=now(),
         canonical_contract_version='1.0.0',index_configuration_sha256=$2,
         observation_result='FIRST_INDEXED',workspace_observation_id=$3,workspace_revision_id=$4,
         index_attempt_status='SUCCEEDED',accepted_workspace_evidence_artifact_id=$5,
         source_continuity_attestation_id=$6
       WHERE id=$1`,
      [SNAP, CONFIG, OBS1, REVISION, ARTIFACT, ATTESTATION],
    );
    await repo.query(
      `INSERT INTO intentchord.workspace_evidence_staging_records
         (snapshot_operation_id,section_type,record_seq,record_id,record_digest,record_json)
       VALUES ($1,'FAILURES',1,'reap_me',$2,'{}'::jsonb)`,
      [SNAP, `sha256:${HEX("5")}`],
    );
    const purged = await repo.reapStagingOlderThan(new Date(Date.now() + 1000));
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await repo.countStagedRecords(SNAP)).toBe(0);
  });

  it("18 V2 no-monolithic-payload DB guard trips adversarially", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    await expect(repo.query(
      `UPDATE intentchord.workspace_index_snapshots SET canonical_index_json='{"z":1}'::jsonb WHERE id=$1`,
      [SNAP],
    )).rejects.toThrow(/wsnaps_v2_no_payload_ck|PROGRESS_PAYLOAD|BACKFILL/);
  });

  it("19 Context Mapping dual binding (runtime-config guard bypassed diagnostically)", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    const weaSha = `sha256:${HEX("3")}`;
    await repo.query(`ALTER TABLE intentchord.context_mapping_runs DISABLE TRIGGER context_mapping_runs_runtime_configuration_v014`);
    try {
      await repo.insertContextMappingForValidation({
        id: randomUUID(),
        mapping_input_snapshot: {
          mapping_input_schema_version: "intentchord.ai-context-mapping-input.v2",
          source_authority: "CANONICAL_INDEX_ARTIFACT",
          canonical_index_artifact_id: ARTIFACT,
          artifact_semantic_sha256: weaSha,
          workspace_index_sha256: weaSha,
          workspace_snapshot_id: REVISION,
        },
        workspace_snapshot_id: REVISION,
        workspace_index_sha256: weaSha,
        qualification_scope: "AI_CONTEXT_MAPPING_V1",
        workspace_index_snapshot_id: SNAP,
        mapping_idempotency_key: "pf2-j10",
        mapping_request_fingerprint_sha256: `sha256:${HEX("4")}`,
        canonical_index_artifact_id: ARTIFACT,
        artifact_semantic_sha256: weaSha,
      });
      await expect(repo.insertContextMappingForValidation({
        id: randomUUID(),
        mapping_input_snapshot: {},
        workspace_snapshot_id: "r",
        workspace_index_sha256: `sha256:${HEX("1")}`,
        qualification_scope: "AI_CONTEXT_MAPPING_V1",
        mapping_idempotency_key: "pf2-j11",
        mapping_request_fingerprint_sha256: `sha256:${HEX("2")}`,
        canonical_index_artifact_id: ARTIFACT,
        artifact_semantic_sha256: `sha256:${HEX("9")}`,
      })).rejects.toThrow(/ARTIFACT_BINDING_INVALID/);
      await expect(repo.query(`DELETE FROM intentchord.workspace_evidence_artifacts WHERE id=$1`, [ARTIFACT]))
        .rejects.toThrow(/INTENTCHORD_/);
    } finally {
      await repo.query(`ALTER TABLE intentchord.context_mapping_runs ENABLE TRIGGER context_mapping_runs_runtime_configuration_v014`);
    }
  });

  it("20 repository APIs remain bounded", async () => {
    const sourceText = await readFile(
      path.resolve(process.cwd(), "src", "server", "workspace-evidence-repository.ts"), "utf8");
    expect(sourceText.includes("CanonicalWorkspaceIndexContract")).toBe(false);
    const repo = new PostgresWorkspaceEvidenceRepository(pathAClient as unknown as PoolClient);
    expect(typeof repo.streamAcceptedRecords(ARTIFACT, "FILES")[Symbol.asyncIterator]).toBe("function");
  });
});

describe.skipIf(!PATH_B_URL)("Phase 2 PostgreSQL integration — PATH B (V1 rows pre-015)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = await connect(PATH_B_URL!);
    await applyMigrationsThrough14(client);
    await client.query(
      `INSERT INTO intentchord.workspaces
        (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
         verification_status,verification_method,verification_authority,device_provenance,source_type)
       VALUES ('11111111-1111-4111-8111-111111111111','PF V1 WS','PRIMARY','LOCAL_PATH','C:\\pf\\v1',
        'v1-fp',3,'c:/pf/v1','UNVERIFIED','NONE','NONE','{}','MANUAL_UNVERIFIED')
       ON CONFLICT DO NOTHING`);
    await client.query(
      `INSERT INTO intentchord.workspace_index_snapshots
        (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
         workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
         snapshot_request_fingerprint_sha256,canonical_contract_version,canonical_index_json,
         canonical_sha256,owner_reference,started_at,completed_at)
       VALUES ('22222222-2222-4222-8222-222222222222','REGISTERED_WORKSPACE','READY',
        '11111111-1111-4111-8111-111111111111',3,'v1-fp','{}','pf2-b-ready',
        'sha256:'||repeat('a',64),'1.0.0','{"contract":"legacy"}'::jsonb,
        'sha256:'||repeat('b',64),'owner',now(),now())
       ON CONFLICT DO NOTHING`);
    for (const trigger of [
      "context_mapping_run_insert_guard_v013",
      "context_mapping_runs_runtime_configuration_v014",
      "context_mapping_runs_snapshot_insert_guard",
    ]) {
      const exists = await client.query(
        `SELECT 1 FROM pg_trigger WHERE tgrelid='intentchord.context_mapping_runs'::regclass AND tgname=$1 AND NOT tgisinternal`,
        [trigger]);
      if ((exists.rowCount ?? 0) > 0) {
        await client.query(`ALTER TABLE intentchord.context_mapping_runs DISABLE TRIGGER ${trigger}`);
      }
    }
    await client.query(
      `INSERT INTO intentchord.context_mapping_runs
        (id,mapping_input_snapshot_id,mapping_input_sha256,mapping_input_snapshot,
         workspace_index_contract_version,workspace_snapshot_id,workspace_index_sha256,
         eligible_entry_count,excluded_entry_count,provider_neutral_estimated_tokens,status,
         primary_provider_id,primary_channel_id,primary_model_id,standby_enabled,
         standby_governance_state,provider_configuration_snapshot,owner_verdict_state,
         qualification_scope,workspace_index_snapshot_id,mapping_idempotency_key,
         mapping_request_fingerprint_sha256)
       VALUES ('55555555-5555-4555-8555-555555555555','pi','sha256:'||repeat('1',64),
        '{"mapping_input_schema_version":"intentchord.ai-context-mapping-input.v1"}'::jsonb,
        '1.0.0','snap','sha256:'||repeat('b',64),0,0,0,'CREATED','zai','chan','mdl',false,
        'BLOCKED_BY_GOVERNANCE','{}'::jsonb,'PENDING','AI_CONTEXT_MAPPING_V1',
        '22222222-2222-4222-8222-222222222222','pf2-b-map','sha256:'||repeat('2',64))
       ON CONFLICT DO NOTHING`);
    for (const trigger of [
      "context_mapping_run_insert_guard_v013",
      "context_mapping_runs_runtime_configuration_v014",
      "context_mapping_runs_snapshot_insert_guard",
    ]) {
      const exists = await client.query(
        `SELECT 1 FROM pg_trigger WHERE tgrelid='intentchord.context_mapping_runs'::regclass AND tgname=$1 AND NOT tgisinternal`,
        [trigger]);
      if ((exists.rowCount ?? 0) > 0) {
        await client.query(`ALTER TABLE intentchord.context_mapping_runs ENABLE TRIGGER ${trigger}`);
      }
    }
  });

  afterAll(async () => {
    await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE").catch(() => undefined);
    await client.end();
  });

  it("Migration 015 applies over V1 state twice; historical rows survive readable", async () => {
    await applyMigration015(client);
    await applyMigration015(client);
    const snaps = await client.query(
      `SELECT status,(canonical_index_json IS NOT NULL) has_payload FROM intentchord.workspace_index_snapshots
        WHERE id='22222222-2222-4222-8222-222222222222'`);
    expect(snaps.rows[0]).toMatchObject({ status: "READY", has_payload: true });
    const maps = await client.query(
      `SELECT count(*)::int n FROM intentchord.context_mapping_runs WHERE canonical_index_artifact_id IS NULL`);
    expect(maps.rows[0].n).toBe(1);
  });

  it("V2 READY without observation remains schema-illegal (PB-4 anchor)", async () => {
    await client.query(
      `INSERT INTO intentchord.workspace_source_revisions
        (id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,
         source_state_summary,first_observed_at)
       VALUES ('wsr_'||repeat('c',64),'11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111','sha256:'||repeat('c',64),'{}'::jsonb,now())`);
    await client.query(
      `INSERT INTO intentchord.workspace_evidence_artifacts
        (id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,
         header_json,section_manifest_json,section_manifest_digest,artifact_manifest_sha256,
         artifact_semantic_sha256,canonical_compat_sha256)
       VALUES ('wea_'||repeat('7',64),'11111111-1111-4111-8111-111111111111',
        'wsr_'||repeat('c',64),'sha256:'||repeat('f',64),'{"h":1}'::jsonb,'[]'::jsonb,
        'sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'sha256:'||repeat('3',64),
        'sha256:'||repeat('4',64))`);
    await expect(client.query(
      `INSERT INTO intentchord.workspace_index_snapshots
        (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
         workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
         snapshot_request_fingerprint_sha256,canonical_contract_version,
         accepted_workspace_evidence_artifact_id,index_configuration_sha256,
         index_attempt_status,owner_reference,started_at,completed_at)
       VALUES ('33333333-3333-4333-8333-333333333331','REGISTERED_WORKSPACE','READY',
        '11111111-1111-4111-8111-111111111111',3,'v1-fp','{}','pf2-b-v2ready',
        'sha256:'||repeat('d',64),'1.0.0','wea_'||repeat('7',64),
        'sha256:'||repeat('f',64),'SUCCEEDED','owner',now(),now())`)
    ).rejects.toThrow(/b1_binding_shape_ck/);
  });
});
