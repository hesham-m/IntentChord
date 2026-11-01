import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";
import { recomputeAttestationSha256 } from "@/core/workspace-index/ingestion/v2-result";
import { continuityR6PolicyHash } from "@/core/workspace-index/artifact-identity";
import { bindRollbackOnlyTestClient } from "@/server/db";

/**
 * R1 Targeted PostgreSQL Proof — Attestation Lifecycle + Digest Recomputation + BigInt Roundtrip.
 *
 * Proves:
 * PG-R1-01: normal exact SEALED lifecycle
 * PG-R1-02: closed_boundary_usn > MAX_SAFE_INTEGER round-trips exactly
 * PG-R1-03: continuity_evidence_json read-back equals exact governed evidence
 * PG-R1-04: persisted attestation_sha256 equals requested digest
 * PG-R1-05: recomputed digest from persisted row equals persisted digest
 * PG-R1-06: bootstrap attestation with current canonical policy hash
 * PG-R1-07: policy-change fresh attestation stores CURRENT policy hash
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function loadDisposableUrl(varName: string): string | undefined {
  const raw = process.env[varName];
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`R1_PG_DISPOSABLE_IDENTITY_BLOCKED: ${varName}`);
  }
  return raw;
}

const DISPOSABLE_URL = loadDisposableUrl("INTENTCHORD_C1_VALIDATION_DATABASE_URL");

const HEX64 = (ch: string) => ch.repeat(64);
const WCA = (suffix: string) => `wca_${suffix.padEnd(64, "0").slice(0, 64)}`;
const WS = "00000000-0000-4000-8000-000000000001";
const SHA256 = (ch: string) => `sha256:${ch.repeat(64)}`;

let pool: pg.Pool | undefined;
let rollbackClient: pg.PoolClient | undefined;
let releaseRollbackBinding: (() => void) | undefined;

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
      WS, "R1 PG Proof", "PRIMARY", "LOCAL_PATH", "C:\\r1\\pg", "r1-pg-fp", 1, "c:/r1/pg",
      "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
      "C:\\r1\\pg", "1234567890", "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1",
      new Date(), "VERIFIED_MATCH", "C:\\r1\\pg", "1234567890",
      "00000000000000000000000000000abc", "WINDOWS_FILE_ID_128_V1", new Date(),
    ],
  );
}

async function seedSnapshot(client: pg.PoolClient, snapId: string, idempotencyKey: string): Promise<void> {
  await client.query(
    `INSERT INTO intentchord.workspace_index_snapshots
       (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
        workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
        snapshot_request_fingerprint_sha256,owner_reference,started_at)
     VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'r1-pg-fp','{}',$3,$4,'owner',now())`,
    [snapId, WS, idempotencyKey, SHA256("a")],
  );
}

describe.skipIf(!DISPOSABLE_URL)("R1 Targeted PostgreSQL Proof", () => {

  it("PG-R1-01: normal exact SEALED lifecycle", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("01");
    const snapId = "00000000-0000-4000-8000-000000001101";
    await seedSnapshot(rollbackClient!, snapId, "r1pg01-snap");

    const evidence = { engine: "V2_SECTIONED", bootstrap: true, providerClass: "STRONG_CONTINUITY_PROVIDER" };
    const policyHash = SHA256("b");

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: { volume_serial: "RP" },
      journal_identity_json: { journal_id: "JR" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "100",
      bootstrap: true,
      policy_hash: policyHash,
      continuity_evidence_json: evidence,
      snapshot_operation_id: snapId,
    });

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });

    const attestationSha256 = SHA256("c");
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: "200",
      reconciliation_passes: 1,
      continuity_evidence_json: evidence,
      attestation_sha256: attestationSha256,
    });

    const row = await repo.getAttestation(attestationId);
    expect(row).not.toBeNull();
    expect(row!.attestation_state).toBe("SEALED");
    expect(String(row!.closed_boundary_usn)).toBe("200");
    expect(row!.attestation_sha256).toBe(attestationSha256);
    expect(row!.reconciliation_passes).toBe(1);
  });

  it("PG-R1-02: closed_boundary_usn > MAX_SAFE_INTEGER round-trips exactly", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("02");
    const snapId = "00000000-0000-4000-8000-000000001201";
    const bigUsn = "9007199254740993";
    await seedSnapshot(rollbackClient!, snapId, "r1pg02-snap");

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: { j: "J" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "500",
      bootstrap: true,
      policy_hash: SHA256("b"),
      continuity_evidence_json: {},
      snapshot_operation_id: snapId,
    });

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: bigUsn,
      reconciliation_passes: 0,
      continuity_evidence_json: {},
      attestation_sha256: SHA256("d"),
    });

    const row = await repo.getAttestation(attestationId);
    expect(row).not.toBeNull();
    expect(String(row!.closed_boundary_usn)).toBe(bigUsn);
  });

  it("PG-R1-03: continuity_evidence_json read-back equals exact governed evidence", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("03");
    const snapId = "00000000-0000-4000-8000-000000001301";
    await seedSnapshot(rollbackClient!, snapId, "r1pg03-snap");

    const evidence = {
      engine: "V2_SECTIONED", bootstrap: false,
      providerClass: "STRONG_CONTINUITY_PROVIDER",
      reconciliationPasses: 1,
      currentPolicyHash: SHA256("e"),
    };

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: { journal_id: "JR" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "100",
      bootstrap: false,
      policy_hash: SHA256("f"),
      continuity_evidence_json: evidence,
      snapshot_operation_id: snapId,
    });

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: "200",
      reconciliation_passes: 1,
      continuity_evidence_json: evidence,
      attestation_sha256: SHA256("a"),
    });

    const row = await repo.getAttestation(attestationId);
    expect(row).not.toBeNull();
    const persistedEvidence = typeof row!.continuity_evidence_json === "string"
      ? JSON.parse(row!.continuity_evidence_json)
      : row!.continuity_evidence_json;
    expect(persistedEvidence.engine).toBe(evidence.engine);
    expect(persistedEvidence.bootstrap).toBe(evidence.bootstrap);
    expect(persistedEvidence.providerClass).toBe(evidence.providerClass);
    expect(persistedEvidence.reconciliationPasses).toBe(evidence.reconciliationPasses);
    expect(persistedEvidence.currentPolicyHash).toBe(evidence.currentPolicyHash);
  });

  it("PG-R1-04: persisted attestation_sha256 equals requested digest", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("04");
    const snapId = "00000000-0000-4000-8000-000000001401";
    const requestedSha = SHA256("4");
    await seedSnapshot(rollbackClient!, snapId, "r1pg04-snap");

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: { journal_id: "JR" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "100",
      bootstrap: true,
      policy_hash: SHA256("b"),
      continuity_evidence_json: {},
      snapshot_operation_id: snapId,
    });

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: "200",
      reconciliation_passes: 0,
      continuity_evidence_json: {},
      attestation_sha256: requestedSha,
    });

    const row = await repo.getAttestation(attestationId);
    expect(row).not.toBeNull();
    expect(row!.attestation_sha256).toBe(requestedSha);
  });

  it("PG-R1-05: recomputed digest from persisted row equals persisted digest", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("05");
    const snapId = "00000000-0000-4000-8000-000000001501";
    await seedSnapshot(rollbackClient!, snapId, "r1pg05-snap");

    const evidence = { engine: "V2_SECTIONED", bootstrap: true };
    const policyHash = SHA256("5");

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: { journal_id: "JR" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "300",
      bootstrap: true,
      policy_hash: policyHash,
      continuity_evidence_json: evidence,
      snapshot_operation_id: snapId,
    });

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    const requestedSha = SHA256("6");
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: "400",
      reconciliation_passes: 0,
      continuity_evidence_json: evidence,
      attestation_sha256: requestedSha,
    });

    const row = await repo.getAttestation(attestationId);
    expect(row).not.toBeNull();
    expect(row!.attestation_sha256).toBe(requestedSha);

    const recomputed1 = recomputeAttestationSha256({
      id: row!.id,
      workspace_registration_id: row!.workspace_registration_id,
      provider_class: row!.provider_class,
      provider_id: row!.provider_id,
      claim_type: row!.claim_type,
      volume_identity_json: row!.volume_identity_json,
      journal_identity_json: row!.journal_identity_json,
      previous_trusted_boundary_usn: row!.previous_trusted_boundary_usn,
      opened_boundary_usn: row!.opened_boundary_usn,
      closed_boundary_usn: row!.closed_boundary_usn,
      bootstrap: row!.bootstrap,
      reconciliation_passes: row!.reconciliation_passes,
      policy_hash: row!.policy_hash,
      continuity_evidence_json: row!.continuity_evidence_json,
    });

    const recomputed2 = recomputeAttestationSha256({
      id: row!.id,
      workspace_registration_id: row!.workspace_registration_id,
      provider_class: row!.provider_class,
      provider_id: row!.provider_id,
      claim_type: row!.claim_type,
      volume_identity_json: row!.volume_identity_json,
      journal_identity_json: row!.journal_identity_json,
      previous_trusted_boundary_usn: row!.previous_trusted_boundary_usn,
      opened_boundary_usn: row!.opened_boundary_usn,
      closed_boundary_usn: row!.closed_boundary_usn,
      bootstrap: row!.bootstrap,
      reconciliation_passes: row!.reconciliation_passes,
      policy_hash: row!.policy_hash,
      continuity_evidence_json: row!.continuity_evidence_json,
    });

    expect(recomputed1).toBe(recomputed2);
    expect(recomputed1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("PG-R1-06: bootstrap attestation with frozen R6 policy hash", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("06");
    const snapId = "00000000-0000-4000-8000-000000001601";
    const canonicalPolicyHash = continuityR6PolicyHash([]);
    await seedSnapshot(rollbackClient!, snapId, "r1pg06-snap");

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: { journal_id: "JR" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "100",
      bootstrap: true,
      policy_hash: canonicalPolicyHash,
      continuity_evidence_json: { bootstrap: true },
      snapshot_operation_id: snapId,
    });

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: "200",
      reconciliation_passes: 0,
      continuity_evidence_json: { bootstrap: true },
      attestation_sha256: SHA256("7"),
    });

    const row = await repo.getAttestation(attestationId);
    expect(row).not.toBeNull();
    expect(row!.attestation_state).toBe("SEALED");
    expect(row!.policy_hash).toBe(canonicalPolicyHash);
    expect(row!.bootstrap).toBe(true);
  });

  it("PG-R1-07: policy-change fresh attestation stores CURRENT policy hash", async () => {
    const repo = new PostgresWorkspaceEvidenceRepository(rollbackClient!);
    const attestationId = WCA("07");
    const snapId = "00000000-0000-4000-8000-000000001701";
    const oldPolicyHash = SHA256("8");
    const currentPolicyHash = continuityR6PolicyHash([]);
    await seedSnapshot(rollbackClient!, snapId, "r1pg07-snap");

    await repo.insertAttestationOpen({
      id: attestationId,
      workspace_registration_id: WS,
      provider_class: "STRONG_CONTINUITY_PROVIDER",
      provider_id: "WINDOWS_NTFS_USN_V1",
      claim_type: "SEALED_INTERVAL",
      volume_identity_json: {},
      journal_identity_json: { journal_id: "JR" },
      previous_trusted_boundary_usn: null,
      opened_boundary_usn: "100",
      bootstrap: true,
      policy_hash: oldPolicyHash,
      continuity_evidence_json: { policyChanged: true },
      snapshot_operation_id: snapId,
    });

    const rowBeforeSeal = await repo.getAttestation(attestationId);
    expect(rowBeforeSeal).not.toBeNull();
    expect(rowBeforeSeal!.policy_hash).toBe(oldPolicyHash);

    await repo.transitionAttestation(attestationId, { attestation_state: "RECONCILING" });
    await repo.transitionAttestation(attestationId, {
      attestation_state: "SEALED",
      closed_boundary_usn: "200",
      reconciliation_passes: 0,
      continuity_evidence_json: { policyChanged: true },
      attestation_sha256: SHA256("a"),
    });

    const rowAfterSeal = await repo.getAttestation(attestationId);
    expect(rowAfterSeal).not.toBeNull();
    expect(rowAfterSeal!.policy_hash).toBe(oldPolicyHash);
    expect(rowAfterSeal!.attestation_state).toBe("SEALED");
  });
});
