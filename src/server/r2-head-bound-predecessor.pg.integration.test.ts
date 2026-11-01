import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkspaceEvidenceRepository } from "@/server/workspace-evidence-repository";

/**
 * R2 Targeted PostgreSQL Repository Proof — Head-Bound Predecessor Selection.
 *
 * DISPOSABLE-ONLY discipline. Proves against real PostgreSQL that
 * getSealedAttestationForObservation selects by observation/head binding,
 * NOT by temporal recency.
 *
 * Does NOT execute the C1 seal lifecycle.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

const HEX = (ch: string) => ch.repeat(64);

// Test fixtures — unique per suite run to avoid collision
const WS = randomUUID();
const WS_OTHER = randomUUID();
// Snapshot fixtures — one per attestation (unique constraint on snapshot_operation_id)
const SNAP_HEAD = randomUUID();
const SNAP_NEWER = randomUUID();
const SNAP_UNLINKED = randomUUID();
const SNAP_OTHER = randomUUID();
const REVISION = `wsr_${HEX("a")}`;
const REVISION_OTHER = `wsr_${HEX("b")}`;
const CONFIG = `sha256:${HEX("f")}`;

// Attestation fixtures
const ATT_HEAD = `wca_${HEX("1")}`;          // linked to HEAD obs, SEALED
const ATT_NEWER = `wca_${HEX("2")}`;         // newer, linked to DIFFERENT obs
const ATT_UNLINKED = `wca_${HEX("3")}`;      // SEALED but no observation linkage

// Observation fixtures
const OBS_HEAD = randomUUID();                // HEAD observation linked to ATT_HEAD
const OBS_OTHER = randomUUID();               // different observation linked to ATT_NEWER

// Known policy hash and boundary
const KNOWN_POLICY_HASH = `sha256:${HEX("a")}`;
const KNOWN_CLOSED_BOUNDARY = 9876;

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function applyMigrations(client: pg.Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE");
  await client.query("CREATE SCHEMA intentchord AUTHORIZATION intentchord_app");
  const names = (await readdir(MIGRATIONS_DIR)).filter(n => /^0\d\d_.*\.sql$/.test(n)).sort();
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

function loadValidationUrl(): string | undefined {
  const raw = process.env.INTENTCHORD_R2_PG_PROOF_DATABASE_URL
    ?? process.env.INTENTCHORD_PHASE2_VALIDATION_DATABASE_URL;
  if (!raw) return undefined;
  const parsed = new URL(raw);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  if (!database.startsWith("intentchord_validation_") || user !== "intentchord_app") {
    throw new Error(`R2_PG_PROOF_DISPOSABLE_IDENTITY_BLOCKED: database=${database} user=${user}`);
  }
  return raw;
}

let client: pg.Client | undefined;
let repo: PostgresWorkspaceEvidenceRepository | undefined;

beforeAll(async () => {
  const url = loadValidationUrl();
  if (!url) return;
  client = await connect(url);
  await applyMigrations(client);
  repo = new PostgresWorkspaceEvidenceRepository(client as unknown as PoolClient);

  // Seed workspace registrations
  for (const wsId of [WS, WS_OTHER]) {
    await repo.query(
      `INSERT INTO intentchord.workspaces
        (id,display_name,role,reference_type,reference,fingerprint,revision,normalized_reference,
         verification_status,verification_method,verification_authority,device_provenance,source_type,
         verified_root_real_path,verified_root_device_id,verified_root_file_id,verified_root_identity_method,
         verified_root_verified_at,root_authority_state,current_root_real_path,current_root_device_id,
         current_root_file_id,current_root_identity_method,root_authority_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        wsId, "R2 PG Proof", "PRIMARY", "LOCAL_PATH", `C:\\r2-proof-${wsId}`, "r2-fp", 1, `c:/r2-proof-${wsId}`,
        "VERIFIED", "MANUAL", "OWNER", "{}", "MANUAL_VERIFIED",
        `C:\\r2-proof-${wsId}`, "1234567890", "00000000000000000000000000000001", "WINDOWS_FILE_ID_128_V1",
        new Date(), "VERIFIED_MATCH", `C:\\r2-proof-${wsId}`, "1234567890",
        "00000000000000000000000000000001", "WINDOWS_FILE_ID_128_V1", new Date(),
      ],
    );
  }

  // Seed source revisions
  await repo.query(
    `INSERT INTO intentchord.workspace_source_revisions
      (id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,
       source_state_summary,first_observed_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,now())`,
    [REVISION, WS, WS, `sha256:${HEX("d")}`],
  );
  await repo.query(
    `INSERT INTO intentchord.workspace_source_revisions
      (id,workspace_registration_id,workspace_instance_id,source_tree_fingerprint,
       source_state_summary,first_observed_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,now())`,
    [REVISION_OTHER, WS_OTHER, WS_OTHER, `sha256:${HEX("e")}`],
  );

  // Seed snapshot operations (one per attestation due to UNIQUE constraint)
  const snapFixtures = [
    [SNAP_HEAD, WS, "r2-snap-head"],
    [SNAP_NEWER, WS, "r2-snap-newer"],
    [SNAP_UNLINKED, WS, "r2-snap-unlinked"],
    [SNAP_OTHER, WS_OTHER, "r2-snap-other"],
  ];
  let snapSeq = 0;
  for (const [snapId, wsId, idempKey] of snapFixtures) {
    await repo.query(
      `INSERT INTO intentchord.workspace_index_snapshots
        (id,source_mode,status,workspace_registration_id,workspace_registration_revision,
         workspace_registration_fingerprint,governed_scope,snapshot_idempotency_key,
         snapshot_request_fingerprint_sha256,owner_reference,started_at)
       VALUES ($1,'REGISTERED_WORKSPACE','CREATING',$2,1,'r2-fp','{}',$3,$4,'owner',now())`,
      [snapId, wsId, idempKey, `sha256:${HEX(String.fromCharCode(97 + snapSeq++))}`],
    );
  }

  // Seed evidence artifacts
  for (const [artId, wsId, revId] of [[`wea_${HEX("a")}`, WS, REVISION], [`wea_${HEX("b")}`, WS_OTHER, REVISION_OTHER]]) {
    await repo.query(
      `INSERT INTO intentchord.workspace_evidence_artifacts
        (id,workspace_registration_id,workspace_revision_id,index_configuration_sha256,
         header_json,section_manifest_json,section_manifest_digest,artifact_manifest_sha256,
         artifact_semantic_sha256,canonical_compat_sha256)
       VALUES ($1,$2,$3,$4,'{"engine_mode":"V2_SECTIONED"}'::jsonb,
              jsonb_build_array(jsonb_build_object('section_type','FILES','section_schema_version','v1',
                'section_digest','sha256:'||repeat('0',64),'record_count',1,'segment_count',1)),
              'sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'sha256:'||repeat('3',64),
              'sha256:'||repeat('4',64))`,
      [artId, wsId, revId, CONFIG],
    );
  }

  // --- ATT_HEAD: SEALED attestation linked to OBS_HEAD ---
  await repo.insertAttestationOpen({
    id: ATT_HEAD,
    workspace_registration_id: WS,
    provider_class: "STRONG_CONTINUITY_PROVIDER",
    provider_id: "WINDOWS_NTFS_USN_V1",
    claim_type: "SEALED_INTERVAL",
    volume_identity_json: { volume_serial: "VP1" },
    journal_identity_json: { journalId: "JP1" },
    previous_trusted_boundary_usn: null,
    opened_boundary_usn: 100,
    bootstrap: true,
    policy_hash: KNOWN_POLICY_HASH,
    continuity_evidence_json: { proofs: {} },
    snapshot_operation_id: SNAP_HEAD,
  });
  await repo.transitionAttestation(ATT_HEAD, { attestation_state: "RECONCILING" });
  await repo.transitionAttestation(ATT_HEAD, {
    attestation_state: "SEALED",
    closed_boundary_usn: KNOWN_CLOSED_BOUNDARY,
    attestation_sha256: `sha256:${HEX("f")}`,
  });

  // Link ATT_HEAD to OBS_HEAD
  await repo.query(
    `INSERT INTO intentchord.workspace_observations
      (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
       index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,
       observed_at,observation_result,accepted_workspace_evidence_artifact_id,
       source_continuity_attestation_id,observation_protocol_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'owner',now(),'FIRST_INDEXED',$8,$9,'{}'::jsonb)`,
    [
      OBS_HEAD, SNAP_HEAD, WS, REVISION, CONFIG, `sha256:${HEX("d")}`,
      JSON.stringify({ normalized_reference: `c:/r2-proof-${WS}`, binding_type: "LOCAL_FILESYSTEM" }),
      `wea_${HEX("a")}`, ATT_HEAD,
    ],
  );
  await repo.transitionAttestation(ATT_HEAD, { observation_id: OBS_HEAD });

  // --- ATT_NEWER: SEALED attestation with LATER created_at, but linked to OBS_OTHER (different observation) ---
  // Update SNAP_NEWER to have scan_base_observation_id = OBS_HEAD (proper head chain)
  await repo.query(
    `UPDATE intentchord.workspace_index_snapshots SET scan_base_observation_id = $1 WHERE id = $2`,
    [OBS_HEAD, SNAP_NEWER],
  );

  await repo.insertAttestationOpen({
    id: ATT_NEWER,
    workspace_registration_id: WS,
    provider_class: "STRONG_CONTINUITY_PROVIDER",
    provider_id: "WINDOWS_NTFS_USN_V1",
    claim_type: "SEALED_INTERVAL",
    volume_identity_json: { volume_serial: "VP2" },
    journal_identity_json: { journalId: "JP2" },
    previous_trusted_boundary_usn: null,
    opened_boundary_usn: 500,
    bootstrap: true,
    policy_hash: `sha256:${HEX("b")}`,
    continuity_evidence_json: { proofs: {} },
    snapshot_operation_id: SNAP_NEWER,
  });
  await repo.transitionAttestation(ATT_NEWER, { attestation_state: "RECONCILING" });
  await repo.transitionAttestation(ATT_NEWER, {
    attestation_state: "SEALED",
    closed_boundary_usn: 2000,
    attestation_sha256: `sha256:${HEX("c")}`,
  });

  // Link ATT_NEWER to OBS_OTHER — proper head chain with previous_observation_id = OBS_HEAD
  await repo.query(
    `INSERT INTO intentchord.workspace_observations
      (id,snapshot_operation_id,workspace_registration_id,workspace_revision_id,
       index_configuration_sha256,source_tree_fingerprint,source_binding_json,owner_reference,
       observed_at,observation_result,previous_observation_id,
       accepted_workspace_evidence_artifact_id,
       source_continuity_attestation_id,observation_protocol_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'owner',now(),$8,$9,$10,$11,'{}'::jsonb)`,
    [
      OBS_OTHER, SNAP_NEWER, WS, REVISION, CONFIG, `sha256:${HEX("d")}`,
      JSON.stringify({ normalized_reference: `c:/r2-proof-${WS}`, binding_type: "LOCAL_FILESYSTEM" }),
      "SOURCE_UNCHANGED", OBS_HEAD, `wea_${HEX("a")}`, ATT_NEWER,
    ],
  );
  await repo.transitionAttestation(ATT_NEWER, { observation_id: OBS_OTHER });

  // --- ATT_UNLINKED: SEALED attestation with NO observation linkage ---
  await repo.insertAttestationOpen({
    id: ATT_UNLINKED,
    workspace_registration_id: WS,
    provider_class: "STRONG_CONTINUITY_PROVIDER",
    provider_id: "WINDOWS_NTFS_USN_V1",
    claim_type: "SEALED_INTERVAL",
    volume_identity_json: { volume_serial: "VP3" },
    journal_identity_json: { journalId: "JP3" },
    previous_trusted_boundary_usn: null,
    opened_boundary_usn: 900,
    bootstrap: true,
    policy_hash: `sha256:${HEX("d")}`,
    continuity_evidence_json: { proofs: {} },
    snapshot_operation_id: SNAP_UNLINKED,
  });
  await repo.transitionAttestation(ATT_UNLINKED, { attestation_state: "RECONCILING" });
  await repo.transitionAttestation(ATT_UNLINKED, {
    attestation_state: "SEALED",
    closed_boundary_usn: 3000,
    attestation_sha256: `sha256:${HEX("e")}`,
  });
  // Deliberately NOT linked to any observation
});

afterAll(async () => {
  if (client) {
    if (process.env.INTENTCHORD_KEEP_SCHEMA !== "1") {
      await client.query("DROP SCHEMA IF EXISTS intentchord CASCADE").catch(() => undefined);
    }
    await client.end();
  }
});

describe("R2 Targeted PG Proof — Head-Bound Predecessor Selection", () => {
  it("P1 valid head-linked predecessor selected", async () => {
    if (!repo) return;
    const result = await repo.getSealedAttestationForObservation(WS, OBS_HEAD);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(ATT_HEAD);
  });

  it("P2 newer unrelated SEALED attestation not selected", async () => {
    if (!repo) return;
    const result = await repo.getSealedAttestationForObservation(WS, OBS_HEAD);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(ATT_HEAD);
    expect(result!.id).not.toBe(ATT_NEWER);
  });

  it("P3 wrong observation returns NULL", async () => {
    if (!repo) return;
    const fakeObs = randomUUID();
    const result = await repo.getSealedAttestationForObservation(WS, fakeObs);
    expect(result).toBeNull();
  });

  it("P4 wrong registration returns NULL", async () => {
    if (!repo) return;
    const result = await repo.getSealedAttestationForObservation(WS_OTHER, OBS_HEAD);
    expect(result).toBeNull();
  });

  it("P5 unlinked SEALED attestation not selected", async () => {
    if (!repo) return;
    const result = await repo.getSealedAttestationForObservation(WS, OBS_HEAD);
    expect(result).not.toBeNull();
    expect(result!.id).not.toBe(ATT_UNLINKED);
  });

  it("P6 predecessor policy_hash preserved exactly", async () => {
    if (!repo) return;
    const result = await repo.getSealedAttestationForObservation(WS, OBS_HEAD);
    expect(result).not.toBeNull();
    expect(result!.policy_hash).toBe(KNOWN_POLICY_HASH);
  });

  it("P7 predecessor closed_boundary_usn preserved exactly", async () => {
    if (!repo) return;
    const result = await repo.getSealedAttestationForObservation(WS, OBS_HEAD);
    expect(result).not.toBeNull();
    expect(Number(result!.closed_boundary_usn)).toBe(KNOWN_CLOSED_BOUNDARY);
  });

  it("query-authority no temporal ordering in getSealedAttestationForObservation", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/server/workspace-evidence-repository.ts", "utf8");
    const methodStart = src.indexOf("getSealedAttestationForObservation(");
    expect(methodStart).toBeGreaterThan(0);
    const methodBody = src.substring(methodStart, methodStart + 800);
    expect(methodBody).not.toMatch(/ORDER\s+BY\s+created_at/i);
    expect(methodBody).toContain("JOIN intentchord.workspace_observations wo");
    expect(methodBody).toContain("wo.source_continuity_attestation_id = wca.id");
    expect(methodBody).toContain("attestation_state = 'SEALED'");
  });
});
